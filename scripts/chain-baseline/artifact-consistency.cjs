// 登记册产物一致性自检（只读，V97 由 tmp/ 提升为常驻入口）：登记册 / 状态件 / 重放清单 / 常驻用例 / Makefile 入口之间的对账。
// 试点跑到 V96，结论分散在 5 个产物里；任何一处漂移都会让"可复核"变成口号。
// 只做计数与存在性检查，不改任何文件。用法：node scripts/chain-baseline/artifact-consistency.cjs（在仓库根跑）
// 判据自测（反向控制）：python3 scripts/chain-baseline/artifact-consistency.selftest.py
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
// 允许把输入指向副本（EWOH_AUDIT_*）：判据自测（"这把尺子能不能红"）必须在不动真产物的前提下做。
const DOC = process.env.EWOH_AUDIT_DOC || 'docs/audit/current/chain-behavior-baseline.md';
const STATE = process.env.EWOH_AUDIT_STATE || '.codex/artifacts/chain-behavior-baseline-state.json';
const VERIFY = process.env.EWOH_AUDIT_VERIFY || 'scripts/chain-baseline/verify.sh';

const problems = [];
const notes = [];
const docLines = fs.readFileSync(DOC, 'utf8').split('\n');
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const doc = docLines.join('\n');

// 一次遍历建立"文件名 → 是否存在"索引（避免 find/shell）
const SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__', '.pnpm', 'output']);
const byName = new Map();
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (!byName.has(e.name)) byName.set(e.name, full);
  }
})(ROOT);


/** 浅层列目录（只扫 tmp/，不递归）：够找重放日志，且不必引入依赖。 */
function globish(dirs) {
  const out = [];
  for (const d of dirs) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isFile()) out.push(d + '/' + e.name);
  }
  return out;
}

