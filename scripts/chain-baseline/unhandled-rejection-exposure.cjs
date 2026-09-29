#!/usr/bin/env node
/**
 * CRASH-02 暴露面普查：哪些「调用 async 方法却没有 rejection 归宿」的位点存在。
 *
 * 只答这一问。它**不**证明某次真实崩溃出自其中哪一位（那需要运行时归属），
 * 只回答"进程顶层兜底是唯一防线的位点有多少、都在哪"——V196 把 57P01 判成可恢复之后，
 * 这些位点的 rejection 不再带走进程，但**结果仍被静默丢弃**。
 *
 * 判据（三态，不折成违规）：
 *   · exposed            —— 语句位的 async／Promise 调用，既没被 await/return 承接，也没有 .catch；
 *                            被调方法体也不是"整个包在 try/catch 且 catch 不重抛"。
 *   · handled-internally —— 被调方法体整个在 try/catch 里且 catch 内不 throw ⇒ 归宿在函数内部。
 *   · unknown-callee     —— 被调名在本文件解析不到（跨文件／注入进来的）⇒ 看不见，单独成档，
 *                            **不**并进 exposed（把看不见读成违规是这类普查最常见的假阳）。
 *   另有 sync-seen（被调是同步方法）与 then-orphan（.then 链末端没 catch，归进 exposed 并打标记）。
 *
 * 已知的诚实边界：
 *   1) 不做跨文件解析：callee 只在本文件内求定义；求不到一律 unknown-callee。
 *   2) `.catch` 判据是"语句文本里出现 .catch("——写在链中间的 .catch 后若又抛出新 rejection，
 *      本件看不见。
 *   3) 定时器／事件回调只作**标记**（timer=1），不额外加权：逃逸不取决于谁调它。
 *
 * 用法：node scripts/chain-baseline/unhandled-rejection-exposure.cjs [--json] [--self-test]
 *      判据自测条数由脚本自报（不要在文档里冻结）。本件按 FLAKE-04/FLAKE-06 同口径
 *      **不接**共享门禁主线（普查类判据的严度不该由一条主线替所有人决定）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'ewoh-spark-app', 'server');

function loadTs() {
  const candidates = [
    path.join(ROOT, 'ewoh-spark-app', 'node_modules', 'typescript'),
    'typescript',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      /* 试下一个 */
    }
  }
  return null;
}

const ts = loadTs();
if (!ts) {
  console.log('❌ 不可判（3）：解析不到 TypeScript 编译器（普查依赖它，缺它读数为空不等于没有）');
  process.exit(3);
}

/** 常见同步调用：登记器／记录器／定时器本身，不当作"发起了异步工作"。 */
const SYNC_ALLOWLIST = new Set([
  'log', 'warn', 'error', 'debug', 'verbose', 'setInterval', 'setTimeout',
  'clearInterval', 'clearTimeout', 'setImmediate', 'on', 'once', 'off',
  'removeListener', 'removeAllListeners', 'emit', 'unref', 'ref',
]);

function walk(node, cb) {
  cb(node);
  ts.forEachChild(node, (child) => walk(child, cb));
}

function hasModifier(node, kind) {
  return (node.modifiers || []).some((m) => m.kind === kind);
}

function isTryStatement(node) {
  return node && node.kind === ts.SyntaxKind.TryStatement;
}

/**
 * 「异步体有没有归宿」的近似判据（两个形状都算安全，缺一即不算）：
 *   A) 整个体就是一条 try/catch；
 *   B) 体里**每一个 await** 都落在某个「catch 内不 rethrow」的 try 块里（worker 的常见形状是
 *      `if (ticking) return; ticking = true; try { await … } catch { log }` —— 语句数 > 1，
 *      只看"体是不是一条 try"会把它误报成逃逸；本轮真实语料里 7 处 exposed 有 5 处就是这个形状，
 *      是手工复核抓出来的假阳性，判据据此加的就是 B）。
 * 体顶层（不在那种 try 里）出现 throw/裸 await ⇒ 仍能拒绝 ⇒ 不算安全。
 */
