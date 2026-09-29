#!/usr/bin/env node
/**
 * 调度关键链路事务边界门禁（审计 §4 主线 7 / NEST-124~129 簇）。
 *
 * 职责（fail-closed，任一未登记违规 → 非零退出）：
 *  1. **persistPlan 调用点动态规则**：ewoh-spark-app/server/modules/scheduler
 *     全部 `*.service.ts` 中每处 `.persistPlan(` 调用（排除定义本身），其所在
 *     **具名定义作用域**（V190 起按花括号配定，注释/字符串/模板/正则先屏蔽）内必须
 *     出现事务边界标记（runInTransaction / db.transaction /
 *     requestDatabaseContextSafe——后者为 runInTransaction 的安全包装），
 *     否则必须登记豁免（带审计编号与理由，双向比对防僵尸登记）；
 *     作用域解析不出来的调用点记 unscoped 并判红（fail-closed，不再退回整文件）；
 *  2. **关键链路清单（文档化 TCK）**：NEST-125/128/129 修复涉及的调度入口
 *     方法（replan 双入口 / 策略激活与回滚 / run 编排 persistPlan 循环）
 *     逐一断言含事务边界——新增入口或拆除事务即在本门禁爆红；
 *  3. **run 终态单一写者（V59 试点模块化调整）**：`ewoh_scheduling_run` 的 UPDATE
 *     只允许出现在 `scheduling-run.lifecycle.ts`（`closeSchedulingRun`），其它文件
 *     要么走委托、要么登记显式豁免；并断言所有者写入口≥1、委托调用≥3、
 *     豁免清单无僵尸条目。背景：standalone_057 已把 `run_id` 单列 UNIQUE 换成
 *     `(org_id, run_id)` 复合唯一 ⇒ 裸 `where run_id` 的 UPDATE 不再天然安全。
 *
 * 作用域判据本体在 `scripts/tx-scope-shared.js`（与主线14 共用同一把尺子，V191），
 * 该共用件自带 `--self-test` 并已接进主线7 的命令块。
 *
 * 自测：`node scripts/audit-scheduler-transactions.js --self-test`
 * （喂假语料证明规则 3 能爆红、认所有者、豁免生效、抓僵尸，并成对跑新旧两档证明
 * 规则 1 的作用域收紧确实抓到跨函数/仅注释两种形状、且不误伤合法写法）。
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

/* ── GATE-16（V190）/V191：作用域判据来自共用件 scripts/tx-scope-shared.js ──────
 * 为什么抽出去：主线14（audit-public-tx-free-reads）的头注释自陈"判据与 audit-scheduler-transactions
 * 同一口径"，两处各写一份就必然漂移。屏蔽注释/字符串/模板/正则、括号配定的具名定义作用域、
 * 以及"具名回调交给执行器才算在事务内"这条外推规则都在共用件里，两边共用同一把尺子。
 * 两档环境开关（V190 留作对照）：GATE16_REGION=text|brace（默认 brace）、
 * GATE16_COMMENTS=raw|strip（默认 strip），且在读判据的时候取档 ⇒ 同进程能跑两档对照。
 */
const SCOPE = require('./tx-scope-shared.js');
const regionMode = () => (process.env.GATE16_REGION || 'brace').toLowerCase();
const commentMode = () => (process.env.GATE16_COMMENTS || 'strip').toLowerCase();
const scopeOpts = () => ({ region: regionMode(), comments: commentMode() });

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
// NEST-48 曾在此登记 `shadow-policy.service.ts::generateShadowPlan` 一条豁免。V190 实测：
// 该调用点在**两档判据下都不靠这条豁免**（`generateShadowPlan` 自己的作用域里有
// `requestDatabaseContext.runInTransaction(persistAndMarkShadow)`，V62 起就在），
// 删掉条目后两档仍全绿 ⇒ 它已是"登记着但不承重"的僵尸近亲，旧的僵尸检查按 key 比对看不见它
// （key 仍对应一个调用点方法）。故摘掉条目，并补 `persistplan_exemption_used` 检查兜住这一类。
const PERSIST_EXEMPTIONS = new Map([]);

const files = walk(SCHED_DIR, []).sort();

/**
 * 纯函数：给定「相对路径 → 原始行数组」返回 persistPlan 调用点判据的逐点读数。
 * 便于 --self-test 直接喂假语料，也便于两档对照（GATE16_REGION/GATE16_COMMENTS）。
 */
