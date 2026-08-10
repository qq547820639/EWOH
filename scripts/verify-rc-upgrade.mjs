#!/usr/bin/env node
/* EWOH PostgreSQL 上一 RC → current main 迁移升级门禁 (Task 14.3).
 *
 * 目标：证明「发布快照（previous-RC）时代的数据库」可以无损升级到当前 main 的
 * 迁移链终点，且新迁移（standalone_030 / standalone_031）引入的列/表与既有
 * 数据语义向后兼容。
 *
 * 精确解释（previous-RC 状态如何确定）：
 *   仓库 release/ 下的发布快照（ewoh-0.6.0-rc1..rc4）不携带完整 SQL DDL 包，
 *   只含 seed + openapi + README。但它们各自打包了一份 db/runner/run_migrations.js，
 *   其中注册的 standalone 迁移命令即为该 RC「实际能构建的数据库状态」。
 *   经核对：rc1..rc4 的 runner 全部只注册到 standalone_003_runtime_role
 *   （--apply-standalone / --apply-standalone-users / --apply-standalone-runtime-role
 *   以及三个 seed），不含任何 standalone_004+ 迁移。
 *
 *   因此本门禁的「previous-RC 数据库状态」= 应用 RC 时代注册的整条 standalone 链
 *   （standalone_001 全量 51 张托管表 → standalone_002 用户 → standalone_003 运行时
 *   角色 + 对应 seed），再在其上应用「剩余」的当前 main 迁移链
 *   （standalone_004..standalone_031，按 standalone.yml / soak-load-gate 的 canonical
 *   顺序：004 → 005 → 017 → 006..016 → 018..028 → 029..031）。
 *
 *   RC 截点（cutoff）在运行时从 release/ 快照动态解析：读取各 RC 打包的
 *   run_migrations.js 中引用的最大 standalone 编号；当前仓库解析结果为 3。
 *   若 release/ 缺失或无法解析（例如在非发布仓库上运行），cutoff 回退为 0，
 *   即基线只剩 base 001/002（standalone 视角由 standalone_001 自包含承载），
 *   测试降级为「从基线直升全链」，语义仍成立（下一最佳忠实测试）。
 *
 * 门禁内容：
 *   G1  RC 基线构建 —— 应用 RC 时代链（standalone_001..cutoff + seeds），
 *       并运行 --verify-standalone 证明基线是合法的已发布状态。
 *   G2  RC → main 升级 —— 在基线上按 canonical 顺序应用剩余迁移
 *       （standalone_(cutoff+1)..031），随后运行全部存在 verify 的迁移 verify
 *       （001/004..006/009..031），任一失败即整体失败。
 *   G3  幂等重放 —— 对 standalone_030/031 重复应用（ADD COLUMN IF NOT EXISTS /
 *       CREATE TABLE IF NOT EXISTS）并复跑 verify，证明新迁移可重入。
 *   G4  向后兼容语义（030/031 新增物与既有数据的兼容性）：
 *       - ewoh_schedule_plan / ewoh_scheduling_run 的 solver_status、
 *         fallback_reason 均为 nullable 且无默认值（存量行保持 NULL）；
 *       - ewoh_snapshot_version_counter 存在，day 为 PRIMARY KEY，
 *         last_seq NOT NULL DEFAULT 0，service_role 具备四类 DML 授权。
 *   G5  契约对齐 —— db/contracts/schema-manifest.yaml 可解析，且由升级迁移
 *       引入的 5 张关键表（ewoh_schedule_plan / ewoh_scheduling_run /
 *       ewoh_scheduling_constraint / ewoh_outbox / ewoh_resource_locks）
 *       既在 manifest 中声明、又真实存在于升级后的数据库中。
 *
 * 失败语义（与 verify-migration-prod.mjs 的区别，Task 14.3 显式要求）：
 *   本门禁是 release gate：任何迁移/verify/断言失败 → exit 1（响亮失败）；
 *   环境缺失（未设 EWOH_DATABASE_URL / 驱动缺失 / PG 不可达）→ 打印
 *   BLOCKED_BY_ENVIRONMENT 后同样 exit 1（绝不静默 PASS，绝不整包 SKIP）。
 *   仅当全部门禁通过才 exit 0。
 *
 * Env:
 *   EWOH_DATABASE_URL  (required) 一次性 PostgreSQL URL（superuser，脚本会重建 public）。
 *   EWOH_ALLOW_DDL / EWOH_ALLOW_DESTRUCTIVE_ROLLBACK 由本脚本自行置 1。
 *
 * 用法：
 *   node scripts/verify-rc-upgrade.mjs            # 真实执行（需 PG）
 *   node scripts/verify-rc-upgrade.mjs --dry-run  # 无 PG 也安全：打印计划并校验
 *                                                 # 命令在 run_migrations.js 均已注册
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'ewoh-spark-app');
const runner = path.join(root, 'db', 'runner', 'run_migrations.js');
const reportPath = path.join(root, 'output', 'rc-upgrade-report.json');
const GATE_ID = 'postgres-migration-rc-upgrade';
const MANIFEST = path.join(root, 'db', 'contracts', 'schema-manifest.yaml');

let postgres;
try {
  postgres = (await import('../ewoh-spark-app/node_modules/postgres/src/index.js')).default;
} catch {
  postgres = null;
}

/** 迁移编号 → apply 命令（standalone 链 1..31，与 db/runner/run_migrations.js 注册一致）。 */
const APPLY = {
  1: '--apply-standalone',
  2: '--apply-standalone-users',
  3: '--apply-standalone-runtime-role',
  4: '--apply-standalone-domain',
  5: '--apply-standalone-workbench-prod',
  6: '--apply-standalone-scheduling',
  7: '--apply-standalone-scheduling-persistence',
  8: '--apply-standalone-phase2-realtime',
  9: '--apply-standalone-reservation-conflict',
  10: '--apply-standalone-scheduling-feedback',
  11: '--apply-standalone-outbox-sequence',
  12: '--apply-standalone-domain-columns',
  13: '--apply-standalone-conflict-lifecycle',
  14: '--apply-standalone-policy-weights',
  15: '--apply-standalone-route-cost-matrix',
  16: '--apply-standalone-task-requirement',
  17: '--apply-standalone-scheduling-tables-fix',
  18: '--apply-standalone-execution-feedback',
  19: '--apply-standalone-kpi-replay',
  20: '--apply-standalone-policy-lifecycle',
  21: '--apply-standalone-sse-envelope',
  22: '--apply-standalone-reservation-capacity',
  23: '--apply-standalone-scheduler-incremental',
  24: '--apply-standalone-scheduler-outbox-notify',
  25: '--apply-standalone-scheduler-rls',
  26: '--apply-standalone-route-cost-matrix-full-key',
  27: '--apply-standalone-resource-time-windows',
  28: '--apply-standalone-assignment-event-tenancy',
  29: '--apply-standalone-prediction-shadow-observation',
  30: '--apply-standalone-solver-activation',
  31: '--apply-standalone-snapshot-version-counter',
};

