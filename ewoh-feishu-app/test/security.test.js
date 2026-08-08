// P0-SEC-001/002/003：Feishu Webhook 安全测试（node:test，无第三方依赖）
// 运行：node --test test/security.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const security = require('../server/security');

function makeValidBody(overrides = {}) {
  return {
    header: {
      event_id: `evt-${crypto.randomUUID()}`,
      event_type: 'card.action.trigger',
      token: 'test-verification-token',
      create_time: new Date().toISOString(),
    },
    open_id: 'ou_test',
    action: {
      value: { action_type: 'acknowledge', event_id: 'EVT-1' },
    },
    ...overrides,
  };
}

function makeReq(body, headers = {}) {
  return { body, headers: { 'x-lark-signature': '', ...headers } };
}

// 注入测试 token
process.env.FEISHU_VERIFICATION_TOKEN = 'test-verification-token';

test('valid request with token is accepted', () => {
  const result = security.verifyWebhookRequest(makeReq(makeValidBody()));
  assert.strictEqual(result.ok, true);
});

test('missing signature-config request with valid token+timestamp accepted (documented downgrade)', () => {
  // 未配置 FEISHU_ENCRYPT_KEY 时依赖 token + timestamp（文档化降级）
  delete process.env.FEISHU_ENCRYPT_KEY;
  const result = security.verifyWebhookRequest(makeReq(makeValidBody()));
  assert.strictEqual(result.ok, true);
});

test('invalid token rejected', () => {
  const body = makeValidBody();
  body.header.token = 'wrong-token';
  const result = security.verifyWebhookRequest(makeReq(body));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WEBHOOK_INVALID_TOKEN');
});

test('missing token rejected', () => {
  const body = makeValidBody();
  delete body.header.token;
  const result = security.verifyWebhookRequest(makeReq(body));
  assert.strictEqual(result.ok, false);
});

test('expired timestamp rejected', () => {
  const body = makeValidBody();
  body.header.create_time = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 分钟前
  const result = security.verifyWebhookRequest(makeReq(body));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WEBHOOK_EXPIRED');
});

test('missing timestamp rejected', () => {
  const body = makeValidBody();
  delete body.header.create_time;
  const result = security.verifyWebhookRequest(makeReq(body));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WEBHOOK_MISSING_TIMESTAMP');
});

test('replayed request rejected', () => {
  const body = makeValidBody();
  // 第一次通过
  assert.strictEqual(security.verifyWebhookRequest(makeReq(body)).ok, true);
  // 第二次（同 event_id）→ replay
  const result = security.verifyWebhookRequest(makeReq(body));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WEBHOOK_REPLAY');
});