function bodyFullyGuarded(body) {
  if (!body || !body.statements) return false;
  const safeTries = [];
  walk(body, (n) => {
    if (isTryStatement(n) && n.catchClause) {
      let rethrows = 0;
      walk(n.catchClause, (c) => {
        if (c.kind === ts.SyntaxKind.ThrowStatement) rethrows += 1;
      });
      if (rethrows === 0) safeTries.push(n);
    }
  });
  if (safeTries.length === 0) return false;
  const insideSafeTry = (node) => {
    let cur = node.parent;
    while (cur && cur !== body) {
      if (isTryStatement(cur) && cur.catchClause && safeTries.includes(cur)) return true;
      cur = cur.parent;
    }
    return false;
  };
  let awaits = 0;
  let unguarded = 0;
  walk(body, (n) => {
    if (n.kind === ts.SyntaxKind.AwaitExpression ||
        (n.kind === ts.SyntaxKind.CallExpression && /\bthen$/.test(calleeOfText(n)))) {
      awaits += 1;
      if (!insideSafeTry(n)) unguarded += 1;
    }
    if (n.kind === ts.SyntaxKind.ThrowStatement && !insideSafeTry(n)) unguarded += 1;
  });
  if (awaitingIsOnlySyncCalls(awaits)) return false;   // 体里根本没有异步发起时交给"同步被调"那一档判
  const singleTry = body.statements.length === 1 && isTryStatement(body.statements[0])
    && Boolean(body.statements[0].catchClause);
  return singleTry || unguarded === 0;
}
/** callee 的文本（只为 `.then(` 的形状判据服务，取不到就回空串）。 */
function calleeOfText(call) {
  const c = call && call.expression;
  if (c && c.kind === ts.SyntaxKind.PropertyAccessExpression && c.name) return c.name.getText();
  return '';
}
function awaitingIsOnlySyncCalls(n) {
  return n === 0;
}

/** 收集本文件里的方法／函数定义：名字 → {async, promise, guarded}。 */
function collectDefs(source) {
  const defs = new Map();
  const add = (nameNode, declNode, body, typeNode) => {
    if (!nameNode || nameNode.kind !== ts.SyntaxKind.Identifier) return;
    const name = nameNode.text;
    if (SYNC_ALLOWLIST.has(name)) return;
    if (!body) return;                       // 重载签名／abstract 声明没有体：看不见定义，不猜
    const isAsync = hasModifier(declNode, ts.SyntaxKind.AsyncKeyword);
    let returnsPromise = /(^|[^A-Za-z])Promise\s*</.test(typeNode ? typeNode.getText() : '');
    if (!returnsPromise && body && body.statements) {
      // 无显式返回类型时，函数体里出现 await/return Promise 也算发起异步
      let awaits = false;
      walk(body, (n) => {
        if (n.kind === ts.SyntaxKind.AwaitExpression) awaits = true;
      });
      if (awaits) returnsPromise = true;
    }
    const prev = defs.get(name);
    // 同名多处定义：只要有一处不是"整个包 try/catch"，就不能算安全（取两侧都严的那侧）
    const guarded = bodyFullyGuarded(body) && (!prev || prev.guarded);
    defs.set(name, {
      async: Boolean(isAsync) || returnsPromise || Boolean(prev && prev.async),
      guarded,
    });
  };
  walk(source, (n) => {
    if (n.kind === ts.SyntaxKind.MethodDeclaration) add(n.name, n, n.body, n.type);
    else if (n.kind === ts.SyntaxKind.FunctionDeclaration && n.name) add(n.name, n, n.body, n.type);
    else if (n.kind === ts.SyntaxKind.PropertyAssignment && n.initializer &&
      (ts.isFunctionExpression(n.initializer) || ts.isArrowFunction(n.initializer))) {
      add(n.name, n.initializer, n.initializer.body, n.initializer.type);
    }
  });
  return defs;
}

