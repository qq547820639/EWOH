#!/usr/bin/env node
/**
 * 事务边界证据的共用作用域判据（V190 起由主线7 使用；V191 抽出供主线14 与其影子量具复用）。
 *
 * 为什么要有这个文件：`audit-scheduler-transactions.js`（主线7）与
 * `audit-public-tx-free-reads.js`（主线14）判的是同一件事——"这段读/写是不是在显式事务里"，
 * 两处各写一份判据就必然漂移（主线14 的头注释已经写着"与 audit-scheduler-transactions 同一口径"）。
 * 零依赖（不引 typescript）：这两个脚本都跑在 CI 的共享门禁面上，吃下 app 的 node_modules
 * 等于把防回归门禁变成装配门禁。
 *
 * API：
 *  - blankNonCode(src)            把注释/字符串/模板文本/正则的内容替换成空格（长度与换行不变）
 *  - defAt(maskedLines, idx)      第 idx 行是否具名定义的开头；返回 {name,start,end,braceLine}|null
 *  - defsOf(maskedLines)          文件内全部具名定义（含嵌套）
 *  - enclosingDef(defs, idx)      包含第 idx 行的**最内层**定义，取不到 ⇒ null
 *  - analyzeFile(rawLines, opts)  → { lines（判据用行）, defs }
 *  - scopeOf(view, idx, opts)     作用域统一入口；opts.region='text' 退回 V190 前的旧口径
 *  - legacyIsMethodDef/legacyMethodRegion/legacyScope  旧口径（两档对照用）
 *
 * 自测：`node scripts/tx-scope-shared.js --self-test`
 */

'use strict';

