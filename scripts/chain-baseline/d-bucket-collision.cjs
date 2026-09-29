#!/usr/bin/env node
/*
 * d-bucket-collision —— 只回答一个问题：
 *   「§6.2 D 桶（属他人未提交工作）里，每一行的『被挡住』在 hunk 级成不成立？」
 *
 * 为什么要有它（V216 实测）：D 桶历次核实只做到**文件级**（`git status --short` 有输出就算挡住），
 * 而文件级回答的是"这文件脏不脏"，不是"我的修法会不会撞进别人正在改的那几行"。
 * V216 把七行算到 hunk 级，顶出两行假前提（CI-03／CI-06 落点在 73、唯一脏块在 22–36，零重叠距 37 行 ⇒ 改判 B），
 * 也确认只有一行真撞（F-18）。手工算一次会腐烂，所以做成量具。
 *
 * 三样输入：
 *   分母  = 登记册 §6.2 桶表里 `| D |` 那一条的**条目列**（现算，不另立清单）
 *   落点  = `.codex/artifacts/d-bucket-fix-sites.json`，用 needle（原文片段）定位、**不存行号**（行号会漂）
 *   脏块  = `git diff -U0 -- <文件>` 的**新行段**
 * 四档判决（互斥，Σ 必须等于分母，否则退出码 2）：
 *   collision      至少一处落点落在他人 hunk 内 ⇒ "挡住"成立
 *   discipline     全部落点在 hunk 外 ⇒ 卡的只是"不许把改动混进别人的未提交 diff"这条纪律，附最近距离
 *   premise-gone   该行的文件现在根本不脏（或已不再是未跟踪以外状态）⇒ 前提消失，应改判
 *   indeterminate  needle 读不到／不唯一／文件解析不到 ⇒ 既不判挡住也不判没挡住，单列
 * 覆盖度也是硬断言：D 桶有行而清单没条目、或清单有行而 D 桶已摘掉 ⇒ 退出码 2（绝不静默漏检）。
 *
 * 限度：新行段是**改动后**的坐标，落点行号按当前工作树现取，两者同坐标系；
 *      但"未提交改动最终会不会挪到别处"不可知——本量具核的是**今天这一棵树**，引用时不得说成"永不冲突"。
 *      另外它只核 hunk 重叠，不核语义冲突（同文件不同段仍可能逻辑打架），也不核授权（共享 CI 文件即使零重叠仍需点头）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.EWOH_ROOT || process.cwd();
const DOC = path.join(ROOT, 'docs/audit/current/chain-behavior-baseline.md');
const SITES = path.join(ROOT, '.codex/artifacts/d-bucket-fix-sites.json');
const args = process.argv.slice(2);

function die(msg, code) { console.error(`[d-bucket-collision] ${msg}`); process.exit(code); }

/* ---------- 纯函数（自测直接打这几个） ---------- */
function parseDBucketIds(docText) {
  const row = docText.split('\n').find((l) => /^\| D \| 属他人未提交工作/.test(l));
  if (!row) die('§6.2 找不到 `| D | 属他人未提交工作` 那一行 ⇒ 分母不可得', 2);
  const cells = row.replace(/\\\|/g, '\u0000').split('|');
  const cell = (cells[cells.length - 2] || '').replace(/\u0000/g, '|');
  // 条目列里只认"带连字符的编号"：既不会被 `（D 半边）` 这类括注带出假 ID，也不会被格内转义管道切开
  return [...new Set((cell.match(/[A-Z][A-Za-z0-9]*-[A-Za-z0-9]+/g) || []))];
}
function parseHunks(diffText) {
  return [...diffText.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)]
    .map((m) => [Number(m[1]), Number(m[1]) + Math.max(0, Number(m[2] === undefined ? 1 : m[2]) - 1)])
    .filter(([a, b]) => b >= a);
}
function findNeedle(srcText, needle) {
  const lines = srcText.split('\n');
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(needle)) hits.push(i + 1); });
  return hits;
}
function distanceTo(line, ranges) {
  let best = null;
  for (const [a, b] of ranges) {
    const d = line < a ? a - line : line > b ? line - b : 0;
    if (best === null || d < best) best = d;
  }
  return best;
}
function judgeSite(hits, ranges) {
  if (!hits.length) return { verdict: 'indeterminate', why: 'needle 在当前树里读不到（已改或被删）' };
  if (hits.length > 1) return { verdict: 'indeterminate', why: `needle 命中 ${hits.length} 处，落点不唯一` };
  const line = hits[0];
  if (!ranges.length) return { verdict: 'premise-gone', line, why: '该文件当前没有未提交 hunk' };
  const d = distanceTo(line, ranges);
  return d === 0
    ? { verdict: 'collision', line, why: `落点 ${line} 落在他人 hunk 内` }
    : { verdict: 'discipline', line, distance: d, why: `落点 ${line} 在 hunk 外，最近 ${d} 行` };
}
function rollUp(siteResults) {
  const vs = siteResults.map((s) => s.verdict);
  if (vs.includes('collision')) return 'collision';
  if (vs.length && vs.every((v) => v === 'premise-gone')) return 'premise-gone';
  if (vs.includes('indeterminate')) return 'indeterminate';
  if (vs.length && vs.every((v) => v === 'discipline')) return 'discipline';
  return 'indeterminate';
}
function coverage(ids, siteMap) {
  const missing = ids.filter((id) => !Array.isArray(siteMap[id]) || !siteMap[id].length);
  const stale = Object.keys(siteMap).filter((k) => k !== '_说明' && k !== '_来源' && !ids.includes(k));
  return { missing, stale };
}

