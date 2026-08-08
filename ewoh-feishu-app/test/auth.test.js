// server/auth.test.js — v1.1.0 D1：API 统一鉴权中间件测试（node:test，无第三方依赖）
// 覆盖：写操作 fail-closed、Bearer/X-API-Key 凭证、常量时间比较、读操作放行与收紧
// 运行：node --test test/auth.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { apiAuth, getApiToken, safeEqual, extractToken, isWriteMethod } = require('../server/auth');

function makeRes() {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function makeReq(method, headers = {}) {
  return { method, headers };
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

test('isWriteMethod: POST/PUT/PATCH/DELETE 为写方法', () => {
  assert.strictEqual(isWriteMethod('POST'), true);
  assert.strictEqual(isWriteMethod('PUT'), true);
  assert.strictEqual(isWriteMethod('PATCH'), true);
  assert.strictEqual(isWriteMethod('DELETE'), true);
  assert.strictEqual(isWriteMethod('GET'), false);
  assert.strictEqual(isWriteMethod('HEAD'), false);
  assert.strictEqual(isWriteMethod('OPTIONS'), false);
});

test('extractToken: 支持 Bearer 与 X-API-Key 两种格式', () => {
  assert.strictEqual(extractToken(makeReq('POST', { authorization: 'Bearer abc123' })), 'abc123');
  assert.strictEqual(extractToken(makeReq('POST', { 'x-api-key': 'key456' })), 'key456');
  assert.strictEqual(extractToken(makeReq('POST', {})), '');
  assert.strictEqual(extractToken(makeReq('POST', { authorization: 'Basic abc' })), '');
});

test('safeEqual: 常量时间比较正确区分相等/不等', () => {
  assert.strictEqual(safeEqual('secret-token', 'secret-token'), true);
  assert.strictEqual(safeEqual('secret-token', 'secret-token2'), false);
  assert.strictEqual(safeEqual('a', 'a'), true);
  assert.strictEqual(safeEqual('a', 'b'), false);
  assert.strictEqual(safeEqual('long-token', 'short'), false);
});

test('写操作在未配置 FEISHU_API_TOKEN 时 fail-closed（503）', () => {
  withEnv({ FEISHU_API_TOKEN: undefined }, () => {
    const res = makeRes();
    apiAuth(makeReq('POST', {}), res, () => assert.fail('不应放行'));
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error.code, 'AUTH_NOT_CONFIGURED');
  });
});

test('写操作 token 错误 → 401', () => {
  withEnv({ FEISHU_API_TOKEN: 'correct-token' }, () => {
    const res = makeRes();
    apiAuth(makeReq('POST', { authorization: 'Bearer wrong-token' }), res, () => assert.fail('不应放行'));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
  });
});

test('写操作 Bearer 正确 token → 放行', () => {
  withEnv({ FEISHU_API_TOKEN: 'correct-token' }, () => {
    let passed = false;
    const res = makeRes();
    apiAuth(makeReq('POST', { authorization: 'Bearer correct-token' }), res, () => { passed = true; });
    assert.strictEqual(passed, true, '正确 token 应放行');
    assert.strictEqual(res.statusCode, 200);
  });
});

test('写操作 X-API-Key 正确 token → 放行', () => {
  withEnv({ FEISHU_API_TOKEN: 'correct-token' }, () => {
    let passed = false;
    const res = makeRes();
    apiAuth(makeReq('POST', { 'x-api-key': 'correct-token' }), res, () => { passed = true; });
    assert.strictEqual(passed, true);
  });
});

test('读操作默认放行（即使未配置 token）', () => {
  withEnv({ FEISHU_API_TOKEN: undefined, FEISHU_REQUIRE_AUTH_FOR_READS: undefined }, () => {
    let passed = false;
    const res = makeRes();
    apiAuth(makeReq('GET', {}), res, () => { passed = true; });
    assert.strictEqual(passed, true);
  });
});

test('FEISHU_REQUIRE_AUTH_FOR_READS=true 时读操作也需鉴权（fail-closed）', () => {
  withEnv({ FEISHU_API_TOKEN: undefined, FEISHU_REQUIRE_AUTH_FOR_READS: 'true' }, () => {
    const res = makeRes();
    apiAuth(makeReq('GET', {}), res, () => assert.fail('不应放行'));
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error.code, 'AUTH_NOT_CONFIGURED');
  });
});

test('FEISHU_REQUIRE_AUTH_FOR_READS=true 时读操作携带正确 token → 放行', () => {
  withEnv({ FEISHU_API_TOKEN: 'read-token', FEISHU_REQUIRE_AUTH_FOR_READS: 'true' }, () => {
    let passed = false;
    const res = makeRes();
    apiAuth(makeReq('GET', { authorization: 'Bearer read-token' }), res, () => { passed = true; });
    assert.strictEqual(passed, true);
  });
});

test('getApiToken: 读取环境变量并 trim', () => {
  withEnv({ FEISHU_API_TOKEN: '  spaced-token  ' }, () => {
    assert.strictEqual(getApiToken(), 'spaced-token');
  });
  withEnv({ FEISHU_API_TOKEN: undefined }, () => {
    assert.strictEqual(getApiToken(), '');
  });
});
