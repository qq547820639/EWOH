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
 *     agent-task actorRole 不匹配拒绝（SH-005）——源码标记消失即 FAIL。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-state-machine-roles.js
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

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-state-machine-roles] 状态机 ${yamlFiles.length} 个（TS 强制 ${Object.keys(TS_ENFORCED).length} / draft ${DRAFT_REGISTRY.size}）`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-state-machine-roles] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log('[audit-state-machine-roles] 全部通过：transition role 非空且与 TS 锁定表双向一致。');
