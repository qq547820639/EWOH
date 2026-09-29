#!/usr/bin/env node
'use strict';
/**
 * 裸 SQL 状态列写入普查（新增量具；只出读数、未接共享门禁主线）
 * ─────────────────────────────────────────────────────────────────────────
 * 一问：**仓里有哪些"权威状态列"是通过裸 SQL 写进去的**——即 `sql` 模板、
 * `unsafe()` 字符串、`.sql` 迁移/verify 里那些 `UPDATE … SET <状态列> = …`？
 *
 * 为什么要单独量这一层：`status-write-guard-census.cjs`（V157）与
 * `audit-state-machine-roles.js`（主线9）都是 **AST 判据**，只认得
 * `db.update(<表>).set({status:'X'}).where(and(eq(<表>.status, from)))` 这一种形状。
 * 状态列还可以走裸 SQL 写，那是 AST 判据**结构上看不见的一面**：
 * 在这一面被量出来之前，任何"该列的每个写者都带来源态守卫"的说法都不可证。
 * 本件只把这一面量成数，**不裁决**这些位点该怎么处理。
 *
 * 分母（一句话写死）：扫描面内每个"带 SET 子句的裸 SQL UPDATE 语句"算一个站点，
 * 站点按可见性分四档，其中 `not-state`（改了非状态列）**照量但不算状态写者**。
 * 语料面：`ewoh-spark-app/server`、`ewoh-spark-app/test`、`scripts`、`db` 下
 * `/\.(ts|tsx|js|mjs|cjs|sql)$/`；跳过 node_modules/dist/output/.git/tmp；
 * `__tests__` **不跳**（测试夹具自建前置条件正是本件要看的那一类）。
 *
 * 四档（永不合并）：
 *   literal    值是被引号包住的字面量（或 true/false/null/数字/DEFAULT）
 *   parameter  值是 `$n`、`?`、`:name` 或 postgres.js 的 `${…}` 绑定
 *   dynamic    **本件解不开**：表名或列名来自被插入的标识符（`${c.table}`、`${q(tbl)}`、
 *              `%I`），或值是无法求值的表达式。看不见 ≠ 合规，更 ≠ 零生产位点。
 *   not-state  SET 里一个状态列都没改（如只改 person_id）⇒ 不计入状态写者，
 *              但逐条打印出来，让复核的人看见"为什么被排除"。
 * 状态列判据：列名（不区分大小写）等于 `status`/`state`/`active`/`accepted`，
 * 或以 `_status` 结尾。这是**词面判据**，不是语义判据：同名列落在别的表上也会计入。
 *
 * 恒等式（不成立即"读数作废"并非零退出，绝不把档位加总当分母报）：
 *   ① Σ四档 == 站点数      ② Σ归属 == 站点数      ③ 站点 + 各弃档原因 == `update` 候选词数
 *
 * 归属（按路径，认不出的单列 `unattributed`，不硬塞进四桶）：
 *   product                  `ewoh-spark-app/server/**`（排除 `*.spec.ts` 与 test 目录）
 *   test-fixture             `ewoh-spark-app/test/**` 或 `*.spec.ts`
 *   verifier-script          `scripts/**`
 *   migration-or-verify-sql  `db/**`
 *
 * 注释不是写入：`//`、块注释、markdown 式文档块、SQL 的 `--` 与块注释（含字符串与
 * 模板字面量**内部**的 SQL 注释）一律先遮掉再匹配；每次遮掉一处都留痕并条数打印，
 * 免得"看不见"被读成"干净"。
 *
 * 限度（不许读成"已穷尽"）：
 *  - 文本判据 + 注释遮罩，不是 SQL 解析器：`${…}` 里嵌 `}`、多列 `SET (a,b)=(…)` 的
 *    深层写法、跨变量别名的表名都可能判不进档 ⇒ 一律落 `dynamic` 并带原因，不落"合规"。
 *  - 引号里的引号：若某条 SQL 的**字符串值本身**含一整句 `UPDATE … SET status=…`，
 *    本件会把它读成站点；这类站点带 `in-sql-literal` 标记逐条打印供人工否决。
 *  - 只数"位点存在"，不判该位点有没有守卫、也不判它写的是不是权威表。
 *  - 本脚本自身不进扫描面（它的自测夹具里就带着真语料的 SQL 原文，否则会自己喂自己）。
 *
 * 用法：node scripts/chain-baseline/raw-status-writes.cjs [--self-test|--roots a,b|--json|--garbled-probe]
 *      （--json 打在最后一整段，可直接从首个独立的 `{` 起解析；--roots/--garbled-probe 是给"能不能红"用的探针档）
 * 依赖：零新增。JS/TS 的注释与字面量边界交给本仓已有的 typescript 词法器判（`status-write-guard-census.cjs`
 *      同源解析，本机实测 typescript@5.9.2）；取不到词法器＝语料读不动 ⇒ 退出码 2，不拿"没数了"冒充"没有写入"。
 * 退出码（对齐 change-amplification.cjs 的三态纪律）：
 *   0 = 度量完成且三条恒等式成立
 *   1 = 判据自测不过 / 恒等式不成立（读数作废）/ 两处已知答案校准不符
 *   2 = 输入解析不到（语料根缺失、语料为空、遮罩器判定语料畸形）——**不会静默读成 0 处**
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const SELF = 'scripts/chain-baseline/raw-status-writes.cjs';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'output', '.git', 'tmp']);
const DEFAULT_ROOTS = ['ewoh-spark-app/server', 'ewoh-spark-app/test', 'scripts', 'db'];
const EXT = /\.(ts|tsx|js|mjs|cjs|sql)$/;

/** 状态列词面（判据本体，改这里即改判据）。 */
const STATE_EXACT = new Set(['status', 'state', 'active', 'accepted']);
const GRADES = ['literal', 'parameter', 'dynamic', 'not-state'];
const ATTRS = ['product', 'test-fixture', 'verifier-script', 'migration-or-verify-sql', 'unattributed'];
/** 两处已知答案（本会话手工核实过的裸 SQL 写入面；对不上即本件坏了，rc=1）。 */
const CALIBRATION = [
  { file: 'ewoh-spark-app/test/e2e/execution-receipt-closed-loop.mjs', grade: 'literal', table: 'ewoh_scheduling_execution', col: 'status', value: 'STARTED' },
  { file: 'scripts/verify-scheduler-multitenant.mjs', grade: 'dynamic', table: '${SCHEMA}.${c.table}', col: '${c.setCol}' },
];

function isStateColumn(name) {
  const c = String(name || '').toLowerCase();
  return STATE_EXACT.has(c) || c.endsWith('_status');
}

/* ─────────────────────────── 遮罩：注释不是写入 ─────────────────────────── */

/**
 * JS/TS 遮罩：注释不是写入 ⇒ 先把全部注释 trivia 擦成等长空格；字面量（字符串/模板）
 * 的内容要留着（裸 SQL 就在里面），并登记每个字面量的**外层**区间供窗口用。
 *
 * 为什么用本仓已有的 typescript 词法器（`status-write-guard-census.cjs` 同源解析）而不是
 * 自己写一遍：本轮手写遮罩器连着栽了三跤——模板区 end 没写回区对象（窗口全撑到 EOF）、
 * `/'/g` 这种正则里的裸引号把引号配错对、跨行模板的奇偶数根本对不上——每一次都"照样出数"，
 * 但数是真的吗看不出来。注释/字面量的边界属于语言事实，交给该语言的词法器判，
 * 本件的判据只负责 SQL 那一面。零新依赖（typescript 已在 ewoh-spark-app/package.json）。
 */
let tsLib;
function loadTs() {
  if (tsLib !== undefined) return tsLib;
  try {
    tsLib = require('node:module').createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');
  } catch (e) {
    try { tsLib = require('typescript'); } catch (e2) { tsLib = null; maskJs.error = `取不到 typescript 词法器（${e2.message}）⇒ 无法区分注释与字面量`; }
  }
  return tsLib;
}

