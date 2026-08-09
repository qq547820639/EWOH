// C1 补测（2026-08-09）：FEISHU_BASE_TOKEN 环境变量覆盖 + 空 token fail 路径
// 覆盖（真实 feishu.js + 假 lark-cli 可执行脚本，不开真实飞书）：
//   - FEISHU_BASE_TOKEN 设置时：base 命令使用环境变量 token（优先于配置），不传空参数
//   - 无 FEISHU_BASE_TOKEN 且无配置 base_token：直接失败（{ ok:false, error:'invalid args' }），不启动子进程
// 运行：node --test test/base-token.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 应用目录（测试从 ewoh-feishu-app 下运行）
const APP_DIR = path.resolve(__dirname, '..');
const FEISHU_PATH = require.resolve('../server/feishu');
const CONFIG_PATH = path.join(APP_DIR, 'feishu-config.json');

// 在临时目录写一个假的 lark-cli 可执行脚本：
// - 把收到的 argv 追加写入 FAKE_LARK_LOG 指定文件（供断言 token 等参数）
// - stdout 输出 JSON 信封 { ok:true, data:{ record_id:'REC-FAKE' } }
function makeFakeLarkCli(dir) {
  const scriptPath = path.join(dir, 'fake-lark-cli.js');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      "const logPath = process.env.FAKE_LARK_LOG;",
      'if (logPath) {',
      "  fs.appendFileSync(logPath, process.argv.slice(2).join('\\n') + '\\n');",
      '}',
      "process.stdout.write(JSON.stringify({ ok: true, data: { record_id: 'REC-FAKE' } }));",
      '',
    ].join('\n')
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-token-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  return dir;
}

// 还原模块级 config 缓存：删除 require.cache 强制重载 feishu.js
function reloadFeishu() {
  delete require.cache[FEISHU_PATH];
  return require('../server/feishu');
}

test('baseRecordCreate: FEISHU_BASE_TOKEN 环境变量优先于配置，命令参数携带 env token', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeFakeLarkCli(dir);
  const logPath = path.join(dir, 'args.log');

  // LARK_CLI 必须在 require feishu 前设置（模块加载时读取 LARK_BIN）
  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  process.env.FEISHU_BASE_TOKEN = 'env-base-token-123';
  // 清掉可能残留的 env（如 CI 注入），保证 token 断言只针对本次设置
  delete process.env.FEISHU_VERIFICATION_TOKEN;

  try {
    const feishu = reloadFeishu();
    const r = await feishu.baseRecordCreate('tbl_test', { '设备ID': 'EXO-001' });
    assert.strictEqual(r.ok, true, '带 env token 应正常走 lark-cli');
    assert.strictEqual(r.record_id, 'REC-FAKE');

    const args = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.ok(args.includes('--base-token'), 'lark-cli 应收到 --base-token');
    const tokenIdx = args.indexOf('--base-token');
    assert.strictEqual(
      args[tokenIdx + 1],
      'env-base-token-123',
      '应使用 FEISHU_BASE_TOKEN 环境变量值，而非配置/空值'
    );
    assert.ok(args.includes('tbl_test'), '应传递 table-id');
    assert.ok(!args.includes('undefined') && !args.includes('null'), '不得传空 token 占位');
  } finally {
    delete process.env.FEISHU_BASE_TOKEN;
    delete process.env.FAKE_LARK_LOG;
  }
});

test('baseRecordCreate: 无 FEISHU_BASE_TOKEN 且无配置 base_token → 直接失败，不启动子进程', async (t) => {
  const dir = tmpDir(t);
  const fakeCli = makeFakeLarkCli(dir);
  const logPath = path.join(dir, 'args2.log');

  process.env.LARK_CLI = fakeCli;
  process.env.FAKE_LARK_LOG = logPath;
  delete process.env.FEISHU_BASE_TOKEN;

  // 临时移走应用目录的 feishu-config.json，模拟"无任何 base_token 来源"。
  // 该文件为本地运行时配置（.gitignore 已忽略），测试用 try/finally 保证恢复。
  // 注意：仓库在 /Volumes 而 os.tmpdir 在 /var（跨设备），renameSync 会 EXDEV，
  // 故用 copyFileSync + unlinkSync。
  const configExists = fs.existsSync(CONFIG_PATH);
  const backupPath = path.join(dir, 'feishu-config.json.bak');
  if (configExists) {
    fs.copyFileSync(CONFIG_PATH, backupPath);
    fs.unlinkSync(CONFIG_PATH);
  }

  try {
    const feishu = reloadFeishu();
    const r = await feishu.baseRecordCreate('tbl_test', { '设备ID': 'EXO-001' });
    assert.strictEqual(r.ok, false, '无 token 应失败');
    assert.strictEqual(r.error, 'invalid args', '应返回 invalid args（不传空参数）');
    // 不得启动 lark-cli 子进程
    assert.strictEqual(
      fs.existsSync(logPath),
      false,
      '空 token 时不应调用 lark-cli（不传空参数）'
    );
  } finally {
    if (configExists && !fs.existsSync(CONFIG_PATH)) {
      fs.copyFileSync(backupPath, CONFIG_PATH);
    }
    delete process.env.FAKE_LARK_LOG;
  }
});
