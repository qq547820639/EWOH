#!/usr/bin/env node
/**
 * 周期机制 tick 可达性普查（V207 提升进 scripts/）。与 worker-timer-census 的分工：
 * 那件问「clearInterval 写在哪个成员上、成员是否真被框架调用」，本件问「间隔是多少、
 * 常驻面有没有人把它改到能在一个用例时长内跑到第 2 个 tick」——两根不同的轴，读数不合并。
 * 一问：**服务端每个周期机制（setInterval 站点），常驻用例有没有可能观察到它跑到第 2 个 tick？**
 *
 * 为什么只问这一个：V206 手工发现 RECOV-01（巡检 worker 默认 600_000ms，链上负向窗 ≤10s，
 * 全仓没人改过那个 env ⇒ "到点自己巡检"这半行为零常驻覆盖）。那一格是手工读出来的；
 * 本量具把同一问法做成**有分母**的矩阵，免得下一轮再靠运气想起另一个 worker。
 *
 * 两根轴，各判各的，**不得合并成一档**（V207 第一版把两轴塞进一个 bucket，结果"间隔读不出"
 * 把"env 只被 unit spec 用过"这件事一起吞掉——正是要看的形状被遮蔽）：
 *   间隔轴 ms：ok＝解析出毫秒数（字面量／文件常量／env 缺省侧／一跳 helper 的 return 或参数默认值）
 *              X＝解析不出（运行时才知道）⇒ 单列不可判，不折算成任何一侧。
 *   使用轴 env：K1＝该文件根本没有 `*_INTERVAL_MS` 旋钮 ⇒ 常驻面**结构上**改不动节奏；
 *               K2＝有旋钮但全仓（test/、CI、harness、Makefile、.deploy、package.json）无人设过 ⇒ 默认间隔独大＝潜在洞；
 *               K3u＝只有 unit spec 设过（测的是**解析函数**，没等 tick）⇒ **不算覆盖**；
 *               K3r＝链上常驻面（e2e spec／场景脚本／CI-harness env）设过 ⇒ 仍需人工读"是否真等到 ≥2 tick 并断到副作用"。
 * Σ(使用轴)＝分母，硬断言，加总不上即非零退出。
 * 达/不达（间隔 vs 用例等待时长）只打印 2×间隔，**不据此判档**：窗在哪条用例里等多久，静态读不出来（V206 教训）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

// 仓根按"哪一层看得见 ewoh-spark-app"来定，不写死层数（脚本从 tmp/ 提升到 scripts/chain-baseline/ 时不必改）。
let ROOT = path.resolve(__dirname, '../..');
if (!fs.existsSync(path.join(ROOT, 'ewoh-spark-app'))) ROOT = path.resolve(__dirname, '..');
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');

/** 扫描面比"常驻面"更宽：K3u 与 K2 的区别只有看得见 unit 面才判得出来。 */
const USAGE_SURFACE = [
  'ewoh-spark-app/test', 'ewoh-spark-app/package.json', 'Makefile',
  '.github', 'scripts', '.deploy',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const num = (t) => Number(String(t).replace(/_/g, ''));

/** 找 `NAME = <expr>` 的全部形态：变量声明、类/实例字段、**参数默认值**、`const f = () => …`。 */
function initializerOf(sf, name) {
  let hit = null;
  (function visit(n) {
    if (hit) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) hit = n.initializer;
    else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) hit = n.initializer;
    else if (ts.isPropertyDeclaration(n) && n.name && n.name.getText && n.name.getText() === name && n.initializer) hit = n.initializer;
    ts.forEachChild(n, visit);
  })(sf);
  return hit;
}

/** 函数体（FunctionDeclaration / 持有箭头函数的变量）里第一个 return 的表达式。 */
function firstReturn(node) {
  let hit = null;
  (function visit(n) {
    if (hit) return;
    if (ts.isReturnStatement(n) && n.expression) { hit = n.expression; return; }
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) { hit = n.body; return; }
    ts.forEachChild(n, visit);
  })(node);
  return hit;
}

function calleeName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return '';
}