/** 迁移编号 → verify 命令（仅存在 verify 文件的迁移；7/8 无独立 verify）。 */
const VERIFY = {
  1: '--verify-standalone',
  4: '--verify-standalone-domain',
  5: '--verify-standalone-workbench-prod',
  6: '--verify-standalone-scheduling',
  9: '--verify-standalone-reservation-conflict',
  10: '--verify-standalone-scheduling-feedback',
  11: '--verify-standalone-outbox-sequence',
  12: '--verify-standalone-domain-columns',
  13: '--verify-standalone-conflict-lifecycle',
  14: '--verify-standalone-policy-weights',
  15: '--verify-standalone-route-cost-matrix',
  16: '--verify-standalone-task-requirement',
  17: '--verify-standalone-scheduling-tables-fix',
  18: '--verify-standalone-execution-feedback',
  19: '--verify-standalone-kpi-replay',
  20: '--verify-standalone-policy-lifecycle',
  21: '--verify-standalone-sse-envelope',
  22: '--verify-standalone-reservation-capacity',
  23: '--verify-standalone-scheduler-incremental',
  24: '--verify-standalone-scheduler-outbox-notify',
  25: '--verify-standalone-scheduler-rls',
  26: '--verify-standalone-route-cost-matrix-full-key',
  27: '--verify-standalone-resource-time-windows',
  28: '--verify-standalone-assignment-event-tenancy',
  29: '--verify-standalone-prediction-shadow-observation',
  30: '--verify-standalone-solver-activation',
  31: '--verify-standalone-snapshot-version-counter',
};

/**
 * 升级阶段 canonical 顺序（standalone_004..031）。
 * 与 standalone.yml「Scheduler V2 multi-tenant isolation E2E」/ soak-load-gate 的
 * 应用顺序逐项一致（017 补建表须先于 006..016 的 ALTER）；029..031 为 runner
 * 最新注册、尚未进入既有 workflow 的链尾迁移，按编号追加。
 */
const UPGRADE_ORDER = [
  4, 5, 17, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
];

/** 升级阶段 seed 命令（与 soak-load-gate 顺序一致）。 */
const UPGRADE_SEEDS = [
  '--seed-standalone',
  '--seed-standalone-admin',
  '--seed-standalone-scheduling',
];