function maskJs(src, fileName) {
  const anomalies = [];
  const blanked = [];
  const regions = [];
  const ts = loadTs();
  if (!ts) return { text: src, regions, lang: 'js', anomalies: [maskJs.error || '词法器不可用'], blanked, lexerUnavailable: true };
  const chars = src.split('');
  const blank = (a, b, why) => {
    for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
    blanked.push({ from: a, to: b, why });
  };
  const COMMENT = new Set([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia, ts.SyntaxKind.ShebangTrivia]);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  for (let tok = scanner.scan(); tok !== ts.SyntaxKind.EndOfFileToken; tok = scanner.scan()) {
    if (!COMMENT.has(tok)) continue;
    blank(scanner.getTokenPos(), scanner.getTextPos(), 'comment');
  }
  const text = chars.join('');
  // 用真文件名解析：.tsx 要走 JSX 语法，按 .ts 解析会满屏 "expected" 假畸形
  const sf = ts.createSourceFile(fileName || 'probe.ts', src, ts.ScriptTarget.Latest, true);
  const LIT = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateExpression]);
  const visit = (node) => {
    if (LIT.has(node.kind)) {   // 外层字面量整块登记；内部的 `${}`/引号属于这段文本，不再另立窗口
      regions.push({ start: node.getStart(sf), end: node.getEnd(), kind: node.kind === ts.SyntaxKind.TemplateExpression ? 'tpl' : 'str' });
      return;
    }
    node.forEachChild(visit);
  };
  ts.forEachChild(sf, visit);
  regions.sort((a, b) => a.start - b.start);
  // 未闭合的字面量（TS 会报 parse 诊断）＝这份语料本件读不动 ⇒ 如实记畸形，不折成"没有写入"
  for (const diag of sf.parseDiagnostics || []) {
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
    if (LEXER_FATAL.test(msg)) anomalies.push(`词法读不动（第 ${lineAt(src, diag.start || 0)} 行：${msg}）`);
  }
  return { text, regions, lang: 'js', anomalies, blanked };
}

/** SQL：遮掉 `--` 行注释与可嵌套的块注释，保留引号串与 dollar-quote 体（迁移里的 EXECUTE 语句在里面）。 */
function maskSql(src) {
  const n = src.length;
  const chars = src.split('');
  const anomalies = [];
  const blanked = [];
  const regions = [];
  const blank = (a, b, why) => {
    for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
    blanked.push({ from: a, to: b, why });
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '-' && d === '-') { const j = src.indexOf('\n', i); blank(i, j < 0 ? n : j, 'sql-line-comment'); i = j < 0 ? n : j; continue; }
    if (c === '/' && d === '*') {
      let depth = 1; let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue; }
        if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) { anomalies.push('SQL 块注释未闭合（' + i + '→EOF）'); blank(i, n, 'sql-block-unterminated'); i = n; continue; }
      blank(i, j, 'sql-block-comment'); i = j; continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        const k = src.indexOf("'", j);
        if (k < 0) { anomalies.push('SQL 字符串未闭合'); regions.push({ start: i, end: n, kind: 'sql-str' }); j = n; break; }
        if (src[k + 1] === "'") { j = k + 2; continue; }
        regions.push({ start: i, end: k + 1, kind: 'sql-str' }); j = k + 1; break;
      }
      i = j; continue;
    }
    const dq = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 12));
    if (dq) {
      const close = src.indexOf(dq[0], i + dq[0].length);
      if (close < 0) { anomalies.push(`dollar-quote 未闭合（${dq[0]}）`); regions.push({ start: i, end: n, kind: 'sql-dollar' }); i = n; continue; }
      regions.push({ start: i, end: close + dq[0].length, kind: 'sql-dollar' });
      i = close + dq[0].length; continue;
    }
    i++;
  }
  return { text: chars.join(''), regions, lang: 'sql', anomalies, blanked };
}

const SQLISH = /\b(select|insert|update|delete|merge|where|from|begin|commit|values|returning)\b/i;

/**
 * 第二轮：字面量**内部**的 SQL 注释（模板里的 `-- …`、`/* … *\/`）也遮掉——
 * 那正是"看起来像写入其实是一句被注释掉的 SQL"。两条护栏：
 *  ① 只有看起来像 SQL 的字面量才做（否则 CLI 帮助串里的 `--flag` 会被整行吃掉）；
 *  ② `--` 只在行首或空白之后才算注释；遮罩永不吃掉字面量的收尾定界符。
 * 每遮一处都进 blanked 清单，读数里逐条计数打印。
 */
function maskInsideRegions(masked) {
  const { text, regions } = masked;
  const chars = text.split('');
  for (const r of regions) {
    const body = text.slice(r.start, r.end);
    if (!SQLISH.test(body)) continue;
    for (let i = r.start + 1; i < r.end - 1; i++) {
      const c = chars[i];
      const prev = i > r.start ? text[i - 1] : ' ';
      if (c === '-' && text[i + 1] === '-' && /[\s>]/.test(prev)) {
        let j = i;
        while (j < r.end - 1 && text[j] !== '\n') j++;
        for (let k = i; k < j; k++) chars[k] = ' ';
        masked.blanked.push({ from: i, to: j, why: 'sql-comment-inside-literal' });
        i = j; continue;
      }
      if (c === '/' && text[i + 1] === '*' && /[\s(]/.test(prev)) {
        const close = text.indexOf('*/', i + 2);
        const end = close < 0 ? r.end - 1 : Math.min(close + 2, r.end - 1);
        for (let k = i; k < end; k++) if (chars[k] !== '\n') chars[k] = ' ';
        masked.blanked.push({ from: i, to: end, why: 'sql-block-inside-literal' });
        i = end; continue;
      }
    }
  }
  return chars.join('');
}

/** 字面量内部的单引号 SQL 串（用来给站点打 `in-sql-literal` 标记，不遮内容）。 */
function sqlLiteralSpans(text, regions) {
  const spans = [];
  for (const r of regions) {
    for (let i = r.start + 1; i < r.end - 1; i++) {
      if (text[i] !== "'" || text[i - 1] === '\\') continue;
      let j = i + 1;
      while (j < r.end - 1) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      if (j > i) spans.push({ start: i, end: Math.min(j + 1, r.end) });
      i = Math.max(j, i);
    }
  }
  return spans;
}

/* ─────────────────────────── 语句解析 ─────────────────────────── */

function skipWs(t, i, limit) { while (i < limit && /\s/.test(t[i])) i++; return i; }

/** 把若干区间擦成等长空格（长度不变 ⇒ 偏移与行号仍然对得上）。 */
function blankRanges(t, ranges) {
  const chars = t.split('');
  for (const [a, b] of ranges) for (let k = Math.max(0, a); k < Math.min(b, chars.length); k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}

function matchBrace(t, openIdx, limit) {
  let depth = 0;
  for (let i = openIdx; i < limit; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return limit;
}

/**
 * 读表名：字面标识符 / 被插入的标识符（`${…}`、`%I`）/ 看不见。
 * 限定符（`schema.table`）逐段拼；`${…}` 段之间的那个点是分隔符，绝不能并进下一段的
 * `$`（第一版把 `IDENT_CHAR` 里的 `.` 和 `$` 连起来吃，读成 `${SCHEMA}..$` ⇒ `set` 永远
 * 找不到 ⇒ 真语料的 dynamic 位点被当成 no-set 弃档，是本轮自测抓出来的）。
 */
function readTable(t, from, limit) {
  let i = skipWs(t, from, limit);
  let only = false;
  if (/^only\b/i.test(t.slice(i, i + 5))) { const j = skipWs(t, i + 4, limit); only = true; i = j; }
  let raw = '';
  let interp = false;
  let parts = 0;
  const join = (piece) => { raw += (parts && !/[.]$/.test(raw) ? '.' : '') + piece; parts++; };
  while (i < limit) {
    if (t.startsWith('${', i)) { const e = matchBrace(t, i + 1, limit); join(t.slice(i, e)); i = e; interp = true; continue; }
    if (t[i] === '%') {
      const m = /^%[Is]/.exec(t.slice(i, i + 2));
      if (m) { join(m[0]); i += 2; interp = true; continue; }
    }
    if (t[i] === '"') { const k = t.indexOf('"', i + 1); if (k < 0 || k > limit) break; join(t.slice(i, k + 1)); i = k + 1; continue; }
    if (t[i] === '.' && parts) { raw += '.'; i++; continue; }
    let j = i;
    while (j < limit && /[A-Za-z0-9_$]/.test(t[j])) j++;
    if (j > i) { join(t.slice(i, j)); i = j; continue; }
    break;
  }
  raw = raw.replace(/\.$/, '');
  if (!raw) return { raw: '', kind: 'missing', end: i };
  return { raw, only, kind: interp ? 'interp' : 'literal', end: i };
}

/** 词法器读不动的诊断族（未闭合的字面量/注释/正则）：命中即整份语料判畸形（rc=2），绝不折成"没有写入"。 */
const LEXER_FATAL = /unterminated|expected|invalid character|regular expression|missing closing/i;

const BOUNDARY = /^(where|returning|from|order|limit|offset|values|set|and|or)$/i;

/** SET 子句：拆顶层逗号成赋值段，遇边界词/`;`/括号收/出窗即止。 */
function readAssignments(t, from, hardLimit) {
  const segs = [];
  let depth = 0;
  let start = from;
  let limit = hardLimit;
  for (let i = from; i < limit; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { segs.push(t.slice(start, i)); limit = i; start = i; break; }
      depth--; continue;
    }
    if (depth > 0) continue;
    if (c === ',') { segs.push(t.slice(start, i)); start = i + 1; continue; }
    if (c === ';') { segs.push(t.slice(start, i)); limit = i; start = i; break; }
    if (/[A-Za-z_]/.test(c) && !/[A-Za-z0-9_$]/.test(t[i - 1] || '')) {
      let j = i;
      while (j < hardLimit && /[A-Za-z0-9_$]/.test(t[j])) j++;
      if (BOUNDARY.test(t.slice(i, j))) { segs.push(t.slice(start, i)); limit = i; start = i; break; }
      i = j - 1; continue;
    }
  }
  if (start < limit) segs.push(t.slice(start, limit));
  return segs.map((s) => s.trim()).filter(Boolean);
}

function splitAssign(seg) {
  let depth = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth > 0) continue;
    if (c === '=' && seg[i + 1] !== '=' && seg[i - 1] !== '!' && seg[i - 1] !== '>' && seg[i - 1] !== '<') {
      return { left: seg.slice(0, i).trim(), right: seg.slice(i + 1).trim() };
    }
  }
  return null;
}

