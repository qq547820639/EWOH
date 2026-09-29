#!/usr/bin/env node
/**
 * 租户隔离应用层谓词门禁（审计 §4 主线 1 / NEST 域 53 条 Critical 共同根因）。
 *
 * 职责（fail-closed，任一未登记违规 → 非零退出）：
 *  1. 从 ewoh-spark-app/server/database/schema.ts 派生「含 org_id 列的表」集合
 *     （pgTable 定义块内含 orgId 字段的导出表）；
 *  2. 静态扫描 ewoh-spark-app/server/modules 下全部 `*.service.ts` 的
 *     `.from(表)` / `.update(表)` 查询链：对 org 表要求——
 *     a) 语句链窗口内出现 orgId 谓词（如 eq(ewohDevice.orgId, orgId)），或
 *     b) 所在方法内有租户断言/RLS 事务标识：`/* org-scoped *​/` 注释、
 *        runInTransaction（请求级 GUC → app.current_org_id RLS）、
 *        assertPlanTenantVisible 等租户守卫、或 globalAdmin 条件化 org 逻辑；
 *  3. 白名单登记制：不满足 a/b 的链必须登记于下方 EXEMPTIONS（带审计编号与
 *     理由）；脚本双向比对——出现未登记违规 → FAIL，登记项在代码中消失 → FAIL
 *     （豁免清单与代码强制同步，防「凑绿豁免」与「僵尸豁免」）。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-org-predicates.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_FILE = path.join(REPO_ROOT, 'ewoh-spark-app/server/database/schema.ts');
const MODULES_DIR = path.join(REPO_ROOT, 'ewoh-spark-app/server/modules');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

// ── 1. schema.ts 派生 org 表集合 ────────────────────────────────────────────
function deriveOrgTables() {
  const src = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const tables = new Map(); // 导出变量名 → 表名（仅含 orgId 字段者）
  const re = /export const (\w+) = pgTable\("([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const blockStart = m.index + m[0].length;
    // 找 pgTable( 后第一个 '{'，做括号配对取字段定义块
    const open = src.indexOf('{', blockStart);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const body = src.slice(open, end);
    if (/(^|\s)orgId:\s*\w+\("org_id"/.test(body)) {
      tables.set(m[1], m[2]);
    }
  }
  return tables;
}

const orgTables = deriveOrgTables();
check(
  'schema_org_tables_derived',
  orgTables.size >= 20,
  `derived ${orgTables.size} org-scoped tables from schema.ts`,
);

// ── 2. 扫描 modules/**/*.service.ts 查询链 ─────────────────────────────────
function walkServices(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkServices(p, out);
    else if (ent.isFile() && ent.name.endsWith('.service.ts')) out.push(p);
  }
  return out;
}

