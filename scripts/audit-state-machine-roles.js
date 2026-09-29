#!/usr/bin/env node
/**
 * 状态机 transition role 约束门禁（审计 §4 主线 9 / SH-004/005）。
 *
 * 职责（fail-closed，任一违反 → 非零退出）：
 *  1. 解析 contracts/state-machines/*.yaml 全部 transition（from/to/role）；
 *  2. 对「TS 强制执行」注册表内的状态机（agent-task / alert，SH-004/005 整改
 *     落地范围）：每条 transition 的 role 必须非空，且与 TS 锁定转移表
 *     （shared/agent-task.ts AGENT_TASK_TRANSITIONS、
 *     shared/alert-state-machine.ts ALERT_TRANSITIONS）逐条双向一致——
 *     删 role、改 role、漂移任一方向即 FAIL；
 *  3. 对 draft 状态机（approval/control/fleet/plan/task，1.0-draft 设计稿，
 *     尚无 TS 运行时强制）：已声明的 role 必须非空，且登记于 DRAFT_REGISTRY
 *     （审计裁决：TS 强制以 agent-task/alert 为落地范围，其余为契约冻结层
 *     设计源，不虚报覆盖）；
 *  4. fail-closed 语义钉死：alert roleSatisfies 对 undefined 拒绝（SH-004）、
 *     agent-task actorRole 不匹配拒绝（SH-005）——源码标记消失即 FAIL；
 *  5. **写入侧对账（V60）**：扫 `ewoh-spark-app/server` 里对受治理表的
 *     `.update(表)…status:'X'` 写入，双向钉两条棘轮——
 *     a) **词表**：代码写出的状态词必须出现在 contracts/state-machines 的 states 内，
 *        现存欠账登记为基线（只许缩小；变大或僵尸都 FAIL）；
 *     b) **位点**：写这张表终态的**文件集合**只许缩小（新增写者必须先裁决权威归属）。
 *     未登记的表=明确未覆盖（不虚报）。`--report-drift` 只打印当前差集。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-state-machine-roles.js
 *      [--report-drift | --self-test]（自测证明规则 5 能爆红、认位点、抓新写者）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SM_DIR = path.join(REPO_ROOT, 'contracts/state-machines');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

/** 解析 yaml transition 行：- { from: X, to: Y, role: R|\"[a, b]\", condition: C } */
function parseTransitions(file) {
  const text = fs.readFileSync(path.join(SM_DIR, file), 'utf8');
  const transitions = [];
  for (const line of text.split('\n')) {
    const m = /-\s*\{\s*from:\s*([^\s,}]+)\s*,\s*to:\s*([^\s,}]+)\s*(?:,\s*role:\s*([^,}]+))?\s*,/.exec(line);
    if (!m) continue;
    const roleRaw = (m[3] || '').trim();
    let roles = [];
    if (roleRaw.startsWith('[')) {
      roles = roleRaw
        .replace(/[\[\]']/g, '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    } else if (roleRaw) {
      roles = [roleRaw];
    }
    transitions.push({ from: m[1], to: m[2], roles });
  }
  return transitions;
}

// ── TS 强制执行注册表 ────────────────────────────────────────────────────────
const TS_ENFORCED = {
  'agent-task.yaml': {
    tsFile: 'ewoh-spark-app/shared/agent-task.ts',
    extract() {
      const src = fs.readFileSync(path.join(REPO_ROOT, this.tsFile), 'utf8');
      const arrMatch = /const AGENT_TASK_TRANSITIONS[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
      if (!arrMatch) return null;
      const entries = [];
      const re = /\{\s*from:\s*'([^']+)'\s*,\s*to:\s*'([^']+)'\s*,\s*role:\s*'([^']+)'\s*\}/g;
      let m;
      while ((m = re.exec(arrMatch[1])) !== null) {
        entries.push({ from: m[1], to: m[2], roles: [m[3]] });
      }
      return entries;
    },
  },
  'alert.yaml': {
    tsFile: 'ewoh-spark-app/shared/alert-state-machine.ts',
    extract() {
      const src = fs.readFileSync(path.join(REPO_ROOT, this.tsFile), 'utf8');
      const objMatch = /const ALERT_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\}\s*as const/.exec(src) ||
        /const ALERT_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
      if (!objMatch) return null;
      const entries = [];
      const stateRe = /^\s*(\w+):\s*\[([\s\S]*?)\]\s*,?\s*$/gm;
      let sm;
      while ((sm = stateRe.exec(objMatch[1])) !== null) {
        const entryRe = /\{\s*to:\s*'([^']+)'\s*,\s*roles:\s*\[([^\]]*)\]\s*\}/g;
        let em;
        while ((em = entryRe.exec(sm[2])) !== null) {
          const roles = em[2].replace(/'/g, '').split(',').map((r) => r.trim()).filter(Boolean);
          entries.push({ from: sm[1], to: em[1], roles });
        }
      }
      return entries;
    },
  },
};

