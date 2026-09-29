#!/usr/bin/env node
/**
 * 一问（V157）：链上每张权威表的 status/state 列，**每一个写入点的 WHERE 里有没有"来源态谓词"**？
 *
 * 为什么问这一层：`write-fanout.cjs`（V120）量的是"同一列今天有几处能改"——**数量**。
 * V156 却发现自己把 `closeSchedulingRun` 误算进 CAS 一族：它的 UPDATE 只有 `(run_id, org_id)`，
 * 数量上它是"唯一写者"，强度上它**没有守卫**（真库实测终态可被后到的写静默覆盖，RUN-02）。
 * ⇒ 数量降了不等于闸在。这一层必须单独量。
 *
 * 与 V156 的方法教训对齐：**语句文本里出现 `status` 不算**（那是渲染 WHERE 的 mock 判据能看到的极限）。
 * 本量具只认 AST：status/state 列必须出现在**谓词调用（eq/ne/inArray/…）的第一个实参位**，
 * 且该谓词在 `.where(...)` 的子树里；写进 `set(...)` 的那一侧永远不算。
 *
 * 三态纪律：认不出来的（`where` 收的是变量、展开数组、包装函数）记 `dynamic-where`，
 * **不折算成"无守卫"**——把"我看不见"写成"代码有问题"是假缺陷。
 *
 * 校准（已知答案必须对上，否则不出数）：
 *   agent `transition`      ⇒ state-guard（row-ref）+ 0 行分支抛错  ← V155
 *   plan `markPlanDispatched` ⇒ state-guard（input-ref）+ returning  ← V79
 *   run  `closeSchedulingRun` ⇒ identity-only（无来源态谓词）        ← V156
 *
 * 用法：node scripts/chain-baseline/status-write-guard-census.cjs [--self-test|--json]
 * 退出码：0=度量成功且校准全对；1=校准不符或判据自测未抓到；3=语料读不到（不可判）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');
const SCAN_ROOT = path.join(ROOT, 'ewoh-spark-app/server');
const SCAN_REL = 'ewoh-spark-app/server';
const SCHEMA = path.join(ROOT, 'ewoh-spark-app/server/database/schema.ts');

/** 与 write-fanout.cjs 同一份权威事实清单（不另起口径）。 */
const FACTS = [
  ['ewohSchedulingRun', '调度 run 闭合（终态）'],
  ['ewohSchedulePlan', '方案状态（含 dispatched）'],
  ['ewohSchedulingPlanAssignment', '方案-任务关联状态'],
  ['ewohSchedulingExecution', '执行记录状态'],
  ['ewohProductionTask', '生产任务状态'],
  ['ewohControlRequest', '高危控制请求状态'],
  ['ewohControlCommand', '控制命令状态（sent/delivered/expired）'],
  ['ewohControlResult', '控制结果状态'],
  ['ewohAgentApproval', '审批实例状态'],
  ['ewohAgentTask', 'AgentTask 状态（链外样本）'],
];
const STATE_COLS = new Set(['status', 'state']);
/** 谓词调用：第一实参位是"被比较的列"。 */
const PREDICATES = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'inArray', 'notInArray', 'like', 'ilike']);
const CALIBRATION = {
  'scheduling-run.lifecycle.ts#closeSchedulingRun': 'identity-only',
  'scheduling-plan.lifecycle.ts#markPlanDispatched': 'state-guard',
  'agent-orchestrator.service.ts#transition': 'state-guard',
};

function listTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listTs(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 纯函数：给定源文本，抽出所有 `<db>.update(<表变量>)` 链并分类守卫强度。 */
function classifySource(src, fileName, tableSet) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const sites = [];
  const colName = (node) => {
    if (!node) return null;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isIdentifier(node)) return node.text;
    return null;
  };
  /** 谓词子树里是否存在"状态列出现在谓词第一实参位"，以及是否有**看不见 contents 的谓词位**
   *  （spread、and/or 里挂变量/非谓词调用）。后者必须优先于"无守卫"的结论——
   *  把"我看不见那个谓词"写成"这段代码没有守卫"是假缺陷（自测 dynamic-where 抓到过一次的镜像形状）。 */
  function scanPredicates(node) {
    let found = false;
    let shape = null;
    let dyn = false;
    const unwrap = (n) => (ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n) || ts.isAsExpression(n)
      ? unwrap(n.expression) : n);
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const fn = colName(n.expression);
        if (fn && PREDICATES.has(fn) && n.arguments.length >= 1) {
          const first = colName(n.arguments[0]);
          if (first && STATE_COLS.has(first)) {
            found = true;
            const v = n.arguments[1];
            if (!v) shape = shape || 'no-value';
            else if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) shape = shape || 'literal';
            else if (ts.isPropertyAccessExpression(v) && v.name.text === 'status') shape = shape || 'row-ref';
            else if (ts.isIdentifier(v) || ts.isPropertyAccessExpression(v)) shape = shape || 'input-ref';
            else shape = shape || 'unresolved';
          }
        }
        if (fn === 'and' || fn === 'or') {
          for (const a of n.arguments) {
            const core = ts.isSpreadElement(a) ? unwrap(a.expression) : unwrap(a);
            const inner = ts.isCallExpression(core) ? colName(core.expression) : null;
            if (!inner || !PREDICATES.has(inner)) dyn = true;   // 变量/spread/包装 ⇒ 看不见
          }
        }
      }
      ts.forEachChild(n, visit);
      return false;
    };
    visit(node);
    return { found, shape, dyn };
  }
  /** set(...) 那侧到底改没改状态列：这是分母的第二根轴——
   *  "对权威表做 UPDATE" ≠ "写 status 列"，把它们混成一个分母就会把只改 taskJson 的语句算成状态写者。 */
  function scanSetTarget(setArgs) {
    const a = setArgs && setArgs[0];
    if (!a) return 'no-set';
    const core = ts.isParenthesizedExpression(a) ? a.expression : a;
    if (ts.isObjectLiteralExpression(core)) {
      for (const prop of core.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const n = ts.isIdentifier(prop.name) ? prop.name.text
            : ts.isStringLiteral(prop.name) ? prop.name.text : '';
          if (STATE_COLS.has(n)) return 'yes';
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          // `.set({ status, updatedAt })`：简写属性同样是写状态列。V284 前这一支整个漏掉，
          // 站点会走到循环末尾返回 'no' ⇒ 不是降档，是从分母里消失（实测产品面丢 10 处）。
          if (STATE_COLS.has(prop.name.text)) return 'yes';
        } else if (ts.isSpreadAssignment(prop)) return 'dynamic';   // {...patch}
      }
      return 'no';
    }
    return 'dynamic';                                                // 变量/成员访问/展开
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'update' && node.arguments.length === 1) {
      const t = colName(node.arguments[0]);
      if (t && tableSet.has(t)) {
        // 沿链向上收方法名与实参（update().set().where().returning()）
        const chain = [];
        const args = {};
        let cur = node;
        while (cur && ts.isCallExpression(cur)) {
          const m = ts.isPropertyAccessExpression(cur.expression) ? cur.expression.name.text : '?';
          chain.push(m);
          args[m] = cur.arguments;
          const parent = cur.parent;
          cur = parent && ts.isPropertyAccessExpression(parent) ? parent.parent : null;
        }
        const whereArg = (args.where || [])[0];
        let guard = 'no-where';
        let valueShape = null;
        let partial = false;
        if (whereArg) {
          const opaque = !(ts.isCallExpression(whereArg) || ts.isParenthesizedExpression(whereArg));
          const pred = ts.isCallExpression(whereArg) ? scanPredicates(whereArg) : { found: false, shape: null, dyn: false };
          if (pred.found) {
            guard = 'state-guard';
            valueShape = pred.shape;
            partial = pred.dyn;               // 守卫找到了，但同一谓词里还有看不见 contents 的位置
          } else if (opaque || pred.dyn) {
            guard = 'dynamic-where';          // 宁可"看不见"，不折算成"无守卫"
          } else {
            guard = 'identity-only';
          }
        }
        // 0 行分支的窗口：从本语句起、往后取到所在块的下一条语句（近似，只作标注不作判据）
        const zeroWindow = (() => {
          let st = node;
          while (st.parent && !ts.isBlock(st.parent) && !ts.isSourceFile(st.parent)) st = st.parent;
          const end = Math.min(src.length, st.getEnd() + 900);
          return src.slice(st.getStart(), end);
        })();
        const writesStatus = args.set ? scanSetTarget(args.set) : 'no-set';
        sites.push({
          writesStatus,
          file: fileName.replace(`${ROOT}/`, ''),
          line: (sf.getLineAndCharacterOfPosition(node.getStart()).line + 1),
          table: t,
          chain: chain.join('>'),
          guard,
          valueShape,
          partial,
          returning: chain.includes('returning'),
          zeroBranch: /length === 0|length > 0|!rows|=== 0/.test(zeroWindow),
        });
      }
    }
    ts.forEachChild(node, visit);
    return false;
  };
  visit(sf);
  return sites;
}

