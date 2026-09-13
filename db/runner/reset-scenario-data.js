#!/usr/bin/env node
'use strict';

/**
 * 演示/仿真场景复位（可重复场景的地基）。
 *
 * 为什么需要：E2E 场景（golden path、执行回执闭环）会消费可调度任务——派工后
 * 任务进入 dispatched/executing，再回执后进入 completed。跑几轮之后调度器就
 * 没有可排程任务了，场景只剩 SKIP。可重复的演示必须能把**场景数据**恢复到
 * 已知起点，而不必重装数据库。
 *
 * 安全设计（这是会写生产表的命令，必须保守）：
 *   - 默认 dry-run：只打印将影响的行数，不写库。必须显式 --yes 才执行。
 *   - 必须显式 --org-id：拒绝"猜一个 org 然后清空它"。
 *   - 只处理 `source='seed'` 的生产任务：人工/真实来源的任务一律不动。
 *   - 只清理这些任务派生出的 plan/assignment/execution/feedback 行。
 *   - 明确不做"删库重来"：真实工厂数据与演示数据必须能共存。
 *
 * 累积表清理（--purge-derived，2026-09-13 新增）：
 *   本地/测试库无界累积是**已实测的退化源**：`ewoh_world_state_snapshot`
 *   7,829 行、`ewoh_event` 12,729 行、`ewoh_production_task` 380 行（种子只有
 *   19）时，求解成本对候选任务数超线性增长，`POST /api/scheduler/runs` 从
 *   5.2s 退化到 >180s。而现象里**没有任何线索指向数据量**，环境退化被误读成
 *   产品故障（实际误判过一次）。
 *
 *   因此新增 `--purge-derived`：在同一个 org 作用域内，逐表清空**派生的/累积
 *   的**运行时事实（快照/事件/遥测/追踪/审计/outbox/通知/排产派生/学习派生
 *   …），但**绝不触碰配置类种子**（人、设备、班次、模板、策略基线、SOP 等）。
 *   这是把「数据量 → 求解耗时」这条关系交还给操作者的开关：
 *     - 仍然默认 dry-run，必须显式 --yes 才写库；
 *     - 仍然必须显式 --org-id，绝不猜租户；
 *     - 逐表列出将要删除的行数，让人能核对；
 *     - 打印不可逆提示与将执行的 SQL 预览。
 *
 * 用法：
 *   EWOH_DATABASE_URL=postgresql://ewoh_owner:...@host:5432/ewoh \
 *     node db/runner/reset-scenario-data.js --org-id <uuid>            # 预览
 *   EWOH_DATABASE_URL=... node db/runner/reset-scenario-data.js \
 *     --org-id <uuid> --yes                                             # 只复位场景
 *   EWOH_DATABASE_URL=... node db/runner/reset-scenario-data.js \
 *     --org-id <uuid> --purge-derived --yes                            # 复位场景 + 清累积表
 *
 * 退出码：0 成功；1 用法错误；2 数据库/前置条件错误。
 */

const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

/** 场景复位后，seed 任务回到契约派发前状态。 */
const RESET_TASK_STATUS = 'pending_dispatch';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 累积/派生的运行时事实表（org 作用域，`org_id` 有 uuid 也有 varchar，故统一
 * 用 `org_id::text = $1` 比较——既容纳两种列型，又不内联未校验的租户）。
 *
 * 白名单而非黑名单：只有在此登记的表才会被 --purge-derived 清空。新增表若没
 * 登记，就是**不会被删**（宁少删、不误删）；反之任何一张表要进来，都必须先
 * 说清「为什么它是派生的、删了能重建」。所有条目都通过与 e2e/仿真、保留策略
 * （server/modules/simulator/retention.service.ts 的清理清单）交叉核对。
 */