function readWord(t, i, limit) {
  i = skipWs(t, i, limit);
  let j = i;
  while (j < limit && /[A-Za-z0-9_$]/.test(t[j])) j++;
  return j > i ? { word: t.slice(i, j), start: i, end: j } : null;
}

/**
 * `UPDATE <表> [AS] <别名>` —— 别名必须吃掉，否则 `SET` 永远看不见。
 * 真语料两处因此漏计（本轮独立复核抓出来的）：
 *   db/migrations/standalone_105_agent_l3_policy_containment.sql:12 `… AS manifest SET status = 'suspended'`
 *   db/runner/reset-scenario-data.js:460 `… ewoh_resource_reservation r SET status = 'released'`
 * 别名后面若不是 `set` 仍然按原路判弃档，不会把文案读成写入。
 */
function skipTableAlias(surface, pos, limit) {
  const w1 = readWord(surface, pos, limit);
  if (!w1 || RESERVED_AFTER_TABLE.test(w1.word)) return pos;
  if (/^as$/i.test(w1.word)) {
    const w2 = readWord(surface, w1.end, limit);
    return w2 && !RESERVED_AFTER_TABLE.test(w2.word) ? w2.end : pos;
  }
  return w1.end;
}

const RESERVED_AFTER_TABLE = /^(set|where|returning|from|using|values|order|limit)$/i;

function classifyColumn(left) {
  const s = left.trim();
  if (!s) return { name: '', kind: 'missing' };
  if (s.startsWith('(')) {
    const inner = s.replace(/^\(/, '').replace(/\).*/, '');
    const names = inner.split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
    return { name: names.join('+'), names, kind: names.every((x) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(x)) ? 'literal' : 'interp' };
  }
  if (/\$\{|%[Is]/.test(s)) return { name: s, kind: 'interp' };
  const bare = s.split('.').pop().replace(/"/g, '');
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(bare)) return { name: bare, kind: 'literal' };
  return { name: s, kind: 'unresolved' };
}

function classifyValue(right) {
  const s = String(right || '').trim();
  if (!s) return { kind: 'empty', text: '' };
  const core = s.replace(/::[\w\s\[\]()]*$/, '').trim();
  let m;
  if (/^(E?)'(?:[^']|'')*'$/s.test(core)) return { kind: 'literal', text: core.replace(/^E?'/, '').replace(/'$/, '').replace(/''/g, "'") };
  if (/^(true|false|null|default)$/i.test(core)) return { kind: 'literal', text: core.toLowerCase() };
  if (/^-?\d+(\.\d+)?$/.test(core)) return { kind: 'literal', text: core };
  if (/^\$\d+$/.test(core)) return { kind: 'parameter', text: core };
  if (/^\?(\d+)?$/.test(core) || /^:[A-Za-z_]\w*$/.test(core)) return { kind: 'parameter', text: core };
  if (/^\$\{.*\}$/s.test(core)) return { kind: 'parameter', text: core, bind: true };
  if ((m = /^\$\{[^}]*\}::/.exec(core))) return { kind: 'parameter', text: m[0], bind: true };
  return { kind: 'unknown', text: s.replace(/\s+/g, ' ').slice(0, 48) };
}

/** 站点可见性：0 字面量 < 1 参数 < 2 解不开；语句取最暗的一档。 */
const OPACITY = { literal: 0, parameter: 1, unknown: 2, empty: 2, interp: 2, unresolved: 2, missing: 2 };
const GRADE_BY_OPACITY = ['literal', 'parameter', 'dynamic'];

/**
 * 在遮过注释的文本里抽所有裸 SQL UPDATE。
 * 返回 { sites, discarded }：discarded 逐条带原因，任何候选都不许静默消失。
 */
function parseUpdates(masked) {
  const text = masked.text;
  const regions = masked.regions;
  const spans = masked.sqlLiterals || [];
  const sites = [];
  const discarded = [];
  const rx = /\bupdate\b/gi;
  let m;
  while ((m = rx.exec(text))) {
    const at = m.index;
    const before = text.slice(Math.max(0, at - 60), at);
    if (/\.\s*$/.test(before)) { discarded.push({ at, why: 'drizzle-call' }); continue; } // `.update(` 归 AST 尺子
    // SQL 窗口：语句所在字面量（跨 `'a' + 'b'` 拼接）；.sql 里裸语句则到本句 `;`（靠 `;`/边界词收）
    const win = regions.filter((r) => r.start <= at && at < r.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
    let limit;
    const gaps = [];
    if (win) {
      limit = win.end;
      for (;;) {
        const nxt = regions.filter((r) => r.start >= limit - 1 && /^\s*\+?\s*$/.test(text.slice(limit, r.start)) && r.start - limit < 24)
          .sort((a, b) => a.start - b.start)[0];
        if (!nxt) break;
        gaps.push([limit, nxt.start]);   // 拼接算子（`' + '`）不是 SQL 的一部分：解析前擦成空格
        limit = nxt.end;
      }
    } else {
      if (masked.lang === 'js') { discarded.push({ at, why: 'bare-keyword-in-js-code' }); continue; }
      const semi = text.indexOf(';', at);
      limit = semi < 0 ? text.length : semi;
    }
    // 解析面：把窗口内的**字面量定界符**与拼接算子擦成等长空格——
    // 它们不是 SQL 的一部分，留着的话 `set '` + `'status = $1` 会被读成一个解不开的列名。
    const blanks = gaps.map(([a, b]) => [a, b]);
    if (win) {
      for (const r of regions) {
        if (r.end <= win.start || r.start >= limit) continue;
        if (r.start >= win.start) blanks.push([r.start, r.start + 1]);
        if (r.end - 1 <= limit) blanks.push([r.end - 1, r.end]);
        // JS 单/双引号串里的 `\'` 是转义不是新串的开始：把反斜杠擦掉，值面就还原成 SQL 写法
        for (let k = Math.max(r.start + 1, win.start); k < Math.min(r.end - 1, limit); k++) {
          if (text[k] === '\\' && (text[k + 1] === "'" || text[k + 1] === '"')) blanks.push([k, k + 1]);
        }
      }
    }
    const surface = blanks.length ? blankRanges(text, blanks) : text;
    // ON CONFLICT DO UPDATE SET：表名从前面最近的 INSERT INTO 解析（大小写都认）
    const upsert = /\bdo\s+$/i.test(text.slice(Math.max(0, at - 12), at));
    let table;
    if (upsert) {
      let ins = -1;
      const irx = /\binsert\s+into\b/gi;
      let im;
      while ((im = irx.exec(surface)) && im.index < at) ins = im.index + im[0].length;
      table = ins < 0 ? { raw: '', kind: 'missing', end: at } : readTable(surface, ins, at);
      // `DO UPDATE SET` 里 UPDATE 与 SET 之间没有列清单，解析位点直接落到 UPDATE 之后
      if (table.kind !== 'missing') { table.end = at + m[0].length; table.upsertResolved = true; }
    } else {
      table = readTable(surface, m.index + m[0].length, limit);
    }
    if (table.kind === 'missing') { discarded.push({ at, why: 'no-table' }); continue; }
    const aliasEnd = skipTableAlias(surface, table.end, limit);
    const afterTable = skipWs(surface, aliasEnd, limit);
    if (!/^set\b/i.test(surface.slice(afterTable, afterTable + 8))) { discarded.push({ at, why: 'no-set' }); continue; }
    const setFrom = skipWs(surface, afterTable + 3, limit);
    const segs = readAssignments(surface, setFrom, limit);
    if (!segs.length) { discarded.push({ at, why: 'empty-set' }); continue; }
    const assigns = segs.map((s) => {
      const sp = splitAssign(s);
      if (!sp) return { col: { name: s, kind: 'unresolved' }, val: { kind: 'empty', text: '' }, raw: s };
      return { col: classifyColumn(sp.left), val: classifyValue(sp.right), raw: s };
    });
    const stateHits = assigns.filter((a) => a.col.kind === 'literal' && (a.col.names || [a.col.name]).some(isStateColumn));
    const opaqueCols = assigns.filter((a) => a.col.kind !== 'literal');
    const writesState = stateHits.length > 0;
    if (!writesState && !opaqueCols.length) {
      // 状态列一个没碰：仍算站点，但按 not-state 记档并逐条打印"为什么被排除"
      sites.push(buildSite(text, at, { grade: 'not-state', table, assigns, stateHits: [], reasons: [], upsert, spans, win, lang: masked.lang, opacity: 0 }));
      continue;
    }
    let opacity = 0;
    const reasons = [];
    if (table.kind !== 'literal') { opacity = Math.max(opacity, 2); reasons.push(`table-${table.kind}`); }
    for (const a of opaqueCols) { opacity = Math.max(opacity, 2); reasons.push(`column-${a.col.kind}`); }
    for (const a of stateHits) {
      const o = OPACITY[a.val.kind] ?? 2;
      if (o > opacity) opacity = o;
      if (o === 2) reasons.push(`value-${a.val.kind}`);
    }
    const grade = GRADE_BY_OPACITY[opacity];
    sites.push(buildSite(text, at, { grade, table, assigns, stateHits, reasons: [...new Set(reasons)], upsert, spans, win, lang: masked.lang, opacity }));
  }
  return { sites, discarded };
}

function lineAt(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === '\n') line++;
  return line;
}