/** 判据自测：四类形状各一条，逐格对上真值（不是"结果非零"）。 */
function selfTest(tableSet) {
  const FIX = [
    ['guarded-literal.ts', `db.update(ewohControlCommand).set({ status: 'sent' }).where(and(eq(ewohControlCommand.id, id), eq(ewohControlCommand.status, 'pending')));`,
      (s) => s[0].guard === 'state-guard' && s[0].valueShape === 'literal'],
    ['guarded-input.ts', `db.update(ewohSchedulePlan).set({ status: 'dispatched' }).where(and(eq(planId, id), eq(status, input.fromStatus))).returning();`,
      (s) => s[0].guard === 'state-guard' && s[0].valueShape === 'input-ref' && s[0].returning === true],
    ['identity-only.ts', `db.update(ewohSchedulingRun).set(input.patch).where(and(eq(runId, id), eq(orgId, org)));`,
      (s) => s[0].guard === 'identity-only'],
    ['no-where.ts', `db.update(ewohAgentTask).set({ status: 'cancelled' });`,
      (s) => s[0].guard === 'no-where'],
    ['dynamic-where.ts', `const predicates = [eq(orgId, org)]; db.update(ewohControlCommand).set({ status: target }).where(and(...predicates));`,
      (s) => s[0].guard === 'dynamic-where'],
    // 反例：状态只出现在 set 侧 ⇒ 不得算守卫
    ['set-only.ts', `db.update(ewohProductionTask).set({ status: 'done' }).where(eq(taskId, id));`,
      (s) => s[0].guard === 'identity-only' && s[0].writesStatus === 'yes'],
    // 同表但完全不碰状态列 ⇒ 必须被分母剔除（第一版读数就栽在这个混合分母上）
    ['no-status-set.ts', `db.update(ewohAgentTask).set({ taskJson: { a: 1 } }).where(eq(taskId, id));`,
      (s) => s[0].writesStatus === 'no'],
    // 参数化 patch ⇒ set 侧看不见，如实记 dynamic（不折算成"改状态"也不折算成"没改"）
    ['patch-dynamic.ts', `db.update(ewohSchedulingRun).set(input.patch).where(and(eq(runId, id), eq(orgId, org)));`,
      (s) => s[0].writesStatus === 'dynamic' && s[0].guard === 'identity-only'],
    // V284 简写属性正反一对：`.set({ status, ... })` 必须算状态写者（漏它 ⇒ 站点从分母整条消失），
    // 而只简写非状态列的 `.set({ orgId })` 不得算（否则分母被内存字段灌水）。
    ['shorthand-status.ts', `db.update(ewohControlCommand).set({ status, updatedAt: new Date() })
      .where(and(eq(ewohControlCommand.requestId, id), eq(ewohControlCommand.status, expected)));`,
      (s) => s[0].writesStatus === 'yes' && s[0].guard === 'state-guard' && s[0].valueShape === 'input-ref'],
    ['shorthand-nonstatus.ts', `db.update(ewohAgentTask).set({ orgId }).where(eq(taskId, id));`,
      (s) => s[0].writesStatus === 'no'],
  ];
  const fails = [];
  for (const [name, src, judge] of FIX) {
    const got = classifySource(src, name, tableSet);
    if (got.length !== 1) { fails.push(`${name}: 站点数 ${got.length}（应为 1）`); continue; }
    if (!('writesStatus' in got[0])) fails.push(`${name}: 缺 writesStatus 轴`)
    if (!judge(got)) fails.push(`${name}: 分类 ${got[0].guard}/${got[0].valueShape}（不符预期）`);
  }
  // 不变量：before/after 用同一棵树 ⇒ 每格差值必须恰为 0（差值口径自己有假数的最常见形状）
  const one = classifySource(FIX[0][1], 'a.ts', tableSet);
  const delta = diffSites(one, one);
  if (Object.values(delta).some((v) => v !== 0)) {
    fails.push(`同一棵树自差应全 0，实得 ${JSON.stringify(delta)}`);
  }
  return { checks: FIX.length + 1, fails };
}

