// P2-10 补测：lark-cli 队列上限（FEISHU_CLI_MAX_QUEUE）—— 排队任务超限立即拒绝
// 覆盖（真实 feishu.js + 假 lark-cli 可执行脚本，不开真实飞书）：
//   - 并发槽位占满 + 排队达到上限后，新任务立即拒绝（{ ok:false, error:'lark-cli queue full ...' }）
//   - 被拒绝的任务不启动子进程，且不计入熔断统计
// 运行：node --test test/queue-limit.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FEISHU_PATH = require.resolve('../server/feishu');

function reloadFeishu() {
  delete require.cache[FEISHU_PATH];
  return require('../server/feishu');
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-queue-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  return dir;
}

// 慢 CLI：启动即记录 start，延时 300ms 后输出成功 JSON（占住并发槽位）
function makeSlowCli(dir) {
  const scriptPath = path.join(dir, 'slow-lark-cli.js');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      "const log = process.env.FAKE_LARK_LOG;",
      "if (log) fs.appendFileSync(log, 'start\\n');",
      'setTimeout(() => {',
      "  process.stdout.write(JSON.stringify({ ok: true, data: { pid: String(process.pid) } }));",
      '}, 300);',
    ].join('\n')
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function countLines(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
}

test('larkCli: 队列超限立即拒绝（MAX_CONCURRENT=1, MAX_QUEUE=2）', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeSlowCli(dir);
  const logPath = path.join(dir, 'queue.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  try {
    const feishu = reloadFeishu();
    feishu.__test.setMaxConcurrent(1);
    feishu.__test.setMaxQueue(2);

    // 同时发起 4 个调用：第 1 个占住唯一槽位，第 2、3 个排队，第 4 个应被立即拒绝
    const results = await Promise.all(
      Array.from({ length: 4 }, () => feishu.larkCli(['im', '+messages-send']))
    );

    const rejected = results.filter((r) => !r.ok && /queue full/.test(r.error));
    const ok = results.filter((r) => r.ok);
    assert.strictEqual(rejected.length, 1, '应恰好 1 个调用因队列满被拒绝');
    assert.match(rejected[0].error, /lark-cli queue full \(2 pending, 1 running\)/);
    assert.strictEqual(ok.length, 3, '其余 3 个调用（1 执行 + 2 排队）最终成功');

    // 被拒绝的调用不得启动子进程：总启动次数 = 3（1 执行 + 2 排队最终执行）
    assert.strictEqual(countLines(logPath), 3, '被拒绝的调用不得启动子进程');

    // 队列满失败不计入熔断统计（从未启动子进程）
    const state = feishu.__test.getState();
    assert.strictEqual(state.consecutiveCliFailures, 0, '队列拒绝不应计入熔断失败计数');
    assert.strictEqual(state.queuedCliJobs, 0, '全部结束后队列应清空');
    assert.strictEqual(state.activeCliCalls, 0, '全部结束后并发应归零');
  } finally {
    delete process.env.LARK_CLI;
    delete process.env.FAKE_LARK_LOG;
  }
});
