#!/usr/bin/env node
/**
 * 世界快照契约门禁（阶段三，2026-09-19）。
 *
 * 检查最近 N 个持久化世界快照的 contractCheck 与 entityVersions：
 *   - contractCheck.valid === false（含 bad_entity_version_* 等违约）
 *   - entityVersions 值非整数/负数（独立复核，不信任落库时的自检）
 *
 * 任一违约 → 退出 1（构建失败）。无 DB 连接时显式跳过（exit 0），
 * 供无库环境（纯静态 CI）通过；有库环境（本地/CI 服务容器）必须绿。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_NODE_MODULES = path.join(REPO_ROOT, 'ewoh-spark-app/node_modules');
const WINDOW = Number(process.env.EWOH_SNAPSHOT_CONTRACT_WINDOW || 5);

const DB_URL =
  process.env.EWOH_DATABASE_URL ||
  process.env.EWOH_PG_URL ||
  '';

if (!DB_URL) {
  console.log('[audit-world-snapshot-contract] SKIP：未提供 EWOH_DATABASE_URL/EWOH_PG_URL（无库环境跳过）');
  process.exit(0);
}

const { createRequire } = require('node:module');
const requireFromApp = createRequire(path.join(APP_NODE_MODULES, 'package.json'));
let postgres;
try {
  postgres = requireFromApp('postgres');
} catch (error) {
  console.error('[audit-world-snapshot-contract] FAIL：无法加载 postgres 驱动', error.message);
  process.exit(1);
}

// kind 注册表从 shared/identity.ts 的锁定清单直读（避免双源）。
const identitySource = fs.readFileSync(
  path.join(REPO_ROOT, 'ewoh-spark-app/shared/identity.ts'), 'utf8',
);
const kindsBlock = identitySource.slice(
  identitySource.indexOf('IDENTITY_KINDS = ['),
  identitySource.indexOf('] as const'),
);
const KINDS_FROM_SOURCE = new Set(
  [...kindsBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
);
const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$/;

(async () => {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      SELECT snapshot_version, snapshot_json
      FROM ewoh_world_state_snapshot
      ORDER BY created_at DESC
      LIMIT ${WINDOW}
    `;
    if (rows.length === 0) {
      console.log('[audit-world-snapshot-contract] PASS：库中暂无持久化快照');
      process.exit(0);
    }
    const failures = [];
    for (const row of rows) {
      const snap = row.snapshot_json ?? {};
      const cc = snap.contractCheck;
      if (cc && cc.valid === false) {
        failures.push(`${row.snapshot_version}: contractCheck ${JSON.stringify(cc.errors ?? []).slice(0, 160)}`);
      }
      // 独立复核 entityVersions（不信任落库自检）。
      const versions = snap.entityVersions ?? {};
      for (const [key, value] of Object.entries(versions)) {
        const kind = String(key).split(':')[0];
        if (!KINDS_FROM_SOURCE.has(kind)) {
          failures.push(`${row.snapshot_version}: 非规范实体键 ${key}（kind=${kind} 不在注册表）`);
          continue;
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          failures.push(`${row.snapshot_version}: 非法版本值 ${key}=${value}`);
        }
      }
    }
    if (failures.length > 0) {
      console.error('[audit-world-snapshot-contract] FAIL：世界快照契约违约 ——');
      for (const f of failures.slice(0, 20)) console.error('  -', f);
      if (failures.length > 20) console.error(`  … 共 ${failures.length} 条`);
      process.exit(1);
    }
    console.log(`[audit-world-snapshot-contract] PASS：最近 ${rows.length} 个快照契约全部合规`);
    process.exit(0);
  } catch (error) {
    console.error('[audit-world-snapshot-contract] FAIL：检查执行失败', error.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 3 });
  }
})();