/** 把表达式节点求成数值；解析不出返回 null。trail 记录求值路径，供人审。 */
function evalExpr(node, sf, depth = 0, trail = []) {
  if (!node || depth > 8) return null;
  if (ts.isNumericLiteral(node)) return { value: num(node.getText(sf)), trail: trail.concat(node.getText(sf)) };
  if (ts.isParenthesizedExpression(node)) return evalExpr(node.expression, sf, depth + 1, trail);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const r = evalExpr(node.operand, sf, depth + 1, trail);
    return r && { value: -r.value, trail: r.trail.concat('-') };
  }
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    const arith = { [ts.SyntaxKind.AsteriskToken]: (a, b) => a * b, [ts.SyntaxKind.PlusToken]: (a, b) => a + b,
      [ts.SyntaxKind.MinusToken]: (a, b) => a - b, [ts.SyntaxKind.SlashToken]: (a, b) => a / b }[k];
    if (arith) {
      const l = evalExpr(node.left, sf, depth + 1, trail);
      const r = evalExpr(node.right, sf, depth + 1, trail);
      return l && r && { value: arith(l.value, r.value), trail: l.trail.concat(r.trail) };
    }
    // `Number(env.K ?? DEFAULT)` / `env.K || DEFAULT`：取**缺省侧**（真跑起来用的那个值）
    if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) {
      const r = evalExpr(node.right, sf, depth + 1, trail);
      return r && { value: r.value, trail: ['缺省侧'].concat(r.trail) };
    }
    return null;
  }
  if (ts.isIdentifier(node)) {
    const init = initializerOf(sf, node.text);
    return init ? evalExpr(init, sf, depth + 1, trail.concat(node.text)) : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const init = initializerOf(sf, node.name.text);
    return init ? evalExpr(init, sf, depth + 1, trail.concat(node.getText(sf))) : null;
  }
  if (ts.isConditionalExpression(node)) {
    return evalExpr(node.whenTrue, sf, depth + 1, trail) || evalExpr(node.whenFalse, sf, depth + 1, trail);
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (/^Number$/.test(name) && node.arguments.length) return evalExpr(node.arguments[0], sf, depth + 1, trail.concat('Number()'));
    // 一跳 helper：① 实参里带字面量缺省（`backlogIntervalMs(env, 10*60_000, cb)`）先取实参；
    // ② 否则进函数体取第一个 return（其标识符再经参数默认值解析）；③ 再不行就逐个试数值实参。
    const litArg = node.arguments.find((a) => ts.isNumericLiteral(a) || ts.isBinaryExpression(a));
    const decl = initializerOf(sf, name);
    const fn = decl && (ts.isFunctionLike(decl) ? decl : null);
    const bodyReturn = fn ? firstReturn(fn) : (decl ? null : firstReturnOfFunctionDeclaration(sf, name));
    if (bodyReturn) {
      const r = evalExpr(bodyReturn, sf, depth + 1, trail.concat(`${name}()→return`));
      if (r) return r;
    }
    if (litArg) {
      const r = evalExpr(litArg, sf, depth + 1, trail.concat(`${name}()实参缺省`));
      if (r) return r;
    }
    return null;
  }
  return null;
}

function firstReturnOfFunctionDeclaration(sf, name) {
  let hit = null;
  (function visit(n) {
    if (hit) return;
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) { hit = firstReturn(n); return; }
    ts.forEachChild(n, visit);
  })(sf);
  return hit;
}

/** 一个文件的 setInterval 站点 + 该文件的 env 旋钮（含 `env.X` 与 `process.env.X` 两种写法）。 */
function scanFile(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites = [];
  (function visit(n) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'setInterval' && n.arguments[1]) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const ev = evalExpr(n.arguments[1], sf);
      sites.push({
        file: rel, line,
        ms: ev ? ev.value : null,
        msAxis: ev ? 'ok' : 'X',
        trail: ev ? ev.trail.join(' · ') : 'unresolved',
      });
    }
    ts.forEachChild(n, visit);
  })(sf);
  const knobs = [...new Set([...text.matchAll(/\benv\.(?:\?\.)?([A-Z0-9_]*INTERVAL_MS)\b/g)].map((m) => m[1]))];
  const disabled = [...new Set([...text.matchAll(/\benv\.(?:\?\.)?([A-Z0-9_]*DISABLED)\b/g)].map((m) => m[1]))];
  return { sites, knobs, disabled };
}

function usageFiles(root = ROOT) {
  const out = [];
  for (const p of USAGE_SURFACE) {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isFile()) { out.push(p); continue; }
    (function walkDir(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walkDir(f);
        else if (/\.(ts|mjs|js|json|yml|yaml|sh)$/.test(e.name)) out.push(path.relative(root, f));
      }
    })(abs);
  }
  return out;
}
const isChainPath = (rel) => rel.startsWith('ewoh-spark-app/test/e2e/');