const PURGE_TABLES = [
  // ---- 排产派生：每次求解/派工/回执都会新增 ----
  { table: 'ewoh_scheduling_run', group: '排产派生', why: '每次求解的运行台账' },
  { table: 'ewoh_schedule_plan', group: '排产派生', why: '求解产出的方案（可再生）' },
  { table: 'ewoh_scheduling_plan_assignment', group: '排产派生', why: '方案的派工分配行' },
  { table: 'ewoh_schedule_assignment', group: '排产派生', why: '历史派工分配表（旧版镜像）' },
  { table: 'ewoh_assignment_event', group: '排产派生', why: '派工生命周期事件' },
  { table: 'ewoh_scheduling_execution', group: '排产派生', why: '执行回执记录' },
  { table: 'ewoh_scheduling_feedback', group: '排产派生', why: '执行反馈记录' },
  { table: 'ewoh_scheduling_conflict', group: '排产派生', why: '冲突快照（逐次求解重算）' },
  { table: 'ewoh_scheduling_kpi', group: '排产派生', why: 'KPI 聚合（可重算）' },
  { table: 'ewoh_resource_reservation', group: '排产派生', why: '资源预约（派工副作用）' },
  { table: 'ewoh_resource_locks', group: '排产派生', why: '资源锁（派工副作用）' },
  { table: 'ewoh_replan_trigger', group: '排产派生', why: '重排触发去抖台账' },
  { table: 'ewoh_schedule_audit', group: '排产派生', why: '排产审计流水' },
  { table: 'ewoh_schedule_task', group: '排产派生', why: 'MES 工单镜像（由方案派生）' },
  { table: 'ewoh_schedule_task_step', group: '排产派生', why: 'MES 工单工序镜像' },
  { table: 'ewoh_work_order', group: '排产派生', why: '工单（由方案派生）' },
  { table: 'ewoh_shift_handover', group: '排产派生', why: '交接班记录（运行时产生）' },

  // ---- 观测/世界：每 tick / 每事件 / 每条日志都追加 ----
  { table: 'ewoh_world_state_snapshot', group: '观测/世界', why: '世界快照（单行可达数十 MB，保留策略也清它）' },
  { table: 'ewoh_world_snapshot', group: '观测/世界', why: '世界快照（旧表）' },
  { table: 'ewoh_world_delta_log', group: '观测/世界', why: '世界增量日志' },
  { table: 'ewoh_simulation_run', group: '观测/世界', why: '仿真运行记录' },
  { table: 'ewoh_telemetry', group: '观测/世界', why: '遥测帧（保留策略 24h）' },
  { table: 'ewoh_event', group: '观测/世界', why: '事件流（保留策略 7d）' },
  { table: 'ewoh_event_chain', group: '观测/世界', why: '事件链（保留策略 7d）' },
  { table: 'ewoh_trace_span', group: '观测/世界', why: '链路追踪 span' },
  { table: 'ewoh_audit_log', group: '观测/世界', why: '审计流水（观测类事实，非决策记录本体）' },
  { table: 'ewoh_notification', group: '观测/世界', why: '通知' },
  { table: 'ewoh_outbox', group: '观测/世界', why: '发件箱（已投递的事件信封）' },
  { table: 'ewoh_dead_letter', group: '观测/世界', why: '死信队列' },
  { table: 'ewoh_ingest_event_dedup', group: '观测/世界', why: '入库事件去重簿记' },
  { table: 'ewoh_idempotency_keys', group: '观测/世界', why: '幂等键（请求簿记）' },
  { table: 'ewoh_idempotency_payload_fingerprint', group: '观测/世界', why: '幂等请求指纹簿记' },

  // ---- 学习/推理派生：闭环每跑一轮新增，可重算 ----
  { table: 'ewoh_inference_result', group: '学习/推理派生', why: '推理结果（可由输入重算）' },
  { table: 'ewoh_learning_evaluation', group: '学习/推理派生', why: '学习评估结果（可重算）' },
  { table: 'ewoh_learning_signal', group: '学习/推理派生', why: '学习信号（可重算）' },
  { table: 'ewoh_outcome_annotation', group: '学习/推理派生', why: '结果标注（学习闭环产物）' },
];

