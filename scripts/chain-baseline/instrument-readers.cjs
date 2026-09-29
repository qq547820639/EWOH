#!/usr/bin/env node
'use strict';
/* 仓内量具读取普查（V339 新增，只出读数、未改任何既有分档）
 * ─────────────────────────────────────────────────────────────────────────
 * 这条量具只回答一句问题：**改了某个文件，仓里有没有哪把量具会去读它？**
 * 动因：`change-amplification` 的第三根轴（链外机器入口）只认"入口配方里提到这个路径"
 * 与"jest 自己收哪些测试文件"，于是登记文档（《基线》／ADR／交付指令）与派生清单
 * （`feature-status.yaml`、`old-finding-regression.yaml`）明明被量具逐行核着，却仍落在
 * 「已扫面内无入口」那一档 ⇒ 判据①（维护成本）**读得比实际更贵**。V338 复核时实测：
 * 按"文本窗口"（字面量附近出现读调用名）判读取会同时造假阴与假红（真被读的
 * `adr-004-mes-scheduling-convergence.md` 落窗口外、只是挨着读调用的文件被误收），
 * 所以这里改成**AST 绑定追踪**，三档：
 *   `direct`    字面量本身就在某个读调用的实参子树里；
 *   `const1hop` 字面量赋给**模块顶层**常量，该常量出现在某读调用实参子树里；
 *   `tableProp` 字面量嵌在模块顶层的数组／对象字面量里，其最近的属性名 K 以 `X.K` 形式
 *                 出现在某读调用实参里（表驱动判据的形状：`PAIRS=[{docFile:'…'}]` + `read(p.docFile)`）。
 * 三条刻意设计（都是实测过才定的）：
 *  - **只看模块顶层语句** ⇒ 量具自测夹具（`const CLI_TEST='…'` 写在 `selfTest()` 体内）
 *    与真语料断言名单（`mustHaveEntry`）天然被排除；不靠"名字看起来像夹具"的启发式。
 *  - **排除量具自身路径**（`const SELF='scripts/chain-baseline/<本文件>'`）——自己读自己不是入口。
 *  - 字面量**在盘上不存在**的那些单独计数（`missingExcluded`），绝不与"没判成读取"混成一格：
 *    两者在输出上都表现为"这个文件没有读取者"，但一个是判据没用上、另一个是文件根本没有。
 * 限度（不许读成"已穷尽"）：
 *  - 只认字面量。路径被拼出来（`path.join(root, dir, name)`、变量间赋值超过一跳）读不到 ⇒ 下界。
 *  - "被读"≠"被核对"：判据可能只把它当排除表／白名单来读，那仍然是"改了会有东西变红"，
 *    但**红的原因可能是排除表失效**而不是内容漂移 ⇒ 逐条读的那一步不许省。
 *  - 解析器取仓内 `typescript`（与被测代码同一份）；取不到 ⇒ 整条判不可判 rc=3，不读成"零读取者"。
 * 用法：判据自测 `node scripts/chain-baseline/instrument-readers.cjs --self-test`；
 *       读数 同上去掉 `--self-test`（`--json` 另落 `tmp/instrument-readers.json`）。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const SELF = 'scripts/chain-baseline/instrument-readers.cjs';
const DIR = path.join(root, 'scripts/chain-baseline');
const EXT = /\.(cjs|mjs|js)$/;

function loadTs() {
  const cands = [
    path.join(root, 'ewoh-spark-app/node_modules/typescript'),
    path.join(root, 'node_modules/typescript'),
  ];
  for (const c of cands) { try { return require(c); } catch { /* 下一个 */ } }
  return null;
}
const READ_NAMES = new Set(['readFileSync', 'readFile', 'readFileSyncSafe', 'existsSync', 'statSync',
  'openSync', 'require', 'readFace', 'readJson', 'read', 'readFileOrNull', 'RD', 'RDQ', 'readOrEmpty']);