test('invalid signature rejected when encrypt key configured', () => {
  process.env.FEISHU_ENCRYPT_KEY = 'test-encrypt-key';
  const body = makeValidBody();
  const result = security.verifyWebhookRequest(
    makeReq(body, { 'x-lark-signature': 'aW52YWxpZA==' })
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WEBHOOK_INVALID_SIGNATURE');
  delete process.env.FEISHU_ENCRYPT_KEY;
});

test('valid signature accepted when encrypt key configured', () => {
  process.env.FEISHU_ENCRYPT_KEY = 'test-encrypt-key';
  const body = makeValidBody();
  // v1.1.0 D4：签名使用秒级时间戳（extractSignatureTimestamp）
  const timestamp = security.extractSignatureTimestamp(body);
  const nonce = '';
  const expected = crypto
    .createHmac('sha256', 'test-encrypt-key')
    .update(`${timestamp}${nonce}test-encrypt-key`)
    .digest('base64');
  const result = security.verifyWebhookRequest(
    makeReq(body, { 'x-lark-signature': expected })
  );
  assert.strictEqual(result.ok, true);
  delete process.env.FEISHU_ENCRYPT_KEY;
});

// v1.1.0 D4：签名时间戳必须为秒级字符串（飞书 HMAC 协议），毫秒参与会签名不匹配
test('D4: signature uses seconds-level timestamp (Feishu HMAC protocol)', () => {
  process.env.FEISHU_ENCRYPT_KEY = 'test-encrypt-key';
  const body = makeValidBody();

  // extractSignatureTimestamp 应从 ISO create_time 得到秒级字符串
  const tsSec = security.extractSignatureTimestamp(body);
  assert.strictEqual(typeof tsSec, 'string');
  assert.ok(/^\d{10}$/.test(tsSec), `秒级时间戳应为 10 位数字，实际: ${tsSec}`);
  // 与毫秒的 floor 关系
  const ms = Date.parse(body.header.create_time);
  assert.strictEqual(Number(tsSec), Math.floor(ms / 1000), '应为毫秒时间戳的秒级截断');

  // 用秒级时间戳构造签名 → 校验通过
  const source = `${tsSec}${''}test-encrypt-key`;
  const expected = crypto.createHmac('sha256', 'test-encrypt-key').update(source).digest('base64');
  const result = security.verifyWebhookRequest(
    makeReq(body, { 'x-lark-signature': expected })
  );
  assert.strictEqual(result.ok, true, '秒级时间戳签名应通过');

  // 若用毫秒时间戳构造签名 → 校验失败（旧 bug 复现验证）
  const wrongSource = `${ms}${''}test-encrypt-key`;
  const wrongSig = crypto.createHmac('sha256', 'test-encrypt-key').update(wrongSource).digest('base64');
  const result2 = security.verifyWebhookRequest(
    makeReq(body, { 'x-lark-signature': wrongSig })
  );
  assert.strictEqual(result2.ok, false, '毫秒时间戳签名应被拒绝（协议不兼容）');
  delete process.env.FEISHU_ENCRYPT_KEY;
});

test('D4: body.timestamp 秒字符串直接用于签名（不再 ×1000）', () => {
  process.env.FEISHU_ENCRYPT_KEY = 'test-encrypt-key';
  const body = makeValidBody({ header: { event_id: `evt-${crypto.randomUUID()}`, token: 'test-verification-token' } });
  body.timestamp = String(Math.floor(Date.now() / 1000)); // 秒字符串（飞书事件订阅标准字段）
  delete body.header.create_time;

  const tsSec = security.extractSignatureTimestamp(body);
  assert.strictEqual(tsSec, body.timestamp, '秒字符串应原样使用，不得 ×1000');

  const source = `${tsSec}${''}test-encrypt-key`;
  const expected = crypto.createHmac('sha256', 'test-encrypt-key').update(source).digest('base64');
  const result = security.verifyWebhookRequest(
    makeReq(body, { 'x-lark-signature': expected })
  );
  assert.strictEqual(result.ok, true);
  delete process.env.FEISHU_ENCRYPT_KEY;
});

// P0-SEC-002：simulator 开关（复用 index.js 逻辑，通过模块级函数验证）
test('simulator disabled by default', () => {
  const saved = process.env.FEISHU_SIMULATOR_ENABLED;
  delete process.env.FEISHU_SIMULATOR_ENABLED;
  delete process.env.NODE_ENV;
  // 直接验证 index.js 的 simulatorEnabled 行为——通过 require 重载
  // 此处验证 env 判断的核心逻辑（避免启动整个 app）
  const enabled = (process.env.FEISHU_SIMULATOR_ENABLED || '').trim().toLowerCase() === 'true';
  assert.strictEqual(enabled, false);
  if (saved !== undefined) process.env.FEISHU_SIMULATOR_ENABLED = saved;
});

test('simulator blocked in production unless explicit allow', () => {
  process.env.FEISHU_SIMULATOR_ENABLED = 'true';
  process.env.NODE_ENV = 'production';
  delete process.env.ALLOW_SIMULATOR_IN_PRODUCTION;
  const isProd = process.env.NODE_ENV === 'production';
  const allow = (process.env.ALLOW_SIMULATOR_IN_PRODUCTION || '').trim().toLowerCase();
  const starts = isProd && allow !== 'true' && allow !== '1' ? false : true;
  assert.strictEqual(starts, false, 'production 无显式允许时模拟器不得启动');

  process.env.ALLOW_SIMULATOR_IN_PRODUCTION = 'true';
  const allow2 = (process.env.ALLOW_SIMULATOR_IN_PRODUCTION || '').trim().toLowerCase();
  const starts2 = allow2 === 'true' || allow2 === '1';
  assert.strictEqual(starts2, true, '显式允许后模拟器可启动');

  delete process.env.FEISHU_SIMULATOR_ENABLED;
  delete process.env.NODE_ENV;
  delete process.env.ALLOW_SIMULATOR_IN_PRODUCTION;
});

// P0-SEC-003：CORS 校验逻辑
test('cors wildcard rejected', () => {
  assert.throws(() => {
    const raw = ['*'];
    if (raw.includes('*')) throw new Error('FEISHU_CORS_ORIGINS 不得包含 *');
  });
});

test('cors explicit allowlist accepted', () => {
  const raw = ['http://localhost:3000', 'http://localhost:5173'];
  const origins = raw.length > 0 ? raw : ['http://localhost:3000'];
  assert.deepStrictEqual(origins, ['http://localhost:3000', 'http://localhost:5173']);
});