/** 执行通道：紧挨字面量前面的句柄/调用（`sql`…`、`sqlB.unsafe(…)`、迁移文件直读）。 */
function channelOf(text, win, lang) {
  if (lang === 'sql') return 'sql-file';
  if (!win) return 'unknown';
  // 往前跳着被遮罩的空格找真正的悬挂位（注释被擦成空格后，紧邻区可能整段是空白）
  let from = Math.max(0, win.start - 240);
  const head = text.slice(from, win.start).replace(/[\s\u00a0]+/g, ' ').trim().slice(-60);
  let m = /([\w$][\w$.]*)\s*\.\s*(unsafe|query|execute|transaction|begin)\s*\(\s*[\w$]*$/i.exec(head);
  if (m) return `${m[1]}.${m[2]}`;   // 也认 `db.execute(sql\`…\`)`：括号与反引号之间的那个 tag 名不算通道
  m = /([\w$][\w$.]*)\s*$/.exec(head);
  if (m) return `tagged:${m[1]}`;
  return 'unknown';
}

function buildSite(text, at, x) {
  const cols = x.stateHits.flatMap((a) => a.col.names || [a.col.name]);
  const vals = x.stateHits.map((a) => a.val.text).filter(Boolean);
  const inLiteral = x.spans.some((s) => s.start <= at && at < s.end);
  return {
    line: lineAt(text, at),
    grade: x.grade,
    table: x.table.raw,
    tableKind: x.table.kind,
    cols: cols.length ? cols : x.assigns.map((a) => a.col.name).filter(Boolean),
    values: vals,
    reasons: x.reasons,
    upsertArm: x.upsert,
    inSqlLiteral: inLiteral,
    setRaw: x.assigns.map((a) => a.raw).join(' , ').replace(/\s+/g, ' ').slice(0, 120),
    channel: channelOf(text, x.win, x.lang),
  };
}

/* ─────────────────────────── 归属 ─────────────────────────── */

function attributionOf(rel) {
  const p = rel.split(path.sep).join('/');
  if (p === SELF) return 'self';
  if (p.startsWith('db/')) return 'migration-or-verify-sql';
  if (p.startsWith('scripts/')) return 'verifier-script';
  if (p.startsWith('ewoh-spark-app/test/')) return 'test-fixture';
  if (/\.spec\.ts$/.test(p) || /(^|\/)(__tests__|test)\//.test(p)) return 'test-fixture';
  if (p.startsWith('ewoh-spark-app/server/')) return 'product';
  return 'unattributed';
}

/* ─────────────────────────── 语料 ─────────────────────────── */

function walk(abs, rel, acc) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const a = path.join(abs, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(a, r, acc);
    else if (EXT.test(entry.name) && r !== SELF) acc.push(r);
  }
  return acc;
}

/** 扫描面：roots 全部必须存在且非空，否则"输入解析不到"（rc=2），不静默读成 0 处。 */
function collectFiles(roots) {
  const problems = [];
  const files = [];
  for (const r of roots) {
    const abs = path.resolve(ROOT, r);
    if (!fs.existsSync(abs)) { problems.push(`扫描根不存在：${r}`); continue; }
    if (!fs.statSync(abs).isDirectory()) { problems.push(`扫描根不是目录：${r}`); continue; }
    try { walk(abs, r, files); } catch (e) { problems.push(`扫描根读不动：${r}（${e.message}）`); }
  }
  if (!files.length) problems.push('扫描面为空（没有一个 .ts/.tsx/.js/.mjs/.cjs/.sql 文件）');
  return { files: files.sort(), problems };
}

/** 单文件的完整判据：遮罩 → 解析 → 打归属。**自测与真扫描走这同一条路**。 */
function analyzeSource(rel, src) {
  const lang = /\.sql$/.test(rel) ? 'sql' : 'js';
  const masked = lang === 'sql' ? maskSql(src) : maskJs(src, rel);
  masked.text = maskInsideRegions(masked);          // 遮罩与原文等长 ⇒ regions 偏移仍然对得上
  masked.sqlLiterals = sqlLiteralSpans(masked.text, masked.regions);
  const { sites, discarded } = parseUpdates(masked);
  const attr = attributionOf(rel);
  return {
    rel,
    attr,
    sites: sites.map((s) => ({ ...s, file: rel, attr })),
    discarded: discarded.map((s) => ({ file: rel, line: lineAt(masked.text, s.at), why: s.why })),
    candidates: sites.length + discarded.length,
    blanked: masked.blanked.length,
    anomalies: masked.anomalies,
  };
}

/* ─────────────────────────── 恒等式与校准 ─────────────────────────── */

function tally(rows, keys, keyOf) {
  const out = new Map(keys.map((k) => [k, 0]));
  for (const r of rows) { const k = keyOf(r); out.set(k, (out.get(k) || 0) + 1); }
  return out;
}

/** 三条恒等式：不成立就是量具坏了 ⇒ 读数作废（返回问题清单，main 据此 rc=1）。 */
function checkIdentities(sites, discarded, candidates) {
  const problems = [];
  const g = tally(sites, GRADES, (s) => s.grade);
  const a = tally(sites, [...ATTRS, 'self'], (s) => s.attr);
  const sumG = GRADES.reduce((n, k) => n + (g.get(k) || 0), 0);
  const sumA = [...ATTRS, 'self'].reduce((n, k) => n + (a.get(k) || 0), 0);
  if (sumG !== sites.length) problems.push(`Σ四档 ${sumG} ≠ 站点数 ${sites.length}（有档位被合并或漏计 ⇒ 读数作废）`);
  if (sumA !== sites.length) problems.push(`Σ归属 ${sumA} ≠ 站点数 ${sites.length}（归属面没闭合 ⇒ 读数作废）`);
  if (sites.length + discarded.length !== candidates) problems.push(`站点 ${sites.length} + 弃档 ${discarded.length} ≠ update 候选 ${candidates}（有候选没交代去向）`);
  if (a.get('self')) problems.push(`本件自己进了扫描面（${a.get('self')} 处）——自测夹具会污染分母`);
  return { problems, grades: g, attrs: a };
}

function checkCalibration(sites, known) {
  const bad = [];
  for (const c of known) {
    const hit = sites.find((s) => s.file === c.file && s.grade === c.grade
      && (!c.table || s.table === c.table)
      && (!c.col || s.cols.includes(c.col) || s.cols.length === 0 || s.grade === 'dynamic')
      && (!c.value || s.values.includes(c.value)));
    if (!hit) bad.push(`校准落空：${c.file} 应有 grade=${c.grade}${c.table ? ` 表 ${c.table}` : ''}${c.value ? ` 值 ${c.value}` : ''}`);
    else c._found = hit;
  }
  return bad;
}

/* ─────────────────────────── 读数 ─────────────────────────── */

function report(res, meta) {
  const { sites, discarded, candidates } = res;
  const g = tally(sites, GRADES, (s) => s.grade);
  const a = tally(sites, [...ATTRS, 'self'], (s) => s.attr);
  const stateSites = sites.filter((s) => s.grade !== 'not-state');
  console.log(`[raw-status-writes] 扫描面 ${meta.files} 个文件｜roots=${meta.roots.join(',')}`);
  console.log(`  分母：update 候选词 ${candidates} 处 ⇒ 站点 ${sites.length} 处（每个带 SET 的裸 SQL UPDATE 一句一点）＋ 弃档 ${discarded.length} 处`);
  console.log(`  Σ四档 ${GRADES.map((k) => `${k}=${g.get(k) || 0}`).join(' ')} 合计 ${GRADES.reduce((n, k) => n + (g.get(k) || 0), 0)}｜站点数 ${sites.length}`);
  console.log(`  状态写者（literal+parameter+dynamic）= ${stateSites.length} 处｜not-state ${g.get('not-state') || 0} 处**不计入状态写者**`);
  console.log(`  Σ归属 ${[...ATTRS, 'self'].map((k) => `${k}=${a.get(k) || 0}`).join(' ')} 合计 ${[...ATTRS, 'self'].reduce((n, k) => n + (a.get(k) || 0), 0)}`);
  console.log('\n  按归属 × 档位：');
  for (const at of ATTRS) {
    const mine = sites.filter((s) => s.attr === at);
    if (!mine.length) { console.log(`    ${at.padEnd(24)} 0 处`); continue; }
    const gg = tally(mine, GRADES, (s) => s.grade);
    console.log(`    ${at.padEnd(24)} ${String(mine.length).padStart(3)} 处 ⇒ ` + GRADES.map((k) => `${k}=${gg.get(k) || 0}`).join(' '));
  }
  const reasonTally = new Map();
  for (const s of sites.filter((x) => x.grade === 'dynamic')) for (const r of s.reasons) reasonTally.set(r, (reasonTally.get(r) || 0) + 1);
  console.log(`\n  dynamic（本件解不开）的原因分布：${[...reasonTally].map(([k, v]) => `${k}=${v}`).join(' ') || '（无）'}`);
  console.log('  ⇒ dynamic 档是**看不见**，不是合规：把这些计入之前，"该列每个写者都带来源态守卫"这句话不可证。');

  console.log(`\n—— 状态写者 ${stateSites.length} 处（逐条）`);
  for (const s of stateSites.slice().sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)) {
    console.log(`  ${s.file}:${s.line} grade=${s.grade} table=${s.table || '（解不开）'} cols=${s.cols.join('+') || '（解不开）'}`
      + ` value=${s.values.length ? s.values.map((v) => `'${v}'`).join(',') : s.reasons.includes('column-interp') ? '（列名解不开）' : 'unknown'}`
      + ` attr=${s.attr} via=${s.channel}${s.upsertArm ? ' upsert-arm' : ''}${s.inSqlLiteral ? ' in-sql-literal' : ''}${s.reasons.length ? ` reason=${s.reasons.join('|')}` : ''}`);
  }
  const notState = sites.filter((s) => s.grade === 'not-state');
  console.log(`\n—— not-state ${notState.length} 处：改了非状态列，**已从状态写者分母剔除**，逐条列出以便复核排除理由`);
  for (const s of notState.slice().sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)) {
    console.log(`  ${s.file}:${s.line} table=${s.table || '（解不开）'} 改的列=${(s.cols || []).join(', ') || s.setRaw}${s.upsertArm ? ' upsert-arm' : ''}`);
  }
  const byWhy = new Map();
  for (const d of discarded) byWhy.set(d.why, (byWhy.get(d.why) || 0) + 1);
  console.log(`\n—— 弃档 ${discarded.length} 处（不是写入站点，逐原因计数；明细取前 12）`);
  console.log(`  ${[...byWhy].map(([k, v]) => `${k}=${v}`).join(' ') || '（无）'}`);
  for (const d of discarded.slice(0, 12)) console.log(`  · ${d.file}:${d.line} ${d.why}`);
  if (discarded.length > 12) console.log(`  · …另 ${discarded.length - 12} 处`);
  console.log(`\n  遮掉的注释块 ${meta.blanked} 处（注释不是写入；含字符串内部的 SQL 注释）`);
  const literalFlag = stateSites.filter((s) => s.inSqlLiteral);
  if (literalFlag.length) console.log(`  ⚠ ${literalFlag.length} 处的 UPDATE 关键词落在引号串内部（可能是某条 SQL 的字符串值，而非写入）：${literalFlag.map((s) => `${s.file}:${s.line}`).join(' ')}`);
  if (meta.anomalies.length) console.log(`  ⚠ 遮罩器在 ${meta.anomalies.length} 个文件上判定语料畸形：${meta.anomalies.slice(0, 5).join(' | ')}`);
  console.log('\n  限度：文本判据＋注释遮罩，不是 SQL 解析器；只数位点存在，不判有没有守卫；dynamic 档＝本件看不见。');
}