/**
 * 配置/种子类表：**禁止**被本命令清空。
 *
 * 这些是「世界的地基」——人、设备、班次定义、模板、策略基线、空间/拓扑、
 * 角色权限。删掉它们场景不会"回到起点"，而是直接消失（人没了、设备没了、
 * 班次没了），且无法从任何地方重建。此清单同时用于运行时的输出提示与测试断言
 * （回归：白名单与保护名单不得有交集）。
 */
const PROTECTED_TABLES = [
  'ewoh_organization', 'ewoh_personnel', 'ewoh_user', 'ewoh_role', 'ewoh_person_role',
  'ewoh_person_skill', 'ewoh_skill', 'ewoh_device', 'ewoh_device_binding',
  'ewoh_device_capability', 'ewoh_device_config', 'ewoh_shift', 'ewoh_task_template',
  'ewoh_task_step', 'ewoh_task_skill_req', 'ewoh_scheduling_policy', 'ewoh_scheduler_config',
  'ewoh_workstation', 'ewoh_spatial_entity', 'ewoh_spatial_hierarchy', 'ewoh_spatial_relation',
  'ewoh_topology', 'ewoh_route_node', 'ewoh_route_edge', 'ewoh_factory_profile',
  'ewoh_factory_template', 'ewoh_system_config', 'ewoh_knowledge_base', 'ewoh_exo_config',
  'ewoh_model_registry', 'ewoh_model_asset', 'ewoh_asset_package', 'ewoh_event_rule',
  'ewoh_event_action', 'ewoh_event_subscription', 'ewoh_identity_mapping',
];

/**
 * 规模观测（--purge-derived 与否都打印）：把「数据量 ↔ 求解耗时」这条关系
 * 直接摆在输出里。排产慢时先看这里——候选任务数才是求解成本的直接输入，
 * 而不是「产品坏了」。只读，不改任何语义。
 */
const SCALE_TABLES = [
  { table: 'ewoh_production_task', label: '候选生产任务（status=pending_dispatch）', filter: "AND status = 'pending_dispatch'" },
  { table: 'ewoh_world_state', label: '世界状态实体' },
  { table: 'ewoh_world_state_snapshot', label: '世界快照' },
  { table: 'ewoh_event', label: '事件' },
  { table: 'ewoh_event_chain', label: '事件链' },
  { table: 'ewoh_telemetry', label: '遥测帧' },
  { table: 'ewoh_scheduling_run', label: '排产运行记录' },
  { table: 'ewoh_scheduling_plan_assignment', label: '排产分配行' },
  { table: 'ewoh_resource_reservation', label: '资源预约' },
];

function usage(exitCode = 1) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`用法：node db/runner/reset-scenario-data.js --org-id <uuid> [--purge-derived] [--yes] [--dry-run]

  --org-id <uuid>   必填。只复位该组织下的 seed 场景数据。
  --purge-derived   额外清空该组织下**派生的/累积的**运行时事实（快照/事件/
                    遥测/审计/outbox/通知/排产派生/学习派生…）。配置类种子
                    （人、设备、班次、模板、策略基线）永不清理。不可逆。
  --yes             确认执行（未提供时为 dry-run，只预览）。
  --dry-run         显式预览（默认行为）。
  --help            显示本帮助。

环境：
  EWOH_DATABASE_URL  owner 连接串（必填）
  EWOH_SCHEMA        目标 schema（默认 public）

复位范围（默认）：
  - ewoh_production_task（source='seed'）→ status=${RESET_TASK_STATUS}，清空 assignee/device/progress
  - 这些任务派生出的 plan / assignment / execution / feedback / reservation 行
不变更（默认）：审计日志、遥测、告警、世界状态、非 seed 来源的任务。

清空范围（--purge-derived）：见脚本内 PURGE_TABLES 白名单，逐表打印行数与 SQL。
永不清理：${PROTECTED_TABLES.join('、')}
`);
  process.exit(exitCode);
}

