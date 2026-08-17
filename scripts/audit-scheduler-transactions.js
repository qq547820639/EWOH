#!/usr/bin/env node
/**
 * 调度关键链路事务边界门禁（审计 §4 主线 7 / NEST-124~129 簇）。
 *
 * 职责（fail-closed，任一未登记违规 → 非零退出）：
 *  1. **persistPlan 调用点动态规则**：ewoh-spark-app/server/modules/scheduler
 *     全部 `*.service.ts` 中每处 `.persistPlan(` 调用（排除定义本身），其所在
 *     方法体内必须出现事务边界标记（runInTransaction / db.transaction /
 *     requestDatabaseContextSafe——后者为 runInTransaction 的安全包装），
 *     否则必须登记豁免（带审计编号与理由，双向比对防僵尸登记）；
 *  2. **关键链路清单（文档化 TCK）**：NEST-125/128/129 修复涉及的调度入口
 *     方法（replan 双入口 / 策略激活与回滚 / run 编排 persistPlan 循环）
 *     逐一断言含事务边界——新增入口或拆除事务即在本门禁爆红。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-scheduler-transactions.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHED_DIR = path.join(REPO_ROOT, 'ewoh-spark-app/server/modules/scheduler');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const TX_MARKERS = /runInTransaction|\.transaction\(|requestDatabaseContextSafe/;

const METHOD_DEF_RE = /^\s*(?:private|public|protected|readonly|static|async|override|\s)*[A-Za-z_$][\w$]*\s*(\(|\([^)]*\)\s*(:\s*[\w<>\[\]| .]+)?\s*\{)/;
const CONTROL_FLOW_RE = /^\s*(if|for|while|switch|catch|return|else|try|do|throw)\b/;

function isMethodDef(l) {
  if (CONTROL_FLOW_RE.test(l)) return false;
  const trimmed = l.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  if (l.match(/^\s*/)[0].length > 2) return false;
  return METHOD_DEF_RE.test(l);
}

function methodRegion(lines, idx) {
  let start = 0;
  for (let i = idx; i >= 0; i--) {
    if (isMethodDef(lines[i])) {
      start = i;
      break;
    }
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isMethodDef(lines[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.service.ts')) out.push(p);
  }
  return out;
}

// ── 关键链路清单（NEST-125/128/129；文件相对 scheduler 目录，方法名） ───────
const CRITICAL_CHAINS = [
  { file: 'replan-coordinator.service.ts', method: 'handleTrigger', audit: 'NEST-125/129' },
  { file: 'replan-coordinator.service.ts', method: 'handleConflictBatch', audit: 'NEST-125/129' },
  { file: 'scheduler-run-orchestrator.service.ts', method: 'createRun', audit: 'NEST-129' },
  { file: 'policy-activation.service.ts', method: 'activate', audit: 'NEST-128' },
  { file: 'policy-activation.service.ts', method: 'rollback', audit: 'NEST-128' },
];

// ── persistPlan 调用点豁免登记（带审计编号与理由） ──────────────────────────
const PERSIST_EXEMPTIONS = new Map([
  [
    'shadow-policy.service.ts::generateShadowPlan',
    'NEST-48 裁决：单次 shadow 方案持久化（非循环），事务边界在 PlanService.persistPlan 内部的 runInTransaction；无「循环半提交」原子性缺口。',
  ],
]);

const files = walk(SCHED_DIR, []).sort();
const violations = [];
const callSiteMethods = new Set();
let callSites = 0;

for (const file of files) {
  const rel = path.relative(SCHED_DIR, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/\.persistPlan\(/.test(l)) return;
    if (/async\s+persistPlan\s*\(/.test(l)) return; // 定义本身（内部自带 runInTransaction）
    callSites++;
    const [s, e] = methodRegion(lines, i);
    const body = lines.slice(s, e).join('\n');
    const methodMatch = /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(lines[s]);
    const methodName = methodMatch ? methodMatch[1] : '<unknown>';
    callSiteMethods.add(`${rel}::${methodName}`);
    if (TX_MARKERS.test(body)) return;
    const key = `${rel}::${methodName}`;
    if (PERSIST_EXEMPTIONS.has(key)) return;
    violations.push(`${rel}:${i + 1}（方法 ${methodName}）: persistPlan 调用点所在方法无事务边界标记`);
  });
}

check(
  'persistplan_callsites_transactional',
  violations.length === 0,
  violations.join(' | '),
);

// persistPlan 调用面健全性（防扫描面静默清空）
check('persistplan_callsites_sane', callSites >= 4, `发现 ${callSites} 处调用点`);

// 豁免登记必须仍与代码匹配（防僵尸登记）
const staleExemptions = [...PERSIST_EXEMPTIONS.keys()].filter((k) => !callSiteMethods.has(k));
check('persistplan_exemption_stale', staleExemptions.length === 0, staleExemptions.join(' | '));

// ── 关键链路清单断言 ─────────────────────────────────────────────────────────
for (const chain of CRITICAL_CHAINS) {
  const file = path.join(SCHED_DIR, chain.file);
  if (!fs.existsSync(file)) {
    check(`critical_chain:${chain.file}#${chain.method}`, false, '文件不存在（清单漂移）');
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const defRe = new RegExp(`(?:async\\s+)?${chain.method}\\s*\\(`);
  const defIdx = lines.findIndex((l) => defRe.test(l) && isMethodDef(l));
  if (defIdx === -1) {
    check(`critical_chain:${chain.file}#${chain.method}`, false, '方法不存在（清单漂移）');
    continue;
  }
  const [s, e] = methodRegion(lines, defIdx);
  const body = lines.slice(s, e).join('\n');
  check(
    `critical_chain:${chain.file}#${chain.method}`,
    TX_MARKERS.test(body),
    `${chain.audit} 关键链路方法缺事务边界标记`,
  );
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-scheduler-transactions] persistPlan 调用点 ${callSites} 处 / 关键链路清单 ${CRITICAL_CHAINS.length} 条 / 豁免 ${PERSIST_EXEMPTIONS.size} 条`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-scheduler-transactions] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log('[audit-scheduler-transactions] 全部通过：调度关键链路均包在事务边界内或显式豁免。');
