// 量具执行面清点（V140 建立；V347 把分母从手工名册改成 Makefile 现抽）
//
// 起因（V133–V139）：那几件契约/写入口量具全部只有我手敲 make 才会跑——
//   "读数会在无人复算时过期"这件事必须变成可复算的数字，不能停在印象。
// 起因（V347，SURFACERO-01）：分母原来是一张手写名单（`INSTRUMENTS`，38 条）。
//   V197／V198／V215 三次记下"新量具没进名单 ⇒ 对读数整件隐身"，V346 第四次复发：
//   新增 `chain-baseline-ledger-gap` 后复跑本尺，读数纹丝不动（仍 38／无人跑 33），
//   现算 Makefile 有 60 个 `chain-baseline-*`、名单里只有 37 个 ⇒ 漏 23、反向 0。
//   ⇒ 分母改成**默认纳入**：前缀现抽，只有逐条写了理由的目标才被摘出去，而"摘出去"这件事本身可被判红。
//
// 判据：
//   分母 = Makefile 里 `^chain-baseline-[a-z0-9-]+:` 现抽 − EXEMPT（生命周期/铸造类，逐条带理由）
//          ∪ EXTRA（不带该前缀但确属试点入口者，现只有 unit-triage）
//   执行面 = ① 任一 workflow 里出现 `make <目标>`；② 或被某个已执行目标在配方里 `make <目标>` 间接带起（传递）。
//   可开火的断言（每条都有对应的注入控制，见 --self-test）：
//     豁免过期：EXEMPT 列了 Makefile 里没有的目标；
//     豁免吞量具：被豁免者的 help 里出现「判据／自测／普查／对账／机检」；
//     两头挂：EXTRA 与 EXEMPT 同名；归错表：EXTRA 里塞了带前缀的名字（会被数两遍）；
//     入口失效：EXTRA 里的目标在 Makefile 已不存在；
//     分母不唯一；桶闭合（有执行面 ＋ 无人跑 ≠ 分母）。
//   取不到 Makefile 或一个前缀目标都解析不到 ⇒ 判"不可判"（退 3），绝不折算成"没有量具、全部干净"。
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PREFIX = 'chain-baseline-';

// 生命周期/铸造类：不是"量具"。每条必须写理由，且被"豁免吞量具"那条盯着（help 带度量词即判红）。
const EXEMPT = {
  'chain-baseline-up': '建/复用一次性 PostgreSQL（集群生命周期）',
  'chain-baseline-down': '停止基线集群（集群生命周期）',
  'chain-baseline-seed': '装链基线库：迁移＋种子（环境装配动作）',
  'chain-baseline-rebuild': '复位基线库（环境装配动作，默认 dry-run）',
  'chain-baseline-verify': '一键全量重放本身（被量数的执行体，不是读数入口）',
  'chain-baseline-freshness-mint': '铸造新鲜度 stamp（写证据动作）',
};
// 前缀之外的试点入口。漏加只会少报一件，不像漏加度量目标那样会让新量具对读数隐身。
const EXTRA = { 'unit-triage': '全量后端单测＋归档（单测读数的唯一入口）' };

const MEASURE_RE = /判据|自测|普查|对账|机检/;

function parseTargets(txt) {
  const recipes = new Map();
  const help = new Map();
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z0-9_.-]*):\s*(?:##\s*(.*))?$/);
    if (!m) continue;
    const recipe = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\t/.test(lines[j])) recipe.push(lines[j]);
      else if (lines[j].trim() === '') continue;
      else break;
    }
    recipes.set(m[1], recipe.join('\n'));
    if (m[2]) help.set(m[1], m[2]);
  }
  return { recipes, help };
}

/** 纯函数：前缀全集＋help＋两张表 ⇒ 分母与可开火的判决。判据与取数分离，注入才测得到判据本身。 */
function classify(prefixTargets, helpMap, allDefined, exempt, extra) {
  const P = [...new Set(prefixTargets)].sort();
  const E = new Set(Object.keys(exempt));
  const exemptPresent = P.filter((t) => E.has(t));
  const included = P.filter((t) => !E.has(t));
  const problems = [];
  for (const t of Object.keys(exempt)) {
    if (!allDefined.has(t)) problems.push(`豁免过期：${t} 在 Makefile 里没有定义（该删这条豁免）`);
  }
  for (const t of exemptPresent) {
    const h = String(helpMap.get(t) || '');
    if (MEASURE_RE.test(h)) problems.push(`豁免吞量具：${t} 的 help 写着度量词（${h.slice(0, 30)}…）——它像一把尺子，不该被摘出分母`);
  }
  const extras = [];
  for (const t of Object.keys(extra)) {
    if (!allDefined.has(t)) { problems.push(`前缀外入口已失效：${t} 在 Makefile 里没有定义`); continue; }
    if (E.has(t)) { problems.push(`两头挂：${t} 既在豁免表里又在前缀外入口表里`); continue; }
    if (t.startsWith(PREFIX)) { problems.push(`归错表：${t} 带 ${PREFIX} 前缀，应由现抽进分母，不该写进前缀外入口表`); continue; }
    extras.push(t);
  }
  const denom = [...included, ...extras].sort();
  if (new Set(denom).size !== denom.length) problems.push(`分母不唯一：${denom.length} 项里有 ${denom.length - new Set(denom).size} 个重复`);
  return { prefixAll: P, included, exemptPresent, extras, denom, problems };
}