const CONTROL_FLOW_RE = /^\s*(if|for|while|switch|catch|return|else|try|do|throw)\b/;
const METHOD_DEF_RE = /^\s*(?:private|public|protected|readonly|static|async|override|\s)*[A-Za-z_$][\w$]*\s*(\(|\([^)]*\)\s*(:\s*[\w<>\[\]| .]+)?\s*\{)/;

/** 旧口径（V190 之前主线7/主线14 共用）：只认"顶层缩进"的方法定义行。 */
function legacyIsMethodDef(line) {
  if (CONTROL_FLOW_RE.test(line)) return false;
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
  if (line.match(/^\s*/)[0].length > 2) return false;
  return METHOD_DEF_RE.test(line);
}

/** 旧口径的区域：上一条定义到下一条定义；认不出定义时塌陷到文件头/尾（GATE-16 的 (i)）。 */
function legacyMethodRegion(lines, idx) {
  let start = 0;
  for (let i = idx; i >= 0; i -= 1) {
    if (legacyIsMethodDef(lines[i])) { start = i; break; }
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (legacyIsMethodDef(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function legacyScope(lines, idx) {
  const { start, end } = legacyMethodRegion(lines, idx);
  const m = /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(lines[start]);
  return { name: m ? m[1] : '<unknown>', start, end };
}

/** 主线14 旧口径的"按缩进列方法"清单（区域＝到下一条定义为止，末条到文件尾）。 */
function legacyMethodRegions(lines) {
  const defs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!legacyIsMethodDef(lines[i])) continue;
    const m = lines[i].match(
      /^\s*(?:private|public|protected|readonly|static|async|override|\s)*([A-Za-z_$][\w$]*)\s*(\(|\([^)]*\)\s*(:\s*[\w<>\[\]| .]+)?\s*\{)/,
    );
    const name = m ? m[1] : null;
    if (!name || name === 'constructor') continue;
    defs.push({ name, line: i });
  }
  return defs.map((d, idx) => ({
    name: d.name,
    line: d.line,
    start: d.line,
    end: idx + 1 < defs.length ? defs[idx + 1].line : lines.length,
  }));
}

/** 新口径的"按名取方法区域"清单：花括号配定，末条不再拖到文件尾。 */
function methodRegions(lines, opts = {}) {
  if ((opts.region || 'brace') !== 'brace') return legacyMethodRegions(lines);
  return defsOf(lines).map((d) => ({ name: d.name, line: d.start, start: d.start, end: d.end }));
}

/** 把注释、字符串、模板字面量文本与正则字面量的内容替换成空格（长度与换行位置不变）。 */
function blankNonCode(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (j) => { if (j < n && out[j] !== '\n') out[j] = ' '; };
  /** 模式栈：code 记录当前层花括号深度；tpl 表示处于模板字面量的文本区。 */
  const stack = [{ t: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];
  const REGEX_OK = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  let i = 0;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (top().t === 'tpl') {
      if (c === '`') { stack.pop(); blank(i); i += 1; prev = '`'; continue; }
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '$' && d === '{') { stack.push({ t: 'code', braces: 0 }); blank(i); blank(i + 1); i += 2; prev = '{'; continue; }
      blank(i); i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && d === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      blank(i); i += 1;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') blank(i++); blank(i); i += 1; }
      if (i < n && src[i] === c) blank(i++);
      prev = c; continue;
    }
    if (c === '`') { stack.push({ t: 'tpl' }); blank(i); i += 1; prev = '`'; continue; }
    if (c === '/' && (prev === '' || REGEX_OK.has(prev))) {
      let j = i + 1; let cls = false; let hit = -1;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (cls) { if (src[j] === ']') cls = false; j += 1; continue; }
        if (src[j] === '[') { cls = true; j += 1; continue; }
        if (src[j] === '/') { hit = j; break; }
        j += 1;
      }
      if (hit > i) { for (let k = i; k <= hit; k += 1) blank(k); i = hit + 1; prev = '/'; continue; }
    }
    if (c === '{') top().braces += 1;
    else if (c === '}') {
      if (top().braces > 0) top().braces -= 1;
      else if (stack.length > 1) { stack.pop(); blank(i); }
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

/** 具名定义候选（函数声明 / 类方法 / `const fn = (…) => {`）的名字与签名起点。 */
const DEF_HEADS = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, kind: 'fn' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b|\([^]*\)\s*(?::[^=;{}]{0,120})?=>|[\w$]+\s*=>)/s, kind: 'bind' },
  { re: /^\s*(?:(?:private|public|protected|readonly|static|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:\(|[A-Za-z_$][\w$]*\s*(?::[^={;]+)?=>)/, kind: 'fn' },
];
const NON_DEF_HEAD = /^(?:export\s+)?(?:abstract\s+)?(?:declare\s+)?(?:class|interface|enum|namespace|type|new)\b/;
const DEF_NAME_BLACKLIST = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'try', 'do', 'throw',
  'await', 'yield', 'case', 'default', 'delete', 'typeof', 'instanceof', 'void', 'new',
]);

/**
 * 解析第 idx 行是否是一个**具名定义**的开头，并给出它的花括号块范围。
 * 判据是括号感知的：签名可以跨行（窗口 maxSignatureLines），块起始括号必须在圆/方括号
 * 深度 0 上出现；深度 0 上先遇到 `;` ⇒ 语句或接口声明而非定义；参数表在深度 0 闭合后紧跟
 * `=>` ⇒ 匿名箭头函数，不得当作用域边界（否则外层方法的标记会被切掉，制造假红）。
 * 配不平 ⇒ 返回 null（调用点落到 unscoped，而不是错误的大区域）。
 */
function defAt(maskedLines, idx, maxSignatureLines = 80) {
  const first = maskedLines[idx];
  if (first == null) return null;
  const t = first.trim();
  if (!t || NON_DEF_HEAD.test(t)) return null;
  let name = null; let from = 0;
  for (const head of DEF_HEADS) {
    const m = head.re.exec(first.replace(/\s+$/, ''));
    if (!m) continue;
    name = m[1];
    from = head.kind === 'fn' ? m.index + m[0].length - 1 : m.index + m[0].length;
    break;
  }
  if (!name || DEF_NAME_BLACKLIST.has(name)) return null;
  const defLine = idx;
  let depth = 0; let brace = -1; let braceLine = -1;
  for (let j = idx; j < Math.min(maskedLines.length, idx + maxSignatureLines); j += 1) {
    const line = maskedLines[j];
    for (let k = j === idx ? from : 0; k < line.length; k += 1) {
      const ch = line[k];
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') {
        depth -= 1;
        if (depth <= 0 && /^\s*(?::[^={;]*)?=>/.test(line.slice(k + 1))) return null;
        if (depth < 0) depth = 0;
      } else if (ch === '{' && depth <= 0) { brace = k; braceLine = j; break; }
      else if (ch === ';' && depth <= 0) return null;
    }
    if (brace >= 0) break;
  }
  if (brace < 0) return null;
  let bd = 0; let end = -1;
  for (let j = braceLine; j < maskedLines.length; j += 1) {
    for (const ch of maskedLines[j]) {
      if (ch === '{') bd += 1;
      else if (ch === '}') bd -= 1;
    }
    if (bd <= 0) { end = j + 1; break; }
  }
  if (end === -1) return null;
  return { name, start: defLine, end, braceLine };
}

/** 从第 idx 行向上收集连续装饰器块（跳过空行与注释，遇语句行即停）。 */
function decoratorBlockAbove(lines, idx) {
  const out = [];
  let i = idx - 1;
  let blanks = 0;
  while (i >= 0) {
    const line = lines[i];
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > 3) break;
      i -= 1;
      continue;
    }
    blanks = 0;
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line) || /^\s*@/.test(line)) {
      out.push(line);
      i -= 1;
      continue;
    }
    break;
  }
  return out;
}