/* 1. 编号对账：文档 §五 表格行 ↔ 状态件 findings */
// V97 修①：行过滤器原先 `~~?`（至少一个波浪线）只抓到 12/48 行——尺子先修，再读差集。
const a5 = docLines.findIndex((l) => l.startsWith('## 五'));
const b5 = docLines.findIndex((l) => l.startsWith('## 六'));
const ROW_RE = /^\|\s*(?:~~)?\*{0,2}([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\*{0,2}(?:~~)?\s*\|/;
const rows = docLines.slice(a5, b5).filter((l) => ROW_RE.test(l));
const rowIds = new Set(rows.map((l) => l.match(ROW_RE)[1]));
// 有些条目只在正文里被点名（§5.3 修复记录、§七 验证记录），不占表格行——用"是否留下任何文档痕迹"兜底。
const docMentions = new Set();
for (const m of doc.matchAll(/\b([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\b(?!\s*[a-z])/g)) docMentions.add(m[1]);
const ID_RE = /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/;
// V97 修⑥：分组改非捕获后 match(...)[1] 恒为 undefined ⇒ 27 条 open 全被判"无编号"（假阳性 100%）。取 [0]。
const idOf = (e) => { const m = e.match(ID_RE); return m ? m[0] : `（开头无编号）${e.slice(0, 12)}`; };
const jsonEntries = [...state.findings.fixed, ...state.findings.open].map((e) => [idOf(e), e]);
const jsonIds = new Map(jsonEntries);
notes.push(`§五 表格行=${rows.length}（编号 ${rowIds.size}）｜状态件 fixed=${state.findings.fixed.length} open=${state.findings.open.length}（编号 ${jsonIds.size}）`);
const noDocTrace = [...jsonIds.keys()].filter((x) => !docMentions.has(x));
const openNoRow = state.findings.open.map(idOf).filter((x) => !rowIds.has(x) && !/^V\d+$/.test(x));
const a54 = docLines.findIndex((l) => l.startsWith('### 5.4 '));
const regRowIds = new Set(docLines.slice(a54, b5).filter((l) => ROW_RE.test(l)).map((l) => l.match(ROW_RE)[1]));
const brIds = new Set((state.behavior_changes || []).map(idOf));
const rowNoJson = [...regRowIds].filter((x) => !jsonIds.has(x) && !brIds.has(x));
if (noDocTrace.length) problems.push(`状态件条目在文档里毫无痕迹：${noDocTrace.join(', ')}`);
if (openNoRow.length) problems.push(`开放条目在 §5.4 表格里没有行：${openNoRow.join(', ')}`);
notes.push(`§5.4 登记表行 ${regRowIds.size} 个｜BR 条目 ${brIds.size} 个`);
if (rowNoJson.length) problems.push(`§5.4 登记表行的编号不在状态件 findings/behavior_changes 里：${rowNoJson.join(', ')}`);

/* 2. 状态件自洽：每条都以编号开头、不重复 */
[['findings.fixed', state.findings.fixed], ['findings.open', state.findings.open]].forEach(([label, list]) => {
  const seen = new Map();
  list.forEach((e, i) => {
    const id = idOf(e);
    if (!ID_RE.test(id) || /^V\d+[a-z]?$/.test(id)) problems.push(`${label}[${i}] 开头不是编号：「${id}」`);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  });
  for (const [id, n] of seen) if (n > 1) problems.push(`${label} 里 ${id} 出现 ${n} 次`);
});
// V97 修⑦（反向控制 R2 抓到的漏判）：同一编号同时出现在 fixed 与 open 也是漂移——
// 本轮手工修掉的 F-10b 就是这个形状（"缓解一半"被记成已修），原先只有"同侧重复"会报。
{
  const inFixed = new Set(state.findings.fixed.map(idOf));
  const both = [...new Set(state.findings.open.map(idOf))].filter((x) => inFixed.has(x));
  if (both.length) problems.push(`同一编号同时出现在 fixed 与 open：${both.join(', ')}`);
}

/* 3. 文档内部小节引用都能落地 */
// V97 修③：顶级小节写作「## 五、…」，正文里既有 §5.3ao 也有裸 §5——裸数字要按中文序号解析，否则误报悬空。
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const topHeadings = new Set(docLines.filter((l) => l.startsWith('## ')).map((l) => l.replace(/^##\s*/, '').slice(0, 1)));
const secIds = new Set();
const secSeen = new Map();
docLines.forEach((l) => { const m = l.match(/^#{2,4}\s+([0-9]+(?:\.[0-9]+)*[a-z]*)\s/); if (m) { secIds.add(m[1]); secSeen.set(m[1], (secSeen.get(m[1]) || 0) + 1); } });
// V142 R12：小节号重复。编号字母表用到 5.3cz 后我给自己造了个已存在的号（§5.3cm 早被 V120 占用），
// 悬空引用查不出来（两个都在），被引用的那一侧却会指到先出现的那节 ⇒ 必须单独查。
const dupSec = [...secSeen].filter(([, n]) => n > 1);
const refs = [...new Set((docLines.join('\n').match(/§\s?[0-9]+(?:\.[0-9]+)*[a-z]*/g) || []).map((s) => s.replace(/§\s?/, '')))];
const resolvable = (r) => (r.includes('.')
  ? (secIds.has(r) || secIds.has(r.replace(/[a-z]+$/, '')))
  : (CN[Number(r)] ? topHeadings.has(CN[Number(r)]) : secIds.has(r)));
const dangling = refs.filter((r) => !resolvable(r));
notes.push(`小节号 ${secIds.size} 个（重复 ${dupSec.length}）｜顶级小节 ${topHeadings.size} 个｜被引用 ${refs.length} 个｜悬空 ${dangling.length}`);
if (dangling.length) problems.push(`指向不存在小节的引用：${dangling.join(', ')}`);
if (dupSec.length) problems.push(`小节号重复（§引用会指到先出现的那节）：${dupSec.map(([id, n]) => `${id}×${n}`).join(', ')}`);

/* 4. §七 最后一行 ↔ current_status */
/* V266：`current_status` 与 `findings.fixed_count_note` 都是**逐轮拼接串**（前者段间以 ｜ 分隔，
   后者条间以「（V<nnn> 复算：」起头）。这两处的自述一律只认**最新那段/那条**：全文首个命中会让旧段替
   新段说话——实测 V262–V264 三轮把新前缀写成空格分隔，而 `_NNN_fixed_NNN_open` 的正则要下划线开头，
   于是连续四轮首命中落在 V261 段（V265 记账时实测 index 624），只因那几轮 findings 恰好没变才没报错。
   与 V262 收窄速览读取面是同一条病：值不等＝错误归因，值恰好相等＝静默放行。缺段一律单列「首段未带」，
   不许折成"读到旧段的数就算核对过"。 */
const csHead = String(state.current_status || '').split('｜')[0];
const noteHead = (() => {
  const n = String((state.findings || {}).fixed_count_note || '');
  const re = /（V\d+ 复算：/g;
  const hits = [];
  let m;
  while ((m = re.exec(n)) !== null) hits.push(m.index);
  return hits.length ? n.slice(hits[0], hits.length > 1 ? hits[1] : n.length) : n;
})();
notes.push(`状态件自述读取面：current_status 首段＝${csHead.slice(0, 30)}…｜fixed_count_note 首条＝${noteHead.slice(0, 26)}…`);
const vRows = docLines.filter((l) => /^\| V\d+[a-z]? \|/.test(l)).map((l) => l.split('|')[1].trim());
const lastV = vRows[vRows.length - 1] || '（无）';
const vNum = Number((lastV.match(/\d+/) || [0])[0]);
const csNum = Number((csHead.match(/pilot_through_V(\d+)/) || [])[1] || -1);
notes.push(`§七 行数=${vRows.length}｜最后一行=${lastV}｜current_status=${state.current_status.slice(0, 26)}…`);
if (csNum < 0) problems.push('current_status 首段未带 pilot_through_Vnn（不折成读旧段）');
else if (csNum !== vNum) problems.push(`§七 最后一行 ${lastV} 与 current_status V${csNum} 不一致`);

/* 5. CHAIN_SPECS ↔ 磁盘上的 spec 文件 */
const vs = fs.readFileSync(VERIFY, 'utf8');
const from = vs.indexOf('CHAIN_SPECS=');
const chunk = vs.slice(from, vs.indexOf('\n\n', from) < 0 ? from + 900 : vs.indexOf('\n\n', from));
const specs = [...new Set(chunk.replace(/^CHAIN_SPECS=/, '').split(/[\\\s"']+ /).join(' ').match(/[a-z0-9][a-z0-9-]*-[a-z0-9-]*/g) || [])]
  .filter((s) => s.length > 6);
const e2eDir = 'ewoh-spark-app/test/e2e';
const onDisk = fs.readdirSync(e2eDir).filter((f) => f.endsWith('.e2e.spec.ts')).map((f) => f.replace('.e2e.spec.ts', ''));
const missing = specs.filter((s) => !onDisk.includes(s));
const notListed = onDisk.filter((s) => !specs.includes(s));
notes.push(`CHAIN_SPECS=${specs.length} [${specs.join(' ')}]`);
notes.push(`磁盘 e2e spec=${onDisk.length}｜未列入清单：${notListed.join(' ') || '（无）'}`);
if (missing.length) problems.push(`清单里的 spec 文件不存在：${missing.join(', ')}`);

/* 6. 文档点名的文件都存在 */
// V97 修④：扩展名交替按最长优先并加边界，否则 x.json 被切成 x.js、*.dead-letter.jsonl 被当成文件名；
// 通配与"文档自己写明已删除的一次性脚手架"不算缺失（后者是有意清理，前者不是具体文件）。
const cited = [...new Set((doc.match(/[A-Za-z0-9_./*-]+\.(?:e2e\.spec\.ts|spec\.ts|tsx|sql|ya?ml|jsonl|json|cjs|mjs|sh|py|js)(?![A-Za-z0-9])/g) || []))];
const callSites = new Set();
for (const m of doc.matchAll(/([A-Za-z0-9_.-]+\.[a-z]+)\s*\(/g)) callSites.add(m[1]);
/** 安装进 node_modules 的第三方文件：文档引它当机制证据，不是仓库路径（同 postgres.js 一类）。*/
const LIBRARIES = new Set(['postgres.js', 'pg-symlinks.json', 'hydrate-symlinks.js']);
const tokens = cited.filter((c) => {
  const bare = c.split('/').pop();
  if (c.includes('*') || bare.startsWith('.') || callSites.has(c) || LIBRARIES.has(bare)) return false;
  if (c.includes('/') && fs.existsSync(path.join(ROOT, c))) return false;
  if (c.includes('/') && fs.existsSync(path.join(ROOT, 'ewoh-spark-app', c))) return false;
  return !byName.has(bare);
});
const withCtx = tokens.filter((c) => {
  const i = doc.indexOf(c);
  const window = doc.slice(Math.max(0, i - 260), i + 260);
  return !/(已删除|删除后|取证后删除|用后删除|从未存在|一次性脚本|临时脚本|手工脚本)/.test(window);
});
notes.push(`文档点名文件 ${cited.length} 个（通配/隐藏已排除）｜找不到 ${tokens.length}｜其中上下文未标注"已删除/一次性" ${withCtx.length}`);
if (withCtx.length) problems.push(`文档点名但仓库里找不到、且未标注为已删：${withCtx.join(', ')}`);

/* 7. Makefile 入口齐备 */
const make = fs.readFileSync('Makefile', 'utf8');
['chain-baseline-up', 'chain-baseline-seed', 'chain-baseline-rebuild', 'chain-baseline-verify', 'chain-baseline-down',
  'chain-baseline-doctor', 'chain-baseline-doctor-selftest', 'unit-triage', 'audit-regression-gates']
  .forEach((t) => { if (!new RegExp(`^${t}:`, 'm').test(make)) problems.push(`Makefile 缺少入口 ${t}`); });

/* 7b（V345，OWNID-01）：量具自述"我是某编号的机械半"时，那个编号必须在登记册里。
   动因：`Makefile:477` 曾写「ALIAS-01 的机械半」，而 ALIAS-01 在登记册／状态件／裁决包里一处都没有
   （真正的归属行是 ENTAX-01）——既有判据只核"§5.4 行 ↔ findings"、"小节引用是否指空"、"点名的文件是否存在"，
   没有一条把**编号**当被声明物来核。判据与面清单在 owner-id-claims.cjs 里（纯函数，可被常驻用例 require）。*/
{
  const owner = require('./owner-id-claims.cjs');
  const ofaces = owner.collectFaces(process.cwd());
  const oids = new Set([...regRowIds, ...jsonIds, ...brIds]);
  const oclaims = Object.values(ofaces).reduce((a, t) => a + owner.claimsIn(t).length, 0);
  const obad = owner.offenders(ofaces, oids);
  for (const b of obad) problems.push(`量具归属声明指空：${b.file} 点名「${b.id}」（短语「${b.phrase}」）不在登记册在册编号里`);
  notes.push(`量具归属声明核对：面 ${Object.keys(ofaces).length} 份（Makefile＋CI＋量具，排除本件与 owner-id-claims 自身）、在册编号 ${oids.size} 个、归属短语 ${oclaims} 处、指空 ${obad.length} 处`);
}

/* 8. 门禁脚本至少被某处调用（Makefile 或 CI workflow）*/
// V97 修⑤：原先只认 Makefile，把 11 个由 .github/workflows 接手的他人门禁当成"没接线"。
const workflows = fs.readdirSync('.github/workflows')
  .map((f) => fs.readFileSync(path.join('.github/workflows', f), 'utf8')).join('\n');
const gateScripts = fs.readdirSync('scripts').filter((f) => /^audit-.*\.js$/.test(f));
const unwired = gateScripts.filter((f) => !make.includes(f) && !workflows.includes(f));
notes.push(`scripts/audit-*.js=${gateScripts.length} 个｜Makefile 引 ${gateScripts.filter((f) => make.includes(f)).length}｜CI 引 ${gateScripts.filter((f) => workflows.includes(f)).length}｜两处都无：${unwired.join(' ') || '（无）'}`);
if (unwired.length) notes.push(`（越权不改，仅登记为提示）${unwired.length} 个 audit-*.js 无调用方，均为 ff361548 他人提交：${unwired.join(' ')}`);

/* 9. 状态件里的自述计数 ↔ 数组真实长度（V97 抓到 current_status 与 fixed_count_note 双双过期）*/
const nFixed = state.findings.fixed.length, nOpen = state.findings.open.length;
const cs = csHead.match(/_(\d+)_fixed_(\d+)_open/) || [];
if (cs.length) {
  if (Number(cs[1]) !== nFixed) problems.push(`current_status 写 fixed=${cs[1]} 实际 ${nFixed}`);
  if (Number(cs[2]) !== nOpen) problems.push(`current_status 写 open=${cs[2]} 实际 ${nOpen}`);
} else problems.push('current_status 首段未带 _<n>_fixed_<m>_open 计数段（不折成读旧段）');
const note = noteHead.match(/fixed (\d+) 条 \/ open (\d+) 条/);
if (!note) problems.push('fixed_count_note 首条未写「fixed n 条 / open m 条」（不折成读旧条）');
else {
  if (Number(note[1]) !== nFixed) problems.push(`fixed_count_note 写 fixed=${note[1]} 实际 ${nFixed}`);
  if (Number(note[2]) !== nOpen) problems.push(`fixed_count_note 写 open=${note[2]} 实际 ${nOpen}`);
}
// V110 补：同一条注记里还写着「§5.4 登记表 N 行」，此前只核对 fixed/open 两个数，
// 行数那半句可以一直过期没人发现（本轮记账就真的只改了数组、没改注记）。
const noteRows = noteHead.match(/§5\.4 登记表 (\d+) 行/);
if (!noteRows) problems.push('fixed_count_note 首条未写「§5.4 登记表 n 行」，无法核对（不折成读旧条）');
else if (Number(noteRows[1]) !== regRowIds.size) problems.push(`fixed_count_note 写 §5.4 ${noteRows[1]} 行，实际 ${regRowIds.size} 行`);
const specseg = csHead.match(/chain_specs_(\d+)_(\d+)_/);
if (!specseg) problems.push('current_status 首段未带 chain_specs_<n>_<tests> 段（不折成读旧段）');
else {
  if (Number(specseg[1]) !== specs.length) problems.push(`current_status 写 specs=${specseg[1]} 实际 CHAIN_SPECS ${specs.length}`);
}
/* V115：状态件自述的门线条数也要对上——速览那条已由第 11 项核对，状态件这一侧此前无人核过
   （实测：V114 收尾时 current_status 还写着 gates_19_mainlines，而 Makefile 已是 21 条）。*/
const gseg = csHead.match(/gates_(\d+)_mainlines/);
const makeMainlines = (make.match(/──\s*主线\d+/g) || []).length;
if (!makeMainlines) problems.push('Makefile 里抽不到「── 主线N」标号，无法核对门禁条数');
else if (!gseg) problems.push('current_status 首段未带 gates_<n>_mainlines 段（不折成读旧段）');
else if (Number(gseg[1]) !== makeMainlines) problems.push(`current_status 写 gates=${gseg[1]} 实际 Makefile 主线 ${makeMainlines}`);
notes.push(`计数核对：fixed=${nFixed} open=${nOpen} specs=${specs.length} gates=${makeMainlines}｜current_status=${cs[1] || '?'}/${cs[2] || '?'} g=${gseg ? gseg[1] : '?'}｜note=${note ? `${note[1]}/${note[2]}` : '?'}`);

/* 10 前置：最近一份含汇总行的重放日志。V102 口径——按 mtime 挑，绝不写死文件名（写死的候选列表会把旧读数当真值）。
   V110 起裁决包与文档「当前状态速览」两处都要对同一个 passed 值 ⇒ 选择逻辑只留一份（一处一图）。
   V235 修：候选集原先只有顶层 `tmp/`，而重放器把 D/D2 的汇总行写在 `tmp/chain-baseline/e2e-logs/`
   ⇒ 常驻真值源永远不在候选里，passed 只能由**手边的临时取证日志**供给，一个旧 `tmp/vNNN-replay*.log`
   就能把正确的当期读数判成漂移（本轮实测：文档写 86 条 passed＝chain-specs.log 的 86 passed, 86 total，
   尺子却拿 18:33 的 v229-replay4.log 读出 85 并报了 3 条 ✗）。补进目录与文件名，仍按 mtime 挑。*/
// V239：候选目录与它的档位都可注入（默认＝重放器规范日志优先、顶层手抄取证日志兜底）。
// 之所以做成可注入：不注入就无法在常驻自测里造「两份互相矛盾的日志」，V235 那三条控制只能手工跑。
const LOG_DIRS = (process.env.EWOH_AUDIT_LOG_DIRS || 'tmp/chain-baseline/e2e-logs,tmp')
  .split(',').map((x) => x.trim()).filter(Boolean);
const latest = (() => {
  const cands = [];
  LOG_DIRS.forEach((d, tier) => {
    const re = tier === 0 ? /chain-specs|d2?\.log/ : /replay|d2?\.log|verify/;
    globish([d]).filter((f) => re.test(f)).forEach((f) => cands.push({ f, tier }));
  });
  // 档位（tier）必须参与排序键，否则单纯 prepend 会被 mtime 重排掉（V235 实测过一次）。
  const withSum = cands
    .map((x) => ({ f: x.f, tier: x.tier, m: fs.statSync(x.f).mtimeMs }))
    .filter((x) => /Tests:\s+\d+ passed/.test(fs.readFileSync(x.f, 'utf8')))
    .sort((a, b) => (a.tier - b.tier) || (b.m - a.m));
  if (!withSum.length) return { file: null, passed: null };
  const last = (fs.readFileSync(withSum[0].f, 'utf8').match(/Tests:\s+(\d+) passed/g) || []).pop();
  return { file: withSum[0].f, passed: last ? Number(last.match(/(\d+)/)[1]) : null };
})();
const pn = latest.passed;
// V239：读不到必须单列，不许折成「已核对」。今天没有一条候选日志含 Tests: 汇总行时，三处 passed 判据原先整体静默
// （常驻自测 C4 实测：probs=0、rc=0，与"干净"完全同形）⇒ 登记文本里的 passed 数字就变成无人核对的自述。
if (pn === null) {
  problems.push('链级 passed 不可判：候选日志目录（' + LOG_DIRS.join(' , ') + '）里没有任何含 `Tests: N passed` 汇总行的文件 ⇒ 不折算成已核对');
}

// 中文数词 → 整数（只覆盖本项目会用到的 1..99；门禁主线条数用它把速览与 Makefile 对齐）
function cn2int(s) {
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  const t = s.indexOf('十');
  if (t === -1) return d[s] || NaN;
  const tens = t === 0 ? 1 : (d[s.slice(0, t)] || NaN);
  const ones = t === s.length - 1 ? 0 : (d[s.slice(t + 1)] || NaN);
  return tens * 10 + ones;
}

/* 10. 裁决包引用的登记册读数必须与真值一致（V99：推广件一旦过期比文档更危险，它是给人拍板的那一页）*/
const PKG = process.env.EWOH_AUDIT_PKG || 'docs/audit/current/pilot-promotion-verdict.md';
if (fs.existsSync(PKG)) {
  const pkg = fs.readFileSync(PKG, 'utf8');
  /* R 节自述核对（V248）：§四·补 的标题自己声明「R1..R<n>」，而节数是场上数出来的。
     起因＝V245 用 replace('### R14', …) 插入更正时把标题前缀吃掉 ⇒ 裁决包只剩 15 节，
     此后四轮所有门禁全绿——没有任何判据把这句自述与实数对照。⇒ 节数≠声明数即红；
     编号重复也红（重复＝并单/改号时把两节合并成同名）；声明缺失同样红，不许静默跳过。 */
  const rHeads = pkg.split('\n').filter((l) => /^### R\d+/.test(l));
  const rIds = rHeads.map((l) => (l.match(/^### R(\d+)/) || [])[1]);
  const rDup = rIds.filter((v, i) => v !== undefined && rIds.indexOf(v) !== i);
  if (rDup.length) problems.push('裁决包 R 节编号重复：' + Array.from(new Set(rDup)).join('、'));
  const rClaim = (pkg.match(/^## 四·补[^（\n]*（R1\.\.R(\d+)/m) || [])[1];
  if (!rClaim) problems.push('裁决包 §四·补 标题未声明 R1..R<n> ⇒ 节数无从核对（不折算成已核对）');
  else if (Number(rClaim) !== rHeads.length) problems.push(`裁决包 R 节数 ${rHeads.length} ≠ 标题声明 R1..R${rClaim}`);
  /* R 范围自述的**写法面**推广（V252）：V248 那条只认 `（R1..R<n>` 一种，而 V251 发现同一文档另一处标题写的是
     `（R1–R12）`（en dash）——它停在 R12、场上 16 节，四轮门禁全绿。判据改为扫**所有 2～4 级标题行**里的
     `R1 <sep> R<n>`（sep ∈ `..`／`–`／`—`／`-`／`~`），每个 n 都必须等于实有节数。
     只扫标题、不扫散文＝假阳性面为零：散文里「本单 R1／R2 两处」这类子集引用是合法表述，不该被当全量声明。 */
  const rDecl = [];
  for (const l of pkg.split('\n')) {
    if (!/^#{2,4}\s/.test(l)) continue;
    for (const x of l.matchAll(/R1\s*(?:\.\.|–|—|-|~)\s*R(\d+)/g)) rDecl.push(Number(x[1]));
  }
  for (const n of new Set(rDecl)) {
    if (n !== rHeads.length) problems.push(`裁决包标题自述 R1..R${n}，实有 ${rHeads.length} 个 R 节 ⇒ 范围自述与节数不符`);
  }
  /* §四 那张旧表（不是 §四·补）：V250 决定**只打印现算读数、不立判据**。理由是这张表由人逐行拍，
     把总数抄进散文就等于多造一处会烂的副本（V205／V224／V225／V227／V245 五次同一族）。
     需要引用它的人从这里现取；读不到表 ⇒ 明说不可判，不折算成 0 行。 */
  {
    const l4 = pkg.split('\n');
    const a4 = l4.findIndex((l) => l.startsWith('## 四、'));
    const s4 = a4 < 0 ? -1 : l4.findIndex((l, i) => i > a4 && /^\|/.test(l));
    if (s4 < 0) notes.push('裁决包 §四 表未读到 ⇒ 行数不可判（不折算成 0 行）');
    else {
      let e4 = s4;
      while (e4 < l4.length && /^\|/.test(l4[e4])) e4 += 1;
      notes.push(`裁决包 §四 表数据行数（现算，散文里不留副本）= ${Math.max(0, e4 - s4 - 2)}`);
    }
  }
  const closed = docLines.slice(a54, b5).filter((l) => ROW_RE.test(l))
    .filter((l) => /^\|\s*~~/.test(l) || /已修复|已关闭/.test(l)).length;
  const total = regRowIds.size;
  const mRow = pkg.match(/\*{0,2}§5\.4 ?\*{0,2}(\d+) 行（(\d+) 闭 \/ (\d+) 开）\*{0,2}/);
  if (!mRow) problems.push('裁决包未写「§5.4 N 行（x 闭 / y 开）」读数（粗体位置不限），无法核对');
  else {
    if (Number(mRow[1]) !== total) problems.push(`裁决包写 §5.4 ${mRow[1]} 行，实际 ${total} 行`);
    if (Number(mRow[2]) !== closed) problems.push(`裁决包写 ${mRow[2]} 闭，实际 ${closed} 闭`);
    if (Number(mRow[3]) !== total - closed) problems.push(`裁决包写 ${mRow[3]} 开，实际 ${total - closed} 开`);
  }
  const mFind = pkg.match(/findings \*\*(\d+) fixed \/ (\d+) open\*\*/);
  if (!mFind) problems.push('裁决包未写「findings **n fixed / m open**」读数，无法核对');
  else {
    if (Number(mFind[1]) !== nFixed) problems.push(`裁决包写 fixed=${mFind[1]}，实际 ${nFixed}`);
    if (Number(mFind[2]) !== nOpen) problems.push(`裁决包写 open=${mFind[2]}，实际 ${nOpen}`);
  }
  const mSpec = pkg.match(/(\d+) spec \/ (\d+) passed/);
  if (!mSpec) problems.push('裁决包未写「N spec / M passed」读数，无法核对');
  else if (Number(mSpec[1]) !== specs.length) problems.push(`裁决包写 ${mSpec[1]} spec，CHAIN_SPECS 实际 ${specs.length}`);
  // passed 数只能对着重放日志核；日志不在就明确报"未核对"，绝不当成通过（SKIP≠PASS 的同一条纪律）
  if (pn === null) notes.push(`裁决包的 passed=${mSpec ? mSpec[2] : '?'} 未核对（无含汇总行的重放日志）`);
  else if (mSpec && Number(mSpec[2]) !== pn) problems.push(`裁决包写 ${mSpec[2]} passed，最近的 ${latest.file} 实测 ${pn}`);
  else notes.push(`裁决包 passed=${pn} 与 ${latest.file} 对上（按 mtime 取最近一份）`);
} else notes.push('（裁决包尚未创建，跳过其读数核对）');

/* 11b. §六 收益度量表里"有唯一写者"的数字必须等于真值（V113）。
   这一节是推广判据的证据面，最危险的形状不是空值，而是某个历史读数一直躺在"现值"列里：
   V113 实测就有四例（"修复后 6 项"停在 V56、V97 写的"现值 15 spec/44 passed"自己又过期、
   "真实 PG 全新链"现值列写「同」、§6.1 依据列引 3608/3608 与 33 passed）。*/
function newestWith(paths, re) {
  const hit = paths.filter((f) => fs.existsSync(f))
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .filter((x) => re.test(fs.readFileSync(x.f, 'utf8')))
    .sort((a, b) => b.m - a.m);
  return hit.length ? hit[0].f : null;
}
{
  const a = docLines.findIndex((l) => l.startsWith('## 六、'));
  const b = docLines.findIndex((l) => l.startsWith('## 七、'));
  const sec6 = docLines.slice(a >= 0 ? a : 0, b > 0 ? b : docLines.length).join('\n');
  if (a < 0) problems.push('找不到 §六 收益度量小节');
  const closedClaim = sec6.match(/\*\*(\d+) 项已闭\*\*/);
  if (!closedClaim) problems.push('§六 未把"已闭条目数"写成可核对形式（**N 项已闭**）');
  else if (Number(closedClaim[1]) !== nFixed) problems.push(`§六 写 ${closedClaim[1]} 项已闭，findings.fixed 实际 ${nFixed}`);
  const verClaim = sec6.match(/\*\*(\d+)\/(\d+) verify PASS\*\*/);
  const vlog = newestWith(globish(['tmp']).concat(['tmp/chain-baseline/e2e-logs/fresh-chain.log']), /verify \d+\/\d+ PASS/);
  if (!verClaim) problems.push('§六 的 A 段 verify 未写成可核对形式（**N/N verify PASS**）');
  else if (!vlog) notes.push('§六 verify 未核对（找不到含 A 段计数的日志）');
  else {
    const t = fs.readFileSync(vlog, 'utf8').match(/verify (\d+)\/(\d+) PASS/);
    if (Number(verClaim[1]) !== Number(t[1]) || Number(verClaim[2]) !== Number(t[2])) {
      problems.push(`§六 写 verify ${verClaim[1]}/${verClaim[2]}，${vlog} 实测 ${t[1]}/${t[2]}`);
    }
  }
  const dClaim = sec6.match(/当期读数 = (\d+) spec \/ (\d+) passed \/ 0 skip/);
  if (!dClaim) problems.push('§六 的链级 E2E 当期读数未写成可核对形式（当期读数 = N spec / M passed / 0 skip）');
  else {
    if (Number(dClaim[1]) !== specs.length) problems.push(`§六 写 ${dClaim[1]} spec，CHAIN_SPECS 实际 ${specs.length}`);
    if (pn === null) notes.push('§六 的 passed 未核对（无含汇总行的重放日志）');
    else if (Number(dClaim[2]) !== pn) problems.push(`§六 写 ${dClaim[2]} passed，最近的 ${latest.file} 实测 ${pn}`);
  }
  const uClaim = sec6.match(/后端单测 (\d+)\/(\d+) 通过/);
  // 只认 unit-triage 归档器自己的带时间戳文件名（唯一写者的产物）。第一版用 `unit-*.log` 在 tmp/ 里挑，
  // 结果选中别人早年手跑的 tmp/unit-runinband.log（3608/3608），把**正确**的当期读数报成偏差——
  // 日志选择器必须钉在产物的命名约定上，而不是"看起来像日志"上。
  const unitCands = globish((process.env.EWOH_AUDIT_UNIT_DIRS || 'tmp/chain-baseline,tmp').split(','))
    .filter((f) => /unit-\d{8}-\d{6}\.log$/.test(f));
  const ulog = newestWith(unitCands, /Tests:[^|]*\d+ passed/);
  if (!uClaim) problems.push('§六 的全量单测当期读数未写成可核对形式（后端单测 N/M 通过）');
  else if (!ulog) notes.push('§六 单测读数未核对（找不到含汇总行的单测日志）');
  else {
    const m = fs.readFileSync(ulog, 'utf8').replace(/\x1b\[[0-9;]*m/g, '')
      .match(/Tests:[^|]*?(\d+) passed,\s*(\d+) total/);
    if (Number(uClaim[1]) !== Number(m[1]) || Number(uClaim[2]) !== Number(m[2])) {
      problems.push(`§六 写 后端单测 ${uClaim[1]}/${uClaim[2]}，${ulog} 实测 ${m[1]}/${m[2]}`);
    }
  }
  /* UARCH-01（V351）：上面那段只核"最新一份"的数，**文档里点名的那个归档文件从来没人核**。
     V350 抓到活例：格中抄 417/3694（V348/V349 那两遍的数）却点名 unit-20260929-133730.log（V347 那一遍），
     四门全绿——按名去翻证据的人只会翻到旧树的读数。这里把"点名的归档必须存在、且它自己的汇总行与抄的三个数相符"
     变成判据；两份归档读数相同是合法情形，所以只比"点名的这一份"，不要求它是最新的一份。 */
  const uac = require('./unit-archive-claim.cjs');
  const namedClaim = uac.parseUnitClaim(sec6);
  if (namedClaim) {
    const hit = unitCands.filter((f) => f.split('/').pop() === namedClaim.archive);
    const namedText = hit.length ? fs.readFileSync(hit[0], 'utf8') : null;
    const uc = uac.checkUnitArchiveClaim(namedClaim, namedText, unitCands);
    for (const p of uc.issues) problems.push(p);
    if (uc.verdict === '一致') notes.push(`§六 单测归档定名核对：${namedClaim.archive} 的汇总行与抄写的三个数相符`);
    if (uc.verdict === '不可判') notes.push('§六 单测归档定名未核对（产物集为空 ⇒ 不折成一致）');
  }
  notes.push('§六 定源核对：已闭 / A 段 verify / 链级 spec+passed / 全量单测 四类已与产物对账');
}

/* 11. 文档开头「当前状态速览」的三处自述（V110）：交接时最先被读到的数字，本轮实测它们全是历史值
   （"D 与 D2 各 14 spec / 42 条""十七条主线""50 行 21 闭 29 开"三项都停留在 V86/V92 时点）。
   一处数字只许有一个写者：速览里那三格现在由记账脚本按表重算，并由这里核对。*/
const snap0 = docLines.slice(0, a54).join('\n');
notes.push(`速览段数（现算，勿在注释里写死）＝${snap0.split('\n').filter((l) => l.startsWith('**当前状态速览')).length}`);
/* V262（措辞由 V264/V265 更正）：文档顶部的速览是**逐轮累积**的——每轮 prepend 一段，段数随轮次增长
   （段数由上一行现算）。而 `snap0.match` 取的是"全文首个命中"——
   最新那段缺某句自述时会**顺势读次新段的旧值**。旧值若与现值巧合相等就是静默放行（findings／spec／门禁条数
   这几轮本来就不变，正是最巧合的一族），不相等则报成"写错值"而非"漏写"。V261 收尾时轮次号那格（11j）
   实测撞上了后者。下面五处自述一律只认**首段**（从第一个「**当前状态速览」行到下一个之前）：
   读不到 ⇒ 走各自的「无法核对」分支，不折成已核对。 */
const snapHead = (() => {
  const l = snap0.split('\n');
  const h = l.findIndex((x) => x.startsWith('**当前状态速览'));
  if (h < 0) return '';
  let e = l.length;
  for (let i = h + 1; i < l.length; i++) if (l[i].startsWith('**当前状态速览')) { e = i; break; }
  return l.slice(h, e).join('\n');
})();
{
  const snap = snapHead;
  const rows = docLines.slice(a54, b5).filter((l) => ROW_RE.test(l));
  const closedRows = rows.filter((l) => /^\|\s*~~/.test(l) || /已修复|已关闭/.test(l)).length;
  const mS = snap.match(/§5\.4 共 \*\*(\d+) 行——(\d+) 行已闭[^、]*、(\d+) 行开放\*\*/);
  if (!mS) problems.push('速览未写「§5.4 共 N 行——x 行已闭、y 行开放」，无法核对');
  else {
    if (Number(mS[1]) !== rows.length) problems.push(`速览写 §5.4 ${mS[1]} 行，实际 ${rows.length} 行`);
    if (Number(mS[2]) !== closedRows) problems.push(`速览写 ${mS[2]} 行已闭，实际 ${closedRows} 行`);
    if (Number(mS[3]) !== rows.length - closedRows) problems.push(`速览写 ${mS[3]} 行开放，实际 ${rows.length - closedRows} 行`);
  }
  const mD = snap.match(/D 与 D2 各 (\d+) spec \/ (\d+) 条 passed/);
  if (!mD) problems.push('速览未写「D 与 D2 各 N spec / M 条 passed」，无法核对');
  else {
    if (Number(mD[1]) !== specs.length) problems.push(`速览写 ${mD[1]} spec，CHAIN_SPECS 实际 ${specs.length}`);
    if (pn === null) notes.push(`速览的 passed=${mD[2]} 未核对（无含汇总行的重放日志）`);
    else if (Number(mD[2]) !== pn) problems.push(`速览写 ${mD[2]} 条 passed，最近的 ${latest.file} 实测 ${pn}`);
  }
  // 11e（V206 新增）：速览里那句 findings 自述此前**不在核对清单上**——同一份数抄在两处，
  // 而机器只核另一处（§六「N 项已闭」与裁决包正文），于是 V205 新增开放项时这一格漏改、连续一轮无人发现。
  // 形状与 V113「历史读数躺在现值列里」同族：不是有人写错，而是有一处**根本没被核**。
  const mFx = snap.match(/口径记 \*\*(\d+) fixed \/ (\d+) open\*\*/);
  if (!mFx) problems.push('速览未写「口径记 N fixed / M open」，无法核对（V206 起这一格纳入强核对）');
  else {
    if (Number(mFx[1]) !== nFixed) problems.push(`速览写 fixed=${mFx[1]}，findings.fixed 实际 ${nFixed}`);
    if (Number(mFx[2]) !== nOpen) problems.push(`速览写 open=${mFx[2]}，findings.open 实际 ${nOpen}`);
  }
  // 门禁条数：三处必须同时改（Makefile 头注释、`── 主线N` 的真实条数、速览里的中文数词）
  const mkMax = Math.max(0, ...[...make.matchAll(/── 主线(\d+)/g)].map((x) => Number(x[1])));
  const mkHeader = (make.match(/防回归门禁（([一二三四五六七八九十]+)条主线/) || [])[1];
  const mG = snap.match(/防回归门禁 \*\*([一二三四五六七八九十]+)条主线\*\*/);
  if (!mG) problems.push('速览未写「防回归门禁 N条主线」，无法核对');
  else {
    if (cn2int(mG[1]) !== mkMax) problems.push(`速览写「${mG[1]}条主线」，Makefile 里实际有 ${mkMax} 条（按「── 主线N」计数）`);
    if (mkHeader !== mG[1]) problems.push(`速览写「${mG[1]}条主线」而 Makefile 头注释写「${mkHeader || '?'}条主线」——两处必须一起改`);
  }
  notes.push(`速览核对：§5.4 ${rows.length} 行（${closedRows} 闭）｜spec ${specs.length}｜门禁 主线 ${mkMax} 条（头注释「${mkHeader || '?'}」）｜findings ${mFx ? mFx[1] + '/' + mFx[2] : '?'}（数组 ${nFixed}/${nOpen}）`);
  /* 11j（V250 新增，V262 修形状）：速览首段的**轮次号**此前不在任何判据上。V247 漏写 prepend，是 V248 手工自查才发现的
     ——同一形状还会再来（每轮prepend 一次、共 138 行的那一段最容易忘）。判据＝首段那个 V<n> 必须等于
     current_status 里最新的 pilot_through_V<n>（第 4 项已经拿 §七 末行对过同一个数，这里补第三处副本）。
     读不到形状 ⇒ 单列「无从核对」，不折成已核对。
     V262 的更正（措辞由 V264/V265 再更正）：文档顶部的速览是**逐轮累积**（每轮 prepend 一段，段数由上面现算），
     `snap0.match` 在最新那段没号时会顺势读到次新段的号，
     把「形状坏了」报成「落后一轮」（V261 收尾时控制 O2 正是这样失效的，且被 closer 的 grep 静默了一次）。
     现在 snap 已是首段，声明位＝首段开头那个 `**当前状态速览（V<n>`；没有号就是「无从核对」，后面几段救不了它。 */
  const ovRound = (snap.match(/^\*\*当前状态速览（V(\d+)/) || [])[1];
  if (!ovRound) problems.push('速览首段未写「**当前状态速览（V<n> 收尾时点」⇒ 轮次号无从核对（不折算成已核对）');
  else if (csNum < 0) notes.push(`速览首段 V${ovRound} 未核对（current_status 没有 pilot_through_Vnn）`);
  else if (Number(ovRound) !== csNum) problems.push(`速览首段写 V${ovRound}，current_status 最新轮次是 V${csNum} ⇒ 本轮漏写速览 prepend？`);
  else notes.push(`速览首段轮次号 V${ovRound} ＝ current_status 最新轮次`);
}

/* 11f（V206 新增）：§6.2 归属桶表的数量列 / 条目列 / 加总三件事此前无人核对。
   V205 新增 RECOV-01 时把 E 桶改成 8 条并列进条目，表下那句「加总 = 64」却留在原地——
   表内自述写着 65、表下写着 64，连续一轮判绿。形状与 11e 同族：同一份数抄多处，
   先坏的一定是「没被核的那一处」。这里三向核对：数量↔条目、五桶↔开放数、桶表↔findings.open 集合。*/
{
  // §6.2 里不止一张桶表（V127 原表与 V162 补全表已转历史），所以取 `### 6.2` 之后**第一段连续**的
  // `| A–E |` 行——当期表紧接在「当期唯一读法」那句之后，历史表在它下面且各自连续。
  const a62 = docLines.findIndex((l) => l.startsWith('### 6.2'));
  const ROW62 = /^\|\s*[A-E]\s*\|/;
  const start = a62 < 0 ? -1 : docLines.findIndex((l, i) => i > a62 && ROW62.test(l));
  const rows62 = start < 0 ? [] : (() => {
    const out = [];
    for (let i = start; i < docLines.length && ROW62.test(docLines[i]); i += 1) out.push(docLines[i]);
    return out;
  })();
  if (rows62.length !== 5) {
    problems.push(`§6.2 当期归属桶表读到 ${rows62.length} 行（应为 A–E 五行），无法核对`);
  } else {
    const idOf = (s) => (String(s).match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)?[a-z]?)/) || [])[1] || '';
    const bad = [];
    const items = [];
    let declared = 0;
    for (const l of rows62) {
      const c = l.split('|');
      const bucket = String(c[1]).trim();
      const cnt = Number(String(c[3]).trim());
      const list = String(c[4]).split('、').map((s) => s.trim()).filter(Boolean).map(idOf);
      if (!Number.isFinite(cnt)) bad.push(`${bucket} 桶数量列不是数字`);
      else if (cnt !== list.length) bad.push(`${bucket} 桶数量列 ${cnt}≠条目列实列 ${list.length}`);
      declared += Number.isFinite(cnt) ? cnt : 0;
      items.push(...list);
    }
    const dup = items.filter((x, i) => items.indexOf(x) !== i);
    if (dup.length) bad.push(`同一编号落进两个桶：${[...new Set(dup)].join('、')}`);
    const openRowIds = docLines.slice(a54, b5)
      .filter((l) => ROW_RE.test(l) && !/^\|\s*~~/.test(l) && !/已修复|已关闭/.test(l))
      .map((l) => (l.match(ROW_RE) || [])[1] || '');
    const missing = openRowIds.filter((x) => !items.includes(x));
    const extra = items.filter((x) => !openRowIds.includes(x));
    if (missing.length) bad.push(`在 §5.4 开放行里但桶表未列：${[...new Set(missing)].join('、')}`);
    if (extra.length) bad.push(`桶表列了但 §5.4 开放行里没有：${[...new Set(extra)].join('、')}`);
    if (declared !== openRowIds.length) bad.push(`五桶加总 ${declared}≠§5.4 开放行 ${openRowIds.length}`);
    if (bad.length) problems.push('§6.2 归属桶表与开放项不符：' + bad.join('；'));
    // 分母刻意取 §5.4 开放行而不是 findings.open：两者是**口径差异**（有的条目只在 §5.3/§七 留痕），
    // §6.2 表头自己写的就是"§5.4 共 N 行 = 闭／开"，V206 第一版拿 findings.open 当分母立刻假红三项。
    else notes.push(`§6.2 归属桶核对：五桶加总 ${declared}＝§5.4 开放行，数量列↔条目列↔开放行集合三向对上（findings.open 数组 ${nOpen} 项，口径差异不折算）`);
  }
}

/* 12. B 段约束层事实文件（V116）：V116 实测「连得上但库里什么都没有」时探针仍 rc=0，
   于是 B 段可以把一份 0 条事实的文件当成采集成功写进台账。这里把速览的 B 行数和
   事实文件自己的覆盖行钉在一起，防止"看着像现值"的过期/空采集读数再次流入登记册。*/
{
  const FACTS = process.env.EWOH_AUDIT_FACTS || 'tmp/chain-baseline/schema-facts.txt';
  const mB = snap0.match(/B (\d+) 行约束事实/);
  if (!mB) problems.push('速览未写「B N 行约束事实」，无法核对');
  else if (!fs.existsSync(FACTS)) notes.push(`速览的 B=${mB[1]} 行未核对（${FACTS} 不存在，需先跑一次重放）`);
  else {
    const lines = fs.readFileSync(FACTS, 'utf8').split('\n');
    const n = fs.readFileSync(FACTS, 'utf8').replace(/\n$/, '').split('\n').length;
    const cov = (lines.find((l) => /链相关表 \d+\/\d+/.test(l)) || '').match(/链相关表 (\d+)\/(\d+)/);
    if (!cov) problems.push(`B 段事实文件没有「链相关表 N/M」覆盖行 ⇒ 无法证明采到的是链库（${FACTS}）`);
    else if (Number(cov[1]) !== Number(cov[2])) problems.push(`B 段事实文件覆盖不全：链相关表 ${cov[1]}/${cov[2]}（V116 判据：缺表即非链库，探针本应 rc=1）`);
    if (Number(mB[1]) !== n) problems.push(`速览写 B ${mB[1]} 行，${FACTS} 实测 ${n} 行`);
    else notes.push(`B 段事实核对：${FACTS} ${n} 行、链相关表 ${cov ? `${cov[1]}/${cov[2]}` : '?'}`);
  }
}


console.log('—— V97 一致性自检 ——');

notes.forEach((n) => console.log('  ·', n));
if (!problems.length) console.log('✅ 无漂移');
else { console.log(`⚠️ ${problems.length} 项不一致：`); problems.forEach((p) => console.log('  ✗', p)); }
/* V116 实测到的自检自身缺陷（GATE-08）：本文件从来没有 process.exit ⇒ 有漂移时也 exit 0，
   任何用 `$?` 判断的调用方（make 目标 / CI 步骤）看到的都是绿。判据只在人盯着屏幕时才生效，
   等于没有判据。补上退出码，并让 selftest 断言"注入必须让 rc≠0、对照必须 rc=0"。 */
process.exit(problems.length ? 1 : 0);