/** 取"这次调用最终打到了哪个名字"：`this.tick()` → tick；`this.tick().then(f)` → tick（先看内层）；
 *  `foo()` → foo；解析不到（复杂表达式）→ null。 */
/** 取被调名 + 它的接收者是不是 `this`（只按名字求定义会把 `this.store.set()` 认错成类自己的 `set()`）。 */
function calleeOf(call) {
  let callee = call && call.expression;
  if (!callee) return null;
  // `x.tick().then(...)`：callee 是 `.then` 的属性访问，其 expression 又是一个调用 ⇒ 往里看
  while (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression)) {
    callee = callee.expression.expression;
  }
  if (ts.isCallExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee)) return { name: callee.text, onThis: false, bare: true };
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return {
      name: callee.name.text,
      // TS 里 this 的节点 kind 是 ThisKeyword（没有 ThisExpression 这个 kind）
      onThis: callee.expression.kind === ts.SyntaxKind.ThisKeyword,
      bare: false,
    };
  }
  return null;
}

/** 只有「本对象自己的方法」或「本文件里的具名函数」能按名字求到定义；其余一律不可判。 */
function resolvesToOwnMethod(info) {
  return Boolean(info && (info.bare || info.onThis));
}

function analyzeFile(rel, text) {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defs = collectDefs(source);
  const out = [];
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const inTimerOrCallback = (node) => {
    let cur = node.parent;
    while (cur) {
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) ||
        ts.isFunctionExpression(cur) || cur.kind === ts.SyntaxKind.ArrowFunction) {
        const call = cur.parent;
        if (call && ts.isCallExpression(call)) {
          const fn = (calleeOf(call) || {}).name;
          if (fn && ['setInterval', 'setTimeout', 'setImmediate', 'on', 'once'].includes(fn)) return 1;
        }
        return 0;
      }
      if (ts.isExpressionStatement(cur)) return 0;
      cur = cur.parent;
    }
    return 0;
  };

  const consider = (stmt, expr, voidDiscard) => {
    if (!ts.isCallExpression(expr)) return;
    const info = calleeOf(expr);
    if (!info || SYNC_ALLOWLIST.has(info.name)) return;
    const name = info.name;
    const text = stmt.getText();
    const hasCatch = /\.catch\s*\(/.test(text);
    const hasFinally = /\.finally\s*\(/.test(text);
    const hasThen = /\.then\s*\(/.test(text);
    if (hasCatch) return;                     // 链上有归宿（边界②：catch 之后又抛的新 rejection 看不见）
    if (hasFinally && !voidDiscard) return;   // 只有 finally 不算归宿，但非 void 的写法通常还有后续链
    const def = resolvesToOwnMethod(info) ? defs.get(name) : undefined;
    let bucket;
    if (!def) bucket = 'unknown-callee';
    else if (!def.async) bucket = 'sync-seen';
    else if (def.guarded) bucket = 'handled-internally';
    else bucket = 'exposed';
    out.push({
      rel,
      line: lineOf(stmt.getStart()),
      name,
      bucket,
      voidDiscard: voidDiscard ? 1 : 0,
      thenOrphan: hasThen ? 1 : 0,
      timer: inTimerOrCallback(stmt),
      code: text.replace(/\s+/g, ' ').slice(0, 90),
    });
  };

  walk(source, (n) => {
    if (!ts.isExpressionStatement(n)) return;   // 判定单位=语句位的调用
    let e = n.expression;
    let isVoid = false;
    if (ts.isVoidExpression(e)) {
      isVoid = true;
      e = e.expression;               // TS 的一元节点挂的是 .expression，不是 .operand
    }
    if (!e || ts.isAwaitExpression(e)) return;
    if (ts.isCallExpression(e)) consider(n, e, isVoid);
    // 嵌套：块语句里的箭头函数体等由 walk 自己再进来
  });
  return out;
}

function listServerFiles(dir) {
  const acc = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) acc.push(...listServerFiles(p));
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts') && !ent.name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/* ---------------------------- 判据自测 ---------------------------- */

const FIXTURES = [
  ['正向 void 丢弃 async 调用', 'class A { async tick(){ throw new Error("x"); } run(){ void this.tick(); } }',
    (r) => r.length === 1 && r[0].bucket === 'exposed' && r[0].voidDiscard === 1],
  ['对照 .catch 有归宿', 'class A { async tick(){} run(){ this.tick().catch(()=>{}); } }',
    (r) => r.filter((x) => x.bucket === 'exposed').length === 0],
  ['对照 await 承接', 'class A { async tick(){} async run(){ await this.tick(); } }',
    (r) => r.length === 0],
  ['正向 then 链末端没 catch', 'class A { async tick(){} run(){ this.tick().then(()=>{}); } }',
    (r) => r.length === 1 && r[0].bucket === 'exposed' && r[0].thenOrphan === 1],
  ['对照 被调体内整个包 try/catch', 'class A { async tick(){ try { await x(); } catch (e) { log(e); } } run(){ this.tick(); } }',
    (r) => r.length === 1 && r[0].bucket === 'handled-internally'],
  ['正向 被调体 catch 里重抛 ⇒ 不算内部有归宿',
    'class A { async tick(){ try { await x(); } catch (e) { throw e; } } run(){ this.tick(); } }',
    (r) => r.length === 1 && r[0].bucket === 'exposed'],
  ['对照 同步被调不算', 'class A { tick(){ return 1; } run(){ this.tick(); } }',
    (r) => r.length === 1 && r[0].bucket === 'sync-seen'],
  ['对照 跨文件求不到定义 ⇒ 不可判档，不折成违规', 'class A { run(){ void doSomethingElse(); } }',
    (r) => r.length === 1 && r[0].bucket === 'unknown-callee'],
  ['对照 worker 形状：体不止一条语句但 await 全在不重抛的 try 里',
    'class A { async tick(){ if (this.x) return; this.x = true; try { await sweep(); } catch (e) { log(e); } finally { this.x = false; } } run(){ void this.tick(); } }',
    (r) => r.length === 1 && r[0].bucket === 'handled-internally'],
  ['正向 体里有一个裸 await 在 try 之外 ⇒ 仍能拒绝',
    'class A { async tick(){ const a = await x(); try { await y(); } catch (e) { log(e); } } run(){ void this.tick(); } }',
    (r) => r.length === 1 && r[0].bucket === 'exposed'],
  ['正向 定时器回调里的丢弃带标记',
    'class A { async tick(){} start(){ setInterval(() => { void this.tick(); }, 10); } }',
    (r) => r.length === 1 && r[0].bucket === 'exposed' && r[0].timer === 1],
  ['对照 同名不同接收者不认错：this.store.set() 不等于类自己的 async set()',
    'class A { async set(k,v){ await x(); } run(){ this.store.set("k", 1); } }',
    (r) => r.length === 1 && r[0].bucket === 'unknown-callee'],
  ['对照 记录器与 process.on 不当作异步发起',
    'class A { start(){ this.logger.warn("x"); process.on("SIGTERM", () => this.stop()); } stop(){} }',
    (r) => r.length === 0],
];

function selfTest() {
  let pass = 0;
  const fails = [];
  for (const [name, src, judge] of FIXTURES) {
    let ok = false;
    try {
      ok = judge(analyzeFile('fixture.ts', src));
    } catch (e) {
      ok = false;
      fails.push(`${name} ⇒ 抛异常 ${e.message}`);
      continue;
    }
    if (ok) pass += 1;
    else fails.push(`${name} ⇒ 判据未成立`);
  }
  // 注入：把"有归宿"那条删掉 .catch，必须从 0 变 1（证明开火的是 .catch，不是别处）
  const withCatch = analyzeFile('inj.ts', 'class A { async tick(){} run(){ this.tick().catch(()=>{}); } }')
    .filter((x) => x.bucket === 'exposed').length;
  const without = analyzeFile('inj.ts', 'class A { async tick(){} run(){ this.tick(); } }')
    .filter((x) => x.bucket === 'exposed').length;
  const injOk = withCatch === 0 && without >= 1;
  if (injOk) pass += 1;
  else fails.push(`注入：删掉 .catch 未改变判决（${withCatch} → ${without}）`);
  // 注入：给被调体加整个 try/catch，必须从 exposed 变 handled-internally
  const inj2A = analyzeFile('inj2.ts', 'class A { async tick(){ await x(); } run(){ this.tick(); } }')[0] || {};
  const inj2B = analyzeFile('inj2.ts', 'class A { async tick(){ try { await x(); } catch (e) { log(e); } } run(){ this.tick(); } }')[0] || {};
  const inj2Ok = inj2A.bucket === 'exposed' && inj2B.bucket === 'handled-internally';
  if (inj2Ok) pass += 1;
  else fails.push(`注入：全包 try/catch 未把位点判成 handled-internally（${inj2A.bucket} → ${inj2B.bucket}）`);
  const total = FIXTURES.length + 2;
  console.log(`判据自测：${pass}/${total} 通过（正向 ${FIXTURES.filter((f) => f[0].startsWith('正向')).length} 条 + 对照 + 注入 2 条，条数由脚本自报）`);
  for (const f of fails) console.log('  ✗ ' + f);
  return fails.length === 0 ? 0 : 1;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) process.exit(selfTest());
  if (!fs.existsSync(SERVER_DIR)) {
    console.log('❌ 不可判（3）：找不到 ewoh-spark-app/server');
    process.exit(3);
  }
  const files = listServerFiles(SERVER_DIR);
  const rows = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    rows.push(...analyzeFile(rel, fs.readFileSync(f, 'utf8')));
  }
  const by = (b) => rows.filter((r) => r.bucket === b);
  const exposed = by('exposed');
  console.log(`扫描范围（现算）：${files.length} 个服务端源文件（排除 *.spec.ts／*.d.ts）`);
  console.log(`分档：exposed ${exposed.length}｜handled-internally ${by('handled-internally').length}` +
    `｜unknown-callee ${by('unknown-callee').length}｜sync-seen ${by('sync-seen').length}`);
  console.log(`其中 void 丢弃 ${exposed.filter((r) => r.voidDiscard).length}、` +
    `then 无 catch ${exposed.filter((r) => r.thenOrphan).length}、` +
    `在定时器/事件回调里 ${exposed.filter((r) => r.timer).length}`);
  const head = [...exposed].sort((a, b) => (b.voidDiscard - a.voidDiscard) || (b.timer - a.timer) ||
    a.rel.localeCompare(b.rel)).slice(0, 40);
  for (const r of head) {
    console.log(`  ${r.rel}:${r.line}  void=${r.voidDiscard} timer=${r.timer} then=${r.thenOrphan}  ${r.code}`);
  }
  if (exposed.length > head.length) console.log(`  …其余 ${exposed.length - head.length} 处见 --json`);
  if (args.has('--json')) {
    fs.writeFileSync(path.join(ROOT, 'tmp', 'rejection-exposure.json'),
      JSON.stringify({ files: files.length, rows }, null, 0) + '\n');
    console.log(`--json：tmp/rejection-exposure.json（${rows.length} 行）`);
  }
  console.log('说明：本件只数"位点存在"，不证明任何一次真实崩溃出自哪一位；unknown-callee 是看不见，不是没做。');
  process.exit(0);
}

main();
