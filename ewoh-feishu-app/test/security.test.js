// P0-SEC-001/002/003：Feishu Webhook 安全测试（node:test，无第三方依赖）
// FS-001/002/003 后对齐飞书事件订阅签名协议：
//   X-Lark-Signature = hex( sha256( X-Lark-Request-Timestamp + X-Lark-Request-Nonce
//                                   + encrypt_key + rawBody ) )
//   - rawBody（原始请求体字符串）参与签名，篡改 body 必须被拒
//   - 未配置 FEISHU_ENCRYPT_KEY → fail-closed 拒绝（不再放行）
//   - verification token 常量时间比较
// FS-018：simulatorEnabled / resolveCorsOrigins 直接测 server/middleware.js
// 真实实现（此前测试用局部变量重演 env 判断，测不到生产函数）。
// 运行：node --test test/security.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const security = require('../server/security');
const middleware = require('../server/middleware');

const TOKEN = 'test-verification-token';
const ENCRYPT_KEY = 'test-encrypt-key';

function makeValidBody(overrides = {}) {
  return {
    header: {
      event_id: `evt-${crypto.randomUUID()}`,
      event_type: 'card.action.trigger',
      token: TOKEN,
      create_time: new Date().toISOString(),
    },
    open_id: 'ou_test',
    action: {
      value: { action_type: 'acknowledge', event_id: 'EVT-1' },
    },
    ...overrides,
  };
}

// 按飞书事件订阅协议构造签名（FS-001）
function sign(rawBody, timestamp, nonce, key = ENCRYPT_KEY) {
  return crypto
    .createHash('sha256')
    .update(`${timestamp}${nonce}${key}${rawBody}`, 'utf8')
    .digest('hex');
}

function signedReq(body, { timestamp, nonce, signature, headers } = {}) {
  const rawBody = JSON.stringify(body);
  const ts = timestamp != null ? String(timestamp) : String(Date.now());
  const n = nonce != null ? String(nonce) : 'nonce-test';
  const sig = signature != null ? signature : sign(rawBody, ts, n);
  return {
    body,
    rawBody,
    headers: {
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': n,
      'x-lark-signature': sig,
      ...(headers || {}),
    },
  };
}

// 保存并恢复环境变量
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// 注入测试 token / encrypt key
process.env.FEISHU_VERIFICATION_TOKEN = TOKEN;
process.env.FEISHU_ENCRYPT_KEY = ENCRYPT_KEY;

test('valid request with token + protocol signature is accepted', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const result = security.verifyWebhookRequest(signedReq(makeValidBody()));
    assert.strictEqual(result.ok, true);
    assert.ok(result.eventId, '应返回 header.event_id 作为重放键');
  });
});

test('FS-002: 未配置 FEISHU_ENCRYPT_KEY → fail-closed 拒绝（不再降级放行）', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: undefined }, () => {
    const result = security.verifyWebhookRequest(signedReq(makeValidBody()));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_ENCRYPT_KEY_NOT_CONFIGURED');
  });
});

test('FS-003: invalid token rejected', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    body.header.token = 'wrong-token';
    const result = security.verifyWebhookRequest(signedReq(body));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_INVALID_TOKEN');
  });
});

test('missing token rejected', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    delete body.header.token;
    const result = security.verifyWebhookRequest(signedReq(body));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_INVALID_TOKEN');
  });
});

test('FEISHU_VERIFICATION_TOKEN 未配置 → 拒绝', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: undefined, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const result = security.verifyWebhookRequest(signedReq(makeValidBody()));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_TOKEN_NOT_CONFIGURED');
  });
});

test('FS-001: 缺签名头 rejected', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const req = signedReq(makeValidBody());
    delete req.headers['x-lark-signature'];
    const result = security.verifyWebhookRequest(req);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_INVALID_SIGNATURE');
  });
});

test('FS-001: 签名必须覆盖 raw body（body 被篡改 → 拒绝）', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    const req = signedReq(body);
    // 签名基于原始 body，但实际请求体被篡改（action 改为 resolve）
    const tampered = JSON.stringify({ ...body, action: { value: { action_type: 'resolve', event_id: 'EVT-1' } } });
    req.rawBody = tampered;
    const result = security.verifyWebhookRequest(req);
    assert.strictEqual(result.ok, false, '篡改 body 后旧签名必须失效');
    assert.strictEqual(result.code, 'WEBHOOK_INVALID_SIGNATURE');
  });
});

test('FS-001: 旧算法（HMAC(ts+nonce+key)，不含 body）签名 → 拒绝', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    const ts = String(Date.now());
    const nonce = 'nonce-test';
    const oldHmac = crypto
      .createHmac('sha256', ENCRYPT_KEY)
      .update(`${ts}${nonce}${ENCRYPT_KEY}`)
      .digest('base64');
    const result = security.verifyWebhookRequest(
      signedReq(body, { timestamp: ts, nonce, signature: oldHmac })
    );
    assert.strictEqual(result.ok, false, '不含 body 的旧 HMAC 签名不得通过');
    assert.strictEqual(result.code, 'WEBHOOK_INVALID_SIGNATURE');
  });
});

test('FS-001: sha256(ts+nonce+key)（漏拼 body）签名 → 拒绝', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    const ts = String(Date.now());
    const nonce = 'nonce-test';
    const noBodySig = crypto
      .createHash('sha256')
      .update(`${ts}${nonce}${ENCRYPT_KEY}`, 'utf8')
      .digest('hex');
    const result = security.verifyWebhookRequest(
      signedReq(body, { timestamp: ts, nonce, signature: noBodySig })
    );
    assert.strictEqual(result.ok, false, '漏拼 body 的签名不得通过');
  });
});