/** 纯函数：桶闭合自检（rows 是 {target,plane} 数组）。 */
function bucketCheck(rows, denomLen) {
  const wired = rows.filter((r) => r.plane !== 'none').length;
  const dead = rows.filter((r) => r.plane === 'none').length;
  const out = [];
  if (wired + dead !== denomLen) out.push(`桶闭合失败：有执行面 ${wired} ＋ 无人跑 ${dead} ≠ 分母 ${denomLen}`);
  if (new Set(rows.map((r) => r.target)).size !== rows.length) out.push('分母里有重名目标（同一条被数两遍）');
  return out;
}

function workflowCalls(text) {
  return new Set((text.match(/make\s+([A-Za-z][A-Za-z0-9_.-]*)/g) || []).map((x) => x.split(/\s+/)[1]));
}

function wfFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(yml|yaml)$/.test(f));
}

function analyze(root) {
  const mkPath = path.join(root, 'Makefile');
  if (!fs.existsSync(mkPath)) return { unreadable: `取不到 Makefile：${mkPath}` };
  const { recipes: targets, help } = parseTargets(fs.readFileSync(mkPath, 'utf8'));
  const prefixTargets = [...targets.keys()].filter((t) => t.startsWith(PREFIX));
  if (!prefixTargets.length) return { unreadable: 'Makefile 里一个 chain-baseline-* 目标都没解析到（是解析器坏了，不是"没有量具"）' };
  const cls = classify(prefixTargets, help, new Set(targets.keys()), EXEMPT, EXTRA);

  const direct = new Map();
  for (const f of wfFiles(path.join(root, '.github/workflows'))) {
    const t = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
    for (const name of workflowCalls(t)) {
      if (!direct.has(name)) direct.set(name, []);
      direct.get(name).push(f);
    }
  }
  const executed = new Set(direct.keys());
  let grew = true, rounds = 0;
  while (grew && rounds++ < 6) {
    grew = false;
    for (const t of [...executed]) {
      for (const dep of workflowCalls(targets.get(t) || '')) {
        if (!executed.has(dep) && targets.has(dep)) { executed.add(dep); grew = true; }
      }
    }
  }
  const rows = cls.denom.map((t) => {
    const via = direct.get(t) || [];
    const parents = [...executed].filter((p) => p !== t && workflowCalls(targets.get(p) || '').has(t));
    return {
      target: t, defined: targets.has(t),
      plane: via.length ? 'workflow' : (executed.has(t) && parents.length ? 'transitive'
        : (parents.some((p) => direct.has(p)) ? 'transitive' : 'none')),
      workflows: via, parents: parents.filter((p) => executed.has(p) || direct.has(p)),
    };
  });
  cls.problems.push(...bucketCheck(rows, cls.denom.length));
  return { rows, cls, executedCount: executed.size, executed, direct };
}

