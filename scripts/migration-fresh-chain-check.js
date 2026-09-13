#!/usr/bin/env node
'use strict';

/**
 * 全新库迁移链 + 全量 verify 检查（NO-53a 工程化补强）。
 *
 * 为什么需要它：`make audit-regression-gates` 的主线 5（`migration-fresh-install-check.sh`）
 * 默认只做**静态顺序**校验；真实空库模式需要主机装 `psql`。结果是"迁移链在全新库上到底
 * 能不能装、verify 能不能过"长期没有可复现的跑法——第 53 轮用仓库自带的 node 迁移 runner
 * 在全新库上跑了一遍，立刻暴露 12 项历史 verify 失败（类型不匹配、pg_policies 列名、
 * uuid 字面量、RAISE 占位符数量、psql 专属语法……）。这里把这条跑法固化成脚本：
 *
 *   1. 建一个临时库（默认 `ewoh_chain_check_<pid>`，结束即删）；
 *   2. `standalone-chain.js --apply` 顺序执行全部迁移（必须 100% 成功）；
 *   3. 逐条执行**全部** `--verify-standalone*` 命令，逐项记录 PASS/FAIL；
 *   4. 与基线 `db/migration-verify-baseline.txt` 比对：
 *      · 新增失败（回归）→ 非零退出；
 *      · 基线里已修好的项 → 提示从基线删除（不算失败，避免"基线变成永久借口"）。
 *
 * 用法：
 *   EWOH_PG_URL=postgresql://ewoh_owner:***@127.0.0.1:55432/ewoh \
 *     node scripts/migration-fresh-chain-check.js [--keep] [--baseline <file>]
 *
 * 注意：需要 owner（建库/DDL）权限；`EWOH_API_DATABASE_PASSWORD` 需与迁移建运行角色时一致
 * （缺省会失败在 standalone_003，这是**如实报错**而不是跳过）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));
const postgres = requireFromApp('postgres');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const baselineArg = args.indexOf('--baseline');
const baselineFile =
  baselineArg >= 0 && args[baselineArg + 1]
    ? path.resolve(args[baselineArg + 1])
    : path.join(root, 'db/migration-verify-baseline.txt');

const ownerUrl = process.env.EWOH_PG_URL || process.env.EWOH_DATABASE_URL || '';
if (!ownerUrl) {
  console.error('缺少 EWOH_PG_URL（或 EWOH_DATABASE_URL）：需要 owner 权限连接串');
  process.exit(2);
}

/** 把连接串切到 maintenance 库（建/删临时库用）与目标临时库。 */
function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function readBaseline() {
  if (!fs.existsSync(baselineFile)) return new Set();
  return new Set(
    fs
      .readFileSync(baselineFile, 'utf8')
      .split('\n')
      // 基线行允许行尾注释（`--verify-xxx   # 原因`）：只取命令名，注释是给人看的理由。
      .map((line) => line.split('#')[0].trim())
      .filter((line) => line !== '' && line.startsWith('--verify')),
  );
}

function runChain(action, env) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'db/runner/standalone-chain.js'), `--${action}`],
    { cwd: root, env, encoding: 'utf8' },
  );
  return {
    ok: result.status === 0,
    tail: `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-6).join('\n'),
  };
}

async function main() {
  const dbName = `ewoh_chain_check_${process.pid}`;
  const adminUrl = withDatabase(ownerUrl, 'postgres');
  const freshUrl = withDatabase(ownerUrl, dbName);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });

  console.log(`[fresh-chain] 临时库 ${dbName}`);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
  } catch (error) {
    console.error(`[fresh-chain] 无法创建临时库（需要 owner/建库权限）：${error.message}`);
    await admin.end().catch(() => undefined);
    process.exit(2);
  }

  const env = { ...process.env, EWOH_DATABASE_URL: freshUrl, EWOH_ALLOW_DDL: '1' };
  let exitCode = 0;
  try {
    const apply = runChain('apply', env);
    console.log(`[fresh-chain] apply ${apply.ok ? 'PASS' : 'FAIL'}`);
    if (!apply.ok) {
      console.error(apply.tail);
      exitCode = 1;
    } else {
      const { EXECUTE_COMMANDS } = requireFromApp(path.join(root, 'db/runner/run_migrations.js'));
      const verifyCommands = [...EXECUTE_COMMANDS].filter((c) => c.startsWith('--verify-standalone'));
      const baseline = readBaseline();
      const failures = [];
      for (const command of verifyCommands) {
        const result = spawnSync(
          process.execPath,
          [path.join(root, 'db/runner/run_migrations.js'), command],
          { cwd: root, env, encoding: 'utf8' },
        );
        if (result.status !== 0) {
          const lines = `${result.stderr || ''}`.split('\n').filter((l) => l.trim() !== '');
          failures.push({ command, detail: lines[lines.length - 1] || `exit ${result.status}` });
        }
      }
      const failed = new Set(failures.map((f) => f.command));
      const regressions = failures.filter((f) => !baseline.has(f.command));
      const fixed = [...baseline].filter((c) => !failed.has(c));
      console.log(
        `[fresh-chain] verify ${verifyCommands.length - failures.length}/${verifyCommands.length} PASS`
        + `（已知基线失败 ${baseline.size}）`,
      );
      for (const f of failures) {
        const known = baseline.has(f.command) ? 'BASELINE' : 'REGRESSION';
        console.log(`  ${known}  ${f.command} — ${f.detail}`);
      }
      if (fixed.length > 0) {
        console.log(`[fresh-chain] 基线里已有 ${fixed.length} 项修好，请从 ${path.relative(root, baselineFile)} 删除：`);
        for (const c of fixed) console.log(`  FIXED  ${c}`);
      }
      if (regressions.length > 0) {
        console.error(`[fresh-chain] FAIL：${regressions.length} 项新增 verify 失败（不在基线内）`);
        exitCode = 1;
      } else {
        console.log('[fresh-chain] OK：没有超出基线的 verify 失败');
      }
    }
  } finally {
    if (!keep) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    } else {
      console.log(`[fresh-chain] --keep：保留 ${dbName}`);
    }
    await admin.end().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[fresh-chain] 脚本异常:', error);
  process.exit(2);
});
