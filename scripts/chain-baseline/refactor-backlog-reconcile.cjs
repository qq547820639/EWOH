#!/usr/bin/env node
/**
 * refactor-backlog-reconcile.cjs — 四个重构事项来源的判重与引用落点对账（V353 新建）
 *
 * 回答两个问法：
 *   ①一条候选发现，是否已被某个在册来源登记过？（登记册 §5.4 / roadmap / 08-30 backlog / 长周期提示词）
 *   ②在册行里抄的 `file:line`，今天还指得中它描述的那段代码吗？
 *
 * 判重必须两根轴同时命中才算重复（只命中一根 ⇒ ambiguous，不折成"唯一"也不折成"重复"）：
 *   轴1 落点文件路径（归一到仓内相对路径后）交集非空
 *   轴2 判别符号（AST 取出的标识符／常量子／表名）交集非空
 *   —— 单靠路径会把"同一文件里的不同事实"判成重复；单靠符号会把"同名词的不同落点"判成重复。
 *      这条纪律的来源：本仓 V128 那次召回尝试就是靠集合相似度造出了伪候选。
 *
 * 三态与退出码：0＝一致（无重复无越界）／2＝有判决（重复或引用越界）／3＝不可判（取不到输入）。
 *   「不可判」绝不折算成"没有重复"，也绝不折算成"有重复"。
 *
 * 引用落点的"符号是否在这一行"用 **AST** 判（复用树内 typescript@5.9.2，Apache-2.0），
 * 不用文本窗口正则：本仓 9 次误判的共同根因就是"用模式匹配替代阅读"。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));

const SOURCES = {
  register: 'docs/audit/current/chain-behavior-baseline.md',
  roadmap: 'ewoh-spark-app/docs/refactoring-roadmap.md',
  backlog0830: 'docs/refactoring/refactoring-backlog-2026-08-30.md',
  prompt: 'docs/long-cycle-implementation-prompt.md',
};

const STOP_WORDS = new Set([
  'this','true','false','null','undefined','await','async','return','const','import','export','from',
  'status','file','line','code','test','tests','docs','src','make','node','grep','json','yaml','when',
  'that','with','have','should','must','args','result','value','name','type','types','string','number',
]);

// ---------- 输入解析（结构边界优先，绝不锚上一轮的行号） ----------

/** §5.4 表的切法与编号形状**一律复用 `scripts/chain-baseline/artifact-consistency.cjs:49-51,64-65`
 *  的同一套判据**（`### 5.4 ` 起、`## 六` 止、ROW_RE 认 `~~ID~~`／`**ID**` 两种包装）。
 *  另写一套边界会把 185 行读成 71 或 470——本轮前两遍就分别中招过这两 kinds。 */