/** 自测：每条注入都必须真的改变判决；合规侧必须沉默；取不到一律第三态。 */
function selfTest() {
  const cases = [];
  const t = (name, fn) => cases.push({ name, fn });
  const H = (o) => new Map(Object.entries(o));
  const S = (a) => new Set(a);
  const NONE = {};

  t('注入①：把一把真尺子写进豁免表 ⇒ 必须判"豁免吞量具"（默认纳入不许被反向掏空）', () => {
    const r = classify(['chain-baseline-consistency', 'chain-baseline-up'],
      H({ 'chain-baseline-consistency': '登记册产物一致性自检：四处对账 ＋ 判据自测', 'chain-baseline-up': '建/复用一次性 PostgreSQL' }),
      S(['chain-baseline-consistency', 'chain-baseline-up']), { 'chain-baseline-consistency': '误豁免' }, NONE);
    return r.problems.some((p) => p.startsWith('豁免吞量具')) && r.denom.length === 1;
  });
  t('注入②：豁免表指向 Makefile 里不存在的目标 ⇒ 必须判"豁免过期"（表不许留僵尸行）', () => {
    const r = classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a']),
      { 'chain-baseline-ghost': '已删的动作' }, NONE);
    return r.problems.some((p) => p.startsWith('豁免过期'));
  });
  t('正向③：新增一个前缀目标不必改任何表就自动进分母（V346 那件"隐身"必须在这里翻面）', () => {
    const before = classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a']), NONE, NONE);
    const after = classify(['chain-baseline-a', 'chain-baseline-new'],
      H({ 'chain-baseline-a': '量具 A', 'chain-baseline-new': '新量具：判据自测' }), S(['chain-baseline-a', 'chain-baseline-new']), NONE, NONE);
    return before.denom.length === 1 && after.denom.length === 2 && after.denom.includes('chain-baseline-new');
  });
  t('对照④：前缀目标全被豁免 ⇒ 分母只剩前缀外入口，且不得报任何问题（分母小不等于红）', () => {
    const r = classify(['chain-baseline-up', 'chain-baseline-down'],
      H({ 'chain-baseline-up': '建集群', 'chain-baseline-down': '停集群' }),
      S(['chain-baseline-up', 'chain-baseline-down', 'unit-triage']),
      { 'chain-baseline-up': '集群生命周期', 'chain-baseline-down': '集群生命周期' }, { 'unit-triage': '单测归档' });
    return r.problems.length === 0 && r.denom.length === 1 && r.denom[0] === 'unit-triage';
  });
  t('对照⑤：help 里没有度量词的生命周期豁免 ⇒ 不得判可疑（假阳性面必须为零）', () => {
    const r = classify(['chain-baseline-verify', 'chain-baseline-seed'],
      H({ 'chain-baseline-verify': '一键重放链级基线：7 场景 ＋ 边界用例', 'chain-baseline-seed': '装链基线库' }),
      S(['chain-baseline-verify', 'chain-baseline-seed']),
      { 'chain-baseline-verify': '重放执行体', 'chain-baseline-seed': '环境装配' }, NONE);
    return r.problems.length === 0 && r.exemptPresent.length === 2 && r.denom.length === 0;
  });
  t('注入⑥：EXTRA 与豁免表同名 ⇒ 必须判"两头挂"（一张表说该摘、另一张说该收）', () => {
    const r = classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a', 'zz-tool']),
      { 'zz-tool': '说是生命周期' }, { 'zz-tool': '又当前缀外入口' });
    return r.problems.some((p) => p.startsWith('两头挂'));
  });
  t('注入⑦：EXTRA 里塞一个带前缀的名字 ⇒ 必须判"归错表"（否则现抽与 EXTRA 各数一遍）', () => {
    const r = classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a', 'chain-baseline-b']),
      NONE, { 'chain-baseline-b': '错误地放这里' });
    return r.problems.some((p) => p.startsWith('归错表')) && r.denom.length === 1;
  });
  t('注入⑧：前缀外入口在 Makefile 里已不存在 ⇒ 必须点名"已失效"，不得静默少一件', () => {
    const r = classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a']),
      NONE, { 'unit-triage': '已改名的归档器' });
    return r.problems.some((p) => p.startsWith('前缀外入口已失效')) && r.denom.length === 1;
  });
  t('注入⑨：桶闭合必须能翻红（少一支 ⇒ 加和不等于分母；重名 ⇒ 另一支开火）', () => {
    const good = [{ target: 'a', plane: 'workflow' }, { target: 'b', plane: 'none' }];
    const missing = [{ target: 'a', plane: 'workflow' }];
    const dup = [good[0], { ...good[0] }];
    return bucketCheck(good, 2).length === 0 && bucketCheck(missing, 2).length === 1
      && bucketCheck(dup, 2).length === 1;
  });

  const A = analyze(ROOT);
  t('真语料⑩：分母由现抽得到（>38＝把 V346 漏掉的 23 件收回来），且每个前缀目标要么在分母要么被豁免、两向无交叉', () => {
    if (A.unreadable) return false;
    const c = A.cls;
    const union = new Set([...c.denom.filter((x) => x.startsWith(PREFIX)), ...c.exemptPresent]);
    const overlap = c.denom.filter((x) => c.exemptPresent.includes(x));
    return c.denom.length > 38 && union.size === c.prefixAll.length && overlap.length === 0 && c.problems.length === 0;
  });
  t('真语料⑪：有执行面＋无人跑＝分母，且 V346 隐身的那件与本尺自己都在"无人跑"里被点名', () => {
    if (A.unreadable) return false;
    const wired = A.rows.filter((r) => r.plane !== 'none').length;
    const dead = A.rows.filter((r) => r.plane === 'none');
    return wired + dead.length === A.rows.length
      && dead.some((r) => r.target === 'chain-baseline-ledger-gap')
      && dead.some((r) => r.target === 'chain-baseline-instrument-surface');
  });
  t('不可判⑫：Makefile 取不到 ⇒ 必须判不可判而不是"零个量具"（空集与干净同形）', () => !!analyze(path.join(ROOT, 'zzz-no-such-dir')).unreadable);
  t('正向⑬：识别器认得 audit-regression-gates 被 workflow 调用（认不出则"无人跑"全部不可信）', () => !A.unreadable
    && (A.direct.has('audit-regression-gates') || A.executed.has('audit-regression-gates')));
  t('负向⑭：判"无人跑"的目标都没有 workflow 记录', () => !A.unreadable
    && A.rows.filter((r) => r.plane === 'none').every((r) => r.workflows.length === 0));

  let ok = 0;
  for (const c of cases) {
    let pass = false; let err = '';
    try { pass = c.fn() === true; } catch (e) { err = e.message; }
    console.log(`  ${pass ? '✅' : '❌'} ${c.name}${pass ? '' : '（' + (err || '条件不满足') + '）'}`);
    if (pass) ok += 1;
  }
  const c = A.unreadable ? null : A.cls;
  console.log(`  （度量目标 ${c ? c.denom.length : '不可判'} 个：前缀现抽 ${c ? c.prefixAll.length : '—'} − 生命周期豁免 ${c ? c.exemptPresent.length : '—'} ＋ 前缀外入口 ${c ? c.extras.length : '—'}；`
    + `有执行面 ${A.unreadable ? '—' : A.rows.filter((r) => r.plane !== 'none').length}、无人跑 ${A.unreadable ? '—' : A.rows.filter((r) => r.plane === 'none').length}）`);
  console.log(`  （判据自测 ${ok}/${cases.length} 条，条数由本脚本自报：豁免吞量具／豁免过期／新目标自动入分母／全豁免只剩 EXTRA／生命周期不误伤／两头挂／归错表／入口失效／桶闭合／真语料两支／不可判／识别器正向／负向）`);
  return ok === cases.length && !A.unreadable ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) { process.exitCode = selfTest(); return; }
  const A = analyze(ROOT);
  if (A.unreadable) {
    console.error(`⚠️ 不可判：${A.unreadable}（绝不折算成"没有量具"或"全部已接线"）`);
    process.exitCode = 3; return;
  }
  const { rows, cls } = A;
  const wired = rows.filter((r) => r.plane !== 'none');
  const dead = rows.filter((r) => r.plane === 'none');
  console.log(`试点度量/机检目标 ${rows.length} 个（分母现抽：Makefile 里 ${PREFIX}* 共 ${cls.prefixAll.length} 个 − 生命周期豁免 ${cls.exemptPresent.length} 个 ＋ 前缀外入口 ${cls.extras.length} 个）`);
  console.log(`被豁免（逐条带理由）：${cls.exemptPresent.map((x) => `${x}＝${EXEMPT[x]}`).join(' ｜ ')}`);
  console.log(`CI 里被直接/间接调起的 make 目标共 ${A.executedCount} 个`);
  console.log('');
  console.log('有执行面：');
  for (const r of wired) {
    console.log('  ' + r.target.padEnd(34) + '  ' + (r.workflows.length
      ? `workflow: ${[...new Set(r.workflows)].join(',')}`
      : `经 ${[...new Set(r.parents)].join(',')} 间接带起`));
  }
  console.log('');
  console.log(`无人跑（只有人手敲 make 才执行）：${dead.length} 个`);
  for (const r of dead) console.log('  ' + r.target.padEnd(34) + (r.defined ? '' : '（Makefile 里没定义！）'));
  for (const p of cls.problems) console.log('  ✗ ' + p);
  fs.writeFileSync(path.join(ROOT, 'tmp/instrument-surface.json'),
    JSON.stringify({ rows, denom: cls.denom, exempt: cls.exemptPresent, problems: cls.problems, executedCount: A.executedCount }, null, 1));
  console.log('机器可读：tmp/instrument-surface.json（分母、豁免表与判决都落盘，可逐条复算）');
  process.exitCode = cls.problems.length ? 2 : 0;
}

// 被 require 时只导出判据（常驻位点要注入夹具），命令行才出数并写 tmp/instrument-surface.json
if (require.main === module) main();
else module.exports = { classify, bucketCheck, analyze, parseTargets, EXEMPT, EXTRA, MEASURE_RE };

