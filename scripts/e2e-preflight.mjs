#!/usr/bin/env node
/* EWOH 真实-PG E2E 运行前预检 (Task 14.4)。
 *
 * Release-gate 保证：真实 PostgreSQL E2E 套件（npm run test:e2e）绝不允许因
 * 环境缺失而「整包静默 SKIP」——若 PostgreSQL 不可达或套件未配置为真实运行，
 * 本预检在 test:e2e 之前响亮失败（exit 1），杜绝伪通过。
 *
 * 语义复用 resolveE2EConfig()（test/helpers/e2e-config.ts）：
 *   1. EWOH_E2E_RUNTIME_DATABASE_URL 已设置 → 使用之（CI 路径）；
 *   2. 未设置 → 探测 127.0.0.1:3101 的 standalone API 监听进程，从其环境
 *      读取 DATABASE_URL（本地桌面路径）；
 *   3. 两者皆无 → 这就是「整包 SKIP 的触发条件」→ 直接失败（不静默跳过）。
 *
 * 与 resolveE2EConfig() 的唯一区别：得到 URL 后本脚本还会真实连接一次
 * （select 1），断言 PostgreSQL 确实可达——环境变量存在但库不可达同样失败。
 *
 * 纯 CI 守门：本地开发若未设置 EWOH_E2E_RUNTIME_DATABASE_URL 且无 :3101
 * 监听，运行本脚本会失败——这正是 release gate 想要的；本地跑 E2E 请照常
 * 设置环境变量或启动 :3101 standalone API，套件本身的本地 SKIP 语义不变。
 *
 * Env:
 *   EWOH_E2E_RUNTIME_DATABASE_URL  运行时角色 PostgreSQL URL（CI 必设）
 *   EWOH_E2E_OWNER_DATABASE_URL    owner（superuser）URL，设置了则一并连通性预检
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

let postgres;
try {
  postgres = (await import('../ewoh-spark-app/node_modules/postgres/src/index.js')).default;
} catch {
  postgres = null;
}

/** 读取指定进程的 DATABASE_URL（与 e2e-config.ts readProcessEnvironment 同语义）。 */
function readProcessEnvironment(pid) {
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('ps', ['eww', '-p', pid], { encoding: 'utf8' });
      const match = output.match(/(?:^|\s)DATABASE_URL=(\S+)/);
      return match ? match[1] : null;
    }
    if (process.platform !== 'win32') {
      const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      for (const entry of environment.split('\0')) {
        if (entry.startsWith('DATABASE_URL=')) {
          return entry.slice('DATABASE_URL='.length);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** 探测 127.0.0.1:3101 监听进程的 DATABASE_URL（与 resolveE2EConfig 同语义）。 */
function readRuntimeDatabaseUrlFromPort3101() {
  try {
    const pid = execFileSync(
      'lsof',
      ['-nP', '-iTCP:3101', '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 5000 },
    )
      .trim()
      .split('\n')[0];
    if (!pid) return null;
    return readProcessEnvironment(pid);
  } catch {
    return null;
  }
}

async function main() {
  const envRuntimeUrl = process.env.EWOH_E2E_RUNTIME_DATABASE_URL;
  const runtimeDatabaseUrl = envRuntimeUrl !== undefined && envRuntimeUrl !== null
    ? envRuntimeUrl.trim()
    : readRuntimeDatabaseUrlFromPort3101();

  if (!runtimeDatabaseUrl) {
    console.error(
      '::error::E2E PREFLIGHT FAILED: 未找到运行时 PostgreSQL。EWOH_E2E_RUNTIME_DATABASE_URL ' +
        '未设置且 127.0.0.1:3101 无 standalone API 监听 —— 真实-PG E2E 套件将整包 SKIP，' +
        'release gate 拒绝静默通过。请在 CI 提供 PostgreSQL 并设置环境变量。',
    );
    return 1;
  }

  if (!postgres) {
    console.error('::error::E2E PREFLIGHT FAILED: postgres 驱动不可用（ewoh-spark-app/node_modules 未安装）。');
    return 1;
  }

  const targets = [['runtime', runtimeDatabaseUrl]];
  const ownerUrl = process.env.EWOH_E2E_OWNER_DATABASE_URL;
  if (ownerUrl) targets.push(['owner', ownerUrl]);

  for (const [role, targetUrl] of targets) {
    const sql = postgres(targetUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      const rows = await sql`select current_database() as db, current_user as usr`;
      console.log(`E2E PREFLIGHT OK (${role}): connected as ${rows[0].usr} to ${rows[0].db}`);
    } catch (error) {
      console.error(
        `::error::E2E PREFLIGHT FAILED (${role}): PostgreSQL 不可达 ${targetUrl}: ` +
          (error && (error.message || error)),
      );
      process.exitCode = 1;
    } finally {
      try { await sql.end(); } catch { /* ignore */ }
    }
  }

  if (process.exitCode !== 1) {
    console.log('E2E PREFLIGHT OK: 真实 PostgreSQL 可达且套件已配置为真实运行（不会整包 SKIP）');
  }
  return process.exitCode === 1 ? 1 : 0;
}

main().then((code) => { process.exitCode = code; });