function usagesFor(knob, files, root = ROOT) {
  const hits = [];
  const re = new RegExp(`\\b${knob}\\b`);
  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (!re.test(text)) continue;
    let kind;
    if (/\.spec\.ts$/.test(rel) && isChainPath(rel)) kind = 'chain-spec';
    else if (/\.spec\.ts$/.test(rel)) kind = 'unit-spec';
    else if (/\.mjs$/.test(rel) && isChainPath(rel)) kind = 'scenario';
    else if (rel.startsWith('.github') || rel === 'Makefile' || rel.startsWith('scripts/') || rel.startsWith('.deploy/')) kind = 'ci-harness';
    else kind = 'other';
    hits.push({ rel, kind });
  }
  return hits;
}

/** 使用轴判档（与间隔轴无关 ⇒ 间隔读不出也不得吞掉这一列）。 */
function envClass(knobs, usages) {
  if (!knobs.length) return 'K1';
  const used = knobs.flatMap((k) => usages[k] || []);
  if (!used.length) return 'K2';
  if (used.some((u) => ['chain-spec', 'scenario', 'ci-harness'].includes(u.kind))) return 'K3r';
  if (used.every((u) => u.kind === 'unit-spec')) return 'K3u';
  return 'K2';
}

function analyze(root = ROOT) {
  const files = walk(path.join(root, 'ewoh-spark-app/server'))
    .filter((f) => !/\.spec\.ts$/.test(f))
    .map((f) => [path.relative(root, f), fs.readFileSync(f, 'utf8')]);
  const ufiles = usageFiles(root);
  const rows = [];
  for (const [rel, text] of files) {
    const { sites, knobs, disabled } = scanFile(rel, text);
    if (!sites.length) continue;
    const usages = {};
    for (const k of knobs) usages[k] = usagesFor(k, ufiles, root);
    const env = envClass(knobs, usages);
    for (const s of sites) {
      rows.push({
        ...s, knobs: knobs.join(',') || '-', disabled: disabled.join(',') || '-',
        twice: s.ms === null ? null : s.ms * 2, envClass: env,
        usage: Object.entries(usages).flatMap(([k, v]) => v.map((u) => `${k}@${u.kind}`)).join('|') || '-',
      });
    }
  }
  return rows;
}

const ENV_ORDER = ['K1', 'K2', 'K3u', 'K3r'];
function report(rows) {
  const byEnv = {};
  for (const r of rows) byEnv[r.envClass] = (byEnv[r.envClass] || 0) + 1;
  const xMs = rows.filter((r) => r.msAxis === 'X').length;
  console.log(`分母：服务端非 spec 的 setInterval 站点 ${rows.length} 处（使用面 ${USAGE_SURFACE.join(', ')}）`);
  console.log('使用轴：' + ENV_ORDER.map((b) => `${b} ${byEnv[b] || 0}`).join(' · ')
    + `｜Σ=${ENV_ORDER.reduce((a, b) => a + (byEnv[b] || 0), 0)}`);
  console.log(`间隔轴：可判 ${rows.length - xMs}／不可判(X) ${xMs}——X 只在间隔轴挂账，不改动使用档`);
  for (const b of ENV_ORDER) {
    for (const r of rows.filter((x) => x.envClass === b)) {
      console.log(`  [${b}/${r.msAxis}] ${r.file}:${r.line} 间隔=${r.ms ?? '不可判'}ms 2×=${r.twice ?? '-'}ms 旋钮=${r.knobs}`
        + `${r.usage === '-' ? '' : ' 使用=' + r.usage}｜路径 ${r.trail}`);
    }
  }
  const sum = ENV_ORDER.reduce((a, b) => a + (byEnv[b] || 0), 0);
  if (sum !== rows.length) { console.error('✕ 使用轴加总≠分母，本轮不出数'); return 1; }
  return 0;
}