/* ─────────────────────────── 判据自测（全内存，零写盘） ─────────────────────────── */

const FIXTURES = [
  // ① 必须开火：真语料的跨行形状（execution-receipt-closed-loop.mjs:437 原文）
  ['ewoh-spark-app/test/e2e/probe-multiline.mjs', `
async function pre(sql, id) {
  await sql\`update ewoh_scheduling_execution
     set status = 'STARTED', actual_end_at = null, actual_start_at = now()
     where assignment_id = \${id}\`;
}
`],
  // ② 必须开火：.sql 迁移里的大写 UPDATE … SET，带 ONLY 关键字
  ['db/migrations/probe_only_status.sql', `UPDATE ONLY billing.invoice SET status = 'done', note = 'x' WHERE id = 1;`],
  // ③ 必须不开火：同一句 SQL 出现在 // 注释里
  ['ewoh-spark-app/test/e2e/probe-comment-line.mjs', `
// await sql\`update ewoh_scheduling_execution set status = 'STARTED' where assignment_id = 1\`;
const keep = 1;
`],
  // ③ 必须不开火：块注释（真语料 world-state.service.ts 的 JSDoc 形状）
  ['ewoh-spark-app/server/modules/probe/comment-block.ts', `
/**
 * 对 counter 按天 upsert（ON CONFLICT (day) DO UPDATE SET last_seq = last_seq + 1）
 * 保证版本互异。
 */
const a = 1;
`],
  // ③ 必须不开火：markdown 式文档块里的 SQL 代码围栏
  ['ewoh-spark-app/server/modules/probe/doc.ts', `
/*
 * ## 用法
 * \`\`\`sql
 * UPDATE ewoh_control_command SET status = 'sent' WHERE id = 1;
 * \`\`\`
 */
export const x = 1;
`],
  // ③ 必须不开火：.sql 文件里 -- 与 /* */ 注释掉的写入
  ['db/verify/probe_commented.verify.sql', `-- UPDATE ewoh_event SET status = 'expired' WHERE 1=1;
/* UPDATE ewoh_event SET active = false WHERE 1=1; */
SELECT 1;`],
  // ③ 必须不开火：SQL 模板内部的 -- 行注释
  ['ewoh-spark-app/test/e2e/probe-inline-sql-comment.mjs', `await owner\`
  -- update ewoh_control_command set status = 'sent' where id = 1
  select 1
\`;`],
  // ④ 必须落 not-state：person_id 形状（真语料 445 行原文）
  ['ewoh-spark-app/test/e2e/probe-person-id.mjs', `await sql\`update ewoh_scheduling_plan_assignment
   set person_id = \${boundPerson}::uuid
   where assignment_id = \${ownCandidate.assignmentId}\`;`],
  // ⑤ 必须判 dynamic：表名与列名都是被插入的标识符（verify-scheduler-multitenant.mjs:287 原文）
  ['scripts/probe-scheduler-dynamic.mjs', `const upd = await sqlB.unsafe(
  \`update \${SCHEMA}.\${c.table} set \${c.setCol} = $1 where \${c.keyCol} = $2 returning id\`,
  [c.setVal, c.key],
);`],
  // ⑥ 必须不开火：SELECT 里出现 status
  ['ewoh-spark-app/test/e2e/probe-select.mjs', `const rows = await sql\`select id, status from ewoh_agent_task where status = 'pending'\`;`],
  // ⑦ 必须不开火：文案里的 "UPDATE ewoh_agent_task"（没有 SET，属弃档）
  ['scripts/prose-mention.mjs', "throw new Error(`应用侧被行锁阻塞的 UPDATE ewoh_agent_task`);"],
  // ⑦ 必须不开火：drizzle 形状（`.update(`）——归 AST 尺子，本件按弃档交代
  ['ewoh-spark-app/server/modules/probe/drizzle.ts', `await db.update(ewohControlCommand).set({ status: 'sent' }).where(eq(id, 1));`],
  // ⑧ 必须开火：跨变量拼接的 SQL 字符串（'a' + 'b'）
  ['scripts/probe-concat.mjs', `await client.unsafe('update public.ewoh_event set ' + 'status = $1 where id = $2', [s, id]);`],
  // ⑨ 必须开火并标 upsert-arm：ON CONFLICT DO UPDATE SET 写状态列
  ['ewoh-spark-app/server/modules/probe/upsert.ts', `await db.execute(sql\`
  INSERT INTO ewoh_agent_approval (id, state) VALUES (1, 'pending')
  ON CONFLICT (id) DO UPDATE SET state = 'approved'
\`);`],
  // ⑩ 值是被插入的绑定 ⇒ parameter（列与表都可解析）
  ['ewoh-spark-app/test/e2e/probe-bind.mjs', `await sql\`update ewoh_outbox set status = \${next} where id = 1\`;`],
  // ⑪ 值是表达式 ⇒ 看不见（dynamic/value-unresolved），不许折成合规
  ['ewoh-spark-app/server/modules/probe/expr.ts', `await db.unsafe(\`update ewoh_control_request set status = excluded.status where id = 1\`);`],
  // ⑫ 多列写法 SET (a,b) = (…)：状态列在里面 ⇒ 必须是站点
  ['db/migrations/probe_multicol.sql', `UPDATE billing.t SET (status, note) = (SELECT 'ok', 'x') WHERE id = 1;`],
  // ⑬ 归属：产品码面
  ['ewoh-spark-app/server/modules/x/y.ts', `await this.ownerClient.unsafe(\`UPDATE ewoh_event\n SET status = 'expired', _updated_at = now()\n WHERE id = ANY($1)\`, [ids]);`],
  // ⑬ 归属：常驻用例面（*.spec.ts 即使在 server/ 下也不算 product）
  ['ewoh-spark-app/server/modules/x/__tests__/y.spec.ts', `await owner\`update ewoh_event set status = 'resolved' where id = 1\`;`],
  // ⑬ 归属：四条规则都不认识的路径 ⇒ 必须落 unattributed，不硬塞进四桶
  ['somewhere/else/probe.mjs', `await sql\`update ewoh_replan_trigger set status = 'pending' where k = 1\`;`],
  // ⑭ 表别名：真语料两处漏计的形状（standalone_105:12 与 db/runner/reset-scenario-data.js:460）
  ['db/migrations/probe_table_alias.sql', `UPDATE __EWOH_SCHEMA__.ewoh_agent_manifest AS manifest
   SET status = 'suspended',
       _updated_at = CURRENT_TIMESTAMP
 WHERE manifest.autonomous_level = 'L3';`],
  ['db/runner/probe_table_alias.js', `await sql.unsafe(
  \`UPDATE \${schema}.ewoh_resource_reservation r
 SET status = 'released', _updated_at = CURRENT_TIMESTAMP
 WHERE r.org_id = $1 AND r.status IN ('reserved', 'active')\`, [org]);`],
  // ⑭ 反向对照：吃掉别名不能把文案变成写入（真语料 file.service.ts:124 的报错文案）
  ['ewoh-spark-app/server/modules/probe/alias-prose.ts', `throw new ForbiddenException('Only an administrator may update scan status');`],
];

