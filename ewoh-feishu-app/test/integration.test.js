// server/integration.test.js — v1.1.0 端到端集成测试（node:test + 真实 HTTP server）
// 覆盖（不开真实飞书/lark-cli，仅验证本地 HTTP 行为）：
//   - /api 写操作无 token → 401（fail-closed）
//   - /api 写操作带正确 token → 200
//   - /api 读操作默认放行
//   - /webhook/card 验签失败 → 401；未配置 encrypt_key → 401（FS-002 fail-closed）
//   - /webhook/card 验签通过 + 处置成功；重复投递 → duplicated=true 且状态不变
//   - event not found → dedup 回滚可重试（FS-004）
//   - closed 事件重复处置 → 409 + dedup 回滚可重试
// FS-009：webhook handler 与中间件装配直接复用 server 实现
//（middleware.configureApp + webhook.createWebhookCardHandler），
// 不再维护测试内联副本（原副本缺 createApproval/markReplayHandled/updateCard）。
// 运行：node --test test/integration.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const express = require('express');
const dbm = require('../server/db');
const events = require('../server/events');
const middleware = require('../server/middleware');
const { createApiRouter } = require('../server/api');
const { apiAuth } = require('../server/auth');
const { createWebhookCardHandler } = require('../server/webhook');

const VERIFY_TOKEN = 'test-verification-token';
const ENCRYPT_KEY = 'it-encrypt-key';

// 构建与生产 index.js 同构的 Express app（共用 middleware/webhook/api 装配）
function buildApp(db) {
  const app = express();
  middleware.configureApp(app); // 安全头 + CORS + rawBody 捕获（FS-007/014/001）
  app.use('/api', apiAuth, createApiRouter(db));
  app.post('/webhook/card', createWebhookCardHandler(db)); // FS-009：复用生产 handler
  app.use(middleware.errorHandler);
  return app;
}