const PATHISH = /^[\w.\-/]+\.(?:md|ya?ml|yaml|json|ts|tsx|js|mjs|cjs|sql|py|sh)$/;

let KIND; // 由 ts 注入（下面 initKinds）
function initKinds(ts) {
  KIND = {
    call: ts.SyntaxKind.CallExpression, string: ts.SyntaxKind.StringLiteral,
    tmpl: ts.SyntaxKind.NoSubstitutionTemplateLiteral, prop: ts.SyntaxKind.PropertyAssignment,
    ident: ts.SyntaxKind.Identifier, member: ts.SyntaxKind.PropertyAccessExpression,
    vardecl: ts.SyntaxKind.VariableDeclaration,
  };
}
const callName = (ts, node) => (ts.isIdentifier(node.expression) ? node.expression.text
  : (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''));

/** 一个文件 → { fires: Map<rel,[{instrument,kind}]>, missing: [rel…] }；由 measureFile 汇总。 */
function scanSource(ts, src, fileName, selfRel) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const fires = new Map(); const missing = new Set();
  const relOf = (v) => {
    const rel = v.split(path.sep).join('/');
    return PATHISH.test(rel) && !rel.startsWith('tmp/') && !rel.startsWith('./') && rel !== selfRel;
  };
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  // 先收集"读调用实参里出现过的属性名"（tableProp 那一档要用）
  const argProps = new Set(); const argTexts = [];
  const readCalls = [];
  (function collect(n) {
    if (ts.isCallExpression(n) && READ_NAMES.has(callName(ts, n))) {
      readCalls.push(n);
      for (const a of n.arguments) {
        argTexts.push(a.getText(sf));
        (function deep(m) { if (ts.isPropertyAccessExpression(m)) argProps.add(m.name.text); m.getChildren(sf).forEach(deep); })(a);
      }
    }
    ts.forEachChild(n, collect);
  })(sf);
  const usedAsArg = (id) => argTexts.some((t) => new RegExp(`\\b${id}\\b`).test(t));
  const litInArg = (node) => readCalls.some((c) => c.arguments.some((a) => {
    let hit = false;
    (function deep(m) { if (m === node) hit = true; m.getChildren(sf).forEach(deep); })(a);
    return hit;
  }));
  const push = (rel, kind) => {
    if (!fires.has(rel)) fires.set(rel, []);
    fires.get(rel).push({ instrument: path.relative(root, fileName).split(path.sep).join('/'), kind });
  };
  const FN = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.ClassExpression,
    ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor]);
  for (const stmt of sf.statements) {
    const lits = [];
    /* 关键精度：**不进入任何函数体**。「字面量写在模块顶层的数据/声明位置」才是判据消费的常量；
     * 写在函数体里的（`selfTest()` 内的夹具路径、真语料断言名单）与"入口"无关。
     * 只看 `sf.statements` 不够——函数声明本身也是顶层语句，进去照样会捞到夹具。 */
    (function deep(n) {
      if (FN.has(n.kind)) return;
      if (n.kind === KIND.string || n.kind === KIND.tmpl) {
        const v = n.getText(sf).slice(1, -1);
        if (relOf(v)) lits.push({ node: n, rel: v });
      }
      ts.forEachChild(n, deep);
    })(stmt);
    for (const L of lits) {
      if (!exists(L.rel)) { missing.add(L.rel); continue; }
      if (litInArg(L.node)) { push(L.rel, 'direct'); continue; }
      // 一跳：本语句里的字面量所属的顶层常量名被用作读调用实参
      const ids = [];
      (function deep(n) { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) ids.push(n.name.text); ts.forEachChild(n, deep); })(stmt);
      if (ids.some(usedAsArg)) { push(L.rel, 'const1hop'); continue; }
      // 二跳：字面量最近的属性名以 X.K 形式出现在读调用实参里
      let key = null;
      for (let n = L.node; n && n !== stmt; n = n.parent) if (ts.isPropertyAssignment(n) && n.name) { key = n.name.getText(sf).replace(/['"]/g, ''); break; }
      if (key && argProps.has(key)) { push(L.rel, 'tableProp'); continue; }
    }
  }
  return { fires, missing };
}

function measure(overlay) {
  const ts = loadTs();
  if (!ts) return { unreadable: '取不到 typescript 解析器（仓内与上层 node_modules 都没有）' };
  initKinds(ts);
  const files = overlay ? overlay.files : fs.readdirSync(DIR).filter((f) => EXT.test(f));
  const out = new Map(); const missing = new Map(); const scanned = [];
  for (const f of files) {
    const fileName = overlay ? `fixture/${f}` : path.join(DIR, f);
    const src = overlay ? overlay.map.get(f) : fs.readFileSync(path.join(DIR, f), 'utf8');
    if (src == null) { missing.set(f, ['<读不到>']); continue; }
    const selfRel = overlay ? `scripts/chain-baseline/${f}` : path.relative(root, fileName).split(path.sep).join('/');
    const r = scanSource(ts, src, fileName, selfRel);
    scanned.push(selfRel);
    for (const [rel, hits] of r.fires) { if (!out.has(rel)) out.set(rel, []); out.get(rel).push(...hits); }
    for (const m of r.missing) { if (!missing.has(m)) missing.set(m, []); missing.get(m).push(selfRel); }
  }
  return { out, missing, scanned };
}

function report(res) {
  const rows = [...res.out.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const byKind = { direct: 0, const1hop: 0, tableProp: 0 };
  for (const [, hits] of rows) { const seen = new Set(); for (const h of hits) { if (seen.has(h.kind)) continue; seen.add(h.kind); byKind[h.kind] += 1; } }
  console.log(`[instrument-readers] 扫过 ${res.scanned.length} 份量具｜被读文件 ${rows.length} 个（按类去重后 direct ${byKind.direct}／const1hop ${byKind.const1hop}／tableProp ${byKind.tableProp}，一个文件可多类同记）`);
  console.log(`字面量在盘上不存在而被判据用不上的：${res.missing.size} 个（单列，不与"没判成读取"混成一格）`);
  for (const [rel, hits] of rows) {
    const who = [...new Set(hits.map((h) => `${path.basename(h.instrument)}:${h.kind}`))];
    console.log(`  ${rel}`);
    console.log(`      ← ${who.join('、')}`);
  }
  return byKind;
}

function selfTest() {
  const ts = loadTs();
  if (!ts) { console.log('[instrument-readers] SKIP：取不到 typescript 解析器（不可判 ≠ 通过）'); return true; }
  initKinds(ts);
  const cases = [];
  const ok = (name, cond, detail = '') => cases.push({ name, pass: !!cond, detail });
  // 夹具只用**仓里真实存在**的路径，否则"没 fire"到底是判据不开火还是文件不存在就分不清
  const F = 'docs/architecture/data-flow.md', G = 'Makefile', H = 'scripts/chain-baseline/verify.sh';
  const fix = (map) => measure({ files: Object.keys(map), map: new Map(Object.entries(map)) });
  const d = fix({ 'a_direct.cjs': `const fs=require('fs');fs.readFileSync('${F}','utf8');` });
  ok('direct：字面量就在读调用实参里 ⇒ 必须开火', d.out.has(F), JSON.stringify([...d.out.keys()]));
  const c = fix({ 'b_hop.cjs': `const FD='${F}';function x(){ return fs.readFileSync(FD,'utf8') }` });
  ok('const1hop：顶层常量被读调用用作实参 ⇒ 必须开火', c.out.get(F)?.some((h) => h.kind === 'const1hop'), JSON.stringify(c.out.get(F)));
  const t = fix({ 'c_table.cjs': `const PAIRS=[{docFile:'${F}'}];function m(p){return ctx.read(p.docFile)}` });
  ok('tableProp：表驱动判据（数组里的 docFile 属性被 read(p.docFile) 消费）⇒ 必须开火',
    t.out.get(F)?.some((h) => h.kind === 'tableProp'), JSON.stringify(t.out.get(F)));
  const n1 = fix({ 'd_fixture.cjs': `function selfTest(){ const CL='${F}'; fs.readFileSync(CL,'utf8') }` });
  const keep = fix({ 'd2_useinside.cjs': `const CL2='${F}';\nfunction selfTest(){ fs.readFileSync(CL2,'utf8') }` });
  ok('顶层常量即使在函数体内被读用也必须开火（"不进函数体"砍的是**夹具声明**，不是消费点）',
    keep.out.get(F)?.some((h) => h.kind === 'const1hop'), JSON.stringify(keep.out.get(F)));
  ok('必须不开火：量具**自测函数体内**的夹具路径（只看模块顶层语句）',
    !n1.out.has(F) && n1.scanned.length === 1, JSON.stringify([...n1.out.keys()]));
  const n2 = fix({ 'e_self.cjs': `const SELF='scripts/chain-baseline/e_self.cjs';fs.readFileSync(SELF,'utf8');const A='docs/architecture/nope-zzz-never.md';fs.readFileSync(A,'utf8');` });
  ok('必须不开火：量具自身路径要排除；而"盘上不存在"那条要单列进 missing，不许与"没判成读取"混格',
    !n2.out.has('scripts/chain-baseline/e_self.cjs') && [...n2.missing.keys()].some((k) => k.includes('nope-zzz')),
    JSON.stringify({ fires: [...n2.out.keys()], missing: [...n2.missing.keys()] }));
  const n3 = fix({ 'f_mention.cjs': `// const X='${F}'\nconst X='docs/architecture/nope-zzz2.md'; if (rel === X) skip()` });
  ok('必须不开火：注释里的路径（AST 面）与"只被拿来做字符串比较"的字面量都不算读取',
    !n3.out.has(F), JSON.stringify([...n3.out.keys()]));
  const real = measure(null);
  ok('真语料：三档相加必须等于"被读文件×去重后档数"，且解析器在场时不得返回 unreadable',
    !real.unreadable && real.scanned.length > 20 && (byK(real) >= 0), `扫 ${real.scanned.length} 份、被读 ${real.out.size} 个`);
  ok('真语料当期：V338 认定的那几处"被读却算无入口"的登记文档必须读得出读取者',
    ['docs/audit/current/chain-behavior-baseline.md', 'docs/reviews/rls-coverage-audit-2026-08-08.md',
      'docs/decisions/ADR-004-scheduler-tenancy.md'].every((p) => real.out.has(p)),
    ['docs/audit/current/chain-behavior-baseline.md', 'docs/reviews/rls-coverage-audit-2026-08-08.md',
      'docs/decisions/ADR-004-scheduler-tenancy.md'].filter((p) => !real.out.has(p)).join('、') || '三处都有读取者');
  let bad = 0;
  for (const c2 of cases) { console.log(`${c2.pass ? '✔' : '✗'} ${c2.name}${c2.pass ? '' : ` → ${c2.detail}`}`); if (!c2.pass) bad += 1; }
  console.log(`[instrument-readers] 判据自测 ${cases.length - bad}/${cases.length} 通过`);
  return bad === 0;
}
function byK(res) { let n = 0; for (const [, h] of res.out) n += h.length; return n; }

function main(argv) {
  if (argv.includes('--self-test')) { process.exitCode = selfTest() ? 0 : 1; return; }
  const res = measure(null);
  if (res.unreadable) { console.error(`[instrument-readers] 不可判：${res.unreadable}`); process.exitCode = 3; return; }
  report(res);
  if (argv.includes('--json')) {
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const obj = {}; for (const [k, v] of res.out) obj[k] = v;
    fs.writeFileSync(path.join(root, 'tmp/instrument-readers.json'),
      JSON.stringify({ generatedBy: SELF, instrumentsScanned: res.scanned.length, readers: obj, literalMissing: [...res.missing.keys()] }, null, 2));
  }
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { measure, scanSource };