function parse(argv) {
  const opts = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--org-id') {
      opts.orgId = argv[i + 1];
      if (!opts.orgId || opts.orgId.startsWith('--')) throw new Error('--org-id 需要一个 uuid');
      i += 1;
    } else if (arg.startsWith('--')) {
      opts.flags.add(arg.slice(2));
    } else {
      throw new Error(`无法识别的参数：${arg}`);
    }
  }
  return opts;
}

/** 由已解析的 flag 决定运行模式（纯函数，便于回归测试锁定 dry-run 语义）。 */
function resolveOptions(opts) {
  return {
    // 默认 dry-run：只有显式 --yes 且未显式 --dry-run 才写库。
    dryRun: !opts.flags.has('yes') || opts.flags.has('dry-run'),
    // 累积表清理必须显式请求：默认不碰（保持既有保守语义，不悄悄删审计/事件）。
    purgeDerived: opts.flags.has('purge-derived'),
  };
}

function loadDotenv() {
  const envPath = path.join(appDir, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    requireFromApp('dotenv').config({ path: envPath, quiet: true });
  } catch { /* 显式环境变量仍可用 */ }
}

/**
 * 把 PURGE_TABLES 白名单编译成可执行的 SQL 组（纯函数）。
 *
 * 表名来自硬编码白名单、schema 已过正则校验，均无注入面；org 一律以参数
 * `$1` 绑定（脚本会先校验它是合法 uuid），绝不把租户内联进未校验的语句。
 */
function buildPurgeStatements(schema, org) {
  return PURGE_TABLES.map(({ table, group, why }) => ({
    table,
    group,
    why,
    existsSql: 'SELECT to_regclass($1) IS NOT NULL AS present',
    countSql: `SELECT count(*)::int AS count FROM ${schema}.${table} WHERE org_id::text = $1`,
    countParams: [org],
    deleteSql: `DELETE FROM ${schema}.${table} WHERE org_id::text = $1`,
    deleteParams: [org],
  }));
}

/** dry-run 用：逐表数出行数，不写库。表不存在则如实标注（不静默当 0）。 */
async function collectPurgeCounts(sql, schema, org) {
  const out = [];
  for (const statement of buildPurgeStatements(schema, org)) {
    const [present] = await sql.unsafe(statement.existsSql, [`${schema}.${statement.table}`]);
    if (!present?.present) {
      out.push({ table: statement.table, group: statement.group, why: statement.why, count: null, missing: true });
      continue;
    }
    const [row] = await sql.unsafe(statement.countSql, statement.countParams);
    out.push({ table: statement.table, group: statement.group, why: statement.why, count: row.count });
  }
  return out;
}

/** 执行清理：逐表 DELETE，返回每表删除行数。调用方负责事务（BEGIN/COMMIT）。 */
async function applyPurge(sql, schema, org) {
  const out = [];
  for (const statement of buildPurgeStatements(schema, org)) {
    const [present] = await sql.unsafe(statement.existsSql, [`${schema}.${statement.table}`]);
    if (!present?.present) {
      out.push({ table: statement.table, group: statement.group, deleted: 0, missing: true });
      continue;
    }
    // 不带 RETURNING 的 DELETE 在 postgres.js 里返回空数组 + `.count`（受影响
    // 行数）；这里绝不能读 `.length`（恒为 0）——否则会谎报"删了 0 行"，
    // 让人以为清理没生效，正是本议题要消灭的"数据量不可见"。
    const rows = await sql.unsafe(statement.deleteSql, statement.deleteParams);
    out.push({ table: statement.table, group: statement.group, deleted: Number(rows.count ?? rows.length) });
  }
  return out;
}

/** 把将执行的 DELETE 以可读形式打印出来（SQL 预览）。 */
function formatPurgePreview(schema, org) {
  return buildPurgeStatements(schema, org)
    .map((statement) => `      ${statement.deleteSql};   -- $1 = '${org}'`)
    .join('\n');
}