// 启动真实 HTTP server，返回 { baseUrl, close }
async function startServer(app, t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${port}` };
}

// JSON 请求封装
async function httpJson(baseUrl, method, urlPath, { headers = {}, body, rawBody } = {}) {
  const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

// FS-001：按飞书事件订阅协议签名 hex(sha256(ts + nonce + key + rawBody))
function sign(rawBody, timestamp, nonce) {
  return crypto
    .createHash('sha256')
    .update(`${timestamp}${nonce}${ENCRYPT_KEY}${rawBody}`, 'utf8')
    .digest('hex');
}

// 发送带协议签名的 webhook 请求（rawBody 与签名基串严格一致）
async function postWebhookRaw(baseUrl, body, opts = {}) {
  const raw = JSON.stringify(body);
  const ts = opts.timestamp != null ? String(opts.timestamp) : String(Date.now());
  const n = opts.nonce != null ? String(opts.nonce) : 'it-nonce';
  const sig = opts.signature != null ? opts.signature : sign(raw, ts, n);
  return httpJson(baseUrl, 'POST', '/webhook/card', {
    headers: {
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': n,
      'x-lark-signature': sig,
    },
    rawBody: raw,
  });
}

// 保存并恢复环境变量（async 版：确保整个回调执行期间环境保持，完成后恢复）
async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-it-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  return dir;
}

function makeCardBody(overrides = {}) {
  const now = new Date().toISOString();
  return {
    header: {
      event_id: `evt-${crypto.randomUUID()}`,
      event_type: 'card.action.trigger',
      token: VERIFY_TOKEN,
      create_time: now,
    },
    open_id: 'ou_test',
    operator: { open_id: 'ou_test' },
    action: { value: { action_type: 'acknowledge', event_id: 'EVT-IT-1' } },
    ...overrides,
  };
}

test('集成：/api 写操作无 token → 401（fail-closed）', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_API_TOKEN: 'it-secret' }, async () => {
    const res = await httpJson(baseUrl, 'POST', '/api/events/EVT-X/handle', {
      body: { action: 'acknowledge', handler_id: 'h1' },
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
  });
});

test('集成：/api 写操作正确 token → 200', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  const ev = events.createEvent(db, {
    device_id: 'EXO-001', event_code: 'IT_EVENT', event_type: 'L1', severity: 'high',
    title: '集成测试', description: '', trigger_data: {}, evidence: {},
  });
  await withEnv({ FEISHU_API_TOKEN: 'it-secret' }, async () => {
    const res = await httpJson(baseUrl, 'POST', `/api/events/${ev.event_id}/handle`, {
      headers: { authorization: 'Bearer it-secret' },
      body: { action: 'acknowledge', handler_id: 'h1' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.status, 'handled');
  });
});

// R2-FSH-002：读操作默认不再放行（fail-closed），与写操作同一鉴权
test('集成：/api 读操作默认 fail-closed（未配置 token → 503）', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_API_TOKEN: undefined }, async () => {
    const res = await httpJson(baseUrl, 'GET', '/api/status');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error.code, 'AUTH_NOT_CONFIGURED');
  });
});

// R2-FSH-002：读操作配置正确 token → 放行
test('集成：/api 读操作携带正确 token → 200', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_API_TOKEN: 'it-secret' }, async () => {
    const res = await httpJson(baseUrl, 'GET', '/api/status', {
      headers: { authorization: 'Bearer it-secret' },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.devices.total >= 3);
  });
});

test('集成：FS-007 安全头 + x-powered-by 禁用', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  app.get('/__it', (req, res) => res.json({ ok: 1 }));
  const { baseUrl } = await startServer(app, t);
  const res = await httpJson(baseUrl, 'GET', '/__it');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy'), '应设置 CSP');
  assert.strictEqual(res.headers.get('x-powered-by'), null, 'x-powered-by 必须禁用');
});

test('集成：FS-014 CORS 预检 allowedHeaders 含 Authorization/X-API-Key', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_CORS_ORIGINS: 'http://localhost:3000' }, async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, x-api-key, content-type',
      },
    });
    assert.strictEqual(res.status, 204);
    const allowed = String(res.headers.get('access-control-allow-headers') || '');
    assert.match(allowed, /authorization/i, 'allowedHeaders 应含 Authorization');
    assert.match(allowed, /x-api-key/i, 'allowedHeaders 应含 X-API-Key');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  });
});

test('集成：/webhook/card 验签失败 → 401', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv(
    { FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY },
    async () => {
      const res = await postWebhookRaw(baseUrl, makeCardBody(), { signature: '0'.repeat(64) });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'WEBHOOK_INVALID_SIGNATURE');
    }
  );
});

test('集成：FS-002 /webhook/card 未配置 encrypt_key → 401（fail-closed）', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN, FEISHU_ENCRYPT_KEY: undefined }, async () => {
    const res = await postWebhookRaw(baseUrl, makeCardBody());
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'WEBHOOK_ENCRYPT_KEY_NOT_CONFIGURED');
  });
});

test('集成：/webhook/card 处置成功 + 重复投递幂等命中', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);

  events.createEvent(db, {
    device_id: 'EXO-001', event_code: 'IT_EVENT', event_type: 'L1', severity: 'high',
    title: '集成测试', description: '', trigger_data: {}, evidence: {},
  });
  const evId = db.prepare("SELECT event_id FROM events WHERE event_code = 'IT_EVENT' ORDER BY id DESC LIMIT 1").get().event_id;

  await withEnv(
    { FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY },
    async () => {
      // 第一次：处置成功（acknowledge → handled）
      const cardBody = makeCardBody();
      cardBody.action.value.event_id = evId;
      const res1 = await postWebhookRaw(baseUrl, cardBody);
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.body.ok, true);
      assert.strictEqual(res1.body.duplicated, undefined);
      assert.strictEqual(events.getEvent(db, evId).status, 'handled');

      // 第二次：同一事件同一动作重复投递（新 event_id 信封）→ 幂等命中，状态不变
      const dupBody = makeCardBody();
      dupBody.action.value.event_id = evId;
      const res2 = await postWebhookRaw(baseUrl, dupBody);
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.body.ok, true);
      assert.strictEqual(res2.body.duplicated, true, '重复投递应幂等命中');
      assert.strictEqual(events.getEvent(db, evId).status, 'handled', '状态不应被重复修改');
      assert.strictEqual(dbm.hasWebhookProcessed(db, evId, 'acknowledge'), true);
    }
  );
});

test('集成：FS-004 event not found → dedup 回滚可重试', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);

  await withEnv(
    { FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY },
    async () => {
      const cardBody = makeCardBody();
      cardBody.action.value.event_id = 'EVT-NOT-EXIST';
      const res = await postWebhookRaw(baseUrl, cardBody);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, false);
      assert.match(String(res.body.error), /not found/);
      assert.strictEqual(
        dbm.hasWebhookProcessed(db, 'EVT-NOT-EXIST', 'acknowledge'),
        false,
        'not-found 分支必须回滚 dedup 记录（否则合法重试被误判 duplicated）'
      );
    }
  );
});

test('集成：closed 事件重复处置 → 409 + dedup 回滚可重试', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);

  const ev = events.createEvent(db, {
    device_id: 'EXO-001', event_code: 'IT_EVENT2', event_type: 'L1', severity: 'high',
    title: '关闭后处置', description: '', trigger_data: {}, evidence: {},
  });
  events.handleEvent(db, ev.event_id, { handler_id: 'u1', action: 'resolve' }); // → closed

  await withEnv(
    { FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY },
    async () => {
      const cardBody = makeCardBody();
      cardBody.action.value.event_id = ev.event_id;
      cardBody.action.value.action_type = 'resolve';
      const res = await postWebhookRaw(baseUrl, cardBody);
      assert.strictEqual(res.status, 409, 'closed 事件处置应 409');
      assert.ok(String(res.body.error).includes('already closed'));
      assert.strictEqual(dbm.hasWebhookProcessed(db, ev.event_id, 'resolve'), false, 'dedup 应回滚可重试');
    }
  );
});

test('集成：未知 action_type → 400 + dedup 回滚', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  const ev = events.createEvent(db, {
    device_id: 'EXO-001', event_code: 'IT_EVENT3', event_type: 'L1', severity: 'high',
    title: '未知动作', description: '', trigger_data: {}, evidence: {},
  });
  await withEnv(
    { FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY },
    async () => {
      const cardBody = makeCardBody();
      cardBody.action.value.event_id = ev.event_id;
      cardBody.action.value.action_type = 'bogus';
      const res = await postWebhookRaw(baseUrl, cardBody);
      assert.strictEqual(res.status, 400);
      assert.ok(String(res.body.error).includes('unknown action_type'));
      assert.strictEqual(dbm.hasWebhookProcessed(db, ev.event_id, 'bogus'), false);
    }
  );
});