test('缺 X-Lark-Request-Nonce / rawBody → 拒绝', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    const ts = String(Date.now());
    // 无 nonce 头
    const r1 = security.verifyWebhookRequest({
      body,
      rawBody: JSON.stringify(body),
      headers: { 'x-lark-request-timestamp': ts, 'x-lark-signature': '0'.repeat(64) },
    });
    assert.strictEqual(r1.code, 'WEBHOOK_INVALID_SIGNATURE');
    // 无 rawBody（中间件未挂 raw body 时 fail-closed）
    const r2 = security.verifyWebhookRequest({
      body,
      headers: { 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': 'n', 'x-lark-signature': '0'.repeat(64) },
    });
    assert.strictEqual(r2.code, 'WEBHOOK_INVALID_SIGNATURE');
  });
});

test('expired timestamp rejected（header 时间戳过期）', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    const result = security.verifyWebhookRequest(
      signedReq(body, { timestamp: Math.floor((Date.now() - 10 * 60 * 1000) / 1000) })
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_EXPIRED');
  });
});

test('missing timestamp rejected（无 header ts / create_time / body.timestamp）', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    delete body.header.create_time;
    const req = signedReq(body);
    delete req.headers['x-lark-request-timestamp'];
    const result = security.verifyWebhookRequest(req);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_MISSING_TIMESTAMP');
  });
});

test('replayed request rejected after markReplayHandled', () => {
  withEnv({ FEISHU_VERIFICATION_TOKEN: TOKEN, FEISHU_ENCRYPT_KEY: ENCRYPT_KEY }, () => {
    const body = makeValidBody();
    // v1.1.1 新语义：验证通过不自动标记；业务成功后显式 markReplayHandled
    const first = security.verifyWebhookRequest(signedReq(body));
    assert.strictEqual(first.ok, true);
    // 未标记前：重复请求仍可通过（合法重试不被 401 拦截）
    const retry = security.verifyWebhookRequest(signedReq(body));
    assert.strictEqual(retry.ok, true, '业务成功前允许重试');

    // 业务成功后标记 → 同 event_id 再次请求被拒
    security.markReplayHandled(first.eventId);
    const result = security.verifyWebhookRequest(signedReq(body));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WEBHOOK_REPLAY');
  });
});

test('markReplayHandled 无 eventId 安全', () => {
  security.markReplayHandled(null);
  security.markReplayHandled('');
  assert.strictEqual(security.isReplay(null), false);
});

test('safeEqualStr: 常量时间比较正确区分相等/不等', () => {
  assert.strictEqual(security.safeEqualStr('abc', 'abc'), true);
  assert.strictEqual(security.safeEqualStr('abc', 'abd'), false);
  assert.strictEqual(security.safeEqualStr('a', 'ab'), false);
  assert.strictEqual(security.safeEqualStr('', ''), true);
});

// ---------- FS-018：直接测 server/middleware.js 真实实现 ----------

test('FS-018: simulatorEnabled 默认关闭（真实函数）', () => {
  withEnv({ FEISHU_SIMULATOR_ENABLED: undefined, NODE_ENV: undefined, ALLOW_SIMULATOR_IN_PRODUCTION: undefined }, () => {
    assert.strictEqual(middleware.simulatorEnabled(), false);
  });
});

test('FS-018: simulatorEnabled 显式开启（非 production）→ true', () => {
  withEnv({ FEISHU_SIMULATOR_ENABLED: 'true', NODE_ENV: 'development' }, () => {
    assert.strictEqual(middleware.simulatorEnabled(), true);
  });
});

test('FS-018: production 无显式允许时模拟器不得启动（真实函数）', () => {
  withEnv({ FEISHU_SIMULATOR_ENABLED: 'true', NODE_ENV: 'production', ALLOW_SIMULATOR_IN_PRODUCTION: undefined }, () => {
    assert.strictEqual(middleware.simulatorEnabled(), false, 'production 无显式允许时必须拒绝');
  });
});

test('FS-018: production 显式允许后模拟器可启动（真实函数）', () => {
  withEnv({ FEISHU_SIMULATOR_ENABLED: 'true', NODE_ENV: 'production', ALLOW_SIMULATOR_IN_PRODUCTION: 'true' }, () => {
    assert.strictEqual(middleware.simulatorEnabled(), true);
  });
});

test('FS-018: resolveCorsOrigins 拒绝 *（与 credentials 冲突，真实函数）', () => {
  withEnv({ FEISHU_CORS_ORIGINS: 'http://a.example,*,http://b.example' }, () => {
    assert.throws(() => middleware.resolveCorsOrigins(), /不得包含 \*/);
  });
});

test('FS-018: resolveCorsOrigins 显式 allowlist 透传（真实函数）', () => {
  withEnv({ FEISHU_CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173' }, () => {
    assert.deepStrictEqual(middleware.resolveCorsOrigins(), ['http://localhost:3000', 'http://localhost:5173']);
  });
});

test('FS-018: resolveCorsOrigins 未配置时回退本地默认源（真实函数）', () => {
  withEnv({ FEISHU_CORS_ORIGINS: undefined }, () => {
    assert.deepStrictEqual(middleware.resolveCorsOrigins(), [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]);
  });
});