/** dry-run 预览：逐表行数 + 不可逆提示 + SQL 预览 + 保留清单。 */
function printPurgePreview(rows, schema, org) {
  console.log('\n累积/派生事实清理预览（--purge-derived）：');
  let group = null;
  for (const row of rows) {
    if (row.group !== group) {
      group = row.group;
      console.log(`  【${group}】`);
    }
    const value = row.missing ? '（本部署无此表，跳过）' : `${row.count} 行`;
    console.log(`    ${row.table}：${value}`);
  }
  const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0);
  console.log(`  合计将删除：${total} 行`);
  console.log('\n不可逆提示：以上行将被**永久删除**，数据库无法回滚到清理前状态'
    + '（如需保留请先自行备份）。');
  console.log('将执行的 SQL（org 以参数绑定，逐表）：');
  console.log(formatPurgePreview(schema, org));
  console.log(`保留（配置/种子，不清理）：${PROTECTED_TABLES.join('、')}`);
  console.log('确认无误后加 --yes 执行。');
}

/** 逐表打印已删除行数（执行路径）。 */
function printPurgeResult(rows) {
  console.log('\n累积/派生事实清理完成：');
  let group = null;
  for (const row of rows) {
    if (row.group !== group) {
      group = row.group;
      console.log(`  【${group}】`);
    }
    const value = row.missing ? '（本部署无此表，跳过）' : `${row.deleted} 行`;
    console.log(`    ${row.table}：${value}`);
  }
}

/** 规模观测：候选任务数与关键累积表体积，只读。 */
async function collectScale(sql, schema, org) {
  const out = [];
  for (const { table, label, filter } of SCALE_TABLES) {
    const [present] = await sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS present', [`${schema}.${table}`]);
    if (!present?.present) {
      out.push({ label, count: null });
      continue;
    }
    const [row] = await sql.unsafe(
      `SELECT count(*)::int AS count FROM ${schema}.${table} WHERE org_id::text = $1 ${filter ?? ''}`, [org]);
    out.push({ label, count: row.count });
  }
  return out;
}

function printScale(rows) {
  console.log('\n规模观测（只读；排产耗时对「候选生产任务数」超线性——慢时先看这里）：');
  for (const row of rows) {
    console.log(`  ${row.label}：${row.count === null ? '（本部署无此表）' : row.count}`);
  }
}