/**
 * 判据先写死再读码：每个夹具**声明**它该落哪一档（`none` = 不该开火，可带要求的弃档原因）。
 * 档位分布的期望值由这张声明表算出来，不由判据的读数反推——把任何一档并掉、
 * 或让某个夹具悄悄不再开火，都会在"声明分布 vs 实测分布"上撞红。
 */
const WANT = {
  'ewoh-spark-app/test/e2e/probe-multiline.mjs': 'literal',
  'db/migrations/probe_only_status.sql': 'literal',
  'ewoh-spark-app/test/e2e/probe-comment-line.mjs': 'none',
  'ewoh-spark-app/server/modules/probe/comment-block.ts': 'none',
  'ewoh-spark-app/server/modules/probe/doc.ts': 'none',
  'db/verify/probe_commented.verify.sql': 'none',
  'ewoh-spark-app/test/e2e/probe-inline-sql-comment.mjs': 'none',
  'ewoh-spark-app/test/e2e/probe-person-id.mjs': 'not-state',
  'scripts/probe-scheduler-dynamic.mjs': 'dynamic',
  'ewoh-spark-app/test/e2e/probe-select.mjs': 'none',
  'scripts/prose-mention.mjs': 'none:no-set',
  'ewoh-spark-app/server/modules/probe/drizzle.ts': 'none:drizzle-call',
  'scripts/probe-concat.mjs': 'parameter',
  'ewoh-spark-app/server/modules/probe/upsert.ts': 'literal',
  'ewoh-spark-app/test/e2e/probe-bind.mjs': 'parameter',
  'ewoh-spark-app/server/modules/probe/expr.ts': 'dynamic',
  'db/migrations/probe_multicol.sql': 'dynamic',
  'ewoh-spark-app/server/modules/x/y.ts': 'literal',
  'ewoh-spark-app/server/modules/x/__tests__/y.spec.ts': 'literal',
  'somewhere/else/probe.mjs': 'literal',
  'db/migrations/probe_table_alias.sql': 'literal',
  'db/runner/probe_table_alias.js': 'dynamic',
  'ewoh-spark-app/server/modules/probe/alias-prose.ts': 'none',
};