/* ---------- 自测：判据必须能开火，也必须能不空转 ---------- */
if (args.includes('--self-test')) {
  let pass = 0, fail = 0;
  const t = (name, ok) => { ok ? pass++ : (fail++, console.log(`  ✗ ${name}`)); };
  const DIFF = '@@ -0,0 +730,3 @@\n+const A = {\n+  k: 1,\n+}\n@@ -0,0 +1234,6 @@\n+x\n';
  const ranges = parseHunks(DIFF);
  t('夹具：两段 hunk 解析出 730–732 与 1234–1239', JSON.stringify(ranges) === '[[730,732],[1234,1239]]');
  // 正向对照：落点在 hunk 内 ⇒ 必须判 collision（这条不开火，整个量具就是装饰）
  const inside = judgeSite([1236], ranges);
  t('正向：落点 1236 在 hunk 1234–1239 内 ⇒ collision', inside.verdict === 'collision');
  // 反向对照：hunk 外 ⇒ 必须判 discipline 且距离算对（跨两段取最小）
  const outside = judgeSite([744], ranges);
  t('反向：落点 744 在 hunk 外 ⇒ discipline，距离＝730..732 段算出的 12', outside.verdict === 'discipline' && outside.distance === 12);
  // 边界：恰好压在段首 ⇒ collision（不得因"边界"漏判）
  t('边界：落点正好是 hunk 首行 730 ⇒ collision', judgeSite([730], ranges).verdict === 'collision');
  // needle 读不到 ⇒ 不可判，**不得**被折算成"没挡住"
  t('needle 零命中 ⇒ indeterminate（不得判成干净）', judgeSite([], ranges).verdict === 'indeterminate');
  // needle 不唯一 ⇒ 不可判
  t('needle 两处命中 ⇒ indeterminate', judgeSite([5, 9], ranges).verdict === 'indeterminate');
  // 文件已不脏 ⇒ premise-gone（前提消失，不是"确认挡住"）
  t('无 hunk ⇒ premise-gone', judgeSite([10], []).verdict === 'premise-gone');
  // 多落点行：任一处 collision 即整行 collision（保守方向）
  t('汇总：一撞一不撞 ⇒ 整行 collision', rollUp([inside, outside]) === 'collision');
  t('汇总：全部 hunk 外 ⇒ discipline', rollUp([outside, outside]) === 'discipline');
  t('汇总：混入 indeterminate ⇒ 整行不可判（不替它下结论）', rollUp([outside, { verdict: 'indeterminate' }]) === 'indeterminate');
  t('汇总：全 premise-gone ⇒ premise-gone', rollUp([{ verdict: 'premise-gone' }, { verdict: 'premise-gone' }]) === 'premise-gone');
  // 覆盖度断言：缺一行、多一行都必须被抓到（静默漏检是本量具最坏的错法）
  const cov1 = coverage(['A-01', 'B-02'], { 'A-01': [{ file: 'x', needle: 'y' }] });
  t('覆盖度：D 桶有行而清单缺条目 ⇒ 点名', cov1.missing.join() === 'B-02');
  const cov2 = coverage(['A-01'], { 'A-01': [{ file: 'x', needle: 'y' }], 'Z-99': [{ file: 'x', needle: 'y' }] });
  t('覆盖度：清单有行而 D 桶已摘掉 ⇒ 点名（防改判后清单不跟上）', cov2.stale.join() === 'Z-99');
  // 分母解析：桶表里的转义管道与全角顿号都要吃对
  const fakeDoc = '| D | 属他人未提交工作（按纪律不代改） | 3 | AAA-01、BBB-02、CCC-03 |\n';
  t('分母：从 D 行条目列现算出 3 个 ID', coverage(parseDBucketIds(fakeDoc), { 'AAA-01': [1], 'BBB-02': [1], 'CCC-03': [1] }).missing.length === 0);
  const fakeDoc2 = '| D | 属他人未提交工作 | 2 | AAA-01、CCC-07（D 半边） |\n';
  t('分母：括注里的字母不会被当成 ID', parseDBucketIds(fakeDoc2).join() === 'AAA-01,CCC-07');
  const fakeDoc3 = '| D | 属他人未提交工作 | 1 | AAA-01 \\| BBB-02 |\n';
  t('分母：格内转义管道不切开 ID（也不多出假 ID）', parseDBucketIds(fakeDoc3).join() === 'AAA-01,BBB-02');
  console.log(`[d-bucket-collision] 判据自测 ${pass}/${pass + fail} 通过${fail ? '（有失败 ⇒ 非零退出）' : ''}`);
  process.exit(fail ? 1 : 0);
}

