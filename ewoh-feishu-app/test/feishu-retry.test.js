// P2-10 补测：有界重试策略（指数退避 + 全抖动 + 失败分类）
// 覆盖（真实 feishu.js + 假 lark-cli 可执行脚本，不开真实飞书）：
//   1. 可重试失败（进程级退出 1）→ 触发重试；前 2 次失败、第 3 次成功 → 恰好 3 次子进程调用，
//      身份交替 user→bot→user，返回第 3 次调用数据
//   2. 业务错误（CLI JSON { ok:false, error:{ type:'authorization', code:99991672, ... } }）
//      → 不重试，恰好 1 次子进程调用
//   3. 最大重试次数边界：恒失败 + maxRetries=2 → 恰好 1+2=3 次子进程调用，最终仍失败
//   4. 退避注入：__test.setRetryDelayFn 收到 attempt 下标 [0,1,...]，测试无需真实等待（保持快速）
// 运行：node --test test/feishu-retry.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FEISHU_PATH = require.resolve('../server/feishu');

// 还原模块级状态：删除 require.cache 强制重载 feishu.js（配置均为全新）
function reloadFeishu() {
  delete require.cache[FEISHU_PATH];
  return require('../server/feishu');
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-retry-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  return dir;
}

// 写一个假 lark-cli 可执行脚本（body 为 JS 语句数组，join 成脚本）
function makeScript(dir, body) {
  const scriptPath = path.join(dir, 'fake-lark-cli.js');
  fs.writeFileSync(
    scriptPath,
    ['#!/usr/bin/env node', "'use strict';", ...body].join('\n')
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// 前 failTimes 次失败（stderr + exit 1），之后成功（stdout JSON ok:true）
function makeFailThenSucceedCli(dir, failTimes) {
  return makeScript(dir, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_LARK_LOG;",
    "const failTimes = Number(process.env.FAKE_FAIL_TIMES || 0);",
    "const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0;",
    "if (log) fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');",
    'if (n < failTimes) {',
    "  process.stderr.write('fake lark-cli transient failure');",
    '  process.exit(1);',
    '}',
    "process.stdout.write(JSON.stringify({ ok: true, data: { source: 'ok#' + (n + 1) } }));",
  ]);
}

// 恒失败：stderr + exit 1
function makeAlwaysFailCli(dir) {
  return makeScript(dir, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_LARK_LOG;",
    "if (log) fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');",
    "process.stderr.write('fake lark-cli always fails');",
    'process.exit(1);',
  ]);
}

// 业务错误：stdout JSON 信封 { ok:false, error:{ type:'authorization', code:99991672, message } } + exit 1
// （与真实 lark-cli 授权错误信封形状一致，见 lark-cli 实测输出）
function makeBusinessErrorCli(dir) {
  return makeScript(dir, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_LARK_LOG;",
    "if (log) fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');",
    "const envelope = { ok: false, identity: 'bot', error: {",
    "  type: 'authorization', subtype: 'app_scope_not_applied', code: 99991672,",
    "  message: 'access denied: app has not applied for the required scope(s)',",
    '} };',
    'process.stdout.write(JSON.stringify(envelope));',
    'process.exit(1);',
  ]);
}

function countLines(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
}