/** 文件内全部 `class X {` 块：{name,start,end}（start=定义行，end=闭合集下一行，不含）。 */
function classBlocksOf(maskedLines) {
  const out = [];
  for (let i = 0; i < maskedLines.length; i += 1) {
    const m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(maskedLines[i]);
    if (!m) continue;
    let depth = 0;
    let seen = false;
    let end = -1;
    for (let j = i; j < maskedLines.length; j += 1) {
      for (const ch of maskedLines[j]) {
        if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') depth -= 1;
      }
      if (seen && depth <= 0) { end = j + 1; break; }
    }
    out.push({ name: m[1], start: i, end: end === -1 ? maskedLines.length : end });
  }
  return out;
}

/** 第 idx 行的归属类（多个类时取最内层/最后一个包含它的类）。 */
function owningClass(blocks, idx) {
  let best = null;
  for (const b of blocks) if (idx >= b.start && idx < b.end && (!best || b.start >= best.start)) best = b;
  return best;
}

/** 文件内全部具名定义（含嵌套；调用点取最内层包含它的那一个）。 */
function defsOf(maskedLines) {
  const defs = [];
  for (let i = 0; i < maskedLines.length; i += 1) {
    const d = defAt(maskedLines, i);
    if (d) defs.push(d);
  }
  return defs;
}

function enclosingDef(defs, idx) {
  let best = null;
  for (const d of defs) {
    if (idx >= d.start && idx < d.end && (!best || d.start >= best.start)) best = d;
  }
  return best;
}

/** 单个文件的三态视图：判据用行（按 opts.comments 决定是否屏蔽）、定义清单。 */
function analyzeFile(rawLines, opts = {}) {
  const src = rawLines.join('\n');
  const masked = opts.comments === 'raw' ? src : blankNonCode(src);
  const lines = masked.split('\n');
  return { lines, defs: defsOf(lines) };
}

/** 作用域统一入口：返回 `{ name, start, end }` 或 null（unscoped，fail-closed 用）。 */
function scopeOf(view, idx, opts = {}) {
  if ((opts.region || 'brace') !== 'brace') return legacyScope(view.lines, idx);
  return enclosingDef(view.defs, idx);
}

/**
 * 带"具名回调交给执行器"一条外推规则的作用域判定（V191）。
 *
 * 为什么必须有：`const persist = () => repo.persistPlan(x)` 只有在**名字被交给事务执行器**时
 * 才在事务里。只看最内层定义会把它判成"作用域内无标记"⇒ 假红；而今天语料里那条
 * （`shadow-policy.service.ts:172` 的 `persistAndMarkShadow`）之所以没踩到，仅仅是因为
 * `async (): Promise<void> => {` 的返回类型标注让绑定式定义没被认出来——**依赖的是巧合不是判据**。
 * 规则：最内层定义自己作用域内没有标记时，逐层向外看外层定义的作用域里有没有
 * "事务执行器调用的实参位置上出现本定义名"；有 ⇒ 判为在事务内，并记下是靠具名回调进来的。
 *
 * @returns {{scope:object|null, inTx:boolean, via:'direct'|'named-callback'|'legacy'|null}}
 */