const METHOD_DEF_RE = /^\s*(?:private|public|protected|readonly|static|async|override|\s)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(:\s*[\w<>\[\]| .]+)?\s*\{/;
/** 方法签名起始行（类体缩进 2，兼容跨行参数列表；METHOD_DEF_RE 要求签名与 `{` 同行）。 */
const METHOD_START_RE = /^\s{2}(?:(?:private|public|protected|readonly|static|async|override|get|set)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]{0,80}>)?\s*\(/;
const CONTROL_FLOW_RE = /^\s*(if|for|while|switch|catch|return|else|try|do|throw)\b/;

/** 从链起始行向前找所在方法区域（近似：最近的方法定义行 → 下一个方法定义/文件尾）。 */
function isMethodStart(l) {
  return (
    METHOD_START_RE.test(l) &&
    !CONTROL_FLOW_RE.test(l) &&
    !l.trim().startsWith('//') &&
    !l.trim().startsWith('*')
  );
}

function methodRegion(lines, chainIdx) {
  let start = 0;
  for (let i = chainIdx; i >= 0; i--) {
    if (isMethodStart(lines[i])) {
      start = i;
      break;
    }
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isMethodStart(lines[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}

/** 语句链窗口：从 .from(/.update( 行起，至语句结束（; 收尾 / 空行 / 新语句），至多 25 行。 */
function chainWindow(lines, startIdx) {
  const win = [];
  let depth = 0;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 25); i++) {
    const l = lines[i];
    win.push(l);
    const code = l.replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
    }
    const trimmed = code.trim();
    if (trimmed.endsWith(';') || trimmed === '') break;
    // 括号配平后出现新语句起始（return/const/if/for/await 等）→ 链已结束
    if (depth <= 0 && /^(return\b|const\b|let\b|if\b|for\b|while\b|throw\b|await this\.db\.(select|insert|update|delete))/.test(trimmed) && i > startIdx) {
      win.pop();
      break;
    }
  }
  return win;
}

const violations = []; // { key, file, line, table, kind }
const serviceFiles = walkServices(MODULES_DIR, []).sort();
let chainsTotal = 0;
let chainsCovered = 0;

for (const file of serviceFiles) {
  const rel = path.relative(REPO_ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const perFileOrdinal = new Map(); // table → 第 n 条链（登记键稳定性用）
  for (let i = 0; i < lines.length; i++) {
    const m = /\.from\(\s*([A-Za-z_$][\w$]*)\s*\)|\.update\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(lines[i]);
    if (!m) continue;
    const varName = m[1] || m[2];
    if (!orgTables.has(varName)) continue;
    const tableName = orgTables.get(varName);
    chainsTotal++;
    const ordinal = (perFileOrdinal.get(`${varName}`) ?? 0) + 1;
    perFileOrdinal.set(`${varName}`, ordinal);
    const kind = m[1] ? 'select' : 'update';

    // a) 链窗口内 orgId 谓词
    const win = chainWindow(lines, i).join('\n');
    const windowHasOrg = /orgId/.test(win);
    // b) 方法级租户处理：显式标记 / RLS 事务 / 租户守卫 / 方法体内 org 谓词构建
    //    （含经 orgCondition/buildXxxConditions 等辅助函数以 <表>.orgId 构建、
    //    conditions 数组收集、globalAdmin 条件化等形态）。
    const [mStart, mEnd] = methodRegion(lines, i);
    const methodBody = lines.slice(mStart, mEnd).join('\n');
    // 租户标识符大小写混用（orgId / OrgId / viewerOrgId / primaryOrgId / OrgContext），
    // 原判定用大小写敏感的 /orgId/，于是 listSince(viewerOrgId) 这类**确实按租户
    // 过滤**的方法被误报为违规（2026-09-10 实测 11 条误报中的多数源于此）。
    // 唯一需要排除的是"读 org 列"：`orgId: t.orgId` 投影、`orgId: row.orgId` 返回
    // ——它出现 org 字样但不构成谓词，会把只按键查的裸查询误判为已覆盖。
    const predicateScope = methodBody
      .replace(/orgId:\s*\(?\s*[A-Za-z_$][\w$]*\.orgId\b/gi, 'ORG_COLUMN_READ')
      .replace(/orgId:\s*orgId\b/gi, 'ORG_COLUMN_READ')
      // 类型/字段声明（`orgId: string | null`、`orgId?: string`、`orgId: PgColumn`）
      .replace(
        /orgId\??\s*:\s*(?:string|number|boolean|null|undefined|unknown|SQL|PgColumn|[A-Z][A-Za-z0-9_]*)(?:\s*\|\s*(?:string|number|boolean|null|undefined|unknown|SQL|PgColumn|[A-Z][A-Za-z0-9_]*))*/g,
        'ORG_COLUMN_READ',
      );
    const methodEscape =
      /\/\*\s*org-scoped\s*\*\//.test(methodBody) ||
      /runInTransaction|systemTransaction/.test(methodBody) ||
      /assert\w*Tenant\w*|TenantVisible|tenant-guard|planTenantGuard/i.test(methodBody) ||
      /orgId/i.test(predicateScope) ||
      // 经辅助函数构建 org 谓词：this.orgCondition(actor) / buildXxxConditions(query, actor)
      /[A-Za-z]\w*[Cc]ond\w*\([^()]*actor/.test(methodBody);

    if (windowHasOrg || methodEscape) {
      chainsCovered++;
      continue;
    }
    violations.push({
      key: `${rel}::${varName}#${ordinal}`,
      file: rel,
      line: i + 1,
      table: tableName,
      kind,
      snippet: lines[i].trim().slice(0, 90),
    });
  }
}

check(
  'org_chains_scanned',
  chainsTotal > 100,
  `${chainsTotal} 条 org 表查询链（select/update），${chainsCovered} 条含 org 谓词/租户断言`,
);

// ── 3. 豁免清单（白名单登记制，双向比对） ───────────────────────────────────
// 登记键：<file 相对路径>::<表变量>#<文件内序号>
// 每条必须带审计编号与理由；新违规必须显式登记，否则本门禁 FAIL。
const EXEMPTIONS = [
  {
    key: 'ewoh-spark-app/server/modules/dashboard/dashboard.service.ts::ewohDevice#4',
    audit: 'NEST-206/302 簇',
    reason:
      'buildDeviceQuery(conditions: SQL[]) 为私有查询拼接 helper——org 谓词由调用方 buildDeviceConditions(query, actor)（含 ewohDevice.orgId eq）注入 conditions 数组后传入，链内无字面 orgId 属参数化谓词形态。',
  },
  {
    key: 'ewoh-spark-app/server/modules/notification/channel-dispatcher.service.ts::ewohNotification#1',
    audit: 'NEST-643 簇裁决',
    reason:
      'dispatchPending 为后台系统派发工作器（无用户 actor 上下文），跨租户扫描 pending 通知并出站推送是系统设计语义；行级 CAS（status=pending 条件更新）保证多实例幂等。',
  },
  {
    key: 'ewoh-spark-app/server/modules/notification/channel-dispatcher.service.ts::ewohNotification#2',
    audit: 'NEST-643 簇裁决',
    reason:
      '同上：后台派发工作器 sent 状态 CAS 更新（notificationId+status=pending 条件），无租户语义属系统任务设计。',
  },
  {
    key: 'ewoh-spark-app/server/modules/scheduler/plan.service.ts::ewohSchedulingPlanAssignment#2',
    audit: 'R-5 N+1 批量加载',
    reason:
      'loadAssignmentsBatched(planIds) 按 plan_id 批量取派工：ewoh_schedule_plan.plan_id 为**全局唯一**列（schema.ts:659 .unique() + 唯一索引），且 planIds 只来自上游已按 org 过滤的查询（listPlansBatched / scheduler-query），不存在跨租户命中面；方法内加 org 谓词会与"按主键批量取"语义重复。',
  },
  {
    key: 'ewoh-spark-app/server/modules/scheduler/plan.service.ts::ewohSchedulePlan#3',
    audit: 'R-5 N+1 批量加载',
    reason:
      'listPlansBatched(planIds) 同上：按全局唯一的 plan_id 批量读取，planIds 由调用方从租户作用域查询取得（scheduler-query.service.ts:260/299）。',
  },
  {
    key: 'ewoh-spark-app/server/modules/work-orchestration/domain-persistence.service.ts::ewohFactoryReplicationSessions#1',
    audit: '工厂复制（系统级）',
    reason:
      'updateReplicationSessionOn(db, sessionId, patch)：ewoh_factory_replication_sessions.session_id 为**全局唯一**列（schema.ts:1220 .unique()），且该方法只接受调用方在系统事务（systemTransaction）内传入的 db 句柄——工厂复制是跨工厂系统流程，sessionId 即全局会话键，不存在租户同号会话。',
  },
  {
    key: 'ewoh-spark-app/server/modules/organization/organization.service.ts::ewohOrganization#1',
    audit: 'NEST-231 簇裁决',
    reason:
      'ewoh_organization 是租户注册表本身（组织树管理面），跨租户列出组织为全局管理语义；控制器 @Roles(global_admin) 收敛。',
  },
  {
    key: 'ewoh-spark-app/server/modules/scale/scale.service.ts::ewohFactoryProfile#7',
    audit: 'NEST-202',
    reason:
      'isDatabaseAvailable 连通性探测（select 1 ... limit 1），源码注释明确「无租户语义的裸探测」——不返回业务数据。',
  },
  {
    key: 'ewoh-spark-app/server/modules/scheduler/world-state.service.ts::ewohWorldStateSnapshot#1',
    audit: 'NEST-101 簇',
    reason:
      'getSnapshot 按快照版本号（服务端生成的单调版本键）单条读，供调度内部回放消费；对外 HTTP 读路径走 collectState(ctx) 已透传 org 过滤（见方法注释）。',
  },
  {
    key: 'ewoh-spark-app/server/modules/simulator/simulator.service.ts::ewohEvent#1',
    audit: 'W5/simulator 裁决',
    reason:
      '模拟器状态统计：查询运行于 withSimulatorOrgContext（GUC 模拟 org）包装内（line 200 闭包），非生产数据路径。',
  },
  {
    key: 'ewoh-spark-app/server/modules/simulator/simulator.service.ts::ewohSpatialEntity#1',
    audit: 'W5/simulator 裁决',
    reason:
      '模拟器种子装载：运行于 withSimulatorOrgContext GUC 包装内（line 251 闭包），RLS 按模拟 org 过滤。',
  },
  {
    key: 'ewoh-spark-app/server/modules/simulator/simulator.service.ts::ewohSpatialEntity#2',
    audit: 'W5/simulator 裁决',
    reason: '同上：模拟器种子装载 GUC 上下文内。',
  },
  {
    key: 'ewoh-spark-app/server/modules/simulator/simulator.service.ts::ewohSpatialEntity#3',
    audit: 'W5/simulator 裁决',
    reason: '同上：模拟器种子装载 GUC 上下文内。',
  },
  {
    key: 'ewoh-spark-app/server/modules/simulator/simulator.service.ts::ewohSpatialEntity#4',
    audit: 'W5/simulator 裁决',
    reason: '同上：模拟器种子装载 GUC 上下文内。',
  },
  {
    key: 'ewoh-spark-app/server/modules/simulator/simulator.service.ts::ewohDevice#1',
    audit: 'W5/simulator 裁决',
    reason: '同上：模拟器种子装载 GUC 上下文内。',
  },
  {
    // V322：控制面 revoke 新增一条按 requestId 的命令读 ⇒ 本文件内 ewohControlCommand 的链序号整体后移一位，
    // 这条登记的序号键随之从 #6 改到 #7（判据与理由文字未变，指的仍是 collectBacklogAggregate 那条链）。
    // 序号键这种「插入即移号」的脆弱性，连同方法级 orgId 逃逸，一起登记在 ORKEY-01。
    key: 'ewoh-spark-app/server/modules/control/control.service.ts::ewohControlCommand#7',
    audit: 'V225/PROJ-06',
    reason:
      'collectBacklogAggregate（积压全量聚合，只在明细读满 BACKLOG_SCAN_CAP 时才跑）的 .where(predicate) '
      + '传入的是同类私有 backlogPredicate(orgId, cutoff, statuses) 生成的条件树，内含 '
      + 'or(eq(ewohControlCommand.orgId, orgId), isNull(ewohControlCommand.orgId))；'
      + '链内无字面 orgId 属参数化谓词形态（同 NEST-206/302 簇的既有登记形状）。'
      + '这条链与 collectBacklogRows 的明细读**共用同一棵条件树**是刻意的：总量与明细必须同口径，'
      + '把谓词抄两份正是 NO-77a 要避免的那类漂移源，故不改为调用点内联。'
      + '第二层兜底：ewoh_control_command 开着 RLS（策略 ewoh_org_visible(org_id)），'
      + '运行时句柄带 org GUC ⇒ 即使应用侧谓词被改坏，读到的也只是本租户行（V207/V208 实测机制）。',
  },
  {
    key: 'ewoh-spark-app/server/modules/tracing/tracing.service.ts::ewohTraceSpan#1',
    audit: 'NEST-tracing 裁决',
    reason:
      'enforceBounds 为 TTL + 行上限系统清理任务（无用户 actor，跨租户清理过期 trace 行为设计语义）。',
  },
];

const exemptKeys = new Set(EXEMPTIONS.map((e) => e.key));
const unregistered = violations.filter((v) => !exemptKeys.has(v.key));
for (const v of unregistered) {
  check(`org_predicate:${v.key}`, false, `${v.kind} ${v.table} @ line ${v.line}: ${v.snippet}`);
}
const stale = EXEMPTIONS.filter((e) => !violations.some((v) => v.key === e.key));
for (const e of stale) {
  check(`org_predicate_exemption_stale:${e.key}`, false, '代码中已无此违规，请从豁免清单移除（防僵尸豁免）');
}
for (const e of EXEMPTIONS) {
  if (!e.audit || !e.reason) {
    check(`org_predicate_exemption_invalid:${e.key}`, false, '豁免登记必须带 audit 编号与 reason 理由');
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`[audit-org-predicates] org 表 ${orgTables.size} 张 / 查询链 ${chainsTotal} 条 / 豁免登记 ${EXEMPTIONS.length} 条`);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-org-predicates] ${failures.length} 项失败（未登记的 org 谓词缺失或僵尸豁免）。`);
  process.exit(1);
}
console.log('[audit-org-predicates] 全部通过：org 表查询链均有谓词/租户断言或显式豁免。');