/** 升级迁移（004..031）引入、且 schema-manifest.yaml 声明的关键物理表（G5 核对清单）。 */
const MANIFEST_KEY_TABLES = [
  'ewoh_schedule_plan',
  'ewoh_scheduling_run',
  'ewoh_scheduling_constraint',
  'ewoh_outbox',
  'ewoh_resource_locks',
];

/** 解析 release/ 中最新 RC 打包 runner 引用的最大 standalone 编号（当前 = 3）。 */
function resolveRcCutoff() {
  const releaseDir = path.join(root, 'release');
  let maxNum = 0;
  if (fs.existsSync(releaseDir)) {
    const rcDirs = fs
      .readdirSync(releaseDir)
      .filter((d) => /^ewoh-0\.6\.0-rc\d+$/.test(d))
      .sort();
    for (const dir of rcDirs) {
      const rcRunner = path.join(releaseDir, dir, 'db', 'runner', 'run_migrations.js');
      if (!fs.existsSync(rcRunner)) continue;
      const text = fs.readFileSync(rcRunner, 'utf8');
      const nums = [...text.matchAll(/standalone_(\d{3})_/g)].map((m) => Number(m[1]));
      const max = nums.length ? Math.max(...nums) : 0;
      if (max > maxNum) maxNum = max;
    }
  }
  return maxNum;
}

/** 校验本脚本引用的 apply/verify 命令在 db/runner/run_migrations.js 均已注册。 */
function assertCommandsRegistered() {
  const runnerText = fs.readFileSync(runner, 'utf8');
  const missing = [];
  for (const cmd of new Set([...Object.values(APPLY), ...Object.values(VERIFY), ...UPGRADE_SEEDS])) {
    if (!runnerText.includes(`'${cmd}'`)) missing.push(cmd);
  }
  if (missing.length > 0) {
    throw new Error(`run_migrations.js 未注册以下命令（迁移注册路径失效）: ${missing.join(', ')}`);
  }
}

