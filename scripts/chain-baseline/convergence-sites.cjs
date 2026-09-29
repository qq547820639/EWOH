#!/usr/bin/env node
/*
 * V170 量具：**收敛断言**在哪些常驻用例里（按断言语义找，不按编号/登记位点找）。
 *
 * 为什么要有这把尺（已证实的假阴性）：V166/V168 曾写"RUN-01 没人断言 run 收敛"，
 * V169 读到 `pg-temporary-failure` 才发现收敛断言一直在，只是**没挂在那一项登记的位点名下**。
 * 也就是说"已闭项 ↔ 活位点"那根轴（V114/V143，门禁主线 23）看不见"断言落在哪个文件"，
 * 会把已有覆盖**低估**。本尺把"收敛断言"从登记里独立出来，直接扫常驻用例。
 *
 * 一问（只此一问）：一份常驻用例到底**断没断**"权威事实落到终态"；若断了，
 * 它是**等到终态才断**（能区分"仍在飞行"与"永不收敛"），还是**单次快照就断**（分不清）。
 *
 * 判定单位是**用例块**（`it(`/`test(` 之间），不是文件、也不是行。三条已实测的教训：
 *  1) 行级判定读不到"循环在上一行、终态检查在这一行"的真实轮询（旧读数"1 个文件轮询"是下界）；
 *  2) 文件级判定会让 A 块的轮询污染 B 块（自测 N4 钉这条）；
 *  3) 「有循环」≠「在等终态」——本轮在真语料上抓到三种假阳性，逐条写成对照：
 *     · 迭代循环：`for (const action of ['release','start','complete'])` 走 happy path（`mes/task/scenario-packages`）⇒ 自测 P5；
 *     · 等前提的循环：`waitLockedUpdate` 里 `for(;;)` 等的是"行锁已阻塞"，终态断言在循环外（`agent-task-cas-window:214-238`）⇒ 自测 P6；
 *     · SQL 反向谓词：`t.status NOT IN ('dispatched','received','executing')` 断的是**不许矛盾**，不是"落到终态"（`dispatch-receipt-concurrency:227-229`）⇒ 自测 N6。
 *     ⇒ pollBound 的判据收紧为：**大括号配对取出的循环体内**同时出现「真等待原语」与「终态检查」。
 *
 * 三档（互斥，加总=断到终态的块数，由脚本硬断言）：
 *  - `pollBound`：某个循环体（或 `expect.poll` 回调）内既有等待原语又有终态检查 ⇒ 真"等到终态"；
 *  - `waitOnly` ：块内有真等待原语但没绑到终态检查 ⇒ 只是时间垫，逻辑上仍单次读；
 *  - `single`   ：块内无任何等待原语。
 *
 * 等待原语只收**真等待调用**（delay/sleep/setTimeout/new Promise+setTimeout/waitFor/page.wait/expect.poll）。
 * `deadline`/`retry`/`attempt` 一律不收：本仓这三个词大量是**业务字段名**（任务截止期、命令重试次数、CAS 尝试序号），
 * 收进来就是同名近邻假阳性（旧版收了，本轮删掉）。
 *
 * 终态词表只收**真终态**（succeeded/failed/dispatched/expired/completed/cancelled/superseded/published）。
 * `received`/`executing` 是"在路上"，不算收敛；宽表读数单独打印做双向差集，不混进分子。
 * **全终态**数组名（`const X=['succeeded','failed']`）视作终态词表，引用它即算终态检查；
 * 别名解析范围＝**整个文件**（V203：把词表提到文件作用域是正当重构，V170 的块内范围会让这类块
 * 整批从分子里消失——实测 88→87 就是一处假阴性），混合数组仍不算（N5），跨文件 import 的名字**仍看不见**
 * （N8 钉住：本尺不追模块图，这条是下界而不是已解决）。控制流范围不随别名扩大：循环体与等待原语
 * 仍按**块内**求，别名可见不等于别处的循环能替本块证明"等到终态"（N9）。
 *
 * 三件对照（--self-test，任一不过退出码非零）：P1/P3 真轮询必开火且判 pollBound；P2 单次；P4 时间垫判 waitOnly；
 * P5 迭代循环、P6 等前提的循环 ⇒ 不得冒充 pollBound；N1-N3 非断言/非终态/纯功效不开火；N4 块间不污染；
 * N5 混合清单不开火；N6 SQL 反向谓词（NOT IN 终态）不开火但必须被认出；P7 钉住一条**已知下界**：
 * SQL 层用 `NOT IN (非终态)` 做的消去法证明本尺看不见（不认，只如实报成边界）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'ewoh-spark-app');

/** 真终态（收敛）。`received`/`executing` 属在路上，宽表另计。 */
const TERMINAL = ['succeeded', 'failed', 'dispatched', 'expired', 'completed', 'cancelled', 'superseded', 'published'];
/** 宽表：V170 第一版把这两个也算终态；本轮打印差集，不计入分子。 */
const WIDE_EXTRA = ['received', 'executing'];
const STATUSISH = /(\bstatus\b|\bstate\b|\bafter\b|\bbefore\b|\bfreshStatus\b|\brows\[0\]|\br\b\s*=>|\brun\b|\bplan\b|\btask\b)/i;
/** 断言形状：expect / every / 场景脚本的 step·record（这两种驱动退出码，等价断言，见 V168）。SQL 谓词行不算断言。 */
const ASSERT_SHAPE = /(expect\s*\(|expect\.poll\s*\(|\.every\s*\(|\bstep\s*\(|\brecord\s*\()/;
const SQL_PREDICATE = /NOT IN\s*\(|\bAND\s*\(|\bOR\s*\(|\bWHERE\b/i;
/** 循环/轮询构造头（其**大括号体内**若同时有等待原语与终态检查 ⇒ pollBound）。 */
const LOOP_HEAD = /(for\s*\(|while\s*\(|expect\.poll\s*\(|\.poll\s*\(|retryUntil|waitForCondition)/g;
/** 真等待原语（业务同名词已剔除）。 */
const WAIT_PRIMITIVE = /(await\s+delay\s*\(|\bsleep\s*\(|new Promise\([^)]*setTimeout|setTimeout\s*\(|waitFor|\.wait[A-Z(]|page\.wait)/;

function specFiles() {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist'].includes(e.name)) walk(p); }
      else if (/(e2e\.spec\.ts|spec\.ts|\.mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(APP, 'test'));
  walk(path.join(APP, 'server'));
  walk(path.join(ROOT, 'scripts', 'chain-baseline'));
  return out;
}

/** 切成用例块；无 `it(`/`test(` 的脚本（场景 .mjs）整文件算一块。 */
function blocks(text) {
  const heads = [];
  const re = /^\s*(?:it|test)(?:\.\w+)?\s*\(/gm;
  let m;
  while ((m = re.exec(text)) !== null) heads.push(m.index);
  if (!heads.length) return [{ label: '(whole-file)', body: text }];
  const out = [];
  for (let i = 0; i < heads.length; i += 1) {
    const start = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1] : text.length;
    const nl = text.indexOf('\n', start);
    const firstLine = text.slice(start, nl === -1 ? text.length : nl);
    const label = (firstLine.match(/['"`]([^'"`]{2,90})['"`]/) || [, firstLine.trim().slice(0, 60)])[1];
    out.push({ label, body: text.slice(start, end) });
  }
  return out;
}

/** 从 head 之后第一个 `{` 起做括号配对，返回循环体文本（配不上则退化为 700 字符窗口）。 */
function loopBody(text, fromIndex) {
  const open = text.indexOf('{', fromIndex);
  if (open === -1 || open - fromIndex > 200) return text.slice(fromIndex, fromIndex + 700);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
  }
  return text.slice(open, open + 700);
}

/** 块内声明的**全终态**数组名（`const X = ['succeeded','failed']`）⇒ 视作终态词。 */
function terminalArrayNames(body, vocab) {
  const names = new Set();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const items = [...m[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (items.length && items.every((s) => vocab.includes(s))) names.add(m[1]);
  }
  return names;
}

function stripComments(body) {
  return body.split('\n').filter((l) => !/^\s*(\/\/|\*|--)/.test(l)).join('\n');
}

/**
 * 一行是否构成"断到终态"。
 * 反向规则（都在真语料上抓到过）：
 *  - SQL 谓词行（`NOT IN (` / `AND (` / `WHERE`）且不含断言形状 ⇒ 不是断言，只记 sqlInvariant；
 *  - 终态字面量若出现在 `NOT IN (...)` 括号内 ⇒ 断的是"不许是这个态"，整行否决；
 *  - 行内字面量清单混合了非终态词（`['queued','succeeded'].includes(x)`）⇒ 证明不了收敛，否决。
 */
function terminalAssertion(line, vocab, arrayNames) {
  const hasAssert = ASSERT_SHAPE.test(line);
  const isSql = SQL_PREDICATE.test(line);
  if (!hasAssert) return { hit: null, sqlInvariant: isSql && vocab.some((t) => new RegExp(`['"\`]${t}['"\`]`).test(line)) };
  if (!STATUSISH.test(line)) return { hit: null, sqlInvariant: false };

  // 把 NOT IN (...) 的括号内容摘出去单独判：里面有终态词 ⇒ 整行否决。
  let rest = line;
  const notIn = line.match(/NOT IN\s*\(([^)]*)\)/i);
  if (notIn) {
    const items = [...notIn[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (items.some((s) => vocab.includes(s))) return { hit: null, sqlInvariant: true };
    rest = line.replace(notIn[0], ' NOT_IN_PLACEHOLDER ');
  }
  const lits = vocab.filter((t) => new RegExp(`['"\`]${t}['"\`]`).test(rest));
  const viaArray = [...arrayNames].filter((n) => new RegExp(`\\b${n}\\s*\\.includes\\s*\\(`).test(rest));
  if (!lits.length && !viaArray.length) return { hit: null, sqlInvariant: false };
  const inline = rest.match(/\[([^\]]*)\]/);
  if (inline) {
    const items = [...inline[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (items.length && items.some((s) => !vocab.includes(s))) return { hit: null, sqlInvariant: false };
  }
  return { hit: { terms: [...new Set([...lits, ...viaArray])] }, sqlInvariant: false };
}

/**
 * 守卫式终态检查（V282）：**只在"循环体内已有真等待原语"这一分支里**被调用，
 * 用来认 `if (String(row.status) === 'expired' && rows.length > 0) break;` 这种形状——
 * 收尾的 `expect` 在循环外，但它读的是循环内最后一次取到的行，不收敛就必然在截止时红，
 * 所以"等待＋守卫式 break"与"等待＋循环内断言"是等价的钉法。真语料实例：
 * `ewoh-spark-app/test/e2e/control-backlog-worker-tick.e2e.spec.ts:138-150`（WB-01）。
 * 三条收紧各自带一支不开火的对照：反向守卫（`!==`）、行内没有终态词、循环里没有等待原语。
 */
function terminalGuard(line, vocab, arrayNames) {
  const t = String(line || '').trim();
  if (ASSERT_SHAPE.test(t)) return false;             // 断言形状由 terminalAssertion 管，两路不重叠
  if (!/^if\s*\(/.test(t)) return false;              // 只认守卫行
  if (!/\b(break|return)\b/.test(t)) return false;    // 守卫必须真的结束等待
  if (/!==|!=/.test(t)) return false;                 // 反向：等的是"别是这个态"，不证明收敛
  if (!STATUSISH.test(t)) return false;
  const lits = vocab.some((x) => new RegExp(`['"\`]${x}['"\`]`).test(t));
  const viaArray = [...arrayNames].some((n) => new RegExp(`\\b${n}\\s*\\.includes\\s*\\(`).test(t));
  return lits || viaArray;
}

/* V259 第二根轴：终态判定读的是**哪张表**。分三态：
   · projection ＝ 命中 `.codex/artifacts/projection-map.json` 登记过的派生投影表（保守：块内只要出现一张投影就记投影）
   · authority  ＝ 命中 `schema.ts` 里的 pgTable 名，但**不在**投影清单里（＝「非登记投影」，不等于「已证明它是权威」）
   · unknown   ＝ 块内认不出任何已知表名（只读 HTTP 体、或读表封装在别的文件里）
   真值源读不到 ⇒ unavailable：census 会**响**而不是悄悄全记 unknown。 */
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function loadProjectionTables() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex', 'artifacts', 'projection-map.json'), 'utf8'));
    return new Set((m.projections || []).map((p) => p.table));
  } catch { return null; }
}
function loadSchemaTables() {
  try {
    const t = fs.readFileSync(path.join(APP, 'server', 'database', 'schema.ts'), 'utf8');
    return new Set([...t.matchAll(/pgTable\(\s*["']([^"']+)["']/g)].map((x) => x[1]));
  } catch { return null; }
}
let CACHE = { proj: 0, schema: 0, loaded: false };
function tables() {
  if (!CACHE.loaded) { CACHE = { proj: loadProjectionTables(), schema: loadSchemaTables(), loaded: true }; }
  return CACHE;
}
function objectOf(blockText, sets) {
  const proj = sets.proj; const schema = sets.schema;
  if (!proj || !schema) return { object: 'unavailable', tables: [] };
  const found = new Set();
  for (const m of blockText.matchAll(/\b(?:FROM|UPDATE|INTO|JOIN)\s+(?:public\.)?([a-z][a-z0-9_]*)/gi)) found.add(m[1].toLowerCase());
  for (const m of blockText.matchAll(/\b(ewoh[A-Z][A-Za-z0-9]*)\b/g)) found.add(snake(m[1]));
  const known = [...found].filter((t) => schema.has(t) || proj.has(t));
  if (!known.length) return { object: 'unknown', tables: [...found].filter((t) => t.startsWith('ewoh_')) };
  if (known.some((t) => proj.has(t))) return { object: 'projection', tables: known };
  return { object: 'authority', tables: known };
}

/* V260 第四根轴：终态断言的**主语**读的是哪张表。第二根轴只看"块内出现过哪些表名"，那是筛子——
   一个块里既读权威表又顺手读了投影表，就被记成投影。这一根问的是**判决本身**：`expect(X.status)` 里那个 X 从哪来。
   手法＝语法树，复用仓里**已声明**的 devDependency `typescript`（`ewoh-spark-app/package.json:253`；
   先例＝`ewoh-spark-app/scripts/work-graph-benchmark.js` 的 `require('typescript')`）⇒ **本轮不新增依赖**。
   与 DEP-01 的区别要说清：那个包既不在 package.json 也不在 lockfile，这个在。语法树读不到 ⇒ 整轴 unavailable，
   census 会响，不折算成任何一侧。
   七档（互斥，加总=断到终态块数）：projection｜multi｜authority｜endpoint｜no-table｜no-binding｜no-subject。
   取档＝保守侧在前：任一主语落在登记投影 ⇒ projection；多个已知表 ⇒ multi；恰一个已知表 ⇒ authority；
   再往下三档是"追到哪儿断了"：只到 HTTP 端点／绑定里读不到已知表名／这个名字在本文件根本没有绑定。
   跨文件的 helper（`import { x } from './y'`）**不追模块图** ⇒ 落 no-binding，这是**下界**不是"没断"。 */
let TS_CACHE;
function loadTs() {
  if (TS_CACHE !== undefined) return TS_CACHE;
  TS_CACHE = null;
  for (const c of [path.join(APP, 'node_modules', 'typescript'), 'typescript']) {
    try { TS_CACHE = require(c); break; } catch { /* 换下一个候选路径 */ }
  }
  return TS_CACHE;
}
const SUBJ_COL = '(?:status|state|state_code|stateCode|state_name|stateName|outcome|result|delivery_status|deliveryStatus)';
const SUBJ_SKIP = new Set(['expect', 'assert', 'number', 'string', 'array', 'json', 'boolean', 'object', 'math', 'date', 'length', 'includes', 'tobe', 'toequal', 'totruthy', 'tofalsy', 'not']);
const SUBJ_CALL_SKIP = new Set(['then', 'map', 'filter', 'find', 'some', 'every', 'await', 'count', 'slice', 'push', 'includes', 'number', 'string', 'array', 'json', 'boolean', 'test', 'exec', 'matchall', 'trim', 'split', 'join', 'settimeout', 'promise', 'date', 'parseint', 'isnan', 'tofixed', 'startswith', 'endswith', 'replace', 'touppercase', 'tolowercase', 'tostring', 'keys', 'values', 'entries', 'require']);
const ENDPOINT_TEXT = /\/api\/|\bhttps?\s*\(|\bfetch\s*\(|\brequest\s*\(|\bhttp\.(?:get|post|put|patch|delete)/;

function subjectNames(raw) {
  const out = new Set();
  // 可选链先归一成点号：`a?.b` 与 `a.b` 在"主语是谁"这件事上同义（V260 第一版没归一，`exec?.status` 抽不出主语）
  const line = String(raw).replace(/\?\./g, '.');
  const push = (n) => {
    if (!n || n.length < 3 || SUBJ_SKIP.has(n.toLowerCase()) || /^[A-Z0-9_]+$/.test(n)) return;
    out.add(n);
  };
  // ① 属性链末端是状态列：`rows[0].status`、`exec?.status`、`resp.body.status`
  for (const m of line.matchAll(new RegExp(`\\b([a-z_$][\\w$]*)\\s*(?:\\[[^\\]]*\\]|\\.\\s*(?:find|at|filter)\\s*\\([^)]*\\))?(?:\\s*\\.\\s*\\w+)*\\s*\\.\\s*(?:body\\s*\\.\\s*)?(?:data\\s*\\.\\s*)?${SUBJ_COL}\\b`, 'gi'))) push(m[1]);
  // ② 集合判定的接收者：`rows.every((r) => TERMINAL.includes(r.status))`
  for (const m of line.matchAll(/\b([a-z_$][\w$]*)\s*\.\s*(?:every|some|flatMap)\s*\(/g)) push(m[1]);
  // ③ helper 返回带状态列的行：`(await commandRow(id)).status`、`planStatus(id) === 'dispatched'`
  for (const m of line.matchAll(new RegExp(`([a-z_$][\\w$]*)\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?:\\)\\s*)?\\.\\s*${SUBJ_COL}\\b`, 'gi'))) push(m[1]);
  for (const m of line.matchAll(new RegExp(`\\b([a-z_$][\\w$]*)\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*[=!]==?\\s*['"](?:${TERMINAL.join('|')})['"]`, 'gi'))) push(m[1]);
  // ④ helper 直接返回**状态标量**，整条链上没有状态列：`expect(await planStatus(id)).toBe('dispatched')`
  for (const m of line.matchAll(new RegExp(`\\bexpect\\s*\\(\\s*(?:await\\s+)?([a-z_$][\\w$]*)\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\)\\s*\\.to(?:Be|Equal|StrictEqual)\\s*\\(\\s*['"](?:${TERMINAL.join('|')})['"]`, 'gi'))) push(m[1]);
  return [...out];
}

function buildBinds(ts, sf) {
  const binds = new Map();
  const add = (name, node) => {
    if (!name || !node) return;
    if (!binds.has(name)) binds.set(name, []);
    const list = binds.get(name);
    if (!list.includes(node)) list.push(node);
  };
  const walk = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) add(n.name.text, n.initializer);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) add(n.left.text, n.right);
    if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n.body);
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) add(n.parent.name.text, n.body);
    if (ts.isMethodDeclaration(n) && n.name) add(n.name.getText(), n.body);
    if (ts.isPropertyAssignment(n) && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) add(n.name.getText(), n.initializer.body);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return binds;
}

function nodeFacts(ts, node) {
  const tables = new Set();
  let endpoint = false;
  const walk = (n) => {
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) {
      const s = n.getText();
      for (const m of s.matchAll(/\b(?:FROM|UPDATE|INTO|JOIN)\s+(?:public\.)?([a-z][a-z0-9_]*)/gi)) tables.add(m[1].toLowerCase());
      if (ENDPOINT_TEXT.test(s)) endpoint = true;
    }
    if (ts.isIdentifier(n) && /^ewoh[A-Z]/.test(n.text)) tables.add(snake(n.text));
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'from'
      && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && /^ewoh[A-Z]/.test(n.arguments[0].text)) tables.add(snake(n.arguments[0].text));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return { tables, endpoint, text: node.getText() };
}

function resolveName(ts, binds, name, depth, seen) {
  if (depth > 3 || seen.has(`${name}:${depth}`)) return { bound: false, tables: new Set(), endpoint: false };
  seen.add(`${name}:${depth}`);
  const list = binds.get(name);
  if (!list || !list.length) return { bound: false, tables: new Set(), endpoint: false };
  const acc = new Set();
  let endpoint = false;
  for (const node of list) {
    const t = nodeFacts(ts, node);
    t.tables.forEach((x) => acc.add(x));
    if (t.endpoint) endpoint = true;
    if (!t.tables.size) {
      for (const m of t.text.matchAll(/\b([a-z_$][\w$]{2,})\s*\(/g)) {
        if (SUBJ_CALL_SKIP.has(m[1].toLowerCase())) continue;
        const r = resolveName(ts, binds, m[1], depth + 1, seen);
        if (r.bound) { r.tables.forEach((x) => acc.add(x)); if (r.endpoint) endpoint = true; }
      }
    }
  }
  return { bound: true, tables: acc, endpoint };
}

function mkSubjectIndex(text) {
  const ts = loadTs();
  if (!ts) return { unavailable: true };
  const sf = ts.createSourceFile('inline', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const binds = buildBinds(ts, sf);
  const SUBJ_ORDER = ['projection', 'multi', 'authority', 'endpoint', 'no-table', 'no-binding'];
  return {
    unavailable: false,
    tierOf(blockBody, vocab, arrayNames) {
      const sets = tables();
      if (!sets.proj || !sets.schema) return { subject: 'unavailable', tables: [] };
      const names = new Set();
      for (const line of stripComments(blockBody).split('\n')) {
        if (!terminalAssertion(line, vocab, arrayNames).hit) continue;
        for (const n of subjectNames(line)) names.add(n);
      }
      if (!names.size) return { subject: 'no-subject', tables: [] };
      const per = [...names].map((n) => {
        const r = resolveName(ts, binds, n, 0, new Set());
        if (!r.bound) return { n, tier: 'no-binding', tables: [] };
        const known = [...r.tables].filter((t) => sets.schema.has(t) || sets.proj.has(t));
        if (!known.length) return { n, tier: r.endpoint ? 'endpoint' : 'no-table', tables: [] };
        if (known.some((t) => sets.proj.has(t))) return { n, tier: 'projection', tables: known };
        if (known.length > 1) return { n, tier: 'multi', tables: known };
        return { n, tier: 'authority', tables: known };
      });
      const tier = SUBJ_ORDER.find((k) => per.some((p) => p.tier === k)) || 'no-subject';
      return { subject: tier, tables: [...new Set(per.flatMap((p) => p.tables))], per };
    },
  };
}

/**
 * 第五根轴·终态判定的**强度**（V264）：这一行到底把事实钉成什么了？
 * 六档取块内最强的一档（一个块里只要有一行是等式，本块就算钉住了）：
 *   exactSet   期望值是数组/对象字面量（toEqual([...])）
 *   exactState 状态列等于某个字面量（toBe('succeeded')）
 *   setMembership 只断"每一行都落在终态集合里"（every/includes）——强于存在性，但不指哪一个态
 *   negation   只断"不许是什么"（not.toBe(...)）：守的是不矛盾，不是已收敛
 *   existential 只断"至少有一条像样的"（some/find/toContain/toBe(true)）——V261 实测这种断言抓不到漏发的收件人
 *   other      以上都不是（含纯计数以外的形状）
 * 计数等式（toBe(n)/toHaveLength(n)）不单列：它钉的是"几条"，主语轴已经回答"读的是哪张表"，
 * 两者叠起来才决定这条等式有没有说"收敛到哪个态"，所以按 other 与 exactState 分开即可。
 */
const STRENGTH_ORDER = ['exactSet', 'exactState', 'setMembership', 'negation', 'existential', 'other'];
const STRENGTH_RE = {
  exactSet: /\.to(?:Equal|StrictEqual)\(\s*[{[]/,
  exactState: /\.toBe\(\s*['"`]/,
  setMembership: /\.every\(|toSatisfy\(/,
  negation: /\.not\.(?:toBe|toEqual|toStrictEqual|toContain|toHaveLength)\(/,
  existential: /\.some\(|\.find\(|toContain\(|toBeDefined\(|toBeTruthy\(|toBeGreaterThan\(0\)|\.toBe\(true\)/,
};
function strengthOfLine(line) {
  // 单行内部的优先级（≠ 块内优先级，见 STRENGTH_ORDER）：
  //  ① 否定式必须最先判——`.not.toBe('failed')` 里含 `toBe('`，晚一步就会被读成正向等式；
  //  ② 等式（集合／状态）先于量词；③ `every(...includes...)` 这类"全称成员"先于存在性——
  //     它的行尾常写成 `.toBe(true)`，若让存在性先吃，全称就被误降一档。
  if (STRENGTH_RE.negation.test(line)) return 'negation';
  if (STRENGTH_RE.exactSet.test(line)) return 'exactSet';
  if (STRENGTH_RE.exactState.test(line)) return 'exactState';
  if (STRENGTH_RE.setMembership.test(line)) return 'setMembership';
  if (STRENGTH_RE.existential.test(line)) return 'existential';
  return 'other';
}
function strengthOf(hits) {
  const per = hits.map((h) => strengthOfLine(h.line));
  for (const k of STRENGTH_ORDER) if (per.includes(k)) return { strength: k, per };
  return { strength: 'other', per };
}

function judgeBlock(body, opts = {}) {
  const vocab = opts.wide ? [...TERMINAL, ...WIDE_EXTRA] : TERMINAL;
  const clean = stripComments(body);
  // 别名解析范围＝**整个文件**（V203）：把终态词表提到文件作用域是正当重构，
  // 不该让引用它的块从分子里消失。控制流（循环体、等待原语）的判定范围仍在本块内。
  const arrayNames = terminalArrayNames(clean, vocab);
  for (const nm of opts.fileArrayNames || []) arrayNames.add(nm);
  const hits = [];
  let sqlInvariant = false;
  for (const line of clean.split('\n')) {
    const r = terminalAssertion(line, vocab, arrayNames);
    if (r.sqlInvariant) sqlInvariant = true;
    if (r.hit) hits.push({ line: line.trim(), terms: r.hit.terms, byElimination: !!r.hit.byElimination });
  }
  if (!hits.length) {
    return { asserted: false, terms: [], bucket: 'none', count: 0, evidence: null, sqlInvariant };
  }

  // pollBound：某个循环体内**同时**有真等待原语与终态检查（迭代循环/等前提的循环都不算）。
  let pollBound = false;
  let evidence = null;
  const loopRe = new RegExp(LOOP_HEAD.source, 'g');
  let lm;
  while ((lm = loopRe.exec(clean)) !== null) {
    const bodyText = loopBody(clean, lm.index + lm[0].length);
    if (!WAIT_PRIMITIVE.test(bodyText)) continue;
    const probe = bodyText.split('\n').find((l) => terminalAssertion(l, vocab, arrayNames).hit)
      || bodyText.split('\n').find((l) => terminalGuard(l, vocab, arrayNames));
    if (probe) { pollBound = true; evidence = probe.trim().slice(0, 130); break; }
  }
  const waitOnly = !pollBound && WAIT_PRIMITIVE.test(clean);
  const bucket = pollBound ? 'pollBound' : waitOnly ? 'waitOnly' : 'single';
  const obj = objectOf(clean, tables());
  const st = strengthOf(hits);
  const subj = opts.subjectIndex
    ? (opts.subjectIndex.unavailable ? { subject: 'unavailable', tables: [] } : opts.subjectIndex.tierOf(body, vocab, arrayNames))
    : { subject: 'no-index', tables: [] };
  return {
    asserted: true,
    terms: [...new Set(hits.flatMap((h) => h.terms))],
    bucket,
    count: hits.length,
    evidence: evidence || hits[0].line.slice(0, 130),
    sqlInvariant,
    object: obj.object,
    objectTables: obj.tables,
    subject: subj.subject,
    subjectTables: subj.tables,
    subjectPer: subj.per,
    strength: st.strength,
    strengthPer: st.per,
  };
}

function judgeFile(text, opts) {
  const o = opts || {};
  const vocab = o.wide ? [...TERMINAL, ...WIDE_EXTRA] : TERMINAL;
  const fileArrayNames = terminalArrayNames(stripComments(text), vocab);
  const bs = blocks(text);
  // 主语轴需要整文件的语法树与绑定表：一把尺里只允许一个枚举器/一个索引（V259 的教训写在这里）
  const subjectIndex = mkSubjectIndex(text);
  const judged = bs.map((b) => ({ label: b.label, ...judgeBlock(b.body, { ...o, fileArrayNames, subjectIndex }) }));
  const asserted = judged.filter((j) => j.asserted);
  const nOf = (k) => asserted.filter((j) => j.subject === k).length;
  const n2 = (k) => asserted.filter((j) => j.strength === k).length;
  return {
    blocks: judged.length,
    assertedBlocks: asserted.length,
    pollBound: asserted.filter((j) => j.bucket === 'pollBound').length,
    waitOnly: asserted.filter((j) => j.bucket === 'waitOnly').length,
    single: asserted.filter((j) => j.bucket === 'single').length,
    sqlInvariantOnly: judged.filter((j) => !j.asserted && j.sqlInvariant).length,
    objProjection: asserted.filter((j) => j.object === 'projection').length,
    objAuthority: asserted.filter((j) => j.object === 'authority').length,
    objUnknown: asserted.filter((j) => j.object === 'unknown' || j.object === 'unavailable').length,
    subProjection: nOf('projection'),
    subMulti: nOf('multi'),
    subAuthority: nOf('authority'),
    subEndpoint: nOf('endpoint'),
    subNoTable: nOf('no-table'),
    subNoBinding: nOf('no-binding'),
    subNoSubject: nOf('no-subject'),
    subUnavailable: nOf('unavailable'),
    subjectIndexUnavailable: !!subjectIndex.unavailable,
    stExactSet: n2('exactSet'),
    stExactState: n2('exactState'),
    stMembership: n2('setMembership'),
    stNegation: n2('negation'),
    stExistential: n2('existential'),
    stOther: n2('other'),
    filePoll: asserted.some((j) => j.bucket === 'pollBound'),
    detail: asserted,
  };
}

function census(opts = {}) {
  const files = specFiles();
  const rows = [];
  let sqlOnlyBlocks = 0;
  for (const f of files) {
    const r = judgeFile(fs.readFileSync(f, 'utf8'), opts);
    sqlOnlyBlocks += r.sqlInvariantOnly;
    if (r.assertedBlocks) rows.push({ rel: path.relative(ROOT, f), ...r });
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const assertingBlocks = sum('assertedBlocks');
  const b = { pollBound: sum('pollBound'), waitOnly: sum('waitOnly'), single: sum('single') };
  if (b.pollBound + b.waitOnly + b.single !== assertingBlocks) {
    console.error(`✕ 三档不加总：${b.pollBound}+${b.waitOnly}+${b.single} ≠ ${assertingBlocks} ⇒ 读数作废`);
    process.exit(1);
  }
  const o = {
    projection: sum('objProjection'), authority: sum('objAuthority'), unknown: sum('objUnknown'),
  };
  if (o.projection + o.authority + o.unknown !== assertingBlocks) {
    console.error(`✕ 对象三态不加总：${o.projection}+${o.authority}+${o.unknown} ≠ ${assertingBlocks} ⇒ 读数作废`);
    process.exit(1);
  }
  if (rows.some((r) => r.detail && r.detail.some((d) => d.object === 'unavailable'))) {
    console.error('✕ 真值源（projection-map / schema.ts）读不到 ⇒ 对象这根轴判不可用，不折算成 unknown');
    process.exit(2);
  }
  // 第四根轴：主语七档必须互斥且加总=断到终态块数；'no-index' 说明有人绕开了 judgeFile 这条管道
  const s = {
    projection: sum('subProjection'), multi: sum('subMulti'), authority: sum('subAuthority'),
    endpoint: sum('subEndpoint'), noTable: sum('subNoTable'), noBinding: sum('subNoBinding'),
    noSubject: sum('subNoSubject'),
  };
  if (s.projection + s.multi + s.authority + s.endpoint + s.noTable + s.noBinding + s.noSubject !== assertingBlocks) {
    console.error(`✕ 主语七档不加总：${JSON.stringify(s)} 之和 ≠ ${assertingBlocks} ⇒ 读数作废`);
    process.exit(1);
  }
  if (rows.some((r) => r.detail && r.detail.some((d) => d.subject === 'no-index'))) {
    console.error('✕ 有块的主语档是 no-index ⇒ 有人绕过 judgeFile 直接喂 judgeBlock，枚举器/索引不再是同一个');
    process.exit(1);
  }
  if (s.projection === 0 && rows.some((r) => r.subjectIndexUnavailable)) {
    console.error('✕ 语法树（typescript）读不到：主语轴整轴不可用，那个 0 不是"没有"，是"没量到"');
    process.exit(2);
  }
  if (rows.some((r) => r.detail && r.detail.some((d) => d.subject === 'unavailable'))) {
    console.error('✕ 真值源读不到 ⇒ 主语轴判不可用，不折算成任何一档');
    process.exit(2);
  }
  // 第五根轴（V264）：终态判定的**强度**六档，互斥且加总=断到终态块数
  const st = {
    exactSet: sum('stExactSet'), exactState: sum('stExactState'), membership: sum('stMembership'),
    negation: sum('stNegation'), existential: sum('stExistential'), other: sum('stOther'),
  };
  if (st.exactSet + st.exactState + st.membership + st.negation + st.existential + st.other !== assertingBlocks) {
    console.error(`✕ 强度六档不加总：${JSON.stringify(st)} 之和 ≠ ${assertingBlocks} ⇒ 读数作废`);
    process.exit(1);
  }
  return {
    filesScanned: files.length, rows, assertingBlocks, buckets: b, objs: o, subs: s, strengths: st, sqlOnlyBlocks,
    filesWithPoll: rows.filter((r) => r.filePoll).length,
  };
}

function main() {
  const narrow = census({ wide: false });
  const wide = census({ wide: true });
  const t = narrow;
  console.log(`扫过 ${t.filesScanned} 个常驻用例文件（test/** + server/** + scripts/chain-baseline/**，去注释行，判定单位=用例块）`);
  console.log(
    `断到"权威事实落到终态"的：文件 ${t.rows.length} 个 / 用例块 ${t.assertingBlocks} 个`
    + `；三档 pollBound ${t.buckets.pollBound} · waitOnly ${t.buckets.waitOnly} · single ${t.buckets.single}（互斥且加总=${t.assertingBlocks}）`,
  );
  console.log(`文件级"等到终态才断"（pollBound）：${t.filesWithPoll} 个 / ${t.rows.length} 个断到终态的文件`);
  console.log(
    `第二根轴·终态判定读的是哪张表（三态互斥，加总=${t.assertingBlocks}）：登记投影 ${t.objs.projection} · 非投影（schema 里的表）${t.objs.authority} · 认不出表名＝不可判 ${t.objs.unknown}`
    + `；投影那一档逐条形如"块内出现登记投影表名 ⇒ 保守记投影"（同一块里若同时读了权威表，仍记投影），"不可判"不折算成任何一侧。`,
  );
  console.log(
    `第四根轴·**终态断言的主语**读的是哪张表（七档互斥，加总=${t.assertingBlocks}）：登记投影 ${t.subs.projection} · 多表 ${t.subs.multi} · 非投影已知表 ${t.subs.authority}`
    + ` ｜ 追到端点就断的 ${t.subs.endpoint} · 绑定里读不到已知表 ${t.subs.noTable} · 本文件没有绑定（含跨文件 helper）${t.subs.noBinding} · 抽不出主语 ${t.subs.noSubject}`,
  );
  console.log(
    `  ⇒ 可判面＝${t.subs.projection + t.subs.multi + t.subs.authority}/${t.assertingBlocks}（这三档把主语钉到了已知表）；`
    + `不可判＝${t.subs.endpoint + t.subs.noTable + t.subs.noBinding + t.subs.noSubject}，其中"跨文件 helper"与"走 HTTP 读"是本尺**不追模块图**的下界，不许读成"没有"。`,
  );
  console.log(
    `第五根轴·**终态判定的强度**（六档互斥，加总=${t.assertingBlocks}，块内取最强一行）：`
    + `集合等式 ${t.strengths.exactSet} · 状态等式 ${t.strengths.exactState} · 终态集合成员（every/includes）${t.strengths.membership}`
    + ` ｜ 只断不许矛盾（not.toBe）${t.strengths.negation} · 只断存在（some/find/toContain/toBe(true)）${t.strengths.existential}`
    + ` · 其余形状 ${t.strengths.other}`,
  );
  console.log(
    `  ⇒ 等式面（集合＋状态）＝${t.strengths.exactSet + t.strengths.exactState}/${t.assertingBlocks}；`
    + `存在性 ${t.strengths.existential} · 否定式 ${t.strengths.negation} 块——这两档证不了收敛（存在性只说"有过一条"）。`
    + `成员式（every／toSatisfy）${t.strengths.membership} 块另计：钉的是"每行都在终态集合里"，指不到落到哪一个态，别并入等式面。\n`
    + `  归属要说准：当期存在性那一档是 server/modules/control 的单测（commandUpdates.some(...)）；`
    + `V261 说的到期腿 some(-expiring) **不在本轴分母里**——那行没有终态状态词，本尺不认它是终态判定，两回事别串成一句。`
    + `其余形状（含 toMatchObject 部分等式与"两个终态取其一"的 step 析取）＝${t.strengths.other} 块。`,
  );
  console.log(
    `被排除的形状：SQL 状态谓词行（NOT IN/AND/WHERE，不含断言）单独出现的块 ${t.sqlOnlyBlocks} 个——它们断的是"不许矛盾"不是"落到终态"，不计入分子；`
    + `词表双向差集：窄表 ${narrow.assertingBlocks} 块 vs 宽表(+received/executing) ${wide.assertingBlocks} 块 ⇒ ${wide.assertingBlocks - narrow.assertingBlocks} 块属"在路上"`,
  );
  const sorted = [...t.rows].sort((x, y) => Number(y.filePoll) - Number(x.filePoll) || y.assertedBlocks - x.assertedBlocks);
  for (const r of sorted.slice(0, 30)) {
    const mix = `p${r.pollBound}/w${r.waitOnly}/s${r.single}`;
    const terms = [...new Set(r.detail.flatMap((d) => d.terms))].slice(0, 4).join(',');
    console.log(`  ${r.filePoll ? 'POLL ' : '     '} 块${String(r.assertedBlocks).padStart(3)} ${mix.padEnd(11)} · ${terms} · ${r.rel}`);
  }
  if (sorted.length > 30) console.log(`  …另有 ${sorted.length - 30} 个文件命中（完整清单见 JSON）`);
  console.log('pollBound 全部例证（含被断言的那一行，逐条可核）：');
  for (const r of sorted.filter((x) => x.pollBound > 0)) {
    for (const d of r.detail.filter((x) => x.bucket === 'pollBound')) {
      console.log(`  · ${r.rel}\n      块「${String(d.label).slice(0, 52)}」← ${d.evidence}`);
    }
  }
  console.log('边界：①只认字面量终态 + 状态主语 ⇒ 跨文件导入的词表看不见（下界）；②不判"断得对不对"，只答"有没有断、是不是等到终态才断"；③无 it/test 的场景脚本整文件算一块 ⇒ 块内任一等待会覆盖全文件（偏保守：会把 single 读成 waitOnly，不会把 single 读成 pollBound）；④主语解析**不追模块图**，走 HTTP 的读数也只到端点 ⇒ 那两档是"没量到"，不是"没问题"。');
  fs.writeFileSync(path.join(ROOT, 'tmp', 'convergence-sites.json'), JSON.stringify({
    filesScanned: t.filesScanned,
    assertingBlocks: t.assertingBlocks,
    buckets: t.buckets,
    subjects: t.subs, strengths: t.strengths,
    filesAsserting: t.rows.length,
    filesWithPoll: t.filesWithPoll,
    sqlInvariantOnlyBlocks: t.sqlOnlyBlocks,
    wideDeltaBlocks: wide.assertingBlocks - narrow.assertingBlocks,
    rows: t.rows.map((r) => ({ rel: r.rel, ...r, detail: undefined, blocks: r.detail })),
  }, null, 2) + '\n');
  console.log('机器可读：tmp/convergence-sites.json');
}

function selfTest() {
  const dir = fs.mkdtempSync('/tmp/ewoh-conv-');
  const cases = [
    ['P1_loop_every_includes.spec.ts',
      "it('run 收敛', async () => {\n  for (let attempt = 0; attempt < 12; attempt += 1) {\n    const runs = await offlineRuns();\n    if (runs.length > 0 && runs.every((r) => ['succeeded','failed'].includes(r.status))) break;\n    await delay(1000);\n  }\n});\n",
      { bucket: 'pollBound' }],
    ['P2_single_snapshot.spec.ts',
      "it('重启后授权过期', async () => {\n  const after = await readRow();\n  expect(String(after.status)).toBe('expired');\n});\n",
      { bucket: 'single', strength: 'exactState' }],
    ['P3_while_deadline_arrayname.spec.ts',
      "it('等到终态', async () => {\n  const TERMINAL_STATES = ['succeeded','failed'];\n  const due = Date.now() + 30000;\n  while (Date.now() < due) {\n    const rows = await readRuns();\n    if (rows.length && rows.every((r) => TERMINAL_STATES.includes(r.status))) break;\n    await sleep(500);\n  }\n});\n",
      { bucket: 'pollBound', strength: 'setMembership' }],
    ['P4_delay_cushion.spec.ts',
      "it('等一会儿再读一次', async () => {\n  await delay(3000);\n  expect(String(row.status)).toBe('succeeded');\n});\n",
      { bucket: 'waitOnly' }],
    ['P5_iteration_loop.spec.ts',
      "it('walks the happy path', async () => {\n  let status = 'draft';\n  for (const action of ['release', 'start', 'complete']) {\n    status = await act(action);\n  }\n  expect(status).toBe('completed');\n});\n",
      { bucket: 'single' }],
    ['P6_premise_wait_loop.spec.ts',
      "it('CAS 窗口', async () => {\n  for (;;) {\n    const rows = await readActivity();\n    if (rows.find((r) => r.wait === 'Lock')) break;\n    await new Promise((r) => setTimeout(r, 25));\n  }\n  const after = await readTask();\n  expect(after.status).toBe('dispatched');\n});\n",
      { bucket: 'waitOnly' }],
    ['P7_sql_elimination_not_counted.spec.ts',
      "it('run 不停在非终态', async () => {\n  const stuck = await owner`\n    SELECT count(*)::int AS n FROM ewoh_scheduling_run\n     WHERE org_id = ${org} AND status NOT IN ('queued','pending')`;\n  expect(stuck[0].n).toBe(0);\n});\n",
      { none: true, sqlInvariant: false }],
    ['N1_listonly.spec.ts',
      "const allowed = ['succeeded', 'failed'];\nconsole.log(allowed);\n",
      { none: true }],
    ['N2_nonterminal.spec.ts',
      "it('入队', () => { expect(row.status).toBe('queued'); });\n",
      { none: true }],
    ['N3_efficacy.spec.ts',
      "it('杀连接生效', () => { expect(killLanded).toBe(true); });\n",
      { none: true }],
    ['N4_two_blocks_isolated.spec.ts',
      "it('A 轮询到终态', async () => {\n  const T = ['succeeded','failed'];\n  while (true) {\n    const rows = await read();\n    if (rows.every((r) => T.includes(r.status))) break;\n    await sleep(200);\n  }\n});\nit('B 单次读', async () => {\n  expect(String(after.status)).toBe('dispatched');\n});\n",
      { blocks: ['pollBound', 'single'] }],
    ['N5_mixed_list.spec.ts',
      "it('状态在允许集内', () => { expect(['queued','succeeded'].includes(row.status)).toBe(true); });\n",
      { none: true }],
    ['P8_filescope_terminal_alias_polled.spec.ts',
      "const TERMINAL = ['succeeded','failed'];\nit('轮询到终态（词表在文件作用域）', async () => {\n  let rows = [];\n  for (let i = 0; i < 12; i += 1) {\n    rows = await read();\n    if (rows.length && rows.every((r) => TERMINAL.includes(r.status))) break;\n    await delay(1000);\n  }\n  expect(rows.every((r) => TERMINAL.includes(r.status))).toBe(true);\n});\n",
      { bucket: 'pollBound' }],
    ['G1_guard_break_poll.spec.ts',
      "it('WB-01 形状：等待＋守卫式 break，收尾断言在循环外 ⇒ 必须算 pollBound', async () => {\n  const due = Date.now() + 30000;\n  let row = {};\n  let results = [];\n  while (Date.now() < due) {\n    await new Promise((r) => setTimeout(r, 1000));\n    row = await commandRow(id);\n    results = await expiryRows(id);\n    if (String(row.status) === 'expired' && results.length > 0) break;\n  }\n  expect(String(row.status)).toBe('expired');\n});\n",
      { bucket: 'pollBound' }],
    ['G2_negated_guard_break.spec.ts',
      "it('反向守卫：等的是\u201c别是这个态\u201d，不证明收敛 ⇒ 不得算 pollBound', async () => {\n  const due = Date.now() + 30000;\n  let row = {};\n  while (Date.now() < due) {\n    await new Promise((r) => setTimeout(r, 1000));\n    row = await commandRow(id);\n    if (String(row.status) !== 'expired') break;\n  }\n  expect(String(row.status)).toBe('expired');\n});\n",
      { bucket: 'waitOnly' }],
    ['G3_guard_without_wait.spec.ts',
      "it('有守卫式 break 但循环里没有等待原语 ⇒ 仍不算 pollBound', async () => {\n  for (let i = 0; i < 12; i += 1) {\n    row = await commandRow(id);\n    if (String(row.status) === 'expired') break;\n  }\n  expect(String(row.status)).toBe('expired');\n});\n",
      { bucket: 'single' }],
    ['G4_guard_without_terminal_word.spec.ts',
      "it('守卫里没有终态词（等的是\u201c读到了行\u201d）⇒ 不得算 pollBound', async () => {\n  const due = Date.now() + 30000;\n  let row = null;\n  while (Date.now() < due) {\n    await new Promise((r) => setTimeout(r, 1000));\n    row = await commandRow(id);\n    if (row) break;\n  }\n  expect(String(row.status)).toBe('expired');\n});\n",
      { bucket: 'waitOnly' }],
    ['N7_filescope_mixed_list.spec.ts',
      "const ALLOWED = ['queued','succeeded'];\nit('混合清单按名引用不得算终态', () => { expect(rows.every((r) => ALLOWED.includes(r.status))).toBe(true); });\n",
      { none: true }],
    ['N8_imported_alias_still_invisible.spec.ts',
      "import { TERMINAL } from './vocab';\nit('词表来自别的文件：本尺仍看不见（下界，不是没断）', async () => {\n  await delay(1000);\n  expect(rows.every((r) => TERMINAL.includes(r.status))).toBe(true);\n});\n",
      { none: true }],
    ['N9_alias_visible_loop_not_leaked.spec.ts',
      "const TERMINAL = ['succeeded','failed'];\nit('A 只有等待与循环，没有终态检查', async () => {\n  for (let i = 0; i < 5; i += 1) {\n    if (await settled()) break;\n    await delay(200);\n  }\n});\nit('B 单次读，词表虽可见但块内无循环', async () => {\n  expect(rows.every((r) => TERMINAL.includes(r.status))).toBe(true);\n});\n",
      { blocks: ['single'] }],
    ['O1_projection_polled.spec.ts',
      "it('轮询 KPI 快照并断其收敛 ⇒ 必须认成投影', async () => {\n  let rows = [];\n  for (let i = 0; i < 12; i += 1) {\n    rows = await owner`SELECT status FROM public.ewoh_scheduling_kpi WHERE org_id = 1`;\n    if (rows.length && rows.every((r) => ['succeeded','failed'].includes(r.status))) break;\n    await delay(1000);\n  }\n});\n",
      { bucket: 'pollBound', object: 'projection' }],
    ['O2_authority_polled_compliant.spec.ts',
      "it('轮询 run 表（非登记投影）⇒ 不得被认成投影', async () => {\n  let rows = [];\n  for (let i = 0; i < 12; i += 1) {\n    rows = await owner`SELECT status FROM ewoh_scheduling_run WHERE org_id = 1`;\n    if (rows.length && rows.every((r) => ['succeeded','failed'].includes(r.status))) break;\n    await delay(1000);\n  }\n});\n",
      { bucket: 'pollBound', object: 'authority' }],
    ['O3_http_only_unknown.spec.ts',
      "it('只读 HTTP 体 ⇒ 认不出表名，必须落不可判', async () => {\n  await delay(500);\n  expect(resp.body.status).toBe('succeeded');\n});\n",
      { bucket: 'waitOnly', object: 'unknown' }],
    ['O4_drizzle_identifier_projection.spec.ts',
      "it('drizzle 驼峰实体名也要认得（KPI 是登记投影）', async () => {\n  const rows = await db.select().from(ewohSchedulingKpi);\n  expect(rows.every((r) => ['succeeded','failed'].includes(r.status))).toBe(true);\n});\n",
      { bucket: 'single', object: 'projection' }],
    ['O5_drizzle_identifier_authority.spec.ts',
      "it('drizzle 驼峰实体名：run 表不是登记投影', async () => {\n  const rows = await db.select().from(ewohSchedulingRun);\n  expect(rows.every((r) => ['succeeded','failed'].includes(r.status))).toBe(true);\n});\n",
      { bucket: 'single', object: 'authority' }],
    ['S1_subject_projection_single_read.spec.ts',
      "it('终态主语来自登记投影（KPI 快照）⇒ 必须判 projection', async () => {\n  const rows = await owner`SELECT status FROM public.ewoh_scheduling_kpi WHERE org_id = 1`;\n  expect(rows.every((r) => ['succeeded','failed'].includes(r.status))).toBe(true);\n});\n",
      { bucket: 'single', subject: 'projection' }],
    ['S2_subject_via_helper_call.spec.ts',
      "async function kpiRow() {\n  return owner`SELECT status FROM public.ewoh_scheduling_kpi WHERE id = 1`;\n}\nit('主语是 (await helper(id)).status ⇒ 跟进 helper 判 projection（V259 手工漏掉的形状）', async () => {\n  expect(String((await kpiRow()).status)).toBe('succeeded');\n});\n",
      { bucket: 'single', subject: 'projection' }],
    ['S3_subject_reassign_multiline_sql.spec.ts',
      "it('再赋值＋多行模板串也要跟得到 ⇒ 判 authority 而不是不可判', async () => {\n  let runs = [];\n  runs = await owner`\n    SELECT status FROM ewoh_scheduling_run\n     WHERE org_id = 1`;\n  if (runs.length) expect(runs.every((r) => ['succeeded','failed'].includes(r.status))).toBe(true);\n});\n",
      { bucket: 'single', subject: 'authority' }],
    ['S4_subject_http_endpoint.spec.ts',
      "it('主语来自 HTTP 响应 ⇒ 只到端点，不许折成权威也不折成投影', async () => {\n  const resp = await api.post('/api/scheduler/dispatch', { id: 1 });\n  expect(resp.body.status).toBe('succeeded');\n});\n",
      { bucket: 'single', subject: 'endpoint' }],
    ['S5_subject_for_of_no_binding.spec.ts',
      "it('主语由 for-of 引入、本文件读不到来源 ⇒ 落 no-binding（不折算成任何一侧）', async () => {\n  for (const rows of batches) {\n    if (rows.length && rows.every((r) => ['succeeded','failed'].includes(r.status))) break;\n    await delay(200);\n  }\n});\n",
      { bucket: 'pollBound', subject: 'no-binding' }],
    ['S6_optional_chain_subject.spec.ts',
      "it('可选链主语 exec?.body?.status 也要抽得出 ⇒ 走 HTTP 就落 endpoint', async () => {\n  const exec = await api.get('/api/execution/1');\n  expect(exec?.body?.status).toBe('completed');\n});\n",
      { bucket: 'single', subject: 'endpoint' }],
    ['S7_scalar_returning_helper.spec.ts',
      "async function kpiState(id) {\n  const rows = await owner`SELECT status FROM public.ewoh_scheduling_kpi WHERE id = ${id}`;\n  return rows[0] ? rows[0].status : null;\n}\nit('helper 返回状态标量（断言里没有状态列）⇒ 规则④跟进函数体，必须判 projection', async () => {\n  expect(await kpiState(plan.id)).toBe('dispatched');\n});\n",
      { bucket: 'single', subject: 'projection' }],
    // V264 第五根轴（强度）：四支必须开火＋一支"块内取最强"的极性对照
    ['Q1_strength_existential.spec.ts',
      "it('到期提醒出现过——只断存在抓不到漏发的收件人（V261 实测形状）', async () => {\n  const rows = await read();\n  expect(rows.some((r) => r.status === 'expired')).toBe(true);\n});\n",
      { bucket: 'single', strength: 'existential' }],
    ['Q2_strength_negation.spec.ts',
      "it('只断不许矛盾', async () => {\n  const after = await readRow();\n  expect(after.status).not.toBe('failed');\n});\n",
      { bucket: 'single', strength: 'negation' }],
    ['Q3_strength_exactSet.spec.ts',
      "it('把两条回执的状态集合整个钉住', async () => {\n  const rows = await read();\n  expect(rows.map((r) => r.status).sort()).toEqual(['failed','succeeded']);\n});\n",
      { bucket: 'single', strength: 'exactSet' }],
    ['Q4_strength_block_takes_strongest.spec.ts',
      "it('同块里既有等式又有存在性 ⇒ 块级记最强，弱行不得把整块降档', async () => {\n  const rows = await read();\n  expect(rows.map((r) => r.status).sort()).toEqual(['succeeded']);\n  expect(rows.some((r) => r.notificationId.includes('-expiring'))).toBe(true);\n});\n",
      { bucket: 'single', strength: 'exactSet' }],
    ['Q5_strength_membership_not_existential.spec.ts',
      "it('全称成员（every(...includes...)）不得被行尾 toBe(true) 误降成存在性', async () => {\n  const rows = await readRuns();\n  expect(rows.every((r) => ['succeeded','failed'].includes(r.status))).toBe(true);\n});\n",
      { bucket: 'single', strength: 'setMembership' }],
    ['N6_sql_not_in_terminals.spec.ts',
      "it('投影不矛盾', async () => {\n  const bad = await owner`\n    SELECT count(*) FROM ewoh_scheduling_plan_assignment a JOIN ewoh_task t ON t.id = a.task_id\n     WHERE (a.status = 'dispatched' AND t.status NOT IN ('dispatched','received','executing'))`;\n  expect(Number(bad[0].count)).toBe(0);\n});\n",
      { none: true, sqlInvariant: true }],
  ];
  let ok = true;
  for (const [name, src, want] of cases) {
    fs.writeFileSync(path.join(dir, name), src);
    const r = judgeFile(src, {});
    let pass; let got;
    if (want.blocks) {
      got = r.detail.map((d) => d.bucket);
      pass = JSON.stringify(got) === JSON.stringify(want.blocks);
      console.log(`  ${pass ? '✔' : '✕'} ${name} → 两块档位 ${JSON.stringify(got)}（期望 ${JSON.stringify(want.blocks)}：A 的轮询不得污染 B）`);
    } else if (want.none) {
      got = { assertedBlocks: r.assertedBlocks, sqlInvariantOnly: r.sqlInvariantOnly };
      pass = r.assertedBlocks === 0 && (!want.sqlInvariant || r.sqlInvariantOnly > 0);
      console.log(`  ${pass ? '✔' : '✕'} ${name} → 命中块数=${r.assertedBlocks} SQL不变量块=${r.sqlInvariantOnly}（期望 0 命中${want.sqlInvariant ? '，且必须认出 SQL 不变量' : ''}）`);
    } else {
      got = r.detail[0] && r.detail[0].bucket;
      pass = r.assertedBlocks === 1 && got === want.bucket;
      let objNote = '';
      if (want.object) {
        const go = r.detail[0] && r.detail[0].object;
        pass = pass && go === want.object;
        objNote = ` → object=${go}（期望 ${want.object}）`;
      }
      if (want.strength) {
        const gq = r.detail[0] && r.detail[0].strength;
        pass = pass && gq === want.strength;
        objNote += ` → strength=${gq}（期望 ${want.strength}）`;
      }
      if (want.subject) {
        const gs = r.detail[0] && r.detail[0].subject;
        pass = pass && gs === want.subject;
        objNote += ` → subject=${gs}（期望 ${want.subject}）`;
      }
      console.log(`  ${pass ? '✔' : '✕'} ${name} → bucket=${got}（期望 ${want.bucket}）${objNote}`);
    }
    if (!pass) ok = false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // 条数由脚本自报（V264）：以前要人手抄「当期 29 支」，加一支控制就腐烂一条
  console.log(`  判据自测条数＝${cases.length}（本轮起含强度轴 Q1..Q5 五支；这一行就是条数的唯一来源）`);
  console.log(ok
    ? '结论：尺子可用（强度六档各有极性——否定式先于正向等式、全称成员不得被行尾 toBe(true) 误降、块级取最强一行；真轮询必开火；迭代循环/等前提的循环/时间垫不得冒充 pollBound；非断言·非终态·纯功效·混合清单·SQL 反向谓词·跨文件词表不得开火；块间控制流不互相污染，终态别名按文件作用域求解；主语轴四支极性——轮询/单读登记投影必须判 projection、再赋值＋多行 SQL 必须跟到 authority、走 HTTP 只到 endpoint、for-of 引入的主语落 no-binding 而不折成任何一侧）'
    : '结论：尺子不可用，本轮不出数');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest(); else main();
}

// V171 起被 `async-producer-face.cjs` 复用：**同一套块枚举器**，避免两个枚举器读数不一致（读数作废）。
module.exports = { blocks, judgeBlock, judgeFile, specFiles, objectOf, TERMINAL, WIDE_EXTRA };
