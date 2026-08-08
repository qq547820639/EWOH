// server/integration.test.js — v1.1.0 端到端集成测试（node:test + 真实 HTTP server）
// 覆盖（不开真实飞书/lark-cli，仅验证本地 HTTP 行为）：
//   - /api 写操作无 token → 401（fail-closed）
//   - /api 写操作带正确 token → 200
//   - /api 读操作默认放行
//   - /webhook/card 验签失败 → 401
//   - /webhook/card 验签通过 + 处置成功；重复投递 → duplicated=true 且状态不变
//   - closed 事件重复处置 → 409 + dedup 回滚可重试
// 运行：node --test test/integration.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dbm = require('../server/db');
const events = require('../server/events');

// 构造最小 Express app（复用 index.js 的路由装配逻辑，但不启动模拟器/定时器）
function buildApp(db) {
  const express = require('express');
  const cors = require('cors');
  const { createApiRouter } = require('../server/api');
  const { apiAuth } = require('../server/auth');
  const feishu = require('../server/feishu');
  const sync = require('../server/sync');
  const security = require('../server/security');

  const app = express();
  app.use(cors({ origin: ['http://localhost:3000'], methods: ['GET', 'POST', 'OPTIONS'], credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiAuth, createApiRouter(db));

  // webhook 卡片回调（与 index.js 相同的处理逻辑，含 D3 业务幂等）
  app.post('/webhook/card', (req, res) => {
    const body = req.body || {};
    const value = (body.action && body.action.value) || {};
    const actionType = value.action_type;
    const eventId = value.event_id || (body.header && body.header.event_id);

    const result = security.verifyWebhookRequest(req);
    if (!result.ok) {
      security.auditWebhook(db, req, result, actionType, eventId);
      return res.status(401).json({ ok: false, error: result.error, code: result.code });
    }
    security.auditWebhook(db, req, { ok: true }, actionType, eventId);

    try {
      if (!actionType || !eventId) {
        return res.json({ ok: false, error: 'missing action_type or event_id' });
      }
      const dedup = dbm.tryAcquireWebhookDedup(db, {
        event_id: eventId,
        action_type: actionType,
        actor_id: body.open_id || (body.operator && body.operator.open_id) || 'unknown',
        result: { status: 'processing' },
      });
      if (dedup.error) return res.json({ ok: false, error: dedup.error });
      if (dedup.duplicated) {
        return res.json({ ok: true, duplicated: true, event_id: eventId, action: actionType });
      }

      const event = events.getEvent(db, eventId);
      if (!event) return res.json({ ok: false, error: `event not found: ${eventId}` });
      const dev = dbm.getDevice(db, event.device_id);
      if (dev) event.worker_name = dev.worker_name;

      const openId = body.open_id || (body.operator && body.operator.open_id) || 'unknown';
      let label;
      try {
        if (actionType === 'acknowledge') {
          events.handleEvent(db, eventId, { handler_id: openId, action: 'acknowledge' });
          label = '已确认';
        } else if (actionType === 'resolve') {
          events.handleEvent(db, eventId, { handler_id: openId, action: 'resolve' });
          label = '已解决';
        } else if (actionType === 'escalate') {
          events.handleEvent(db, eventId, { handler_id: openId, action: 'escalate' });
          label = '已上报（审批中）';
        } else {
          dbm.deleteWebhookDedup(db, eventId, actionType);
          return res.status(400).json({ ok: false, error: `unknown action_type: ${actionType}` });
        }
      } catch (e) {
        dbm.deleteWebhookDedup(db, eventId, actionType);
        const isClosedViolation = String(e.message || '').includes('already closed');
        return res.status(isClosedViolation ? 409 : 400).json({ ok: false, error: e.message });
      }
      dbm.updateWebhookDedupResult(db, eventId, actionType, { status: 'done', label, at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) {
      console.error('[webhook] /webhook/card 处理异常:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

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
async function httpJson(baseUrl, method, urlPath, { headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: res.status, body: json };
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
      token: 'test-verification-token',
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

test('集成：/api 读操作默认放行（未配置 token）', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_API_TOKEN: undefined }, async () => {
    const res = await httpJson(baseUrl, 'GET', '/api/status');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.devices.total >= 3);
  });
});

test('集成：/webhook/card 验签失败 → 401', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  await withEnv({ FEISHU_VERIFICATION_TOKEN: 'test-verification-token' }, async () => {
    const res = await httpJson(baseUrl, 'POST', '/webhook/card', {
      body: makeCardBody({ header: { ...makeCardBody().header, token: 'wrong-token' } }),
    });
    assert.strictEqual(res.status, 401);
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

  await withEnv({ FEISHU_VERIFICATION_TOKEN: 'test-verification-token' }, async () => {
    // 第一次：处置成功（acknowledge → handled）
    const cardBody = makeCardBody();
    cardBody.action.value.event_id = evId;
    const res1 = await httpJson(baseUrl, 'POST', '/webhook/card', { body: cardBody });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.ok, true);
    assert.strictEqual(res1.body.duplicated, undefined);
    assert.strictEqual(events.getEvent(db, evId).status, 'handled');

    // 第二次：同一事件同一动作重复投递（新 event_id 信封）→ 幂等命中，状态不变
    const dupBody = makeCardBody();
    dupBody.action.value.event_id = evId;
    const res2 = await httpJson(baseUrl, 'POST', '/webhook/card', { body: dupBody });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.ok, true);
    assert.strictEqual(res2.body.duplicated, true, '重复投递应幂等命中');
    assert.strictEqual(events.getEvent(db, evId).status, 'handled', '状态不应被重复修改');
    assert.strictEqual(dbm.hasWebhookProcessed(db, evId, 'acknowledge'), true);
  });
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

  await withEnv({ FEISHU_VERIFICATION_TOKEN: 'test-verification-token' }, async () => {
    const cardBody = makeCardBody();
    cardBody.action.value.event_id = ev.event_id;
    cardBody.action.value.action_type = 'resolve';
    const res = await httpJson(baseUrl, 'POST', '/webhook/card', { body: cardBody });
    assert.strictEqual(res.status, 409, 'closed 事件处置应 409');
    assert.ok(String(res.body.error).includes('already closed'));
    assert.strictEqual(dbm.hasWebhookProcessed(db, ev.event_id, 'resolve'), false, 'dedup 应回滚可重试');
  });
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
  await withEnv({ FEISHU_VERIFICATION_TOKEN: 'test-verification-token' }, async () => {
    const cardBody = makeCardBody();
    cardBody.action.value.event_id = ev.event_id;
    cardBody.action.value.action_type = 'bogus';
    const res = await httpJson(baseUrl, 'POST', '/webhook/card', { body: cardBody });
    assert.strictEqual(res.status, 400);
    assert.ok(String(res.body.error).includes('unknown action_type'));
    assert.strictEqual(dbm.hasWebhookProcessed(db, ev.event_id, 'bogus'), false);
  });
});