/* ---------- 真语料 ---------- */
if (!fs.existsSync(DOC)) die(`读不到登记册 ${DOC}`, 2);
if (!fs.existsSync(SITES)) die(`读不到落点清单 ${SITES}`, 2);
const ids = parseDBucketIds(fs.readFileSync(DOC, 'utf8'));
if (!ids.length) die('D 桶条目列为空 ⇒ 分母不可信（真空与"真的没有"同形，单列不折算）', 2);
const siteMap = JSON.parse(fs.readFileSync(SITES, 'utf8')).sites;
const cov = coverage(ids, siteMap);
if (cov.missing.length || cov.stale.length) {
  die(`覆盖度不成立：D 桶有行而清单缺条目 ${cov.missing.join('、') || '（无）'}；清单有行而 D 桶没有 ${cov.stale.join('、') || '（无）'}`, 2);
}

function gitDiff(file) {
  try { return execFileSync('git', ['diff', '-U0', '--', file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 }); }
  catch { return null; }
}
function gitStatus(file) {
  try { return execFileSync('git', ['status', '--short', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const cache = new Map();
const rows = ids.map((id) => {
  const sites = (siteMap[id] || []).map((s) => {
    const st = gitStatus(s.file);
    const out = { file: s.file, needle: s.needle, gitStatus: st === null ? 'git 不可判' : (st || 'clean') };
    if (!fs.existsSync(path.join(ROOT, s.file))) return { ...out, verdict: 'indeterminate', why: '路径在当前树里不存在' };
    if (!cache.has(s.file)) {
      const d = gitDiff(s.file);
      cache.set(s.file, d === null ? null : parseHunks(d));
    }
    const ranges = cache.get(s.file);
    if (ranges === null) return { ...out, verdict: 'indeterminate', why: 'git diff 取不到（脏块不可判）' };
    const hits = findNeedle(fs.readFileSync(path.join(ROOT, s.file), 'utf8'), s.needle);
    return { ...out, ...judgeSite(hits, ranges), hunks: ranges.map(([a, b]) => `${a}–${b}`).join(' ') || '（无）' };
  });
  return { id, verdict: rollUp(sites), sites, distance: Math.min(...sites.map((x) => x.distance ?? Infinity)) };
});

const bucket = new Map();
for (const r of rows) bucket.set(r.verdict, (bucket.get(r.verdict) || 0) + 1);
const sum = [...bucket.values()].reduce((a, b) => a + b, 0);
if (sum !== rows.length) die(`读数作废：档位加总 ${sum} != 分母 ${rows.length}`, 2);

if (args.includes('--json')) {
  process.stdout.write(JSON.stringify({ denominator: rows.length, bucket: Object.fromEntries(bucket), rows }, null, 2) + '\n');
} else {
  console.log(`[d-bucket-collision] 分母＝§6.2 D 桶条目 ${rows.length} 个｜落点清单 ${Object.keys(siteMap).length} 条（needle 定位，行号一律按当前树现取）`);
  for (const [k, v] of [...bucket].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  console.log(`  合计 ${sum} == 分母 ${rows.length}`);
  const label = { collision: '真挡住（落点在他人 hunk 内）', discipline: '零重叠（只是纪律）', 'premise-gone': '前提已消失（文件不脏）', indeterminate: '不可判（单列不折算）' };
  for (const key of ['collision', 'indeterminate', 'discipline', 'premise-gone']) {
    const hit = rows.filter((r) => r.verdict === key);
    if (!hit.length) continue;
    console.log(`\n—— ${label[key]}`);
    for (const r of hit) for (const s of r.sites) {
      console.log(`  ${key === 'collision' ? '!' : '·'} ${r.id}  ${s.file}`);
      console.log(`      脏块 ${s.hunks ?? '—'}｜${s.why ?? s.verdict}｜git：${s.gitStatus}`);
    }
  }
  console.log(`\n限度：只核 hunk 重叠，不核语义冲突也不核授权（共享 CI 文件即使零重叠仍要点头）；脏块是**今天这棵树**的坐标，未提交改动落地后本读数即作废。`);
}
process.exit(0);