function readArgs(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

test('larkCliRetry: 可重试失败触发重试（前 2 次失败、第 3 次成功），身份 user→bot→user', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeFailThenSucceedCli(dir, 2);
  const logPath = path.join(dir, 'retry.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  process.env.FAKE_FAIL_TIMES = '2';
  try {
    const feishu = reloadFeishu();
    // 注入零延迟退避：重试逻辑照常执行（attempt 下标仍被传递），但不等待真实时间
    let attemptsSeen = [];
    feishu.__test.setRetryDelayFn((attemptIndex) => {
      attemptsSeen.push(attemptIndex);
      return 0;
    });

    const r = await feishu.larkCliRetry(['im', '+messages-send']);

    assert.strictEqual(r.ok, true, '重试后应成功');
    assert.strictEqual(r.data.source, 'ok#3', '应返回第 3 次调用的数据');

    const args = readArgs(logPath);
    assert.strictEqual(args.length, 3, '恰好 3 次子进程调用（1 次 + 2 次重试）');
    assert.ok(args[0].includes('--as user'), '第 1 次以 user 身份');
    assert.ok(args[1].includes('--as bot'), '第 1 次重试以 bot 身份（兼容原 user→bot 兜底）');
    assert.ok(args[2].includes('--as user'), '第 2 次重试回到 user 身份');
    assert.deepStrictEqual(attemptsSeen, [0, 1], '退避函数应收到 attempt 下标 0,1（指数退避阶段）');
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
    delete process.env.FAKE_FAIL_TIMES;
  }
});

test('larkCliRetry: 业务错误（authorization 类型）不重试 → 恰好 1 次子进程调用', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeBusinessErrorCli(dir);
  const logPath = path.join(dir, 'biz.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  try {
    const feishu = reloadFeishu();
    feishu.__test.setRetryDelayFn(() => 0);

    const r = await feishu.larkCliRetry(['base', '+record-search']);

    assert.strictEqual(r.ok, false, '业务错误不应被重试救回');
    assert.strictEqual(typeof r.error, 'object', '应返回 CLI 结构化错误对象');
    assert.strictEqual(r.error.type, 'authorization', '错误类型为 authorization');
    assert.strictEqual(countLines(logPath), 1, '业务错误不得触发重试（仅 1 次子进程调用）');
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
  }
});

test('larkCliRetry: 最大重试次数边界（maxRetries=2，恒失败 → 恰好 1+2=3 次调用）', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeAlwaysFailCli(dir);
  const logPath = path.join(dir, 'max.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  try {
    const feishu = reloadFeishu();
    feishu.__test.setMaxRetries(2);
    feishu.__test.setRetryDelayFn(() => 0);

    const r = await feishu.larkCliRetry(['im', '+messages-send']);

    assert.strictEqual(r.ok, false, '恒失败最终仍失败');
    assert.strictEqual(countLines(logPath), 3, '1 次 + maxRetries(2) 次 = 恰好 3 次子进程调用');
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
  }
});

test('isRetryableError: 失败分类单元断言（可重试 vs 业务错误）', () => {
  const feishu = reloadFeishu();
  const retryable = [
    { ok: false, error: 'lark-cli timeout (>20s)' },            // 超时（进程级）
    { ok: false, error: 'spawn lark-cli ENOENT' },               // 启动失败
    { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:443' },  // 网络类
    { ok: false, error: { type: 'network', message: 'temporary network error' } }, // 结构化网络类型
    { ok: false, error: 503 },                                   // 可重试 HTTP 码
    { ok: false, error: { code: 429, message: 'rate limited' } },// 可重试 HTTP 码（对象形式）
    { ok: false, error: 'unknown transient glitch' },            // 未知自由文本 → 保守重试
  ];
  for (const r of retryable) {
    assert.strictEqual(feishu.isRetryableError(r), true, `应可重试: ${JSON.stringify(r.error)}`);
  }

  const notRetryable = [
    { ok: false, error: { type: 'authorization', code: 99991672, message: 'access denied: scope not applied' } },
    { ok: false, error: { type: 'validation', subtype: 'invalid_argument', message: 'specify at least one of --chat-id or --user-id' } },
    { ok: false, error: 'invalid token' },                        // 业务关键词
    { ok: false, error: 'permission denied' },                    // 业务关键词
    { ok: false, error: 403 },                                    // 非重试 HTTP 码
    { ok: false, error: { code: 99991672, message: 'access denied: app has not applied for scope' } }, // 飞书业务码
    { ok: false, error: 'lark-cli queue full (200 pending)' },    // 队列已满 → 不重试
    { ok: false, error: 'circuit breaker open (retry in 30s)' },  // 熔断中 → 不重试
  ];
  for (const r of notRetryable) {
    assert.strictEqual(feishu.isRetryableError(r), false, `不应重试: ${JSON.stringify(r.error)}`);
  }
  assert.strictEqual(feishu.isRetryableError({ ok: true }), false, '成功结果不重试');
});