function resolveScope(view, idx, opts = {}) {
  const marker = opts.marker;
  const region = opts.region || 'brace';
  if (region !== 'brace') {
    const legacy = legacyScope(view.lines, idx);
    return { scope: legacy, inTx: marker.test(view.lines.slice(legacy.start, legacy.end).join('\n')), via: 'legacy' };
  }
  const chain = view.defs
    .filter((d) => idx >= d.start && idx < d.end)
    .sort((a, b) => b.start - a.start);
  if (chain.length === 0) return { scope: null, inTx: false, via: null };
  for (let i = 0; i < chain.length; i += 1) {
    const own = chain[i];
    if (i > 0) {
      // 向外层借证据，必须证明"内层这个具名定义是被交给执行器的回调"，否则就是隔壁方法的标记
      // （V190/GATE-16 修的就是这种借法）。
      const child = chain[i - 1];
      if (!passedToExecutor(view.lines, own, child.name, marker)) {
        return { scope: chain[0], inTx: false, via: null };
      }
    }
    if (marker.test(view.lines.slice(own.start, own.end).join('\n'))) {
      return { scope: own, inTx: true, via: i === 0 ? 'direct' : 'named-callback' };
    }
  }
  return { scope: chain[0], inTx: false, via: null };
}

/** 定义名是否出现在**外层定义作用域内**某个事务执行器调用之后、且中间没有语句分隔（文本近似）。 */
function passedToExecutor(lines, outer, name, executorRe) {
  const body = lines.slice(outer.start, outer.end).join('\n');
  // 执行器与名字之间不得跨过语句分隔号（`;`）——跨句借名字与跨句借标记是同一类假证据。
  const callRe = new RegExp(`(?:${executorRe.source})(?:(?!;)[\\s\\S]){0,300}\\b${name}\\b`, 's');
  return callRe.test(body);
}