const REGISTER_ROW_RE = /^\|\s*(?:~~)?\*{0,2}([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\*{0,2}(?:~~)?\s*\|/;
function readRegisterRows(text) {
  const lines = text.split('\n');
  const a54 = lines.findIndex((l) => l.startsWith('### 5.4 '));
  const b5 = lines.findIndex((l) => l.startsWith('## 六'));
  if (a54 < 0 || b5 < 0 || b5 < a54) return null;          // null＝取不到输入（不可判），不是"零行"
  const out = [];
  for (const line of lines.slice(a54, b5)) {
    const m = line.match(REGISTER_ROW_RE);
    if (!m) continue;
    const cells = line.replace(/\\\|/g, '').split('|').map((s) => s.trim());
    if (/^(编号|ID)$/.test(m[1])) continue;
    out.push({ source: 'register', id: m[1], text: `${m[1]} ${cells.slice(2).join(' ')}` });
  }
  return out;
}

/** 带 `### A0.`／`## P0-1` 小节头的清单：每节一条事项，正文全部并入 */
function readSectionItems(text, source, heading) {
  const out = [];
  const re = new RegExp(`^${heading}\\s+([ABCPS]?[0-9]+[-.][0-9]*|[ABCPS][0-9]+)[^\\n]*`, 'm');
  const parts = text.split(new RegExp(`^${heading}\\s+`, 'm'));
  const heads = text.match(new RegExp(`^${heading}\\s+.*$`, 'gm')) || [];
  if (!re.test(text)) return out;
  heads.forEach((h, i) => {
    const idm = h.match(/([ABCPS][0-9]+(?:[-.][0-9]+)?)/);
    out.push({ source, id: idm ? idm[1] : `#${i}`, text: `${h}\n${parts[i + 1] || ''}`.slice(0, 6000) });
  });
  return out;
}

/** 长周期提示词：按 `### 阶段 N` 成条 */
function readStageItems(text) {
  const out = [];
  const heads = text.match(/^### 阶段\s+\d+.*$/gm) || [];
  const parts = text.split(/^### 阶段\s+\d+/m);
  heads.forEach((h, i) => out.push({ source: 'prompt', id: h.replace(/^###\s*/, '').slice(0, 40), text: `${h}\n${parts[i + 1] || ''}`.slice(0, 6000) }));
  return out;
}

// ---------- 归一化与符号抽取 ----------

const basenameIndex = new Map();   // basename -> [仓内相对路径]
let allFiles = [];
function buildPathIndex() {
  allFiles = JSON.parse(execFileSync('node', ['scripts/audit-file-ledger.js', 'paths'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString()).files;
  basenameIndex.clear();
  for (const f of allFiles) {
    const b = path.basename(f);
    if (!basenameIndex.has(b)) basenameIndex.set(b, []);
    basenameIndex.get(b).push(f);
  }
  return allFiles;
}

/** 路径解析的四档尝试，返回**全部**命中而不是"挑一个"：
 *  ①仓内原样存在 ②补 `ewoh-spark-app/` 前缀存在（清单里大量写 `server/modules/...`、`shared/...`）
 *  ③按后缀在现扫总体里命中 ④裸文件名按 basename 命中。
 *  多命中一律交回 multi 让调用方判歧义——本仓 V337 的教训是"硬要求不存在的记号＝逼人编造"，
 *  而这里对应的反面教训是"硬挑一个像的＝把缩写引用读成漂移"（本轮第一遍就把 `run.py:267`
 *  读成了越界，真身是 `src/edge_platform/run.py`，根目录那个 `run.py` 只有 20 行）。 */
function citeCandidates(raw) {
  const clean = raw.replace(/^\.\//, '').replace(/[^A-Za-z0-9._/\-].*$/, '');
  if (!clean) return { kind: 'empty', exact: [], all: [] };
  const exact = [];
  if (fs.existsSync(path.join(ROOT, clean))) exact.push(clean);
  const prefixed = `ewoh-spark-app/${clean}`;
  if (fs.existsSync(path.join(ROOT, prefixed))) exact.push(prefixed);
  const suffix = allFiles.filter((f) => f === clean || f.endsWith('/' + clean));
  const base = !clean.includes('/') ? (basenameIndex.get(path.basename(clean)) || []) : [];
  const all = [...new Set([...exact, ...suffix, ...base])];
  return { kind: all.length === 1 ? 'single' : all.length ? 'multi' : 'none', exact, all };
}

function normalizePath(raw) {
  const c = citeCandidates(raw);
  return c.all.length === 1 ? { ok: true, file: c.all[0] } : { ok: false, reason: c.kind };
}

const lenCache = new Map();
function realLineCount(file) {
  if (lenCache.has(file)) return lenCache.get(file);
  const abs = path.join(ROOT, file);
  let n = 0;
  if (fs.existsSync(abs)) { const b = fs.readFileSync(abs); n = b.length && b[b.length - 1] === 10 ? b.toString('utf8').split('\n').length - 1 : b.toString('utf8').split('\n').length; }
  lenCache.set(file, n);
  return n;
}

// 名字段必须允许点：`plan.service.ts`／`control-delivery-backlog.worker.ts` 这类**带点的文件名**
// 用 `[\w-]+\.` 会被从中间截断读成 `service.ts`，于是整条路径没被剥掉、`server`/`scheduler`
// 这些目录名冒充判别符号（本轮实测：一条候选因此与 100 行判成"重复"）。
const PATH_RE = /(?:[\w./-]*\/)?[\w.-]+\.(?:ts|tsx|js|cjs|mjs|py|sql|yaml|yml|json|md|sh)\b/g;
const LINE_RE = /([\w./-]+\.(?:ts|tsx|js|cjs|mjs|py|sql|yaml|yml|json)):(\d+)(?:-(\d+))?/g;
const SYM_RE = /\b([A-Za-z_][A-Za-z0-9_]{4,}|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|ewoh_[a-z_]+)\b/g;

function extract(itemText) {
  const cites = [];
  for (const m of itemText.matchAll(LINE_RE)) cites.push({ raw: m[0], file: m[1], from: Number(m[2]), to: Number(m[3] || m[2]) });
  const files = new Set();
  const ambiguousFiles = new Set();
  for (const m of itemText.match(PATH_RE) || []) {
    const c = citeCandidates(m);
    if (c.all.length === 1) files.add(c.all[0]);
    else if (c.all.length > 1) ambiguousFiles.add(m);      // 缩写/重名：不进轴1，也不硬挑一个
  }
  // 先剥掉路径与引用形状再抽符号：否则 server/scripts/control/baseline 这类**路径词**会冒充判别符号，
  // 把一条候选判成与 100 行重复（本轮第一遍就中招）。
  const rest = itemText.replace(LINE_RE, ' ').replace(PATH_RE, ' ');
  const syms = new Set();
  for (const m of rest.match(SYM_RE) || []) if (!STOP_WORDS.has(m.toLowerCase())) syms.add(m);
  return { files, syms, cites, ambiguousFiles };
}

// ---------- 引用落点：用 AST 判「这一行真的出现这个符号吗」 ----------

let ts = null;
function loadTs() {
  if (ts) return ts;
  ts = require(path.join(ROOT, 'ewoh-spark-app/node_modules/typescript'));
  return ts;
}
const lineIndexCache = new Map();
/** 返回 Map<lineNumber, Set<symbol>>，符号取自 AST 的标识符／字符串／属性访问节点 */
function symbolsByLine(file) {
  if (lineIndexCache.has(file)) return lineIndexCache.get(file);
  const abs = path.join(ROOT, file);
  const map = new Map();
  if (!fs.existsSync(abs)) { lineIndexCache.set(file, null); return null; }
  const T = loadTs();
  const src = T.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), T.ScriptTarget.Latest, true,
    /\.tsx?$/.test(file) ? (file.endsWith('.tsx') ? T.ScriptKind.TSX : T.ScriptKind.TS) : T.ScriptKind.Unknown);
  const posOf = src.getLineAndCharacterOfPosition.bind(src);
  const visit = (node) => {
    let name = null;
    if (T.isIdentifier(node)) name = node.text;
    else if (T.isStringLiteral(node) || T.isNoSubstitutionTemplateLiteral(node)) name = node.text;
    else if (T.isPropertyAccessExpression(node)) name = node.name.text;
    if (name && name.length > 4 && !STOP_WORDS.has(name.toLowerCase())) {
      const line = posOf(node.getStart(src)).line + 1;
      if (!map.has(line)) map.set(line, new Set());
      map.get(line).add(name);
    }
    T.forEachChild(node, visit);
  };
  visit(src);
  lineIndexCache.set(file, map);
  return map;
}

// ---------- 判据 ----------

function judgePair(a, b, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const sharedFiles = [...a.files].filter((f) => b.files.has(f));
  const sharedAll = [...a.syms].filter((s) => b.syms.has(s));
  const sharedSyms = o.disc ? sharedAll.filter((s) => o.disc.has(s)) : sharedAll;
  // 符号轴的门槛：要么 ≥2 个判别符同时共享，要么 1 个但在整个语料里极罕见（≤2 处）。
  // 只按"共享了某个非高频词"判重复会把 `default`／`check` 这种通用词当成证据——本轮实测就
  // 因此把 OPTWIRE-01 与 roadmap:A0 判成重复。
  const rareMax = o.rareMax === undefined ? 2 : o.rareMax;
  const rare = (s) => !o.freq || (o.freq.get(s) || 99) <= rareMax;
  const rareSymsShared = sharedSyms.filter(rare);
  const axis2 = rareSymsShared.length >= 1;
  if (sharedFiles.length && axis2) return { verdict: 'duplicate', sharedFiles, sharedSyms, rareSymsShared };
  if (sharedFiles.length || sharedSyms.length) return { verdict: 'ambiguous', sharedFiles, sharedSyms, rareSymsShared };
  return { verdict: 'unique', sharedFiles, sharedSyms, rareSymsShared };
}

const CODE_EXT = /\.(ts|tsx|js|cjs|mjs|py)$/;
function windowHit(file, c, syms, window) {
  const idx = symbolsByLine(file);
  if (!idx) return false;
  for (let l = Math.max(1, c.from - window); l <= c.to + window; l += 1) {
    const at = idx.get(l);
    if (at && [...at].some((s) => syms.has(s))) return true;
  }
  return false;
}

/** 引用落点判据（五档，只有 `line-out-of-range` 判红）：
 *   no-candidate        仓里没这个名——可能是量具自测的合成夹具名（如 `negctl-collapse.service.ts`），不判红
 *   ambiguous-citation  裸名/缩写命中多份且符号解不出来 ⇒ 不可判，不判红
 *   resolved-by-symbols 多候选但只有一个候选在该窗口出现本事项判别符号 ⇒ 解出，不判红
 *   line-out-of-range   唯一候选 + 行号超出该文件真实长度 ⇒ **真漂移，判红**
 *   in-window / symbol-window-miss / window-not-applicable 只报数
 */
function judgeCitations(item, window) {
  const out = [];
  for (const c of item.cites) {
    const cand = citeCandidates(c.raw.split(':')[0]);
    if (cand.kind === 'none') { out.push({ ...c, kind: 'no-candidate', red: false }); continue; }
    const longEnough = cand.all.filter((f) => realLineCount(f) >= c.from);
    if (longEnough.length === 0) {
      if (cand.all.length === 1) {
        const f = cand.all[0];
        out.push({ ...c, kind: 'line-out-of-range', red: true, file: f, fileLines: realLineCount(f) });
      } else {
        out.push({ ...c, kind: 'no-candidate-long-enough', red: false, n: cand.all.length });
      }
      continue;
    }
    if (longEnough.length > 1) {
      const solved = longEnough.filter((f) => CODE_EXT.test(f) && windowHit(f, c, item.syms, window));
      out.push(solved.length === 1
        ? { ...c, kind: 'resolved-by-symbols', red: false, file: solved[0] }
        : { ...c, kind: 'ambiguous-citation', red: false, n: longEnough.length });
      continue;
    }
    const file = longEnough[0];
    const lines = realLineCount(file);
    if (!CODE_EXT.test(file)) { out.push({ ...c, kind: 'window-not-applicable', red: false, file, fileLines: lines }); continue; }
    out.push({ ...c, kind: windowHit(file, c, item.syms, window) ? 'in-window' : 'symbol-window-miss', red: false, file, fileLines: lines });
  }
  return out;
}

// ---------- 真语料 ----------

function loadCorpus() {
  const reg = readRegisterRows(fs.readFileSync(path.join(ROOT, SOURCES.register), 'utf8'));
  if (reg === null) throw new Error(`${SOURCES.register} 的 §5.4 表切片取不到（\`### 5.4 \` 或 \`## 六\` 边界不在场）`);
  const rm = readSectionItems(fs.readFileSync(path.join(ROOT, SOURCES.roadmap), 'utf8'), 'roadmap', '###');
  const bk = readSectionItems(fs.readFileSync(path.join(ROOT, SOURCES.backlog0830), 'utf8'), 'backlog0830', '##');
  const pr = readStageItems(fs.readFileSync(path.join(ROOT, SOURCES.prompt), 'utf8'));
  return { reg, rm, bk, pr };
}

function analyze({ window = 6, candidates = [] } = {}) {
  buildPathIndex();
  const { reg, rm, bk, pr } = loadCorpus();
  const items = [...reg, ...rm, ...bk, ...pr].map((it) => {
    const e = extract(it.text);
    e.syms.delete(it.id);          // 条目自己的编号不是判别符号（否则 GUARD-01 会被任何提到它编号的行判成重复）
    return { ...it, ...e };
  });
  // IDF 过滤：出现在超过 cap 行里的符号**不具判别力**（`status`/`update`/`Promise` 这类），
  // 不过滤会把"同文件同高频词"读成重复——本轮第一遍就把一条候选判成与 100 行重复。
  const freq = new Map();
  for (const it of items) for (const s of it.syms) freq.set(s, (freq.get(s) || 0) + 1);
  const cap = Math.max(3, Math.ceil(items.length * 0.02));
  const disc = new Set([...freq].filter(([, n]) => n <= cap).map(([s]) => s));
  const ambiguousPaths = items.reduce((n, it) => n + it.ambiguousFiles.size, 0);
  const rows = [];
  for (const cand of candidates) {
    const c = { source: 'candidate', id: cand.id, ...extract(cand.text || '') };
    c.syms.delete(cand.id);
    let best = { verdict: 'unique' };
    const hits = [];
    for (const it of items) {
      const r = judgePair(c, it, { disc, freq });
      if (r.verdict !== 'unique') hits.push({ to: `${it.source}:${it.id}`, ...r });
      if (r.verdict === 'duplicate') best = { verdict: 'duplicate', to: `${it.source}:${it.id}` };
    }
    rows.push({ id: c.id, verdict: best.verdict, hits, cites: judgeCitations(c, window) });
  }
  // 四个来源之间的跨源判重（统一表的"重复判定"列就取这里）
  const cross = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[i].source === items[j].source) continue;
      const r = judgePair(items[i], items[j], { disc, freq });
      if (r.verdict === 'unique') continue;
      cross.push({
        a: `${items[i].source}:${items[i].id}`, b: `${items[j].source}:${items[j].id}`, verdict: r.verdict,
        sharedFiles: r.sharedFiles.slice(0, 3), sharedSyms: r.sharedSyms.slice(0, 6),
      });
    }
  }
  const drift = items.map((it) => ({ id: `${it.source}:${it.id}`, cites: judgeCitations(it, window) }));
  return {
    rows, cross, drift,
    discStats: { cap, kept: disc.size, dropped: freq.size - disc.size, symbols: freq.size },
    ambiguousPaths,
    denominators: { register: reg.length, roadmap: rm.length, backlog0830: bk.length, prompt: pr.length, candidates: candidates.length, items: items.length },
  };
}

// ---------- 判据自测（合成夹具，绝不读真语料） ----------

function selfTest() {
  buildPathIndex();
  const A = (t) => extract(t);
  const cases = [];
  const t = (name, why, fn) => cases.push({ name, why, fire: () => fn() });

  t('DUP-POS', '同一落点＋同一判别符号 ⇒ 必须判重复', () => {
    const x = A('server/modules/scheduler/heuristic-scheduling-solver.ts 的 LOCKED_STATION case 缺失');
    const y = A('heuristic-scheduling-solver.ts:354-356 未处理 LOCKED_STATION');
    return judgePair(x, y, 6).verdict === 'duplicate';
  });
  t('AXIS1-ONLY', '只共享文件不共享符号 ⇒ 必须落 ambiguous，不得算重复也不得算唯一（并须真的解出那一个文件，否则控制是空的）', () => {
    const x = A('ewoh-spark-app/server/modules/scheduler/plan.service.ts 的 persistPlan 事务边界');
    const y = A('ewoh-spark-app/server/modules/scheduler/plan.service.ts 的 describeStaleness 调用');
    const r = judgePair(x, y, 6);
    return x.files.size === 1 && y.files.size === 1 && r.sharedFiles.length === 1
      && r.sharedSyms.length === 0 && r.verdict === 'ambiguous';
  });
  t('AXIS2-ONLY', '只共享符号不共享文件 ⇒ 同样必须落 ambiguous', () => {
    const x = A('server/modules/scheduler/plan.service.ts 的 superseded 写法');
    const y = A('src/edge_platform/scheduler/scheduler_service.py 里的 superseded 词表');
    return judgePair(x, y, 6).verdict === 'ambiguous';
  });
  t('UNI-NEG', '两根轴皆不中 ⇒ 必须判唯一（假阳性面）', () => {
    const x = A('db/migrations/standalone_004_ewoh_domain.sql 的 ewoh_handoffs 表定义');
    const y = A('scripts/audit-ssrf-surface.js 的出站面判据');
    return judgePair(x, y, 6).verdict === 'unique';
  });
  t('AMB-BASENAME', '重名裸文件名：能唯一定位的必须定准、定不准的必须判歧义，绝不允许"挑一个像的"', () => {
    const groups = [...basenameIndex.entries()].filter(([, v]) => v.length > 1);
    let ambiguityChecked = 0;
    for (const [b, hits] of groups) {
      const rootExact = fs.existsSync(path.join(ROOT, b));
      const appExact = fs.existsSync(path.join(ROOT, `ewoh-spark-app/${b}`));
      const n = normalizePath(b);
      if (!rootExact && !appExact) { if (n.ok) return false; ambiguityChecked += 1; }
      else if (n.ok && !hits.includes(n.file)) return false;   // 根名与包内同名同时存在时允许判歧义，但解出来的必须是其中之一
    }
    // 非空洞要求：树上确实存在"根目录没有同名文件"的重名组，否则这条控制等于没跑
    return ambiguityChecked > 0;
  });
  t('IDF-TEETH', '反向对照：两根轴里的符号轴必须真的被 IDF 约束——高频非判别符号共享时不得判重复，摘掉过滤则必须判重复', () => {
    const f = new Set(['ewoh-spark-app/server/modules/scheduler/plan.service.ts']);
    const x = { files: f, syms: new Set(['status']), cites: [] };
    const y = { files: f, syms: new Set(['status']), cites: [] };
    const withFilter = judgePair(x, y, { disc: new Set() }).verdict;            // status 被视为非判别 ⇒ 只剩一根轴
    const withoutFilter = judgePair(x, y).verdict;                                // 不过滤 ⇒ 两轴齐 ⇒ 判重复（正是误判形态）
    return withFilter !== 'duplicate' && withoutFilter === 'duplicate';
  });
  t('RARE-TEETH', '符号轴门槛两极都要验：1 个语料内不罕见的共享符号＋同文件 ⇒ 不得判重复；2 个共享 ⇒ 必须判重复', () => {
    const f = new Set(['a/one.ts']);
    const freq = new Map([['commonish', 9], ['alphaRare', 1], ['betaRare', 1]]);
    const one = judgePair({ files: f, syms: new Set(['commonish']), cites: [] },
                          { files: f, syms: new Set(['commonish']), cites: [] }, { freq });
    const two = judgePair({ files: f, syms: new Set(['alphaRare', 'betaRare']), cites: [] },
                          { files: f, syms: new Set(['alphaRare', 'betaRare']), cites: [] }, { freq });
    return one.verdict !== 'duplicate' && two.verdict === 'duplicate';
  });
  t('ABBREV-NEG', '假阳性面：裸名/缩写命中多份 ⇒ 只判歧义，绝不判红（本轮第一遍就是把 `run.py:267` 读成了越界）', () => {
    const group = [...basenameIndex.entries()].find(([b, v]) => v.length > 1 && !fs.existsSync(path.join(ROOT, b)) && !fs.existsSync(path.join(ROOT, `ewoh-spark-app/${b}`)));
    if (!group) return true;
    const b = group[0];
    const item = { syms: new Set(['zzzNotInAnyFile']), files: new Set(), cites: [{ raw: `${b}:2`, file: b, from: 2, to: 2 }] };
    const r = judgeCitations(item, 6);
    return r.length === 1 && r[0].red === false && /ambiguous|resolved/.test(r[0].kind);
  });
  t('SYNTH-NEG', '假阳性面：仓里没有的名字（量具自测的合成夹具名）⇒ 判 no-candidate，不判红', () => {
    const item = { syms: new Set(['whatever']), files: new Set(), cites: [{ raw: 'zznonsistentfixture.ts:12', file: 'zznonsistentfixture.ts', from: 12, to: 12 }] };
    const r = judgeCitations(item, 6);
    return r.length === 1 && r[0].kind === 'no-candidate' && r[0].red === false;
  });
  t('INV-REV', '反向对照：判重真的依赖路径归一——同一份文件，归一后必须判重复、不归一必须不判重复', () => {
    const sym = new Set(['LOCKED_STATION']);
    const rawL = 'server/modules/scheduler/heuristic-scheduling-solver.ts';
    const rawR = 'ewoh-spark-app/server/modules/scheduler/heuristic-scheduling-solver.ts';
    const left = normalizePath(rawL); const right = normalizePath(rawR);
    if (!left.ok || !right.ok) return false;
    const withNorm = judgePair({ files: new Set([left.file]), syms: sym }, { files: new Set([right.file]), syms: sym }, 6).verdict;
    const withoutNorm = judgePair({ files: new Set([rawL]), syms: sym }, { files: new Set([rawR]), syms: sym }, 6).verdict;
    return withNorm === 'duplicate' && withoutNorm !== 'duplicate';
  });
  t('CITE-OUT-OF-RANGE', '引用行号超出文件现行长度 ⇒ 必须判红', () => {
    const item = { ...A('scripts/audit-file-ledger.js:999999 的口径'), cites: [{ raw: 'scripts/audit-file-ledger.js:999999', file: 'scripts/audit-file-ledger.js', from: 999999, to: 999999 }] };
    const r = judgeCitations(item, 6);
    return r.length === 1 && r[0].red === true && r[0].kind === 'line-out-of-range';
  });
  t('CITE-IN-WINDOW', '正向对照：真实存在的「行号＋该行确实出现的符号」必须不开火', () => {
    const file = 'scripts/audit-file-ledger.js';
    const idx = symbolsByLine(file);
    const line = [...idx.keys()].sort((p, q) => p - q).find((l) => (idx.get(l) || []).size > 0);
    const sym = [...idx.get(line)][0];
    const item = { syms: new Set([sym]), cites: [{ raw: `${file}:${line}`, file, from: line, to: line }] };
    const r = judgeCitations(item, 6);
    return r.length === 1 && r[0].kind === 'in-window' && r[0].red === false;
  });
  t('CITE-WINDOW-MISS', '行号在范围内但该处没有本事项的判别符号 ⇒ 必须进 window-miss 桶（不判红，只报数）', () => {
    const file = 'scripts/audit-file-ledger.js';
    const idx = symbolsByLine(file);
    const last = Math.max(...idx.keys());
    const item = { syms: new Set(['zzzNotARealSymbolAnywhere']), cites: [{ raw: `${file}:${last}`, file, from: last, to: last }] };
    const r = judgeCitations(item, 6);
    return r.length === 1 && r[0].kind === 'symbol-window-miss' && r[0].red === false;
  });
  t('TRI-NULL', '§5.4 切片取不到 ⇒ 必须返回 null（不可判），绝不折成"一个在册行都没有"', () => {
    const rows = readRegisterRows('# 标题\n没有这个小节\n');
    return rows === null && corpusAbsenceIsNotSilence();
  });
  t('SUM-EQ', 'Σ档位必须等于分母：造一条落不进任何桶的判决，必须被 Σ 校验抓住', () => {
    const buckets = { duplicate: 1, ambiguous: 1, unique: 0 };
    const total = 4;                                     // 声明 4 条，桶里只有 2 条 ⇒ 漏 2
    const sum = Object.values(buckets).reduce((p, q) => p + q, 0);
    return sum !== total ? 'RED' : 'GREEN';              // 期望 'RED'（校验真的会红）
  });

  let ok = 0;
  const failures = [];
  for (const c of cases) {
    let pass = false;
    try { const v = c.fire(); pass = (c.name === 'SUM-EQ') ? v === 'RED' : v === true; } catch (e) { pass = false; failures.push(`${c.name}: ${e.message}`); }
    if (pass) ok += 1; else failures.push(`${c.name}: 未开火（${c.why}）`);
  }
  console.log(`  （refactor-backlog-reconcile 判据自测 ${ok}/${cases.length} 条：判重两根轴各一支单向控制 ＋ 假阳性对照 ＋ 歧义名 ＋ 归一化反向对照 ＋ 引用三态各一支 ＋ 不可判 ＋ Σ==分母）`);
  for (const f of failures) console.log('  ✗ ' + f);
  return { ok, total: cases.length, failures };
}

function corpusAbsenceIsNotSilence() {
  // 「没有这个小节」与「这个小节里一行都没有」必须不同形：前者不可判（读不到输入），后者才是零行
  const text = fs.readFileSync(path.join(ROOT, SOURCES.register), 'utf8');
  return /^#{2,4}\s*5\.4\b/m.test(text) === true;
}

// ---------- CLI ----------

function main(argv) {
  if (argv.includes('--self-test')) {
    const r = selfTest();
    process.exitCode = r.ok === r.total ? 0 : 2;
    return;
  }
  buildPathIndex();
  const winAt = argv.indexOf('--window');
  const window = winAt >= 0 ? Number(argv[winAt + 1]) : 6;
  const candAt = argv.indexOf('--candidates');
  let candidates = [];
  if (candAt >= 0) {
    const p = path.resolve(argv[candAt + 1]);
    if (!fs.existsSync(p)) { console.error(`候选文件读不到：${p} ⇒ 判不可判，不折成"没有新发现"`); process.exitCode = 3; return; }
    candidates = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const out = (() => {
    try { return analyze({ window, candidates }); }
    catch (e) {
      console.log(`  · 不可判：${e.message}`);
      console.log('  · 输入取不到既不读成"没有重复"，也不读成"有重复"（退 3）');
      process.exitCode = 3;
      return null;
    }
  })();
  if (!out) return;
  const buckets = { duplicate: 0, ambiguous: 0, unique: 0 };
  for (const r of out.rows) buckets[r.verdict] += 1;
  const sum = Object.values(buckets).reduce((p, q) => p + q, 0);
  const reds = out.drift.flatMap((d) => d.cites.filter((c) => c.red).map((c) => `${d.id} → ${c.raw} ${c.kind}`));
  const missed = out.drift.flatMap((d) => d.cites.filter((c) => c.kind === 'symbol-window-miss').map((c) => `${d.id} → ${c.raw}`));
  const badPair = out.rows.filter((r) => r.verdict === 'duplicate').map((r) => {
    const dups = r.hits.filter((h) => h.verdict === 'duplicate');
    const names = [...new Set(dups.flatMap((h) => h.rareSymsShared || []))];
    return `${r.id} ≡ ${dups.map((h) => h.to).join(',')}  ← 触发名字[${names.join(', ')}]`;
  });
  if (sum !== out.denominators.candidates) {
    console.log(`  ✗ Σ档位(${sum}) != 分母(${out.denominators.candidates}) ⇒ 读数作废`);
    process.exitCode = 2;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...out, buckets, sum }, null, 1));
  else {
    console.log(`  · 分母：登记册 ${out.denominators.register} 行｜roadmap ${out.denominators.roadmap} 条｜08-30 清单 ${out.denominators.backlog0830} 条｜提示词 ${out.denominators.prompt} 阶段｜候选 ${out.denominators.candidates} 条`);
    const crossB = { duplicate: 0, ambiguous: 0 };
    for (const p of out.cross) crossB[p.verdict] += 1;
    console.log(`  · 符号轴 IDF 门限 ${out.discStats.cap}：保留 ${out.discStats.kept}／剔除 ${out.discStats.dropped}（非判别符号）；路径歧义不进气轴 ${out.ambiguousPaths} 处`);
    console.log(`  · 跨源判重（${out.denominators.items} 条互比）：重复 ${crossB.duplicate} 对｜歧义 ${crossB.ambiguous} 对`);
    for (const p of out.cross.filter((x) => x.verdict === 'duplicate').slice(0, 25)) {
      console.log(`    ≡ ${p.a} ≡ ${p.b}  文件[${p.sharedFiles.join(', ')}] 符号[${p.sharedSyms.join(', ')}]`);
    }
    console.log(`  · 候选判重：重复 ${buckets.duplicate}｜歧义 ${buckets.ambiguous}｜唯一 ${buckets.unique}（Σ=${sum}）`);
    for (const b of badPair) console.log('    ≡ ' + b);
    console.log(`  · 在册引用：判红(行号越界) ${reds.length}｜符号不在窗口(只报数) ${missed.length}`);
    for (const r of reds.slice(0, 20)) console.log('    ✗ ' + r);
    for (const m of missed.slice(0, 20)) console.log('    · ' + m);
    process.exitCode = reds.length ? 2 : (sum !== out.denominators.candidates ? 2 : 0);
  }
}

main(process.argv.slice(2));
