// server/auth.test.js — v1.1.0 D1：API 统一鉴权中间件测试（node:test，无第三方依赖）
// 覆盖：写操作 fail-closed、Bearer/X-API-Key 凭证、常量时间比较、读操作放行与收紧
// 运行：node --test test/auth.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { apiAuth, getApiToken, safeEqual, extractToken, isWriteMethod } = require('../server/auth');
const ratelimit = require('../server/ratelimit');

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

// R2-FSH-002：读操作默认不再放行，与写操作同一 fail-closed 鉴权
test('R2-FSH-002: 读操作默认 fail-closed（未配置 token → 503）', () => {
  withEnv({ FEISHU_API_TOKEN: undefined, FEISHU_REQUIRE_AUTH_FOR_READS: undefined }, () => {
    const res = makeRes();
    apiAuth(makeReq('GET', {}), res, () => assert.fail('不应放行'));
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error.code, 'AUTH_NOT_CONFIGURED');
  });
});

test('R2-FSH-002: 读操作默认需鉴权——错误 token → 401，正确 token → 放行', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'read-token', FEISHU_REQUIRE_AUTH_FOR_READS: undefined }, () => {
    const bad = makeRes();
    apiAuth(makeReq('GET', { authorization: 'Bearer wrong' }), bad, () => assert.fail('不应放行'));
    assert.strictEqual(bad.statusCode, 401);
    assert.strictEqual(bad.body.error.code, 'UNAUTHORIZED');

    let passed = false;
    const res = makeRes();
    apiAuth(makeReq('GET', { authorization: 'Bearer read-token' }), res, () => { passed = true; });
    assert.strictEqual(passed, true);
  });
  ratelimit.reset();
});

test('R2-FSH-002: 读鉴权失败连续达阈值 → 429（复用 recordFailure 限流）', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'read-token', FEISHU_REQUIRE_AUTH_FOR_READS: undefined, FEISHU_RATELIMIT_MAX_FAILURES: '3' }, () => {
    const wrong = makeReq('GET', { authorization: 'Bearer wrong' });
    for (let i = 0; i < 3; i += 1) {
      const res = makeRes();
      apiAuth(wrong, res, () => assert.fail('不应放行'));
      assert.strictEqual(res.statusCode, 401, `第 ${i + 1} 次失败应 401`);
    }
    const blocked = makeRes();
    apiAuth(makeReq('GET', { authorization: 'Bearer read-token' }), blocked, () => assert.fail('达阈值后不得放行'));
    assert.strictEqual(blocked.statusCode, 429);
    assert.strictEqual(blocked.body.error.code, 'RATE_LIMITED');
  });
  ratelimit.reset();
});

test('R2-FSH-002: FEISHU_REQUIRE_AUTH_FOR_READS=false 显式放宽——无凭证读放行', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'read-token', FEISHU_REQUIRE_AUTH_FOR_READS: 'false' }, () => {
    let passed = false;
    const res = makeRes();
    apiAuth(makeReq('GET', {}), res, () => { passed = true; });
    assert.strictEqual(passed, true);
  });
  ratelimit.reset();
});

test('R2-FSH-002: 放宽模式下错误 token 读仍 fail-closed 401', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'read-token', FEISHU_REQUIRE_AUTH_FOR_READS: 'false' }, () => {
    const res = makeRes();
    apiAuth(makeReq('GET', { authorization: 'Bearer wrong' }), res, () => assert.fail('携带错误凭证不得放行'));
    assert.strictEqual(res.statusCode, 401);
  });
  ratelimit.reset();
});

test('R2-FSH-002: 放宽模式下无凭证读达阈值 → 429（IP 级读限流）', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'read-token', FEISHU_REQUIRE_AUTH_FOR_READS: 'false', FEISHU_RATELIMIT_READ_MAX: '3' }, () => {
    for (let i = 0; i < 3; i += 1) {
      let passed = false;
      const res = makeRes();
      apiAuth(makeReq('GET', {}), res, () => { passed = true; });
      assert.strictEqual(passed, true, `第 ${i + 1} 次无凭证读应放行`);
    }
    const blocked = makeRes();
    apiAuth(makeReq('GET', {}), blocked, () => assert.fail('读限流达阈值后不得放行'));
    assert.strictEqual(blocked.statusCode, 429);
    assert.strictEqual(blocked.body.error.code, 'RATE_LIMITED');
  });
  ratelimit.reset();
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

// ---- FS-010：写操作 IP+token 失败计数限流 ----

test('FS-010: 连续写鉴权失败达阈值 → 429 RATE_LIMITED，成功后解除', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'correct-token', FEISHU_RATELIMIT_MAX_FAILURES: '3' }, () => {
    const wrong = makeReq('POST', { authorization: 'Bearer wrong' });
    // 前 3 次失败 → 401
    for (let i = 0; i < 3; i += 1) {
      const res = makeRes();
      apiAuth(wrong, res, () => assert.fail('不应放行'));
      assert.strictEqual(res.statusCode, 401, `第 ${i + 1} 次失败应 401`);
    }
    // 第 4 次（无论 token 对错）→ 429
    const blocked = makeRes();
    apiAuth(makeReq('POST', { authorization: 'Bearer correct-token' }), blocked, () => assert.fail('达阈值后不得放行'));
    assert.strictEqual(blocked.statusCode, 429);
    assert.strictEqual(blocked.body.error.code, 'RATE_LIMITED');
  });
  ratelimit.reset();
});

test('FS-010: 鉴权成功清除计数（合法客户端不受影响）', () => {
  ratelimit.reset();
  withEnv({ FEISHU_API_TOKEN: 'correct-token', FEISHU_RATELIMIT_MAX_FAILURES: '3' }, () => {
    // 2 次失败（未达阈值 3）
    for (let i = 0; i < 2; i += 1) {
      const res = makeRes();
      apiAuth(makeReq('POST', { authorization: 'Bearer wrong' }), res, () => assert.fail('不应放行'));
      assert.strictEqual(res.statusCode, 401);
    }
    // 成功一次 → 计数清零
    let passed = false;
    const okRes = makeRes();
    apiAuth(makeReq('POST', { authorization: 'Bearer correct-token' }), okRes, () => { passed = true; });
    assert.strictEqual(passed, true);
    // 再失败 2 次仍不至于触发 429（计数已重置）
    for (let i = 0; i < 2; i += 1) {
      const res = makeRes();
      apiAuth(makeReq('POST', { authorization: 'Bearer wrong' }), res, () => assert.fail('不应放行'));
      assert.strictEqual(res.statusCode, 401, `清零后第 ${i + 1} 次失败应仍为 401 而非 429`);
    }
  });
  ratelimit.reset();
});

test('FS-010: ratelimit key 不含明文 token', () => {
  const k = ratelimit.key('api', '1.2.3.4', 'secret-token-value');
  assert.ok(!k.includes('secret-token-value'), 'key 中不得出现明文 token');
  assert.match(k, /^api\|1\.2\.3\.4\|[0-9a-f]{16}$/);
});