/* ---------- 自测：判据必须能开火 ---------- */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-tickreach-'));
  const w = (rel, src) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  };
  w('ewoh-spark-app/server/modules/a/a.worker.ts',
    "const DEFAULT_INTERVAL_MS = 5 * 60_000;\n"
    + "export class A { s() {\n"
    + "  const v = Number(process.env.A_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);\n"
    + "  this.timer = setInterval(() => this.tick(), v);\n} }\n");
  w('ewoh-spark-app/server/modules/b/b.worker.ts',
    "export class B { s() { this.t = setInterval(() => this.tick(), 2_000); } }\n");
  w('ewoh-spark-app/server/modules/c/c.worker.ts',
    "const DEFAULT_INTERVAL_MS = 10 * 60_000;\n"
    + "export class C { s() { const v = Number(process.env.C_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);"
    + " this.t = setInterval(() => this.tick(), v); } }\n");
  w('ewoh-spark-app/server/modules/d/d.worker.ts',
    "export class D { s() { this.t = setInterval(() => this.tick(), this.runtimeOnly); } }\n");
  w('ewoh-spark-app/server/modules/e/e.spec.ts',
    "it('x', () => { setInterval(() => {}, 1000); });\n");
  // F：真语料形状——间隔来自 helper，旋钮在 helper 里以 `env.NAME` 出现（control-backlog 同形）
  w('ewoh-spark-app/server/modules/f/f.worker.ts',
    "export function intervalMs(env = process.env, fallback = 10 * 60_000) {\n"
    + "  const raw = env.F_WORKER_INTERVAL_MS;\n  if (raw == null) return fallback;\n"
    + "  return Math.floor(Number(raw));\n}\n"
    + "export class F { s() { this.t = setInterval(() => this.tick(), intervalMs(process.env, 10 * 60_000, null)); } }\n");
  // G：helper 无实参缺省，第一个 return 走三元、缺省侧是文件常量（channel-dispatcher 同形）
  w('ewoh-spark-app/server/modules/g/g.worker.ts',
    "export const DEFAULT_MS = 15_000;\n"
    + "function gInterval() { const raw = Number(process.env.G_WORKER_INTERVAL_MS ?? ''); return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_MS; }\n"
    + "export class G { s() { this.t = setInterval(() => this.tick(), gInterval()); } }\n");
  w('ewoh-spark-app/test/unit/a.spec.ts', "process.env.A_WORKER_INTERVAL_MS = '3000';\n");
  w('ewoh-spark-app/test/e2e/c.e2e.spec.ts', "process.env.C_WORKER_INTERVAL_MS = '2000';\n");
  const rows = analyze(dir);
  const by = (f) => rows.find((r) => r.file.includes(f));
  const cases = [
    ['分母排除 spec 文件（e.spec.ts 不得计入）', !rows.some((r) => r.file.includes('e.spec.ts'))],
    ['A：有旋钮、只有 unit spec 用过 ⇒ 必须 K3u（只测解析≠覆盖）', by('a/a.worker').envClass === 'K3u'],
    ['B：无 INTERVAL_MS 旋钮 ⇒ 必须 K1', by('b/b.worker').envClass === 'K1'],
    ['C：链上 spec 设过 ⇒ 必须 K3r', by('c/c.worker').envClass === 'K3r'],
    ['D：间隔运行时才知道 ⇒ 间隔轴 X，但使用轴仍要判（不得被 X 吞掉）',
      by('d/d.worker').msAxis === 'X' && by('d/d.worker').envClass === 'K1'],
    ['C 的缺省值必须由 env 的 ?? 右侧解析出 600000（不是 2000）', by('c/c.worker').ms === 600000],
    ['A 的缺省值解析成 300000（5 * 60_000，含下划线字面量）', by('a/a.worker').ms === 300000],
    ['F：间隔来自带默认参数的一跳 helper ⇒ 必须解析出 600000（control-backlog 形状，V206 那格不得读成 X）',
      by('f/f.worker').ms === 600000 && by('f/f.worker').envClass === 'K2'],
    ['G：helper 走 `? raw : DEFAULT_MS` ⇒ 必须落到缺省侧 15000', by('g/g.worker').ms === 15000],
    ['加总＝分母', report(rows) === 0],
  ];
  let ok = true;
  for (const [name, pass] of cases) { if (!pass) ok = false; console.log(`  ${pass ? '✔' : '✕'} ${name}`); }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok ? `结论：尺子可用（${cases.length} 项判据自测全过）` : '结论：尺子不可用，本轮不出数');
  return ok ? 0 : 1;
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const rows = analyze(ROOT);
  const rc = report(rows);
  fs.writeFileSync(path.join(ROOT, 'tmp/v207-tick-reach.json'), JSON.stringify(rows, null, 2) + '\n');
  process.exit(rc);
}
module.exports = { analyze, scanFile, evalExpr, envClass };