function scanPersistCallSites(entries, exemptions = PERSIST_EXEMPTIONS) {
  const violations = [];
  const unscoped = [];
  const methods = new Set();
  const usedExemptions = new Set();
  const sites = [];
  let callSites = 0;
  for (const [rel, rawLines] of entries) {
    const view = SCOPE.analyzeFile(rawLines, scopeOpts());
    view.lines.forEach((l, i) => {
      if (!/\.persistPlan\(/.test(l)) return;
      if (/async\s+persistPlan\s*\(/.test(l)) return; // 定义本身（内部自带 runInTransaction）
      callSites += 1;
      const resolved = SCOPE.resolveScope(view, i, { marker: TX_MARKERS, region: regionMode() });
      const scope = resolved.scope;
      if (!scope) {
        unscoped.push(`${rel}:${i + 1}: 调用点不在任何可解析的具名定义作用域内（fail-closed，需显式豁免）`);
        return;
      }
      const key = `${rel}::${scope.name}`;
      methods.add(key);
      const inTx = resolved.inTx;
      sites.push(`${key}@${i + 1}\t${inTx ? `tx(${resolved.via})` : exemptions.has(key) ? 'exempt' : 'bare'}`);
      if (inTx) return;
      if (exemptions.has(key)) {
        usedExemptions.add(key);
        return;
      }
      violations.push(
        `${rel}:${i + 1}（方法 ${scope.name}）: persistPlan 调用点所在作用域无事务边界标记`,
      );
    });
  }
  const staleExemptions = [...exemptions.keys()].filter((k) => !methods.has(k));
  // 另一种"僵尸登记"：key 仍对应一个调用点方法，但该调用点早已自带事务标记 ⇒ 豁免不再承重。
  // 只查 stale 看不见它（V190 实测：NEST-48 那条在两档下删掉都仍全绿）。
  const unusedExemptions = [...exemptions.keys()].filter(
    (k) => methods.has(k) && !usedExemptions.has(k),
  );
  return { violations, unscoped, callSites, methods, staleExemptions, unusedExemptions, sites };
}

const persistEntries = files.map((f) => [path.relative(SCHED_DIR, f), fs.readFileSync(f, 'utf8').split('\n')]);
const persistScan = scanPersistCallSites(persistEntries);
const violations = persistScan.violations;
const callSites = persistScan.callSites;

check(
  'persistplan_callsites_transactional',
  violations.length === 0,
  violations.join(' | '),
);
check(
  'persistplan_callsites_scoped',
  persistScan.unscoped.length === 0,
  persistScan.unscoped.join(' | '),
);

// persistPlan 调用面健全性（防扫描面静默清空）
check('persistplan_callsites_sane', callSites >= 4, `发现 ${callSites} 处调用点`);

// 豁免登记必须仍与代码匹配（防僵尸登记）
check('persistplan_exemption_stale', persistScan.staleExemptions.length === 0, persistScan.staleExemptions.join(' | '));
// 豁免必须"真的在挡东西"：不再承重的登记要摘掉（否则豁免清单只增不减，成为第二个没人读的注释区）。
check(
  'persistplan_exemption_used',
  persistScan.unusedExemptions.length === 0,
  persistScan.unusedExemptions.join(' | '),
);

// ── 关键链路清单断言 ─────────────────────────────────────────────────────────
const chainCorpus = new Map(persistEntries);
const chainReadings = [];
const chainViews = new Map([...chainCorpus].map(([k, v]) => [k, SCOPE.analyzeFile(v, scopeOpts())]));
for (const chain of CRITICAL_CHAINS) {
  const view = chainViews.get(chain.file);
  if (!view) {
    check(`critical_chain:${chain.file}#${chain.method}`, false, '文件不存在（清单漂移）');
    continue;
  }
  const defRe = new RegExp(`(?:async\\s+)?${chain.method}\\s*\\(`);
  let hit = null;
  if (regionMode() === 'brace') {
    hit = view.defs.find((d) => d.name === chain.method && defRe.test(view.lines[d.start]));
  } else {
    const defIdx = view.lines.findIndex((l) => defRe.test(l) && SCOPE.legacyIsMethodDef(l));
    if (defIdx >= 0) hit = SCOPE.legacyScope(view.lines, defIdx);
  }
  if (!hit) {
    check(
      `critical_chain:${chain.file}#${chain.method}`,
      false,
      regionMode() === 'brace' ? '方法不存在或作用域不可解析（清单漂移/形状盲区）' : '方法不存在（清单漂移）',
    );
    continue;
  }
  const body = view.lines.slice(hit.start, hit.end).join('\n');
  chainReadings.push(`${chain.file}#${chain.method}\t${hit.name}@${hit.start + 1}-${hit.end}\t${TX_MARKERS.test(body) ? 'tx' : 'bare'}`);
  check(
    `critical_chain:${chain.file}#${chain.method}`,
    TX_MARKERS.test(body),
    `${chain.audit} 关键链路方法缺事务边界标记`,
  );
}

// ── 规则 3：`ewoh_scheduling_run.status` 的单一写者（V59 试点模块化调整） ────
//
// 为什么立这条：同一个终态列原来有两个所有者——`replan-coordinator`（带 org 谓词 +
// 命中检查）与 `scheduler-run-orchestrator`（裸 `where run_id`）。而 standalone_057
// 已把 `run_id` 的单列 UNIQUE 换成 `(org_id, run_id)` 复合唯一（实测 pg_indexes），
// 所以"裸 run_id 谓词天然安全"这个前提今天并不成立：跨租户命中只剩 RLS 与
// id 不撞号在兜。收口成唯一写者之后，这条性质由门禁守住而不是靠约定。
const RUN_STATUS_OWNER = 'scheduling-run.lifecycle.ts';
const RUN_STATUS_UPDATE_RE = /\.update\(ewohSchedulingRun\)/;

/** 未来若确有需要直连 UPDATE run 表（例如只补观测列），必须在此登记并写明理由。 */
const RUN_STATUS_EXEMPTIONS = new Map([]);

function walkTs(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      walkTs(p, out);
    } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/**
 * 纯函数：给定「相对路径 → 行数组」返回违规清单（便于 --self-test 直接喂假语料）。
 *
 * 规则取"更强的那一版"：所有者之外**任何**对 `ewoh_scheduling_run` 的 UPDATE 都要显式豁免，
 * 而不是只看是否写了 `status:`。原因（实测）：所有者把 patch 作为参数传入
 * （`.set(input.patch as never)`），按"是否含 status 字面量"判会漏认所有者——
 * 判据依赖于参数形状的门禁自己就是空转门禁。
 */
function scanRunStatusWrites(fileLinesById, exemptions = RUN_STATUS_EXEMPTIONS) {
  const violations = [];
  let ownerWrites = 0;
  let delegatingCalls = 0;
  const matchedExemptions = new Set();
  for (const [rel, lines] of fileLinesById) {
    const exempted = exemptions.has(rel) ? rel : null;
    lines.forEach((l, i) => {
      if (/closeSchedulingRun\s*\(/.test(l) && !/function closeSchedulingRun/.test(l)) {
        delegatingCalls++;
      }
      if (!RUN_STATUS_UPDATE_RE.test(l)) return;
      if (rel === RUN_STATUS_OWNER) {
        ownerWrites++;
        return;
      }
      if (exempted) {
        matchedExemptions.add(exempted);
        return;
      }
      const writesStatus = /\bstatus\s*:/.test(lines.slice(i, i + 16).join('\n'));
      violations.push(
        `${rel}:${i + 1} 直接 UPDATE ewoh_scheduling_run${writesStatus ? '（改写 status）' : ''}`
        + `——必须经 ${RUN_STATUS_OWNER} 的 closeSchedulingRun，或登记显式豁免`,
      );
    });
  }
  const staleExemptions = [...exemptions.keys()].filter(
    (k) => !matchedExemptions.has(k),
  );
  return { violations, ownerWrites, delegatingCalls, staleExemptions };
}

const runStatusFiles = walkTs(SCHED_DIR, [])
  .sort()
  .map((f) => [path.relative(SCHED_DIR, f), fs.readFileSync(f, 'utf8').split('\n')]);
const runScan = scanRunStatusWrites(runStatusFiles);

check('run_status_single_writer', runScan.violations.length === 0, runScan.violations.join(' | '));
// 扫描面健全性：所有者确实存在且确有写入口；委托调用不得被悄悄清空；豁免不得变僵尸。
check('run_status_owner_present', runScan.ownerWrites >= 1, `所有者写入口 ${runScan.ownerWrites} 处`);
check('run_status_callsites_sane', runScan.delegatingCalls >= 3, `委托调用 ${runScan.delegatingCalls} 处`);
check('run_status_exemption_stale', runScan.staleExemptions.length === 0, runScan.staleExemptions.join(' | '));

// ── --sites：逐点读数（两档对照用；只读，不改判据） ──────────────────────────
if (process.argv.includes('--sites')) {
  console.log(`MODE region=${regionMode()} comments=${commentMode()}`);
  for (const s2 of persistScan.sites) console.log(`SITE\t${s2}`);
  for (const s2 of persistScan.unscoped) console.log(`UNSCOPED\t${s2}`);
  for (const s2 of chainReadings) console.log(`CHAIN\t${s2}`);
}

// ── --self-test：证明本规则既能爆红也不会空转（V41 教训：只会比对清单的门禁能给空跑判绿） ──
if (process.argv.includes('--self-test')) {
  const results = [];
  const record = (label, ok, detail = '') => results.push({ label, ok, detail });
  const corpus = [
    [RUN_STATUS_OWNER, ['  .update(ewohSchedulingRun)', '  .set(input.patch as never)']],
    ['bad.service.ts', ['  await this.db', '    .update(ewohSchedulingRun)', "      .set({ status: 'failed' })"]],
    ['impostor.ts', ['  await this.db', '    .update(ewohSchedulingRun)', '      .set(input.patch)']],
    ['observer.service.ts', ['  await this.db', '    .update(ewohSchedulingRun)', '      .set({ solverStatus: null })']],
  ];
  const s = scanRunStatusWrites(corpus);
  const redOk = s.violations.length === 3
    && s.violations.every((v) => /^(bad\.service\.ts|impostor\.ts|observer\.service\.ts):\d+/.test(v));
  const ownerOk = s.ownerWrites === 1; // 只有登记名被承认，参数化 patch 也算写入口
  const staleOk = s.staleExemptions.length === 0;
  const s2 = scanRunStatusWrites(corpus, new Map([['observer.service.ts', '只补观测列']]));
  const exemptOk = s2.violations.length === 2 && s2.staleExemptions.length === 0;
  const s3 = scanRunStatusWrites(corpus.slice(0, 3), new Map([['observer.service.ts', '只补观测列']]));
  const zombieOk = s3.staleExemptions.length === 1;
  record('规则3 能爆红（三处非所有者写）', redOk);
  record('规则3 认所有者（参数化 patch 也算写入口）', ownerOk);
  record('规则3 豁免生效', exemptOk);
  record('规则3 僵尸豁免', zombieOk);
  record('规则3 空清单', staleOk);

  /* ── GATE-16（V190）：作用域判据的正反对照 ─────────────────────────────────
   * 每条都成对跑两档：新档（brace+strip）判什么、旧档（text+raw）判什么。
   * 只在新档红、旧档绿的形状 = 本轮真补上的盲区；两档都绿的形状 = 收紧没误伤。
   */
  const scan16 = (lines, region, comments) => {
    const keep = [process.env.GATE16_REGION, process.env.GATE16_COMMENTS];
    process.env.GATE16_REGION = region;
    process.env.GATE16_COMMENTS = comments;
    try {
      return scanPersistCallSites([['f.service.ts', lines]], new Map());
    } finally {
      if (keep[0] === undefined) delete process.env.GATE16_REGION; else process.env.GATE16_REGION = keep[0];
      if (keep[1] === undefined) delete process.env.GATE16_COMMENTS; else process.env.GATE16_COMMENTS = keep[1];
    }
  };
  const CROSSFN = [
    '@Injectable()',
    'export class CrossFnSvc {',
    '  async good(planId: string) {',
    '    return this.repo.runInTransaction(async (tx: any) => tx.count(planId));',
    '  }',
    '}',
    'export async function negHelper(repo: any, plan: any) {',
    '  await repo.persistPlan(plan);',
    '}',
  ];
  const COMMENTONLY = [
    'export class CommentSvc {',
    '  async bad(plan: any) {',
    '    // runInTransaction 由下游负责（本行只是注释，不是事务）',
    '    await this.repo.persistPlan(plan);',
    '  }',
    '}',
  ];
  const ARROW = [
    'export class ArrowSvc {',
    '  async run(list: any[]) {',
    '    const rows = list.map((p: any) => this.repo.persistPlan(p));',
    '    return this.repo.runInTransaction(async (tx: any) => tx.save(rows));',
    '  }',
    '}',
  ];
  // 字符串里一个未配平的 `{`：不屏蔽注释/字符串的朴素花括号计数会让本方法的区域
  // 一路吞掉下一个方法的标记 ⇒ 旧形状给绿、新形状必须给红。
  const ODD_OPEN = [
    'export class OddSvc {',
    '  async run(plan: any) {',
    '    const odd = "open { here";',
    '    await this.repo.persistPlan(plan);',
    '  }',
    '  async other() {',
    '    return this.repo.runInTransaction(async (tx: any) => tx.save(1));',
    '  }',
    '}',
  ];
  // 反向：字符串里一个未配平的 `}` + 模板插值 + 除法。屏蔽正确时区域不提前收口 ⇒ 必须保持绿。
  const ODD_CLOSE = [
    'export class Odd2Svc {',
    '  async run(plan: any) {',
    '    const odd = "close } here";',
    '    const msg = `n=${1000 / 2} 个`;',
    '    this.repo.runInTransaction(async (tx: any) => tx.save(1));',
    '    await this.repo.persistPlan(plan);',
    '  }',
    '}',
  ];
  const TOPLEVEL = [
    'const repo = createRepo();',
    'await repo.persistPlan(plan);',
  ];
  const want = (label, got, exp) => record(label, got === exp, `实得 ${got}，期望 ${exp}`);
  const b = scan16(CROSSFN, 'brace', 'strip');
  const t = scan16(CROSSFN, 'text', 'raw');
  want('GATE-16 跨函数标记：新档必须红', b.violations.length, 1);
  want('GATE-16 跨函数标记：旧档确实绿（证明确实是本轮补上的）', t.violations.length, 0);
  record('GATE-16 跨函数标记：归因到真正持有调用点的函数', /negHelper/.test(b.violations[0] || ''), b.violations[0]);
  const b2 = scan16(COMMENTONLY, 'brace', 'strip');
  const t2 = scan16(COMMENTONLY, 'brace', 'raw');
  want('GATE-16 仅注释标记：剥注释后必须红', b2.violations.length, 1);
  want('GATE-16 仅注释标记：不剥注释确实绿（旧形状）', t2.violations.length, 0);
  want('GATE-16 同方法内箭头回调：新档不得误伤', scan16(ARROW, 'brace', 'strip').violations.length, 0);
  want('GATE-16 同方法内箭头回调：旧档也绿（无回归）', scan16(ARROW, 'text', 'raw').violations.length, 0);
  want('GATE-16 字符串未配平 `{`：屏蔽后不得跨方法借标记', scan16(ODD_OPEN, 'brace', 'strip').violations.length, 1);
  want('GATE-16 字符串未配平 `{`：不屏蔽时确实假绿（对照）', scan16(ODD_OPEN, 'brace', 'raw').violations.length, 0);
  const oc = scan16(ODD_CLOSE, 'brace', 'strip');
  want('GATE-16 字符串未配平 `}`/模板插值/除法：不得误伤', oc.violations.length + oc.unscoped.length, 0);
  const tl = scan16(TOPLEVEL, 'brace', 'strip');
  want('GATE-16 顶层裸调用：fail-closed 记 unscoped 而不是退回整文件', tl.unscoped.length, 1);
  want('GATE-16 顶层裸调用：不得被区域塌陷算成有标记', tl.violations.length, 0);
  // 豁免"登记着但不承重"必须看得见（V190 实测：旧的 stale 检查按 key 比对，看不见这一形）
  const BARE1 = ['export class ExSvc {', '  async bad(plan: any) {', '    await this.repo.persistPlan(plan);', '  }', '}'];
  const MARKED1 = ['export class ExSvc {', '  async bad(plan: any) {', '    this.repo.runInTransaction(async (tx: any) => tx.save(plan));', '    await this.repo.persistPlan(plan);', '  }', '}'];
  const exMap = new Map([['f.service.ts::bad', '演示用豁免']]);
  want('豁免在用：不得报 unused', scanPersistCallSites([['f.service.ts', BARE1]], exMap).unusedExemptions.length, 0);
  want('豁免不再承重：必须报 unused（stale 检查在此形下是绿的）', (() => {
    const r = scanPersistCallSites([['f.service.ts', MARKED1]], exMap);
    return r.unusedExemptions.length === 1 && r.staleExemptions.length === 0 && r.violations.length === 0;
  })(), true);

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`[${r.ok ? 'OK  ' : 'FAIL'}] ${r.label}${r.detail && !r.ok ? `（${r.detail}）` : ''}`);
  }
  console.log(`[self-test] ${results.length - bad.length}/${results.length} 抓到`);
  process.exit(bad.length === 0 ? 0 : 1);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-scheduler-transactions] persistPlan 调用点 ${callSites} 处 / 关键链路清单 ${CRITICAL_CHAINS.length} 条 / 豁免 ${PERSIST_EXEMPTIONS.size} 条 / run 状态写入口 ${runScan.ownerWrites} 处（委托 ${runScan.delegatingCalls} 处）`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-scheduler-transactions] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log(
  '[audit-scheduler-transactions] 全部通过：调度关键链路均包在事务边界内或显式豁免，run 终态由唯一写者收口。',
);