// ── draft 状态机登记（无 TS 运行时强制——契约冻结层设计源，审计裁决） ────────
const DRAFT_REGISTRY = new Map([
  ['approval.yaml', '1.0-draft 设计源（AG-05）：TS 运行时强制以 agent-task/alert 为落地范围（spec W6/边界 3）；approval 流程角色由 approval.service 编排层校验。'],
  ['control.yaml', '1.0-draft 设计源（AG-05）：control.yaml 的 approver 角色由 control.service 编排层校验；状态机函数无 TS 锁定表。'],
  ['fleet.yaml', '1.0-draft 设计源（PX-09）：ring 发布状态机，无 TS 运行时转移函数（ring 字段而非 role 字段承载约束）。'],
  ['plan.yaml', '1.0-draft 设计源（AG-05）：plan shadow/approve 链路的 approver 角色由 policy-activation/approval 服务层强制（critical_chain 门禁覆盖事务与角色面）。'],
  ['task.yaml', '1.0-draft 设计源（AG-05）：生产任务状态机；worker/dispatcher/approver 角色由 MES/task 服务层与 RBAC 控制器 @Roles 强制。'],
]);

const yamlFiles = fs.readdirSync(SM_DIR).filter((f) => f.endsWith('.yaml')).sort();
check('sm_yaml_files_sane', yamlFiles.length >= 7, yamlFiles.join(','));

const unregistered = yamlFiles.filter(
  (f) => !TS_ENFORCED[f] && !DRAFT_REGISTRY.has(f),
);
check('sm_machine_registry_complete', unregistered.length === 0, `未登记状态机: ${unregistered}`);

for (const file of yamlFiles) {
  const transitions = parseTransitions(file);

  if (TS_ENFORCED[file]) {
    // 强制执行机：每条 transition role 非空 + 与 TS 表双向一致
    const emptyRoles = transitions.filter((t) => t.roles.length === 0 || t.roles.some((r) => !r));
    check(
      `sm_role_nonempty:${file}`,
      emptyRoles.length === 0,
      emptyRoles.map((t) => `${t.from}->${t.to}`).join(','),
    );

    const tsEntries = TS_ENFORCED[file].extract();
    check(`sm_ts_table_parsed:${file}`, tsEntries !== null && tsEntries.length > 0);
    if (tsEntries) {
      const key = (t) => `${t.from}->${t.to}`;
      const yamlMap = new Map(transitions.map((t) => [key(t), t.roles]));
      const tsMap = new Map(tsEntries.map((t) => [key(t), t.roles]));
      const missingInTs = [...yamlMap.keys()].filter((k) => !tsMap.has(k));
      check(`sm_ts_covers_yaml:${file}`, missingInTs.length === 0, missingInTs.join(','));
      const extraInTs = [...tsMap.keys()].filter((k) => !yamlMap.has(k));
      check(`sm_yaml_covers_ts:${file}`, extraInTs.length === 0, extraInTs.join(','));
      const roleDrift = [...yamlMap.keys()].filter(
        (k) => tsMap.has(k) && JSON.stringify(tsMap.get(k)) !== JSON.stringify(yamlMap.get(k)),
      );
      check(
        `sm_role_parity:${file}`,
        roleDrift.length === 0,
        roleDrift.map((k) => `${k} yaml=${yamlMap.get(k)} ts=${tsMap.get(k)}`).join(' | '),
      );
      const tsEmptyRole = tsEntries.filter((t) => t.roles.length === 0);
      check(`sm_ts_role_nonempty:${file}`, tsEmptyRole.length === 0);
    }
  } else if (DRAFT_REGISTRY.has(file)) {
    // draft 机：已声明的 role 必须非空（防设计稿倒退）
    const declaredEmpty = transitions.filter(
      (t) => t.roles.length > 0 && t.roles.some((r) => !r),
    );
    check(
      `sm_draft_declared_roles_nonempty:${file}`,
      declaredEmpty.length === 0,
      declaredEmpty.map((t) => `${t.from}->${t.to}`).join(','),
    );
    // 至少存在 transition（防文件被清空）
    check(`sm_draft_transitions_present:${file}`, transitions.length > 0, `${transitions.length} 条`);
  }
}

