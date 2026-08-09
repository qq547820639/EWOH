// P2 收尾（QA 两轮建议的覆盖缺口）：lark-cli 异步化提交测试
// 覆盖（真实 feishu.js + 假 lark-cli 可执行脚本，不开真实飞书）：
//   1. 并发上限：8 个并行调用，假 CLI 记录并发峰值 → 峰值 ≤ MAX_CONCURRENT(4)
//   2. 超时：假 CLI sleep 25s → 20s 硬超时 SIGTERM 回收 → { ok:false, error:'lark-cli timeout (>20s)' }
//   3. 熔断：假 CLI 恒失败 → 连续 5 次后第 6 次 fast-fail（子进程不启动）
//   4. user→bot 重试：首次 user 失败、bot 成功 → 恰好 2 次子进程调用且返回 bot 数据
// 运行：node --test test/lark-cli-async.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const FEISHU_PATH = require.resolve('../server/feishu');

// 还原模块级状态：删除 require.cache 强制重载 feishu.js（计数器/配置均为全新）
function reloadFeishu() {
  delete require.cache[FEISHU_PATH];
  return require('../server/feishu');
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-lark-'));
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

// 并发探针 CLI：启动即追加 start:<pid>，延时后追加 end:<pid>（记录真实并发峰值）
function makeConcurrencyCli(dir) {
  return makeScript(dir, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_LARK_LOG;",
    "const pid = process.pid;",
    "fs.appendFileSync(log, 'start:' + pid + '\\n');",
    'setTimeout(() => {',
    "  fs.appendFileSync(log, 'end:' + pid + '\\n');",
    "  process.stdout.write(JSON.stringify({ ok: true, data: { pid: String(pid) } }));",
    '}, 300);',
  ]);
}

// 恒失败 CLI：记录 argv 后 exit(1)
function makeAlwaysFailCli(dir) {
  return makeScript(dir, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_LARK_LOG;",
    "if (log) fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');",
    "process.stderr.write('fake lark-cli always fails');",
    'process.exit(1);',
  ]);
}

// 慢 CLI：sleep 25s 后才输出（用于 20s 硬超时）
function makeSlowCli(dir) {
  return makeScript(dir, [
    'setTimeout(() => {',
    "  process.stdout.write(JSON.stringify({ ok: true, data: { slow: true } }));",
    '}, 25000);',
  ]);
}

// user 失败 / bot 成功 CLI（按 argv 中 --as 区分身份）
function makeUserFailBotOkCli(dir) {
  return makeScript(dir, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_LARK_LOG;",
    "if (log) fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');",
    "const idx = process.argv.indexOf('--as');",
    "const as = process.argv[idx + 1];",
    "if (as === 'user') {",
    "  process.stderr.write('user identity denied');",
    '  process.exit(1);',
    '}',
    "process.stdout.write(JSON.stringify({ ok: true, data: { source: 'bot' } }));",
  ]);
}

// 从日志计算并发峰值：逐行统计未配对的 start 数量最大值
function concurrencyPeak(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  let active = 0;
  let peak = 0;
  for (const line of lines) {
    if (line.startsWith('start:')) {
      active += 1;
      peak = Math.max(peak, active);
    } else if (line.startsWith('end:')) {
      active -= 1;
    }
  }
  return { peak, starts: lines.filter((l) => l.startsWith('start:')).length, ends: lines.filter((l) => l.startsWith('end:')).length, active };
}

test('larkCli: 并发上限 MAX_CONCURRENT=4（8 个并行调用峰值 ≤4，全部成功）', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeConcurrencyCli(dir);
  const logPath = path.join(dir, 'conc.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  try {
    const feishu = reloadFeishu();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => feishu.larkCli(['im', '+messages-send']))
    );

    assert.strictEqual(results.length, 8);
    assert.ok(results.every((r) => r.ok === true), '全部 8 个调用应成功');
    const stat = concurrencyPeak(logPath);
    assert.strictEqual(stat.starts, 8, '8 次子进程全部启动');
    assert.strictEqual(stat.ends, 8, '8 次子进程全部结束');
    assert.strictEqual(stat.active, 0, '结束后并发归零');
    assert.ok(stat.peak <= 4, `并发峰值应 ≤4（信号量上限），实际 ${stat.peak}`);
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
  }
});

test('larkCli: 超时（子进程 25s / 硬超时 20s SIGTERM 回收）→ timeout 错误', { timeout: 45000 }, async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeSlowCli(dir);

  process.env.LARK_CLI = fakeCli;
  try {
    const feishu = reloadFeishu();
    const started = Date.now();
    const r = await feishu.larkCli(['im', '+messages-send']);
    const elapsed = Date.now() - started;

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'lark-cli timeout (>20s)');
    assert.ok(elapsed >= 19000 && elapsed < 40000, `应在 ~20s 返回（实际 ${elapsed}ms）`);
  } finally {
    delete process.env.LARK_CLI;
  }
});

test('larkCli: 连续失败 ≥5 次触发熔断，第 6 次 fast-fail 不启动子进程', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeAlwaysFailCli(dir);
  const logPath = path.join(dir, 'cb.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  try {
    const feishu = reloadFeishu();
    // 缩短冷却期避免依赖真实 30s（熔断打开判定走同一状态机，不影响语义）
    feishu.__test.setBreakerCooldownMs(5000);

    for (let i = 0; i < 5; i += 1) {
      const r = await feishu.larkCli(['im', '+messages-send']);
      assert.strictEqual(r.ok, false, `第 ${i + 1} 次应失败`);
    }

    const linesBefore = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.strictEqual(linesBefore, 5, '前 5 次均启动子进程');

    const r6 = await feishu.larkCli(['im', '+messages-send']);
    assert.strictEqual(r6.ok, false);
    assert.match(r6.error, /circuit breaker open/, '第 6 次应快速失败（熔断打开）');

    const linesAfter = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.strictEqual(linesAfter, 5, '第 6 次不得启动子进程');
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
  }
});

test('larkCliRetry: 首次 user 失败、bot 成功 → 恰好 2 次子进程调用且返回 bot 数据', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeUserFailBotOkCli(dir);
  const logPath = path.join(dir, 'retry.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  try {
    const feishu = reloadFeishu();
    const r = await feishu.larkCliRetry(['im', '+messages-send']);

    assert.strictEqual(r.ok, true, '重试后应成功');
    assert.strictEqual(r.data.source, 'bot', '应返回 bot 身份的数据');

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, '恰好 2 次子进程调用（user 失败 + bot 重试成功）');
    assert.ok(lines[0].includes('--as user'), '首次以 user 身份调用');
    assert.ok(lines[1].includes('--as bot'), '重试以 bot 身份调用');
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
  }
});