function recordGate(status, details) {
  const args = [
    path.join(root, 'scripts', 'truth-gate-record.js'),
    '--id', GATE_ID,
    '--name', 'PostgreSQL 上一 RC → current main 迁移升级门禁',
    '--status', status,
    '--details', details,
  ];
  spawnSync(process.execPath, args, { stdio: 'inherit' });
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // 迁移注册路径 + RC 截点解析不需要 DB，最先执行（dry-run 在无 PG 时也可验证）
  let cutoff;
  try {
    assertCommandsRegistered();
    cutoff = resolveRcCutoff();
  } catch (error) {
    console.error('RC-UPGRADE FAILED: ' + (error && (error.message || error)));
    return 1;
  }

  const baselineNums = Array.from({ length: cutoff }, (_, i) => i + 1); // 1..cutoff
  const upgradeNums = UPGRADE_ORDER.filter((n) => n > cutoff);
  const verifyNums = Object.keys(VERIFY).map(Number).sort((a, b) => a - b);
  const plan = {
    rcCutoff: cutoff,
    baseline: baselineNums.map((n) => APPLY[n]),
    upgrade: upgradeNums.map((n) => APPLY[n]),
    seeds: UPGRADE_SEEDS,
    verifies: verifyNums.map((n) => VERIFY[n]),
    extraChecks: ['G3 idempotent re-apply 030/031', 'G4 backward-compat SQL (030/031)', 'G5 schema-manifest alignment'],
  };

  if (dryRun) {
    console.log('RC-UPGRADE DRY-RUN OK');
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  const url = process.env.EWOH_DATABASE_URL;

  // 环境缺失 → 响亮失败（release gate 绝不静默通过 / 绝不整包 SKIP）
  if (!url) {
    const msg = 'EWOH_DATABASE_URL is required (disposable PostgreSQL URL, superuser)';
    console.error('::error::BLOCKED_BY_ENVIRONMENT: ' + msg);
    recordGate('BLOCKED_BY_ENVIRONMENT', msg);
    fs.writeFileSync(reportPath, JSON.stringify({
      gate: GATE_ID, status: 'BLOCKED_BY_ENVIRONMENT', checkedAt: nowIso(), reason: msg, gates: [],
    }, null, 2) + '\n');
    return 1;
  }
  if (!postgres) {
    const msg = 'postgres driver unavailable (ewoh-spark-app/node_modules not installed)';
    console.error('::error::BLOCKED_BY_ENVIRONMENT: ' + msg);
    recordGate('BLOCKED_BY_ENVIRONMENT', msg);
    fs.writeFileSync(reportPath, JSON.stringify({
      gate: GATE_ID, status: 'BLOCKED_BY_ENVIRONMENT', checkedAt: nowIso(), reason: msg, gates: [],
    }, null, 2) + '\n');
    return 1;
  }

  const sql = postgres(url, { max: 2, idle_timeout: 30_000, onnotice: () => {} });
  const report = { gate: GATE_ID, checkedAt: nowIso(), rcCutoff: cutoff, gates: [] };
  const results = [];

  const exec = (label) => (command, args) => {
    const res = spawnSync(command, args, {
      cwd: root, encoding: 'utf8',
      env: {
        ...process.env,
        EWOH_DATABASE_URL: url,
        EWOH_ALLOW_DDL: '1',
        EWOH_ALLOW_DESTRUCTIVE_ROLLBACK: '1',
        EWOH_API_DATABASE_PASSWORD: report.runtimePassword,
        EWOH_BOOTSTRAP_ADMIN_USERNAME: 'rc_upgrade_admin',
        EWOH_BOOTSTRAP_ADMIN_PASSWORD: report.adminPassword,
      },
    });
    if (res.error) throw new Error(`${label}: spawn error ${res.error.message}`);
    if (res.status !== 0) {
      const tail = (res.stderr || res.stdout || '').split('\n').slice(-10).join('\n');
      throw new Error(`${label}: exit ${res.status}\n${tail}`);
    }
  };

  const run = exec('rc-upgrade');

  const connect = async () => {
    try {
      await sql`select 1`;
      return true;
    } catch {
      return false;
    }
  };

  const resetSchema = async () => {
    await sql.unsafe('drop schema if exists public cascade');
    await sql.unsafe('create schema public');
  };

  // G4：standalone_030 新增列的 nullable / 无默认值语义
  const solverNullableSemantics = async () => {
    const [row] = await sql.unsafe(`
      select
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='ewoh_schedule_plan'
            and column_name in ('solver_status','fallback_reason') and is_nullable='YES')::int as plan_nullable,
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='ewoh_schedule_plan'
            and column_name in ('solver_status','fallback_reason') and column_default is null)::int as plan_no_default,
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='ewoh_scheduling_run'
            and column_name in ('solver_status','fallback_reason') and is_nullable='YES')::int as run_nullable,
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='ewoh_scheduling_run'
            and column_name in ('solver_status','fallback_reason') and column_default is null)::int as run_no_default
    `);
    return row;
  };

  // G4：standalone_031 计数器表结构 + service_role 授权
  const counterFacts = async () => {
    const [row] = await sql.unsafe(`
      select
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='ewoh_snapshot_version_counter'
            and column_name in ('day','last_seq','created_at','_updated_at'))::int as cols,
        (select count(*) from information_schema.table_constraints
          where table_schema='public' and table_name='ewoh_snapshot_version_counter'
            and constraint_type='PRIMARY KEY')::int as pk,
        (select count(*) from information_schema.table_privileges
          where table_schema='public' and table_name='ewoh_snapshot_version_counter'
            and grantee='service_role'
            and privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))::int as svc_grants,
        (select count(*) from information_schema.columns
          where table_schema='public' and table_name='ewoh_snapshot_version_counter'
            and column_name='last_seq' and is_nullable='NO' and column_default is not null)::int as seq_default
    `);
    return row;
  };

  // G5：manifest 契约 + 关键表存在性
  const manifestFacts = async () => {
    let yaml;
    try {
      yaml = createRequire(path.join(appDir, 'package.json'))('js-yaml');
    } catch {
      return { ok: false, error: 'js-yaml unavailable (ewoh-spark-app deps not installed)' };
    }
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(MANIFEST, 'utf8'));
    } catch (error) {
      return { ok: false, error: `schema-manifest.yaml parse failed: ${error.message}` };
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.managed_tables)) {
      return { ok: false, error: 'schema-manifest.yaml 结构异常（缺 managed_tables）' };
    }
    const declared = new Set(
      doc.managed_tables.map((t) => t && t.physical_table).filter(Boolean),
    );
    const present = {};
    for (const table of MANIFEST_KEY_TABLES) {
      const [row] = await sql.unsafe(`select to_regclass('public.${table}') as reg`);
      present[table] = Boolean(row && row.reg) && declared.has(table);
    }
    const allOk = MANIFEST_KEY_TABLES.every((t) => present[t])
      && typeof doc.managed_count === 'number' && doc.managed_count >= 51
      && typeof doc.version === 'string' && doc.version.length > 0;
    return { ok: allOk, doc, declared, present };
  };

  try {
    if (!(await connect())) {
      const msg = `数据库不可达: ${url}`;
      console.error('::error::BLOCKED_BY_ENVIRONMENT: ' + msg);
      recordGate('BLOCKED_BY_ENVIRONMENT', msg);
      report.status = 'BLOCKED_BY_ENVIRONMENT';
      report.reason = msg;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      return 1;
    }

    report.runtimePassword = crypto.randomBytes(24).toString('hex');
    report.adminPassword = crypto.randomBytes(24).toString('hex');

    // ---- G1: RC 基线构建（standalone_001..cutoff + seeds）----
    {
      await resetSchema();
      for (const num of baselineNums) {
        await run(process.execPath, [runner, APPLY[num]]);
      }
      // RC 时代链的 seed（standalone_001 seed + admin seed）
      await run(process.execPath, [runner, '--seed-standalone']);
      await run(process.execPath, [runner, '--seed-standalone-admin']);
      await run(process.execPath, [runner, '--verify-standalone']);
      results.push({
        id: 'rc-baseline-build',
        ok: true,
        detail: `RC 基线（${cutoff > 0 ? `standalone_001..${String(cutoff).padStart(3, '0')}` : 'cutoff=0：无 RC 快照可解析，直接从基线升级'}）构建完成 + --verify-standalone 通过`,
      });
    }

    // ---- G2: RC → main 升级（剩余迁移 + seeds + 全量 verify）----
    {
      for (const num of upgradeNums) {
        await run(process.execPath, [runner, APPLY[num]]);
      }
      for (const seed of UPGRADE_SEEDS) {
        await run(process.execPath, [runner, seed]);
      }
      for (const num of verifyNums) {
        await run(process.execPath, [runner, VERIFY[num]]);
      }
      results.push({
        id: 'rc-to-main-upgrade',
        ok: true,
        detail: `standalone_004..031（${upgradeNums.length} 个迁移，canonical 顺序）+ seeds + ${verifyNums.length} 项 verify 全部通过`,
      });
    }

    // ---- G3: 幂等重放（030/031 重复应用 + 复跑 verify）----
    {
      for (const num of [30, 31]) {
        await run(process.execPath, [runner, APPLY[num]]);
        await run(process.execPath, [runner, VERIFY[num]]);
      }
      results.push({ id: 'idempotent-reapply-030-031', ok: true, detail: 'standalone_030/031 重放两次无错，verify 保持通过' });
    }

    // ---- G4: 向后兼容语义（030 列 nullable / 031 计数器表）----
    {
      const solver = await solverNullableSemantics();
      const okSolver = Number(solver.plan_nullable) === 2 && Number(solver.plan_no_default) === 2
        && Number(solver.run_nullable) === 2 && Number(solver.run_no_default) === 2;
      if (!okSolver) throw new Error(`030 solver 列语义不符: ${JSON.stringify(solver)}`);

      const counter = await counterFacts();
      const okCounter = Number(counter.cols) === 4 && Number(counter.pk) === 1
        && Number(counter.svc_grants) === 4 && Number(counter.seq_default) === 1;
      if (!okCounter) throw new Error(`031 计数器表结构不符: ${JSON.stringify(counter)}`);

      results.push({
        id: 'backward-compat-030-031',
        ok: true,
        detail: `solver_status/fallback_reason 4 列均 nullable 无默认（存量行保持 NULL）；计数器表 ${JSON.stringify(counter)}`,
      });
    }

    // ---- G5: schema-manifest 契约对齐 ----
    {
      const manifest = await manifestFacts();
      if (!manifest.ok) throw new Error(`manifest 契约核对失败: ${manifest.error || JSON.stringify(manifest.present)}`);
      results.push({
        id: 'schema-manifest-alignment',
        ok: true,
        detail: `manifest v${manifest.doc.version}（managed_count=${manifest.doc.managed_count}）与升级后库一致；关键表 ${MANIFEST_KEY_TABLES.join('/')} 均在库中且已声明`,
      });
    }

    report.status = 'SUCCEEDED';
    report.results = results;
    report.gates = results;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    recordGate('SUCCEEDED', `5/5 升级门禁通过: ${results.map((r) => r.id).join(', ')}`);
    console.log('RC-UPGRADE OK: ' + results.map((r) => r.id).join(' -> '));
    return 0;
  } catch (error) {
    report.status = 'FAILED';
    report.results = results;
    report.error = (error && (error.message || String(error)));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    recordGate('FAILED', report.error);
    console.error('RC-UPGRADE FAILED: ' + report.error);
    return 1;
  } finally {
    try { await sql.end(); } catch { /* ignore */ }
  }
}

main().then((code) => { process.exitCode = code; });