function selfTest() {
  const cases = [];
  const bad = [];
  const add = (name, ok, detail = '') => { cases.push({ name, ok: !!ok, detail }); if (!ok) bad.push(`${name} → ${detail}`); };
  const per = new Map();
  const runs = [];
  for (const [rel, src] of FIXTURES) { const r = analyzeSource(rel, src); per.set(rel, r); runs.push(r); }
  const S = (rel) => (per.get(rel) || { sites: [] }).sites;
  const st = (rel) => S(rel).filter((x) => x.grade !== 'not-state');

  // 0) 声明表与夹具清单必须一一对应（漏挂声明 = 有一支夹具没人判它的极性）
  add('夹具与声明表一一对应（每支都写死了该开火还是该哑火）',
    FIXTURES.length === Object.keys(WANT).length && FIXTURES.every(([rel]) => rel in WANT),
    `夹具 ${FIXTURES.length} 支／声明 ${Object.keys(WANT).length} 条，缺：${FIXTURES.map(([r]) => r).filter((r) => !(r in WANT)).join(',') || '（无）'}`);
  // 1) 跨行 sql 模板必须开火，且定档 literal、值 STARTED、归属 test-fixture
  const ml = st('ewoh-spark-app/test/e2e/probe-multiline.mjs');
  add('正例 A：跨行 sql 模板 `set status = 字面量` 必须开火并判 literal',
    ml.length === 1 && ml[0].grade === 'literal' && ml[0].values.includes('STARTED') && ml[0].attr === 'test-fixture',
    JSON.stringify(ml.map((x) => [x.grade, x.values, x.attr])));
  add('正例 A 的行号落在 `update` 关键词那一行', ml.length === 1 && ml[0].line === 3, `line=${ml[0] && ml[0].line}`);
  // 2) .sql 的 UPDATE … SET（含 ONLY）
  const sx = st('db/migrations/probe_only_status.sql');
  add('正例 B：.sql 文件大写 UPDATE…SET 字面量必须开火并判 migration-or-verify-sql',
    sx.length === 1 && sx[0].grade === 'literal' && sx[0].attr === 'migration-or-verify-sql' && sx[0].values.includes('done'),
    JSON.stringify(sx.map((x) => [x.grade, x.values, x.attr])));
  // 3) 注释不是写入
  for (const rel of Object.keys(WANT).filter((k) => WANT[k] === 'none')) {
    add(`反例：注释/markdown/文案里的同一句 SQL 不得开火（${rel}）`,
      S(rel).length === 0 && per.get(rel).discarded.length >= 0,
      `站点数=${S(rel).length}`);
  }
  // 4) not-state 单独一档：不计入状态写者，但必须留痕
  const pid = S('ewoh-spark-app/test/e2e/probe-person-id.mjs');
  add('反例：只改 person_id ⇒ 判 not-state、不计入状态写者、但逐条留痕',
    pid.length === 1 && pid[0].grade === 'not-state' && pid[0].cols.includes('person_id'),
    JSON.stringify(pid.map((x) => [x.grade, x.cols])));
  // 5) 解不开 ⇒ dynamic，且不许被折进"零位点"
  const dyn = st('scripts/probe-scheduler-dynamic.mjs');
  add('正例 C：`${SCHEMA}.${c.table}` + `${c.setCol}` 必须判 dynamic（看不见＝单列一档）',
    dyn.length === 1 && dyn[0].grade === 'dynamic' && dyn[0].reasons.includes('column-interp') && dyn[0].attr === 'verifier-script',
    JSON.stringify(dyn.map((x) => [x.grade, x.reasons, x.attr])));
  add('正向对照：把被插入的列名换成字面列名，同一判据必须翻成 parameter（证明 dynamic 不是常量档）',
    (() => {
      const swap = analyzeSource('scripts/probe-swap.mjs', 'const u = await sqlB.unsafe(`update t set status = $1 where id = $2`, [v, k]);');
      return swap.sites.length === 1 && swap.sites[0].grade === 'parameter';
    })(), '换字面列名后应判 parameter');
  // 6) SELECT 里的 status 不算
  add('反例：SELECT 里出现 status 不得开火', S('ewoh-spark-app/test/e2e/probe-select.mjs').length === 0, `站点 ${S('ewoh-spark-app/test/e2e/probe-select.mjs').length}`);
  // 7) 文案与 drizzle 形状按弃档交代，不进站点
  for (const rel of Object.keys(WANT).filter((k) => WANT[k].startsWith('none:'))) {
    const why = WANT[rel].split(':')[1];
    const r = per.get(rel);
    add(`反例：${rel} 不开火，且必须按弃档原因 ${why} 交代（不静默消失）`,
      r.sites.length === 0 && r.discarded.some((d) => d.why === why),
      `弃档=${r.discarded.map((d) => d.why).join(',') || '（无）'}`);
  }
  // 8) 拼接字符串
  const cc = st('scripts/probe-concat.mjs');
  add('正例 D：`\'…set \' + \'status = $1\'` 跨拼接的 SQL 必须开火并判 parameter',
    cc.length === 1 && cc[0].grade === 'parameter', JSON.stringify(cc.map((x) => [x.grade, x.table])));
  // 9) upsert 支臂
  const up = st('ewoh-spark-app/server/modules/probe/upsert.ts');
  add('正例 E：ON CONFLICT DO UPDATE SET 写状态列必须开火并标 upsert-arm（表名回溯到 INSERT INTO）',
    up.length === 1 && up[0].upsertArm === true && up[0].table === 'ewoh_agent_approval' && up[0].grade === 'literal' && up[0].cols.includes('state'),
    JSON.stringify(up.map((x) => [x.grade, x.table, x.upsertArm])));
  // 10) 值绑定 / 值表达式
  const bm = st('ewoh-spark-app/test/e2e/probe-bind.mjs');
  add('正例 F：`set status = ${next}` 值位的绑定判 parameter', bm.length === 1 && bm[0].grade === 'parameter',
    JSON.stringify(bm.map((x) => x.grade)));
  const ex = st('ewoh-spark-app/server/modules/probe/expr.ts');
  add('正例 G：`set status = excluded.status` 值求不出来 ⇒ 判 dynamic/value-unknown，不许折成合规',
    ex.length === 1 && ex[0].grade === 'dynamic' && ex[0].reasons.includes('value-unknown'),
    JSON.stringify(ex.map((x) => [x.grade, x.reasons])));
  // 11) 多列 SET
  const mc = st('db/migrations/probe_multicol.sql');
  add('正例 H：`SET (status, note) = (SELECT …)` 里的状态列必须算站点（不因写法漏计）',
    mc.length === 1 && mc[0].cols.includes('status') && mc[0].grade === 'dynamic',
    JSON.stringify(mc.map((x) => [x.grade, x.cols])));
  // 12) 归属两根轴
  add('归属：server/ 非 spec ⇒ product', S('ewoh-spark-app/server/modules/x/y.ts')[0]?.attr === 'product',
    `attr=${S('ewoh-spark-app/server/modules/x/y.ts')[0]?.attr}`);
  add('归属：server 下 __tests__/*.spec.ts ⇒ test-fixture（不算 product）',
    S('ewoh-spark-app/server/modules/x/__tests__/y.spec.ts')[0]?.attr === 'test-fixture',
    `attr=${S('ewoh-spark-app/server/modules/x/__tests__/y.spec.ts')[0]?.attr}`);
  add('归属：四条规则都不认识的路径 ⇒ 落 unattributed 兜底，不硬塞进四桶',
    S('somewhere/else/probe.mjs')[0]?.attr === 'unattributed',
    `attr=${S('somewhere/else/probe.mjs')[0]?.attr}`);
  // 12b) 表别名：`AS manifest` / `r` 都不得挡住 SET（本轮独立复核抓出的两处漏计）
  const al = st('db/migrations/probe_table_alias.sql');
  add('正例 I：`UPDATE 表 AS 别名 SET status = 字面量` 必须开火（别名挡住 SET 就是漏计）',
    al.length === 1 && al[0].grade === 'literal' && al[0].cols.includes('status') && al[0].values.includes('suspended'),
    JSON.stringify(al.map((x) => [x.grade, x.table, x.values])));
  const al2 = st('db/runner/probe_table_alias.js');
  add('正例 J：`UPDATE ${schema}.表 别名 SET status = …` 必须开火并判 dynamic（别名＋表名解不开）',
    al2.length === 1 && al2[0].grade === 'dynamic' && al2[0].cols.includes('status') && al2[0].reasons.includes('table-interp'),
    JSON.stringify(al2.map((x) => [x.grade, x.table, x.reasons])));
  add('反例：报错文案 "may update scan status" 不得被别名规则读成写入',
    per.get('ewoh-spark-app/server/modules/probe/alias-prose.ts').sites.length === 0,
    `站点 ${per.get('ewoh-spark-app/server/modules/probe/alias-prose.ts').sites.length}`);
  // 12c) 执行通道：读数必须说得出"这条裸 SQL 由哪个句柄执行"，且注释被遮掉后仍认得出
  const chan = (rel) => (per.get(rel).sites[0] || {}).channel;
  add('通道识别：`sql`模板 / x.unsafe(…) / x.execute(…) 三种悬挂位都要认得出',
    chan('ewoh-spark-app/test/e2e/probe-multiline.mjs') === 'tagged:sql'
      && chan('scripts/probe-scheduler-dynamic.mjs') === 'sqlB.unsafe'
      && chan('ewoh-spark-app/server/modules/probe/upsert.ts') === 'db.execute',
    [chan('ewoh-spark-app/test/e2e/probe-multiline.mjs'), chan('scripts/probe-scheduler-dynamic.mjs'), chan('ewoh-spark-app/server/modules/probe/upsert.ts')].join(' / '));
  add('通道识别：迁移与 verify 的 .sql 文件标 sql-file',
    chan('db/migrations/probe_only_status.sql') === 'sql-file' && chan('db/migrations/probe_table_alias.sql') === 'sql-file',
    `${chan('db/migrations/probe_only_status.sql')} / ${chan('db/migrations/probe_table_alias.sql')}`);
  // 13) 恒等式在合成语料上闭合
  const allSites = runs.flatMap((r) => r.sites);
  const allDisc = runs.flatMap((r) => r.discarded);
  const cand = runs.reduce((n, r) => n + r.candidates, 0);
  const idc = checkIdentities(allSites, allDisc, cand);
  add(`对账：Σ四档==站点数、Σ归属==站点数、站点+弃档==候选（合成语料站点 ${allSites.length}／弃档 ${allDisc.length}／候选 ${cand}）`,
    idc.problems.length === 0, idc.problems.join(' '));
  // 13b) 声明分布 vs 实测分布（四档永不合并的机械证明）
  const declared = new Map(GRADES.map((g) => [g, 0]));
  for (const w of Object.values(WANT)) if (!String(w).startsWith('none')) declared.set(w, declared.get(w) + 1);
  const got = idc.grades;
  add(`档位分布必须等于声明表（声明 ${GRADES.map((g) => `${g}=${declared.get(g)}`).join(' ')}）⇒ 四档各自非零、无一被并`,
    GRADES.every((g) => (declared.get(g) || 0) === (got.get(g) || 0)) && GRADES.every((g) => declared.get(g) > 0),
    `实测 ${GRADES.map((g) => `${g}=${got.get(g) || 0}`).join(' ')}`);
  // 14) 闸门本身会翻红（拿真函数喂假分母，两条恒等式各注入一次）
  add('反证：候选 +1 必须判"读数作废"（恒等式③不是装饰）',
    checkIdentities(allSites, allDisc, cand + 1).problems.length > 0, '闸门没翻红');
  add('反证：任一档位的名字被改写（＝把某档并进别处）必须被 Σ四档 抓到',
    checkIdentities(allSites.map((s, i) => (i ? s : { ...s, grade: 'collapsed-into-something' })), allDisc, allSites.length + allDisc.length).problems.length > 0,
    'Σ四档闸门没翻红');
  add('反证：归属出现认不出的值必须被 Σ归属 抓到',
    checkIdentities(allSites.map((s, i) => (i ? s : { ...s, attr: 'who-knows' })), allDisc, allSites.length + allDisc.length).problems.some((p) => p.includes('Σ归属')),
    'Σ归属闸门没翻红');
  // 15) 遮罩器自己的字面量区必须闭合到位（本轮实测栽过一次：区的 end 写到了栈帧上、
  //     区对象一直是 -1 ⇒ 所有窗口被撑到 EOF，站点照样出、档位照样看着合理，但读数是假的）
  const regProbe = maskJs(`const a = 'update t set x = 1';\nconst b = 'status = 2';\nconst c = \`update u set y = 3\`;\n`);
  add('遮罩器：每个字面量区的 end 必须落在自己的收尾定界符之后（不是 EOF）',
    regProbe.regions.length === 3 && regProbe.regions.every((r) => r.end < regProbe.text.length - 1)
      && regProbe.regions.every((r) => /['`]/.test(regProbe.text[r.end - 1])),
    JSON.stringify(regProbe.regions.map((r) => [r.start, r.end])));
  // 16) 本件自身不进扫描面
  const cb = collectFiles(['scripts/chain-baseline']);
  add('反自污染：本脚本自身不得进扫描面（否则自测夹具里的 SQL 原文会喂给自己）',
    cb.files.length > 0 && !cb.files.includes(SELF),
    `scripts/chain-baseline 下 ${cb.files.length} 个文件，含 SELF=${cb.files.includes(SELF)}`);
  // 16) 退出码三态：畸形输入与缺失语料都必须判 2，不是静默 0
  //     子进程带 RSW_NESTED=1：它自己不再往下派生（否则自测会递归），只把"退出码本身"交给外层判。
  const nested = process.env.RSW_NESTED === '1';
  const rc = (argv) => nested ? null
    : spawnSync(process.execPath, [__filename, ...argv], { encoding: 'utf8', env: { ...process.env, RSW_NESTED: '1' } }).status;
  if (!nested) {
    const rcMissing = rc(['--roots', 'scripts/chain-baseline/__no_such_root__']);
    add('能变红：--roots 指向不存在的目录 ⇒ 退出码 2（输入解析不到），不是 0', rcMissing === 2, `实得 rc=${rcMissing}`);
    const rcGarbled = rc(['--garbled-probe']);
    add('能变红：--garbled-probe（内存里造的畸形语料，块注释/模板不收尾）⇒ 退出码 2', rcGarbled === 2, `实得 rc=${rcGarbled}`);
    const rcGreen = rc(['--self-test-rc']);
    const rcRed = rc(['--self-test-rc', '--force-red']);
    add('能变红：自测体内注入一条失败必须映射成退出码 1（0/1 两态都实测）', rcGreen === 0 && rcRed === 1,
      `rc(自测)=${rcGreen} rc(注入红)=${rcRed}`);
  }
  // 17) 校准：两处已知答案必须能在真语料上抽到（不在这里断言读数，只断言判据认得它们）
  const realRes = scanAll(DEFAULT_ROOTS);
  if (realRes.problems.length) {
    add('校准前提：真语料解析得到（否则本件无法自证认得两处已知答案）', false, realRes.problems.join(' '));
  } else {
    const cal = checkCalibration(realRes.sites, CALIBRATION);
    add('校准：本会话手工核实的两处裸 SQL 位点必须被抽到（execution-receipt…:literal / verify-scheduler-multitenant…:dynamic）',
      cal.length === 0, cal.join(' | '));
  }
  return { cases, bad };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

function scanAll(roots) {
  const { files, problems } = collectFiles(roots);
  const sites = [];
  const discarded = [];
  let candidates = 0;
  let blanked = 0;
  const anomalies = [];
  for (const rel of files) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { problems.push(`读不到文件：${rel}（${e.message}）`); continue; }
    if (!/\bupdate\b/i.test(src)) continue;
    const r = analyzeSource(rel, src);
    sites.push(...r.sites);
    discarded.push(...r.discarded);
    candidates += r.candidates;
    blanked += r.blanked;
    for (const a of r.anomalies) anomalies.push(`${rel}：${a}`);
  }
  return { files, sites, discarded, candidates, blanked, anomalies, problems };
}

/** 畸形输入档：把内存里造的一份坏语料喂给同一条判据，返回它的 anomaly 清单。 */
function garbledCorpus() {
  const bad = [
    ['scripts/garbled-a.mjs', '/* update ewoh_event set status = \'X\' where id = 1\n（块注释在这里就没关）\n'],
    ['scripts/garbled-b.mjs', 'const s = `update ewoh_event set status = \'X\' where id = 1\n（模板没反引号收尾）\n'],
  ];
  const anomalies = [];
  for (const [rel, src] of bad) for (const a of analyzeSource(rel, src).anomalies) anomalies.push(`${rel}：${a}`);
  return anomalies;
}

function main(argv) {
  const args = argv.map(String);
  // --self-test-rc 是给"退出码本身"用的探针档：只跑自测并把失败映射成 rc=1（不打印计数细节）
  if (args.includes('--self-test-rc')) {
    const { cases, bad } = selfTest();
    if (args.includes('--force-red')) { cases.push({ name: '注入红', ok: false }); bad.push('注入红'); }
    process.exit(bad.length ? 1 : 0);
  }
  if (args.includes('--self-test')) {
    const { cases, bad } = selfTest();
    for (const c of cases) console.log(`${c.ok ? '✔' : '✗'} ${c.name}${c.ok ? '' : ` → ${c.detail}`}`);
    console.log(`[raw-status-writes] 判据自测 ${cases.length - bad.length}/${cases.length} 通过（条数由本脚本现算，Makefile 不冻结它）`);
    if (bad.length) console.log(`  ✗ 未通过：${bad.join(' ｜ ')}`);
    process.exit(bad.length ? 1 : 0);
  }
  if (args.includes('--garbled-probe')) {
    const a = garbledCorpus();
    console.log(`[raw-status-writes] 畸形语料探针：遮罩器判到 ${a.length} 处畸形 ⇒ ${a.join(' | ')}`);
    if (!a.length) { console.error('判据自测失败：畸形输入被判成"可读"（会伪装成零站点）'); process.exit(1); }
    process.exit(2);
  }
  const roots = args.includes('--roots') ? args[args.indexOf('--roots') + 1].split(',').filter(Boolean) : DEFAULT_ROOTS;
  const res = scanAll(roots);
  if (res.problems.length || (args.includes('--roots') && !res.files.length)) {
    console.error(`[raw-status-writes] 输入解析不到 ⇒ 读数作废：${res.problems.join(' | ')}`);
    console.error('（"看不见语料"绝不折算成"零处裸 SQL 写入"）');
    process.exit(2);
  }
  if (res.anomalies.length) {
    console.error(`[raw-status-writes] 遮罩器在 ${res.anomalies.length} 个文件上判定语料畸形 ⇒ 读数作废：${res.anomalies.slice(0, 5).join(' | ')}`);
    process.exit(2);
  }
  const { problems, grades, attrs } = checkIdentities(res.sites, res.discarded, res.candidates);
  report(res, { files: res.files.length, roots, blanked: res.blanked, anomalies: res.anomalies });
  const cal = checkCalibration(res.sites, CALIBRATION);
  console.log('\n—— 两处已知答案校准');
  for (const c of CALIBRATION) {
    if (c._found) console.log(`  ✅ ${c.file}:${c._found.line} grade=${c._found.grade} table=${c._found.table} cols=${c._found.cols.join('+')}${c._found.values.length ? ` value=${c._found.values.join(',')}` : ''}`);
    else console.log(`  ✗ ${c.file} 应有 grade=${c.grade} 的位点没抽到`);
  }
  if (problems.length) { problems.forEach((p) => console.error(`  ✗ ${p}`)); console.error('读数作废'); process.exit(1); }
  if (cal.length) { cal.forEach((p) => console.error(`  ✗ ${p}`)); console.error('校准不符 ⇒ 本件判据有问题，本轮不出数'); process.exit(1); }
  console.log('✅ 三条恒等式成立，两处已知答案校准全对');
  // --json 放在最后一块：读数（报告）与机器档分两段，管道里 `tail -1` 起的整段就是合法 JSON
  if (args.includes('--json')) console.log(JSON.stringify({
    generatedBy: SELF, roots, filesScanned: res.files.length,
    denominator: { updateCandidates: res.candidates, sites: res.sites.length, discarded: res.discarded.length },
    grades: Object.fromEntries(grades), attrs: Object.fromEntries(attrs),
    stateWriterSites: res.sites.filter((s) => s.grade !== 'not-state').length,
    sites: res.sites, discarded: res.discarded, blankedComments: res.blanked,
  }, null, 2));
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { analyzeSource, parseUpdates, maskJs, maskSql, attributionOf, checkIdentities, checkCalibration, CALIBRATION, DEFAULT_ROOTS, isStateColumn, scanAll, garbledCorpus, SELF };