/** 守卫强度差值：after - before，按 `guard` 分桶（正数=该类站点变多）。 */
function diffSites(before, after) {
  const key = (s) => `${s.guard}`;
  const tally = (list) => list.reduce((m, s) => { m[key(s)] = (m[key(s)] || 0) + 1; return m; }, {});
  const b = tally(before), a = tally(after);
  const out = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) out[k] = (a[k] || 0) - (b[k] || 0);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (!fs.existsSync(SCHEMA)) { console.log('不可判：读不到 schema.ts'); process.exit(3); }
  const schemaSrc = fs.readFileSync(SCHEMA, 'utf8');
  // 键位点核验：FACTS 的每个表变量必须真的映射成 pgTable（写错键 ⇒ 恒 0 ⇒ 假装量过）
  const missing = FACTS.filter(([k]) => !new RegExp(`export const ${k}\\s*=\\s*pgTable\\(`).test(schemaSrc));
  if (missing.length) {
    console.log(`不可判：FACTS 里 ${missing.map((m) => m[0]).join(', ')} 在 schema.ts 无映射（静默零比没有数更贵）`);
    process.exit(3);
  }
  const tableSet = new Set(FACTS.map(([k]) => k));

  if (args.includes('--self-test')) {
    const r = selfTest(tableSet);
    r.fails.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(r.fails.length ? `判据自测：${r.checks - r.fails.length}/${r.checks} 抓到（有分支不开火）`
      : `判据自测：${r.checks} 类形状逐格对上，且"状态只在 set 侧"不误判为守卫`);
    process.exit(r.fails.length ? 1 : 0);
  }

  /* ── before/after（V158）：把同一套分类器套到旧树上，量"守卫强度"随试点收口的变化。
     旧树内容一律 `git show <rev>:<path>`，绝不落盘、绝不改工作树（与 write-fanout 同一纪律）。
     两侧文件清单取并集：试点新建的守卫入口（scheduling-run/plan.lifecycle.ts）在旧树里根本不存在
     ⇒ 它必须按"旧侧不存在 = 0 处"计，否则差值会把"新增入口"读成"守卫变多"。 */
  if (args.includes('--against')) {
    const rev = args[args.indexOf('--against') + 1] || 'HEAD';
    let listed;
    try {
      listed = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', SCAN_REL],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 });
    } catch {
      console.log(`不可判：git ls-tree ${rev} 失败（不把"读不到"当成"没有变化"）`);
      process.exit(3);
    }
    const beforeFiles = listed.split('\n').filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const readGit = (f) => {
      try {
        return execFileSync('git', ['show', `${rev}:${f}`],
          { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 });
      } catch { return null; }
    };
    const collect = (pairs) => pairs
      .filter(([f, src]) => src && !/\.spec\.ts$/.test(f) && !f.includes('__tests__'))
      .flatMap(([f, src]) => classifySource(src, f, tableSet))
      .filter((x) => x.writesStatus === 'yes' || x.writesStatus === 'dynamic');
    const after = collect(listTs(SCAN_ROOT).map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]));
    const before = collect(beforeFiles.map((f) => [f, readGit(f)]));
    if (!before.length) {
      console.log(`不可判：旧树（${rev}）一条状态写入都没抽到 ⇒ 判据在旧侧不开火，差值无意义`);
      process.exit(3);
    }
    const status = (s) => `${s.table} ${s.guard}${s.writesStatus === 'dynamic' ? '(patch 参数化)' : ''} ${s.file.split('/').pop()}:${s.line}`;
    const seen = new Set(after.map(status));
    const gone = before.map(status).filter((x) => !seen.has(x));
    const added = after.map(status).filter((x) => !new Set(before.map(status)).has(x));
    // 第二把尺：**不带行号**的多重集差集。带行号的差集会把"同一条语句搬家"同时算成消失与新增
    // （本轮实测 19/10 里就有 4 对纯平移），只有按 (表, 守卫形状, 文件) 计数才分得清"真没了"与"挪位置"。
    const key2 = (x) => `${x.table} ${x.guard} ${x.file.split('/').pop()}`;
    const bag = (list) => list.reduce((m, x) => { const k = key2(x); m[k] = (m[k] || 0) + 1; return m; }, {});
    const kb = bag(before), ka = bag(after);
    const moves = [];
    for (const k of new Set([...Object.keys(kb), ...Object.keys(ka)])) {
      const d = (ka[k] || 0) - (kb[k] || 0);
      if (d !== 0) moves.push(`    ${d > 0 ? '+' : '-'}${Math.abs(d)} ${k}`);
    }
    console.log(`before/after（旧树 ${rev} → 工作树）产品面状态写入：${before.length} 处 → ${after.length} 处`);
    console.log(`  按守卫强度差值：${JSON.stringify(diffSites(before, after))}`);
    console.log(`  消失的写入点 ${gone.length} 处：`);
    gone.forEach((x) => console.log(`    - ${x}`));
    console.log(`  新增的写入点 ${added.length} 处（**含行号平移**，只作线索不作结论）：`);
    added.forEach((x) => console.log(`    + ${x}`));
    console.log(`  按 (表, 守卫形状, 文件) 的净变化（不带行号 ⇒ 搬家不重复计）：`);
    moves.forEach((m) => console.log(m));
    const byTable = (list) => list.reduce((m, s) => { m[s.table] = (m[s.table] || 0) + 1; return m; }, {});
    const bT = byTable(before), aT = byTable(after);
    console.log('  逐表写者数变化（旧→新）：');
    for (const k of FACTS.map(([n]) => n)) {
      if (!bT[k] && !aT[k]) continue;
      console.log(`    ${k}: ${bT[k] || 0} → ${aT[k] || 0}`
        + `${bT[k] === undefined ? '（旧树无此表的写入点）' : bT[k] === aT[k] ? '（持平）' : bT[k] > aT[k] ? '（收口）' : '（变多）'}`);
    }
    process.exit(0);
  }

  const files = listTs(SCAN_ROOT);
  const sites = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('.update(')) continue;
    classifySource(src, f, tableSet).forEach((s) => sites.push(s));
  }
  if (!sites.length) { console.log('不可判：一条 .update(<权威表>) 都没抽到 ⇒ 量具没接上语料'); process.exit(3); }

  const isTest = (s) => /\.spec\.ts$/.test(s.file) || s.file.includes('__tests__');
  const prod = sites.filter((s) => !isTest(s) && (s.writesStatus === 'yes' || s.writesStatus === 'dynamic'));
  const nonState = sites.filter((s) => !isTest(s) && s.writesStatus === 'no').length;
  const byGuard = {};
  for (const s of prod) byGuard[s.guard] = (byGuard[s.guard] || 0) + 1;

  console.log(`原始观测：扫 ${files.length} 个 server .ts；权威表上的 UPDATE ${sites.length} 处`
    + ` ⇒ 其中 set 侧确实写 status/state（或经参数化 patch）的产品面 ${prod.length} 处`
    + `／同表但不改状态列 ${nonState} 处（已从分母剔除）／测试面 ${sites.filter(isTest).length} 处`);
  for (const s of prod.slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${s.file}:${s.line} ${s.table} set=${s.writesStatus} [${s.chain}] guard=${s.guard}`
      + `${s.valueShape ? ` values=${s.valueShape}` : ''}${s.partial ? ' partial(谓词里有看不见的位置)' : ''} returning=${s.returning ? 'y' : 'n'} zeroBranch=${s.zeroBranch ? 'y' : 'n'}`);
  }
  console.log('按表汇总（产品面）：');
  for (const [k, what] of FACTS) {
    const mine = prod.filter((s) => s.table === k);
    if (!mine.length) { console.log(`  ${k}（${what}）：0 处`); continue; }
    const g = {};
    mine.forEach((s) => { g[s.guard] = (g[s.guard] || 0) + 1; });
    console.log(`  ${k}（${what}）：${mine.length} 处 ⇒ `
      + Object.entries(g).map(([kk, v]) => `${kk}=${v}`).join(', '));
  }
  console.log(`守卫形状合计（产品面）：${Object.entries(byGuard).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // 校准：三个已知答案必须对上（对不上 ⇒ 本轮不出数）
  const bad = [];
  const findSite = (fileRe, lineRe) => prod.find((s) => new RegExp(fileRe).test(s.file) && lineRe.test(`${s.line}`));
  const runSite = prod.find((s) => /scheduling-run\.lifecycle\.ts/.test(s.file));
  const planSite = prod.find((s) => /scheduling-plan\.lifecycle\.ts/.test(s.file));
  const agentSite = prod.find((s) => /agent-orchestrator\.service\.ts/.test(s.file));
  if (!runSite || runSite.guard !== 'identity-only') bad.push(`run 闭合校准失败：${runSite ? runSite.guard : '未抽到'}（应 identity-only）`);
  if (!planSite || planSite.guard !== 'state-guard') bad.push(`plan 收口校准失败：${planSite ? planSite.guard : '未抽到'}（应 state-guard）`);
  if (!agentSite || agentSite.guard !== 'state-guard') bad.push(`agent 校准失败：${agentSite ? agentSite.guard : '未抽到'}（应 state-guard）`);
  bad.forEach((b) => console.log(`  ✗ 校准不符：${b}`));
  if (!bad.length) console.log('✅ 校准三处全对（V155/V156/V79 的已知答案）');
  if (args.includes('--json')) {
    fs.writeFileSync(path.join(ROOT, 'tmp/chain-baseline/status-write-guard-census.json'),
      JSON.stringify({ sites, prod }, null, 2) + '\n');
  }
  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { classifySource, selfTest, diffSites, FACTS, STATE_COLS };