// require.main 守卫：被门禁 require 时不得跑自测（否则会把调用方的 --self-test 吃掉并 process.exit）
if (require.main === module && process.argv.includes('--self-test')) {
  const cases = [];
  const eq = (label, got, exp) => cases.push({
    label, ok: JSON.stringify(got) === JSON.stringify(exp), detail: `实得 ${JSON.stringify(got)}，期望 ${JSON.stringify(exp)}`,
  });
  const M = (src) => blankNonCode(src).split('\n');
  const TX = /runInTransaction|\.transaction\(|requestDatabaseContextSafe|systemTransaction/;

  eq('模板结束必须弹出文本态（漏弹会吞掉后面整个文件）',
    M('const a = `x ${1000 / 2} y`;\nconst keep = 1;')[1].includes('keep'), true);
  eq('注释里的花括号不参与配平',
    (() => { const d = defAt(M('/** 注释里有 } 和 { */\nfunction f() {\n  return 1;\n}\n'), 1); return d && d.end; })(), 4);
  eq('字符串里未配平的 } 不得提前收口',
    (() => { const d = defAt(M('async function f() {\n  const s = "close } here";\n  return 1;\n}\n'), 0); return d && d.end; })(), 4);
  eq('匿名箭头不得当作用域边界', defAt(M('  async (tx) => {\n    x.persistPlan(p);\n  }\n'), 0), null);
  eq('调用语句（深度 0 先遇 ;）不得当定义', defAt(M('foo(a, {b: 1});\n'), 0), null);
  eq('class/interface 行不得当定义', defAt(M('export class Foo {\n'), 0), null);

  const nested = M('class S {\n  async outer() {\n    const inner = () => {\n      x.read();\n    };\n    return this.db.runInTransaction(inner);\n  }\n}\n');
  eq('调用点取最内层具名定义', enclosingDef(defsOf(nested), 3).name, 'inner');
  eq('具名回调被交给执行器 ⇒ 判在事务内（via=named-callback）',
    resolveScope({ lines: nested, defs: defsOf(nested) }, 3, { marker: TX }).inTx, true);
  eq('  …并记下是靠具名回调进来的',
    resolveScope({ lines: nested, defs: defsOf(nested) }, 3, { marker: TX }).via, 'named-callback');
  const orphan = M('class S {\n  async outer() {\n    const inner = () => {\n      x.read();\n    };\n    return inner();\n  }\n}\n');
  eq('  反向对照：同名回调从未交给执行器 ⇒ 必须判在事务外',
    resolveScope({ lines: orphan, defs: defsOf(orphan) }, 3, { marker: TX }).inTx, false);
  eq('  撤销不开火：执行器换成别的名字 ⇒ 仍判事务外',
    resolveScope({ lines: nested, defs: defsOf(nested) }, 3, { marker: /notTheExecutor/ }).inTx, false);
  const direct = M('class S {\n  async outer() {\n    this.db.runInTransaction(async () => {});\n    return 1;\n  }\n}\n');
  eq('带返回类型标注的箭头仍是具名定义（不靠标注没匹配的巧合）',
    defAt(M('  const f = async (): Promise<void> => {\n    x.read();\n  };\n'), 0).name, 'f');
  const SP = M('class S {\n  async gen() {\n    const cb = async (): Promise<void> => {\n      await this.planService.persistPlan(p);\n    };\n    await this.ctx.runInTransaction(\n      { tag: 1 },\n      cb,\n    );\n    await cb();\n  }\n}\n');
  const spView = { lines: SP, defs: defsOf(SP) };
  eq('真实形状：具名回调交给执行器（跨行实参）⇒ 判事务内',
    resolveScope(spView, 3, { marker: TX }).via, 'named-callback');
  eq('  同一段里"直接调用回调"那条也在同一作用域 ⇒ 同一判据（不再依赖标注巧合）',
    resolveScope(spView, 9, { marker: TX }).inTx, true);
  eq('  撤销不开火：执行器名字换掉 ⇒ 必须判事务外',
    resolveScope(spView, 3, { marker: /notTheExecutor/ }).inTx, false);
  eq('标记就在本作用域内 ⇒ via=direct',
    resolveScope({ lines: direct, defs: defsOf(direct) }, 3, { marker: TX }).via, 'direct');
  eq('顶层取不到定义 ⇒ scope=null（fail-closed 用）',
    resolveScope({ lines: M('x.read();\n'), defs: [] }, 0, { marker: TX }).scope, null);
  eq('旧口径末条区域拖到文件尾（新口径不拖）',
    legacyMethodRegions(M('class S {\n  async a() {\n    return 1;\n  }\n  // 尾部散码\n  const z = 2;\n}\n')).slice(-1)[0].end, 8);
  eq('类块识别含多类文件与装饰器块', (() => {
    const L = M('/** doc */\n@Public()\n@UseGuards(G)\nexport class A {\n  x() {}\n}\n@Controller()\nclass B {\n  y() {}\n}\n');
    const bl = classBlocksOf(L);
    return bl.length === 2 && bl[0].name === 'A' && bl[0].end === 6 && bl[1].start === 7 && bl[1].end === 10
      && decoratorBlockAbove(L, bl[0].start).some((l) => /@Public\(\)/.test(l))
      && !decoratorBlockAbove(L, bl[1].start).some((l) => /@Public\(\)/.test(l));
  })(), true);
  eq('成员归属到**自己那个类**（不是文件里第一个类）', (() => {
    const L = M('@Public()\nclass A {\n  x() {}\n}\nclass B {\n  y() {}\n}\n');
    const bl = classBlocksOf(L);
    return owningClass(bl, 2).name === 'A' && owningClass(bl, 5).name === 'B';
  })(), true);
  eq('新口径按花括号收口（不拖到文件尾）',
    methodRegions(M('class S {\n  async a() {\n    return 1;\n  }\n  // 尾部散码\n  const z = 2;\n}\n')).slice(-1)[0].end, 4);
  eq('passedToExecutor：名字出现在执行器实参位才算',
    passedToExecutor(nested, { start: 1, end: 7 }, 'inner', TX), true);
  eq('  名字只出现在无关调用里不算',
    passedToExecutor(orphan, { start: 1, end: 6 }, 'inner', TX), false);

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.label}${c.ok ? '' : `（${c.detail}）`}`);
  console.log(`[tx-scope-shared] 自测 ${cases.length - bad.length}/${cases.length} 抓到`);
  process.exit(bad.length === 0 ? 0 : 1);
}

module.exports = {
  blankNonCode, defAt, defsOf, enclosingDef, resolveScope, passedToExecutor,
  decoratorBlockAbove, classBlocksOf, owningClass,
  analyzeFile, scopeOf, methodRegions,
  legacyIsMethodDef, legacyMethodRegion, legacyMethodRegions, legacyScope,
};