// ── fail-closed 语义源码标记（SH-004/005） ──────────────────────────────────
const alertSrc = fs.readFileSync(
  path.join(REPO_ROOT, 'ewoh-spark-app/shared/alert-state-machine.ts'),
  'utf8',
);
check(
  'sm_alert_failclosed_undefined_role',
  /actorRole != null && HANDLER_ROLES\.has\(actorRole\)/.test(alertSrc) && /actorRole === required/.test(alertSrc),
  'roleSatisfies 必须对 undefined fail-closed（SH-004）',
);
const agentTaskSrc = fs.readFileSync(
  path.join(REPO_ROOT, 'ewoh-spark-app/shared/agent-task.ts'),
  'utf8',
);
check(
  'sm_agent_task_role_mismatch_denied',
  // R2-SHR-004 后语义更严：actorRole 缺省即拒绝（无 undefined 旁路），
  // 仅角色精确匹配放行——门禁同步锁定新不变量。
  /return match\.role === actorRole;/.test(agentTaskSrc)
    && !/if \(actorRole === undefined\) return true;/.test(agentTaskSrc),
  'actorRole 不匹配必须拒绝（SH-005 + R2-SHR-004：缺省亦拒绝，fail-closed 无旁路）',
);

// ── 规则 5：写入侧状态词表漂移棘轮（V60，链内第二类试点） ───────────────────
//
// 契约（contracts/state-machines/*.yaml）声明"允许哪些状态"，代码里 `.set({status:'X'})`
// 写的是"实际会写哪些状态"。这两件事今天没有任何对账：`plan.yaml` 声明 7 个状态，
// 而写入侧出现的词远超它——于是"改一处状态词表会不会撞别的流程"没人能回答。
// 本规则把差集钉成**只许缩小**的基线（与 tests/ci-skip-baseline 的跳过棘轮同形）：
//  ① 漂移变多 ⇒ FAIL；② 基线里有条目在代码里消失了却不更新基线 ⇒ FAIL（防僵尸登记）；
//  未登记的表 = 明确未覆盖（不虚报覆盖面）。
// 动态 patch（`.set(input.patch)`）会记成 `__dynamic__`：所有者把状态当参数传时，
// 门禁必须看得见"这里写的是状态"，否则就又是 V59 那种自证空的判据。
const WRITER_DRIFT_TARGETS = [
  { table: 'ewohSchedulePlan', contract: 'plan.yaml' },
  { table: 'ewohControlCommand', contract: 'control.yaml' },
];
const WRITER_DRIFT_ROOT = path.join(REPO_ROOT, 'ewoh-spark-app/server');

function walkTsFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      walkTsFiles(p, out);
    } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function parseDeclaredStates(file) {
  const text = fs.readFileSync(path.join(SM_DIR, file), 'utf8');
  const block = /^states:\s*$([\s\S]*?)(?=^\S)/m.exec(text);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((l) => /^\s*-\s*([\w-]+)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** 纯函数（可被 --self-test 直接喂语料）：归纳各表被写入的状态词与写入位点。 */
function scanWrittenStatesFromText(entries) {
  const written = new Map();
  const sites = new Map();
  for (const { table } of WRITER_DRIFT_TARGETS) {
    written.set(table, new Set());
    sites.set(table, new Set());
  }
  for (const [rel, lines] of entries) {
    lines.forEach((l, i) => {
      for (const { table } of WRITER_DRIFT_TARGETS) {
        // V312：取词面补 INSERT 侧。原先只认 `.update(表)`，于是"只在创建时写入"的态
        // （如 ewoh_schedule_plan 的 `proposed`，它同时是该列的 DDL 默认值）**从未进过欠账基线**，
        // 那份"代码越表"清单其实是不完整的。位点集合不改（INSERT 不算终态写位点，避免与规则 6 串台）。
        const isInsert = new RegExp(`\\.insert\\(${table}\\)`).test(l);
        if (!isInsert && !new RegExp(`\\.update\\(${table}\\)`).test(l)) continue;
        const window = lines.slice(i, i + (isInsert ? 12 : 18)).join('\n');
        // 只认字面量状态；参数化 patch 由「写入位点」这一维度负责（位点可数，词表不可数）。
        if (!/\bstatus\s*:/.test(window)) continue;
        sites.get(table).add(rel);
        const re = /(?:^|[{,\s])status\s*:\s*'([\w-]+)'/g;
        let m;
        while ((m = re.exec(window)) !== null) written.get(table).add(m[1]);
      }
    });
  }
  return { written, sites };
}

function scanWrittenStates(files) {
  return scanWrittenStatesFromText(
    files.map((f) => [path.relative(WRITER_DRIFT_ROOT, f), fs.readFileSync(f, 'utf8').split('\n')]),
  );
}

/** 纯函数：观测集合与基线双向比对（变大 / 变僵尸）。 */
function diffDrift(observed, baseline) {
  const list = [...observed].sort();
  return {
    grown: list.filter((x) => !baseline.has(x)),
    stale: [...baseline].filter((x) => !list.includes(x)),
  };
}

// 词表漂移基线（登记=已知欠账，只许缩小）。
// plan：`confirmed/rejected` 来自 legacy confirmPlan 面（与 V2 的 `approved` 是**同一个业务动作
//   的两个名字**）；`cancelled/superseded` 完全不在契约词表内。收敛哪一个属产品裁决
//   （改词表=改审批权威），本门禁只把欠账钉住。
const WRITER_DRIFT_BASELINE = new Map([
  // V312：取词面补了 INSERT 的 .values() 侧之后，两条**一直存在但从没被看见**的欠账同时报红，
  // 这里登记而不是回退可见性——
  //   · `proposed`：它同时是 ewoh_schedule_plan.status 的 DDL 默认值（schema.ts:1458 /
  //     standalone_006_scheduling.sql:72），又被 gamification 两条创建路径显式写；
  //     plan.yaml 的 states 里没有它 ⇒ 契约缺态还是代码越态待拍（登记册 PLANV-01）。
  //   · `sent`：命令表的**attempt 级**词（§5.3n2 ④ 已记 attempt 词不属于请求级 states），
  //     而本门禁把请求级 control.yaml 挂给了命令表 ⇒ 这正是 TBLST/WDRV-01 说的"表↔词表↔级别"缺机读归属的实锤。
  ['plan.yaml', new Set(['confirmed', 'rejected', 'cancelled', 'superseded', 'proposed'])],
  ['control.yaml', new Set(['sent'])],
]);
// 写入位点（谁能改这张表的终态）——同一条棘轮：只许缩小。V60 实测现状：
// plan 4 个文件（派工 / V2 审批 / legacy 确认 / 沙箱），command 1 个文件。
// V79（试点第三个边界样本）：`status='dispatched'` 原来有**两个**各自维护 CAS 的写者
// （`dispatch-coordinator` 的 approved→dispatched 与 `gamification` 派工旁路的 confirmed→dispatched）。
// 现收进 `scheduling-plan.lifecycle.ts#markPlanDispatched` 这一处：旁路不再直接写状态，改为声明
// 自己的前置状态并调用同一入口 ⇒ 该文件从基线消失、生命周期模块接替其位。
// 文件数不变（4→4），**变的是同一条终态写入的守卫实现点 2→1**；批准词表本身未动
// （`approved` 与 `confirmed` 仍并存，属 F-11 未决项，本样本不越权收敛）。
const WRITER_SITE_BASELINE = new Map([
  [
    'ewohSchedulePlan',
    new Set([
      'modules/scheduler/scheduling-plan.lifecycle.ts',
      'modules/scheduler/dispatch-coordinator.service.ts',
      'modules/scheduler/plan.service.ts',
      'modules/scheduler/scheduler-plan-application.service.ts',
      // V312：INSERT 侧取词后显形——它一直在**创建时**写方案状态（status: 'proposed'，:296/:486），
      // 原先只扫 UPDATE 所以没进过位点基线。这不改变 V79 那条"派工终态只有一个入口"的结论。
      'modules/gamification/gamification.service.ts',
    ]),
  ],
  ['ewohControlCommand', new Set(['modules/control/control.service.ts'])],
]);
const NOT_COVERED = ['task.yaml', 'approval.yaml', 'agent-task.yaml', 'alert.yaml', 'fleet.yaml'];

const driftScan = scanWrittenStates(walkTsFiles(WRITER_DRIFT_ROOT, []));
const driftReport = [];
for (const { table, contract } of WRITER_DRIFT_TARGETS) {
  const declared = new Set(parseDeclaredStates(contract));
  const written = driftScan.written.get(table) ?? new Set();
  const sites = driftScan.sites.get(table) ?? new Set();
  const undeclared = [...written].filter((x) => !declared.has(x)).sort();
  const wordDiff = diffDrift(undeclared, WRITER_DRIFT_BASELINE.get(contract) ?? new Set());
  const siteDiff = diffDrift(sites, WRITER_SITE_BASELINE.get(table) ?? new Set());
  driftReport.push(
    `${contract}(${table}): 写入 ${written.size} 词 / 契约声明 ${declared.size} 词 / `
    + `词表漂移 ${undeclared.length} [${undeclared.join(',')}] / 写入文件 ${sites.size} 个 [${[...sites].join(' ')}]`,
  );
  check(`sm_writer_drift_${contract}_no_growth`, wordDiff.grown.length === 0, `未登记的写入状态: ${wordDiff.grown.join(',')}`);
  check(`sm_writer_drift_${contract}_no_zombie`, wordDiff.stale.length === 0, `词表基线已消失，请删掉它: ${wordDiff.stale.join(',')}`);
  check(`sm_writer_sites_${table}_no_new_writer`, siteDiff.grown.length === 0, `新增状态写入文件（先裁决权威归属再登记）: ${siteDiff.grown.join(', ')}`);
  check(`sm_writer_sites_${table}_no_zombie`, siteDiff.stale.length === 0, `位点基线已消失: ${siteDiff.stale.join(', ')}`);
  // 覆盖面健全性：扫描面被清空（改路径/改表名）必须变红，而不是悄悄全绿。
  check(`sm_writer_scan_nonempty_${table}`, written.size > 0, `扫到 0 个写入状态（扫描面疑似失效）`);
}

// 报告模式只**追加打印**，不提前 exit：一旦在这里 exit(0)，前面累计的失败就再也打不出来
// （实测第一版就被我自己这样掩盖过一次：基线为空、明明有 1 个未防护位点，命令仍 rc=0）。
if (process.argv.includes('--report-drift')) {
  console.log('[drift] ' + driftReport.join('\n[drift] '));
  console.log(`[drift] 未覆盖（明确登记，不虚报）: ${NOT_COVERED.join(', ')}`);
}

// ── 规则 6：状态写入的**谓词强度**棘轮（V63，F-12 类） ──────────────────────
/**
 * 纯函数：对每个「写 status 的 UPDATE 位点」判它的 WHERE 段里看得见什么谓词。
 *
 * 为什么要有这条：V63 实测到 `replan` 把**已驳回**与**已派工**的方案都改成 `superseded`
 * （`plan.service.ts:1400-1403`：`where plan_id` 而已，无 status/version 谓词、无
 * `.returning()`），而源方案是在事务**外**读的（:1272），读写之间还夹着求解器 ⇒ 这是一个
 * 秒级的丢失更新窗口。词表/位点两条棘轮（规则 5）抓不到这种形态：**同一个合法状态词、
 * 同一个已登记文件**，坏的是"无条件改写"这件事本身。
 *
 * 判据的局限必须写清（否则这条门禁会骗人）：
 *  ① 它只看位点周围窗口内的**字面**谓词。若某处把 where 交给 helper 动态拼装，这里会被
 *     算成「未防护」。
 *  ② 另一侧同样受限：`.set(input.patch)` 这种把状态当参数传进来的写法**不会**被认成状态写入
 *     （那类由规则 5 的"位点"维度负责——同一条 V59 教训：判据依赖参数形状就等于空转）。
 *  ③ 键是 `文件#所写字面状态` 而不是行号：行号会让基线在任何一次上方改动后同时报
 *     "新增 + 僵尸"两条红，逼人反复重登记，棘轮就废了。代价是同一文件里写同一状态的
 *     两个位点会并成一个键（少报不虚报），报告里会如实打印键的形态。
 * 所以本规则是**只许缩小的欠账登记**，不是"带谓词=安全"的证明；它承诺的是
 * "新增未防护位点必红、欠账被修掉后基线不删也必红"，不承诺覆盖动态拼装与参数化 set。
 */
const GUARD_WINDOW = 26;
const STATUS_PREDICATE_RE =
  /(?:\b(?:eq|ne|inArray|notInArray|gt|gte|lt|lte)\(\s*[\w.]+\.(?:status|version)\b)/;

function scanStatusWriteGuardsFromText(entries) {
  const guarded = new Set();
  const unguarded = new Set();
  for (const [rel, lines] of entries) {
    lines.forEach((l, i) => {
      for (const { table } of WRITER_DRIFT_TARGETS) {
        if (!new RegExp(`\\.update\\(${table}\\)`).test(l)) continue;
        const win = lines.slice(i, i + GUARD_WINDOW).join('\n');
        const whereAt = win.indexOf('.where(');
        const setPart = whereAt === -1 ? win : win.slice(0, whereAt);
        // 只判"这一处 UPDATE 是否写 status"；不写 status 的更新与本规则无关。
        if (!/\bstatus\s*:/.test(setPart)) continue;
        const wherePart = whereAt === -1 ? '' : win.slice(whereAt);
        const literal = /(?:^|[{,\s])status\s*:\s*'([\w-]+)'/.exec(setPart);
        const key = literal ? `${rel}#${literal[1]}` : `${rel}:L${i + 1}`;
        (STATUS_PREDICATE_RE.test(wherePart) ? guarded : unguarded).add(key);
      }
    });
  }
  return { guarded, unguarded };
}

function scanStatusWriteGuards(files) {
  return scanStatusWriteGuardsFromText(
    files.map((f) => [path.relative(WRITER_DRIFT_ROOT, f), fs.readFileSync(f, 'utf8').split('\n')]),
  );
}

// 未防护位点基线（登记=已知欠账，只许缩小）。V63 实测：全仓 11 处状态写入 UPDATE 里
// **只有 1 处**看不见 status/version 谓词——`plan.service.ts:1401` 的 replan supersede
// （键形态 `文件#所写状态` ⇒ 登记为 `plan.service.ts#superseded`），
// 也就是 F-12（§5.4/§5.3s）那条被 e2e 独立测到的无条件改写。修掉它时请把本基线清空。
const STATUS_GUARD_BASELINE = new Set(['modules/scheduler/plan.service.ts#superseded']);

const guardScan = scanStatusWriteGuards(walkTsFiles(WRITER_DRIFT_ROOT, []));
const guardDiff = diffDrift(guardScan.unguarded, STATUS_GUARD_BASELINE);
const guardReport = [];
guardReport.push(
  `状态写入位点 ${guardScan.guarded.size + guardScan.unguarded.size} 处：`
  + `带 status/version 谓词 ${guardScan.guarded.size} / 未防护 ${guardScan.unguarded.size}`,
);
check(
  'sm_status_guard_no_new_unguarded_site',
  guardDiff.grown.length === 0,
  `新增「无条件改写状态」的 UPDATE 位点（F-12 同形态，改条件式 + .returning() 再来登记）: `
  + guardDiff.grown.join(', '),
);
check(
  'sm_status_guard_no_zombie',
  guardDiff.stale.length === 0,
  `基线里的未防护位点已消失（欠账被修掉了，请把基线同步缩小）: ${guardDiff.stale.join(', ')}`,
);
check(
  'sm_status_guard_scan_nonempty',
  guardScan.guarded.size + guardScan.unguarded.size > 0,
  '状态写入位点扫到 0 处（扫描面疑似失效）',
);

if (process.argv.includes('--report-guard')) {
  console.log('[guard] ' + guardReport.join('\n[guard] '));
  console.log(`[guard] 未防护位点 ${guardScan.unguarded.size}:\n  ${[...guardScan.unguarded].sort().join('\n  ')}`);
  console.log(`[guard] 已防护位点 ${guardScan.guarded.size}:\n  ${[...guardScan.guarded].sort().join('\n  ')}`);
}

// ── 规则 5 自测（V41 教训：能给空跑判绿的模式不配当门禁） ───────────────────
if (process.argv.includes('--self-test')) {
  const corpus = [
    ['modules/some/new-writer.service.ts', [
      '  await this.db',
      '    .update(ewohSchedulePlan)',
      "    .set({ status: 'brand_new_state' })",
      '    .where(eq(ewohSchedulePlan.planId, planId));',
    ]],
    ['modules/control/control.service.ts', [
      '      .update(ewohControlCommand)',
      "      .set({ status: 'revoked', revokedReason: reason })",
      '      .where(and(',
    ]],
  ];
  const s = scanWrittenStatesFromText(corpus);
  const litOk = s.written.get('ewohSchedulePlan').has('brand_new_state');
  const siteOk = s.sites.get('ewohSchedulePlan').has('modules/some/new-writer.service.ts');
  const growOk = diffDrift(['a', 'b'], new Set(['a'])).grown.join() === 'b';
  const zombieOk = diffDrift(['a'], new Set(['a', 'b'])).stale.join() === 'b';
  const cleanOk = diffDrift(['a'], new Set(['a'])).grown.length === 0;
  const newWriterRed = diffDrift(
    s.sites.get('ewohSchedulePlan'),
    WRITER_SITE_BASELINE.get('ewohSchedulePlan'),
  ).grown.length === 1;
  // ── 规则 5 补臂（V312）：新建侧取词必须开火 ──────────────────────────
  // 只在 INSERT 的 .values() 里出现的态必须被取到（反向：只读不写不许取）。
  // 用模板字面量写多行语料——双引号字符串里塞真换行是非法 JS（第一版就是这么写炸过一次）。
  const insCorpus = [['ins.ts', [
    '      await db.insert(ewohSchedulePlan).values({',
    "        status: 'proposed',",
    '        x: 1,',
    '      });',
  ]]];
  const insW = scanWrittenStatesFromText(insCorpus).written.get('ewohSchedulePlan');
  const insOk = !!insW && insW.has('proposed');
  const readOnlyCorpus = [['r.ts', [
    '      await db.insert(ewohSchedulePlan).values({',
    "        note: 'proposed',",
    '      });',
  ]]];
  const readOnlyW = scanWrittenStatesFromText(readOnlyCorpus).written.get('ewohSchedulePlan');
  const insNegOk = !readOnlyW || !readOnlyW.has('proposed');
  console.log(`[self-test 规则5·新建侧] INSERT values 认态=${insOk ? 'OK' : 'FAIL'} `
    + `只读不写不认=${insNegOk ? 'OK' : 'FAIL'}`);
  if (!insOk || !insNegOk) fails.push('规则5 新建侧取词失效');
  console.log(
    `[self-test 规则5] 认字面量=${litOk ? 'OK' : 'FAIL'} 认位点=${siteOk ? 'OK' : 'FAIL'}`
    + ` 词表变大报红=${growOk ? 'OK' : 'FAIL'} 僵尸报红=${zombieOk ? 'OK' : 'FAIL'}`
    + ` 无漂移不误报=${cleanOk ? 'OK' : 'FAIL'} 新写者报红=${newWriterRed ? 'OK' : 'FAIL'}`,
  );
  // ── 规则 6 自测：谓词强度判据能不能爆红 ──────────────────────────────
  const corpus6 = [
    ['modules/x/unguarded.service.ts', [
      '      .update(ewohSchedulePlan)',
      "      .set({ status: 'superseded', supersededBy: newPlanId })",
      '      .where(eq(ewohSchedulePlan.planId, planId));',
    ]],
    ['modules/x/guarded.service.ts', [
      '      .update(ewohSchedulePlan)',
      "      .set({ status: 'rejected' })",
      '      .where(and(',
      '        eq(ewohSchedulePlan.planId, planId),',
      '        eq(ewohSchedulePlan.status, plan.status),',
      '      ))',
    ]],
    ['modules/x/version-guarded.service.ts', [
      '      .update(ewohControlCommand)',
      "      .set({ status: 'revoked' })",
      '      .where(and(eq(ewohControlCommand.commandId, id),',
      '        eq(ewohControlCommand.version, v)))',
    ]],
    ['modules/x/not-a-status-write.service.ts', [
      '      .update(ewohSchedulePlan)',
      '      .set({ planName: \'x\' })',
      '      .where(eq(ewohSchedulePlan.planId, planId));',
    ]],
  ];
  const g6 = scanStatusWriteGuardsFromText(corpus6);
  const g6Unguarded = g6.unguarded.has('modules/x/unguarded.service.ts#superseded');
  const g6Guarded = g6.guarded.has('modules/x/guarded.service.ts#rejected')
    && g6.guarded.has('modules/x/version-guarded.service.ts#revoked');
  const g6IgnoresNonStatus = ![...g6.unguarded, ...g6.guarded].some((k) => k.includes('not-a-status-write'));
  const g6RedOnNew = diffDrift(g6.unguarded, new Set()).grown.length === 1;
  const g6RedOnZombie = diffDrift(new Set(), g6.unguarded).stale.length === 1;
  console.log(
    `[self-test 规则6] 认未防护位点=${g6Unguarded ? 'OK' : 'FAIL'}`
    + ` 认 status/version 两类谓词=${g6Guarded ? 'OK' : 'FAIL'}`
    + ` 不写 status 的更新不介入=${g6IgnoresNonStatus ? 'OK' : 'FAIL'}`
    + ` 新增未防护报红=${g6RedOnNew ? 'OK' : 'FAIL'} 僵尸报红=${g6RedOnZombie ? 'OK' : 'FAIL'}`,
  );
  const selfTestOk = litOk && siteOk && growOk && zombieOk && cleanOk && newWriterRed
    && g6Unguarded && g6Guarded && g6IgnoresNonStatus && g6RedOnNew && g6RedOnZombie;
  // 报告/自测模式都不许掩盖前面 check() 记下的失败（否则"--self-test 绿"会变成假绿）。
  process.exit(selfTestOk && failures.length === 0 ? 0 : 1);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-state-machine-roles] 状态机 ${yamlFiles.length} 个（TS 强制 ${Object.keys(TS_ENFORCED).length} / draft ${DRAFT_REGISTRY.size}）；写入侧漂移对账 ${WRITER_DRIFT_TARGETS.length} 张表`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-state-machine-roles] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log('[audit-state-machine-roles] 全部通过：transition role 非空且与 TS 锁定表双向一致。');