async function main() {
  const opts = parse(process.argv.slice(2));
  loadDotenv();
  const { dryRun, purgeDerived } = resolveOptions(opts);
  const schema = process.env.EWOH_SCHEMA || 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error(`EWOH_SCHEMA 非法：${schema}`);
  if (!opts.orgId) throw new Error('必须显式提供 --org-id（拒绝猜测要清空哪个组织）');
  if (!UUID_RE.test(opts.orgId)) throw new Error(`--org-id 不是合法 uuid：${opts.orgId}`);
  const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
  if (!url) throw new Error('EWOH_DATABASE_URL 未设置（本命令写业务表，需要 owner 连接）');

  const postgres = requireFromApp('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const org = opts.orgId;

  try {
    const [orgRow] = await sql.unsafe(
      `SELECT id::text AS id, name FROM ${schema}.ewoh_organization WHERE id = $1::uuid`, [org]);
    if (!orgRow) throw new Error(`组织不存在：${org}`);
    console.log(`目标组织：${orgRow.name} (${orgRow.id})${dryRun ? '  [DRY-RUN]' : ''}`);

    printScale(await collectScale(sql, schema, org));

    // 累积表清理先于场景复位：它自带独立事务，且在"没有 seed 任务"时也应生效
    // （数据量退化与有没有 seed 任务无关）。
    if (purgeDerived) {
      if (dryRun) {
        printPurgePreview(await collectPurgeCounts(sql, schema, org), schema, org);
      } else {
        await sql.unsafe('BEGIN');
        try {
          const purged = await applyPurge(sql, schema, org);
          await sql.unsafe('COMMIT');
          printPurgeResult(purged);
        } catch (error) {
          await sql.unsafe('ROLLBACK').catch(() => {});
          throw error;
        }
      }
    }

    const [{ count: seedTasks }] = await sql.unsafe(
      `SELECT count(*)::int AS count FROM ${schema}.ewoh_production_task
        WHERE org_id = $1::uuid AND source = 'seed'`, [org]);
    console.log(`\n将复位 seed 生产任务：${seedTasks} 行 → status='${RESET_TASK_STATUS}'`);
    if (!seedTasks) {
      console.log('没有 source=\'seed\' 的任务；场景无需复位（真实/人工来源的任务不会被本命令改动）');
      if (dryRun) console.log('\nDRY-RUN：未写库。确认无误后加 --yes 执行。');
      return;
    }

    // 场景引用的 plan_id 与 seed 任务 id 必须在删除前锁定（删完 assignment
    // 就无法反推归属；按"没有 assignment 就删"清理会误伤别人的空方案）。
    const scenarioPlanIds = (await sql.unsafe(
      `SELECT DISTINCT a.plan_id
         FROM ${schema}.ewoh_scheduling_plan_assignment a
         JOIN ${schema}.ewoh_production_task t ON t.id::text = a.task_id
        WHERE a.org_id = $1 AND t.source = 'seed'`, [org])).map((r) => r.plan_id);
    const seedTaskIds = (await sql.unsafe(
      `SELECT id::text AS id FROM ${schema}.ewoh_production_task
        WHERE org_id = $1::uuid AND source = 'seed'`, [org])).map((r) => r.id);

    // 派生行统计（按 seed 任务的 plan 归属）
    const counts = {};
    for (const [label, query] of Object.entries({
      plans: `SELECT count(DISTINCT p.plan_id)::int AS count
                FROM ${schema}.ewoh_schedule_plan p
                JOIN ${schema}.ewoh_scheduling_plan_assignment a ON a.plan_id = p.plan_id
                JOIN ${schema}.ewoh_production_task t ON t.id::text = a.task_id
               WHERE p.org_id = $1::uuid AND t.source = 'seed'`,
      assignments: `SELECT count(*)::int AS count
                      FROM ${schema}.ewoh_scheduling_plan_assignment a
                      JOIN ${schema}.ewoh_production_task t ON t.id::text = a.task_id
                     WHERE a.org_id = $1 AND t.source = 'seed'`,
      executions: `SELECT count(*)::int AS count
                     FROM ${schema}.ewoh_scheduling_execution e
                     JOIN ${schema}.ewoh_production_task t ON t.id::text = e.task_id
                    WHERE e.org_id = $1 AND t.source = 'seed'`,
      feedback: `SELECT count(*)::int AS count
                   FROM ${schema}.ewoh_scheduling_feedback f
                   JOIN ${schema}.ewoh_production_task t ON t.id::text = f.task_id
                  WHERE f.org_id = $1 AND t.source = 'seed'`,
      // 资源预约是派工的副作用：不释放它们，复位后的任务仍会因
      // 独占约束（person/device EXCLUDE + station 容量）而无法再次派工，
      // 场景就永远回不到起点。
      reservations: `SELECT count(*)::int AS count
                       FROM ${schema}.ewoh_resource_reservation r
                      WHERE r.org_id = $1
                        AND r.status IN ('reserved', 'active')
                        AND (r.task_id = ANY($2::text[])
                             OR r.plan_id = ANY($3::text[])
                             -- 孤儿预占：方案行已被更早的复位删除，按 plan_id 再也匹配不到。
                             -- 不释放它们会永久占用 person/device（EXCLUDE 约束），
                             -- 使场景复位后调度器找不到可用资源而产出空方案（实测）。
                             OR NOT EXISTS (
                               SELECT 1 FROM ${schema}.ewoh_schedule_plan p WHERE p.plan_id = r.plan_id
                             ))`,
    })) {
      const [row] = label === 'reservations'
        ? await sql.unsafe(query, [org, seedTaskIds, scenarioPlanIds])
        : await sql.unsafe(query, [org]);
      counts[label] = row.count;
      console.log(`  派生 ${label}：${row.count} 行`);
    }

    // 时间窗重锚（2026-09-10 修复）：seed 任务的时间窗是**播种时刻**的相对值
    // （now() + interval ...）。若不重锚，几小时后全部落入过去 → 调度器找不到
    // 未来窗口内的任务 → 产出**空方案**（0 assignment），且没有任何报错——
    // 场景会"静默失效"，排查成本极高（实测踩到）。这里按最旧 plan_start 计算
    // 统一位移，保留任务之间的相对间隔，只把整体挪到当前时刻。
    const [anchor] = await sql.unsafe(
      `SELECT min(plan_start) AS oldest,
              count(*)::int AS total
         FROM ${schema}.ewoh_production_task
        WHERE org_id = $1::uuid AND source = 'seed' AND plan_start IS NOT NULL`, [org]);
    const shiftMs = anchor?.oldest ? Date.now() - new Date(anchor.oldest).getTime() : 0;
    console.log(`时间窗重锚：${anchor?.total ?? 0} 行，位移 ${Math.round(shiftMs / 1000)} 秒`
      + `${shiftMs <= 0 ? '（已在未来，跳过）' : ''}`);

    if (dryRun) {
      console.log('\nDRY-RUN：未写库。确认无误后加 --yes 执行。');
      return;
    }

    await sql.unsafe('BEGIN');
    try {
      // 顺序：先释放/删除派生行，再复位任务本身。
      const deleted = {};
      // 资源预约必须先释放：否则复位后 person/device 仍被独占，下一次派工
      // 直接撞 STATION_CAPACITY / reservce 冲突，场景无法重跑。
      deleted.reservations = (await sql.unsafe(
        `UPDATE ${schema}.ewoh_resource_reservation r
            SET status = 'released', _updated_at = CURRENT_TIMESTAMP
          WHERE r.org_id = $1
            AND r.status IN ('reserved', 'active')
            AND (r.task_id = ANY($2::text[])
                 OR r.plan_id = ANY($3::text[])
                 -- 见上：孤儿预占按 plan_id 匹配不到，必须显式按"方案已不存在"释放。
                 OR NOT EXISTS (
                   SELECT 1 FROM ${schema}.ewoh_schedule_plan p WHERE p.plan_id = r.plan_id
                 ))
          RETURNING r.reservation_id`, [org, seedTaskIds, scenarioPlanIds])).length;
      deleted.feedback = (await sql.unsafe(
        `DELETE FROM ${schema}.ewoh_scheduling_feedback f
          USING ${schema}.ewoh_production_task t
          WHERE f.org_id = $1 AND f.task_id = t.id::text AND t.source = 'seed'
          RETURNING f.feedback_id`, [org])).length;
      deleted.executions = (await sql.unsafe(
        `DELETE FROM ${schema}.ewoh_scheduling_execution e
          USING ${schema}.ewoh_production_task t
          WHERE e.org_id = $1 AND e.task_id = t.id::text AND t.source = 'seed'
          RETURNING e.execution_id`, [org])).length;
      deleted.assignmentEvents = (await sql.unsafe(
        `DELETE FROM ${schema}.ewoh_assignment_event ev
          USING ${schema}.ewoh_production_task t
          WHERE ev.org_id = $1 AND ev.task_id = t.id::text AND t.source = 'seed'
          RETURNING ev.event_id`, [org])).length;
      deleted.assignments = (await sql.unsafe(
        `DELETE FROM ${schema}.ewoh_scheduling_plan_assignment a
          USING ${schema}.ewoh_production_task t
          WHERE a.org_id = $1 AND a.task_id = t.id::text AND t.source = 'seed'
          RETURNING a.assignment_id`, [org])).length;
      // 只删除"场景引用过、且现在已空"的方案——不碰其它方案。
      deleted.plans = scenarioPlanIds.length
        ? (await sql.unsafe(
          `DELETE FROM ${schema}.ewoh_schedule_plan p
            WHERE p.org_id = $1::uuid
              AND p.plan_id = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM ${schema}.ewoh_scheduling_plan_assignment a WHERE a.plan_id = p.plan_id
              )
            RETURNING p.plan_id`, [org, scenarioPlanIds])).length
        : 0;
      let reanchored = 0;
      if (shiftMs > 0) {
        reanchored = (await sql.unsafe(
          `UPDATE ${schema}.ewoh_production_task
              SET plan_start = plan_start + ($2::bigint || ' milliseconds')::interval,
                  plan_end   = CASE WHEN plan_end IS NULL THEN NULL
                                    ELSE plan_end + ($2::bigint || ' milliseconds')::interval END,
                  _updated_at = CURRENT_TIMESTAMP
            WHERE org_id = $1::uuid AND source = 'seed' AND plan_start IS NOT NULL
            RETURNING id`, [org, String(shiftMs)])).length;
        // MES 工单镜像表同源同窗（存在才更新，避免对不含该表的部署报错）。
        await sql.unsafe(
          `UPDATE ${schema}.ewoh_schedule_task
              SET plan_start = CASE WHEN plan_start IS NULL THEN NULL
                                    ELSE plan_start + ($2::bigint || ' milliseconds')::interval END,
                  plan_end   = CASE WHEN plan_end IS NULL THEN NULL
                                    ELSE plan_end + ($2::bigint || ' milliseconds')::interval END,
                  _updated_at = CURRENT_TIMESTAMP
            WHERE org_id = $1::uuid AND plan_start IS NOT NULL`,
          [org, String(shiftMs)]).catch(() => undefined);
      }
      // 触发冷却台账（ewoh_replan_trigger）必须一并清掉：调度触发的去抖是
      // 按 (org, triggerType, entityId) 最近一次触发 + triggerCooldownMs
      // （默认 30s）判定的。复位后立刻跑场景会被判定为 debounced → 不生成
      // 方案 → 场景如实报 SKIP（实测踩到）。复位的目的就是"立刻可重跑"，
      // 因此这里显式清掉本组织的触发台账（属于场景簿记，不是人工决策审计）。
      deleted.replanTriggers = (await sql.unsafe(
        `DELETE FROM ${schema}.ewoh_replan_trigger
          WHERE org_id = $1
          RETURNING trigger_key`, [org]).catch(() => [])).length;
      const reset = await sql.unsafe(
        `UPDATE ${schema}.ewoh_production_task
            SET status = '${RESET_TASK_STATUS}',
                assignee_id = NULL,
                device_id = NULL,
                progress = 0,
                _updated_at = CURRENT_TIMESTAMP
          WHERE org_id = $1::uuid AND source = 'seed'
          RETURNING id`, [org]);
      await sql.unsafe('COMMIT');
      console.log('\n复位完成：');
      console.log(`  任务复位：${reset.length} 行`);
      console.log(`  时间窗重锚：${reanchored} 行`);
      for (const [k, v] of Object.entries(deleted)) console.log(`  删除 ${k}：${v} 行`);
    } catch (error) {
      await sql.unsafe('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

module.exports = {
  RESET_TASK_STATUS,
  UUID_RE,
  PURGE_TABLES,
  PROTECTED_TABLES,
  SCALE_TABLES,
  parse,
  resolveOptions,
  buildPurgeStatements,
  collectPurgeCounts,
  applyPurge,
  formatPurgePreview,
  collectScale,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    const msg = String(error?.message ?? '');
    process.exitCode = /未设置|不存在|owner 连接/.test(msg) ? 2 : 1;
  });
}
