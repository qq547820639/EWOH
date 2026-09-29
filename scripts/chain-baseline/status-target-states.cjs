#!/usr/bin/env node
/**
 * 一问（V159）：每张权威表，代码**实际能写入的目标态集合**是什么？试点把写者收口之后，这个集合变了吗？
 *
 * 为什么单独问这一句（判据②「业务语义没有丢失」）：
 * V158 量到"写者数 33→24、守卫形状不倒退"——那是**结构与数量**。收口最坏的失败模式不在那里，
 * 而在"合并成一个入口时，旧某条路径才会写的那个态悄悄没人写了"：数量对、形状对，语义却少了一格。
 * 这一格只能对着**目标态集合**看：旧树若干处各写哪些字面量，新树（含入口调用方传进来的 patch）合计能写出哪些。
 *
 * 两半合成一个集合：
 *  ①直接形状：`.set({ status: 'X' })` 里的字面量（AST 取属性值，不看注释不看字符串包含）。
 *  ②入口形状：`set(input.patch)`（参数化）本身看不见值 ⇒ 顺着**包含该 UPDATE 的函数名**去找它的调用点，
 *    从调用点实参里的对象字面量收 `status:`/`state:` 字面量（`outcome.status` 这类三元/联合也收，
 *    只要它是 `X ? 'a' : 'b'` 形状）。收得到的记 `via=<函数名>`；调用点仍传变量的记 `unresolved`，
 *    **单列报出、不折算成"没有"**（看不见 ≠ 不可达）。
 *
 * 用法：node scripts/chain-baseline/status-target-states.cjs [--against <rev>] [--self-test]
 * 退出码：0=可判；1=自测未抓到；3=语料读不到（不把"读不到"当成"集合为空"）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '../..');
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');
/* 复用 V157 那件量具的同一份权威事实清单与列定义——不另起口径，也不留第三份拷贝。 */
const { FACTS, STATE_COLS } = require('./status-write-guard-census.cjs');
const SCAN_REL = 'ewoh-spark-app/server';
const SCAN_ROOT = path.join(ROOT, SCAN_REL);

const listTs = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listTs(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
};

/** 从一段源码抽：①每个 `.set({status:'X'})` 的字面量；②包含动态 patch 写入的函数名；③全部 `status:'X'` 字面量（供调用侧收敛）。 */
function harvest(src, fileName, tableSet) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const direct = [];         // { table, value } 或 { table, value:null, nonliteral? }
  const dynamicFns = [];     // { table, fn }：只有顶层函数声明才进得来
  const dynUnresolved = [];  // { table }：每个动态 patch 站点一条
  let isTopLevelFn = false;
  const literalValues = (node, sink) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { sink.push(node.text); return; }
    if (ts.isConditionalExpression(node)) { literalValues(node.whenTrue, sink); literalValues(node.whenFalse, sink); return; }
    if (ts.isParenthesizedExpression(node)) { literalValues(node.expression, sink); return; }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      literalValues(node.left, sink); literalValues(node.right, sink); return;
    }
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'update' && node.arguments.length === 1
      && tableSet.has(nameOf(node.arguments[0]) || '')) {
      const table = nameOf(node.arguments[0]);
      // 找同一处流式链上的 .set(...)
      let cur = node, setArg = null;
      while (cur && ts.isCallExpression(cur)) {
        if (ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.text === 'set') {
          setArg = cur.arguments[0];
        }
        const parent = cur.parent;
        cur = (parent && ts.isPropertyAccessExpression(parent)) ? parent.parent : null;
      }
      // V288：入口归属先解一次，两个分支共用。以前只有"整块 set 是变量"才登记入口，
      // 于是 `.set({ status: target })`（值是形参）这一族压根没挂过入口 ⇒ 调用侧永远无从回收。
      let enc = null;
      if (setArg) {
        for (let q0 = node.parent; q0; q0 = q0.parent) {
          if (ts.isFunctionDeclaration(q0) || ts.isMethodDeclaration(q0) || ts.isFunctionExpression(q0) || ts.isArrowFunction(q0)) {
            const nm = ts.isFunctionDeclaration(q0) ? (q0.name ? q0.name.text : '(匿名函数声明)')
              : ts.isMethodDeclaration(q0) ? nameOf(q0.name)
              : (q0.parent && ts.isVariableDeclaration(q0.parent)) ? q0.parent.name.getText() : null;
            // V298：匿名回调（`db.transaction(async (tx) => …)` 里的那支箭头）不再终止上溯——
            // 以前 `break` 会让"写在事务回调体内"的入口连登记都不发生，站点从分母整条消失
            //（实物：agent.service.ts 的 resolveRow，三个调用侧字面量从未被收进集合）。
            if (!nm) continue;
            let cls = null;
            if (ts.isMethodDeclaration(q0)) {
              for (let q = q0.parent; q; q = q.parent) {
                if (ts.isClassDeclaration(q) && q.name) { cls = q.name.text; break; }
              }
            }
            const params = (q0.parameters || []).map((pp) => (pp.name && ts.isIdentifier(pp.name)) ? pp.name.text : null).filter(Boolean);
            enc = { name: nm, kind: ts.isFunctionDeclaration(q0) ? 'fn' : (cls ? 'method' : 'other'), className: cls, params,
                    argIndex: null, keyPath: null };
            // V289：绑定"哪个形参供给状态列"。不绑定就会把同一次调用的其它字符串实参当成目标态
            //（注入实测：夹具里 this.transition('a','b','in_progress',…) 曾把 'a'/'b' 也收进集合）。
            enc.bindFrom = (init) => {
              const e0 = ts.isParenthesizedExpression(init) ? init.expression : init;
              const idn = ts.isAsExpression(e0) ? e0.expression : e0;
              const isProp = ts.isPropertyAccessExpression(idn);
              const root = isProp ? idn.expression : idn;
              if (!ts.isIdentifier(root)) return false;
              const idx = enc.params.indexOf(root.text);
              if (idx < 0) return false;
              enc.argIndex = idx;
              enc.keyPath = isProp ? idn.name.text : null;
              return true;
            };
            break;
          }
        }
      }
      const registerEntry = (countUnresolved) => {
        if (!enc || enc.kind === 'other') return;
        if (countUnresolved) dynUnresolved.push({ table });
        // 绑不出实参位（如 `.set(values)` 的值来自赋值表）⇒ 不登记可回收入口，继续留在"看不见"
        if (enc.argIndex === null) { enc.unbound = true; return; }
        if (enc.kind === 'fn') dynamicFns.push({ table, fn: enc.name, kind: 'fn', argIndex: enc.argIndex, keyPath: enc.keyPath });
        else dynamicFns.push({ table, fn: enc.name, kind: 'method', className: enc.className, argIndex: enc.argIndex, keyPath: enc.keyPath });
      };
      if (setArg && ts.isObjectLiteralExpression(setArg)) {
        let hit = false;
        let paramRef = false;
        for (const prop of setArg.properties) {
          if (ts.isPropertyAssignment(prop) && STATE_COLS.has(nameOf(prop.name) || '')) {
            hit = true;
            const sink = [];
            literalValues(prop.initializer, sink);
            if (sink.length) sink.forEach((v) => direct.push({ table, value: v }));
            else {
              const idn = ts.isParenthesizedExpression(prop.initializer) ? prop.initializer.expression : prop.initializer;
              const cid = nameOf(ts.isAsExpression(idn) ? idn.expression : idn);   // V299：带住标识符，供常量档解引用
              direct.push({ table, value: '（非字面量）', id: cid });
              if (enc && enc.bindFrom(prop.initializer)) paramRef = true;
            }
          } else if (ts.isShorthandPropertyAssignment(prop) && STATE_COLS.has(prop.name.text)) {
            // V287：`.set({ status })` 与 `.set({ status: status })` 是同一种写。V284 给守卫尺补过这一支，
            // 本尺当时没同步 ⇒ 站点曾被判成"这条链不改状态列"而整条从分母消失。
            hit = true;
            // 简写没有 initializer 节点，值就是那个标识符本身（V299：一并带住，供常量档解引用）
            direct.push({ table, value: '（非字面量）', id: prop.name.text });
            if (enc && enc.bindFrom(prop.name)) paramRef = true;
          }
        }
        if (!hit) direct.push({ table, value: null });        // 这条链改的不是状态列（不计入集合）
        else if (direct.length && direct[direct.length - 1].value === '（非字面量）') {
          // 值不是字面量：它**不是一个状态**，不能进集合，也不能被差集当成"丢失"
          direct[direct.length - 1] = { table, value: null, nonliteral: true,
                                         id: direct[direct.length - 1].id ?? null };
        }
        // 形参引用不另计 unresolved（站点已经以「非字面量」留名），只登记入口以便回到调用侧收值
        if (paramRef) registerEntry(false);
      } else if (setArg) {
        enc && enc.bindFrom(setArg);          // `.set(input.patch)`：根标识符是形参、键是 patch
        registerEntry(true);
      }
    }
    ts.forEachChild(node, visit);
    return false;
  };
  visit(sf);
  return { direct, dynamicFns, dynUnresolved };
}

/** 只由字符串字面量搭出来的表达式（`'a'`、`cond ? 'a' : 'b'`、`a ?? 'b'`、`x || 'b'`）取其叶子值。 */
function stringLiteralLeaves(node, sink) {
  if (!node) return;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { sink.push(node.text); return; }
  if (ts.isParenthesizedExpression(node)) { stringLiteralLeaves(node.expression, sink); return; }
  if (ts.isConditionalExpression(node)) { stringLiteralLeaves(node.whenTrue, sink); stringLiteralLeaves(node.whenFalse, sink); return; }
  const k = node.operatorToken && node.operatorToken.kind;
  if (ts.isBinaryExpression(node) && (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken)) {
    stringLiteralLeaves(node.left, sink); stringLiteralLeaves(node.right, sink); return;
  }
}

/**
 * V299：`const NAME = '字符串字面量'` 的表（值回收的第四档——值既不写在调用点也不在被调函数里，
 * 而是被提成一个具名常量）。三条不猜的边界：只认 **const**（let/var 可被再赋值，不收）、
 * 名字在整个扫描面内**出现两次即撤销**（与 `literalReturnFns` 的 dup 同一条纪律）、
 * 定义必须在扫描面内（import 进来的解不到就不猜）。
 * 先量后收的读数（`tmp/v299-const-arm.log`）：链上 22 处"状态列的值不是字面量"的写点里，
 * 形参 18 处（入口档已管）、非标识符表达式 2 处、解不到 1 处、**可解到唯一 const 的只有 1 处**
 * （`dispatch-coordinator.service.ts:640` 的 `TASK_PRE_DISPATCH_STATUS` = `pending_dispatch`，
 * 定义在 `task-lifecycle.ts:69`，且该值在 `contracts/state-machines/task.yaml` 的 states 里）。
 */
function literalConsts(sources) {
  const out = new Map();
  const dup = new Set();
  for (const [rel, src] of sources) {
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
    const walk = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
          && n.initializer && ts.isStringLiteral(n.initializer)
          && n.parent && (n.parent.flags & ts.NodeFlags.Const) !== 0) {  // const 位挂在 VariableDeclarationList 上，不在语句节点
        const nm = n.name.text;
        if (out.has(nm)) dup.add(nm);
        else out.set(nm, { value: n.initializer.text, file: rel,
                           line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  dup.forEach((n) => out.delete(n));
  return out;
}

/** 一段源码里出现过的所有形参名：被形参遮蔽的标识符一律不当常量解（宁可少收）。 */
function paramNamesOf(src, fileName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out = new Set();
  const walk = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)
         || ts.isArrowFunction(n) || ts.isConstructorDeclaration(n)) && n.parameters) {
      for (const p of n.parameters) {
        let t = p.name;
        if (ts.isAssignmentPattern(t)) t = t.left;
        if (ts.isBindingPattern(t)) { out.add('*非标识符形参*'); continue; }   // 解构形参：一律按"可能被遮蔽"处理，不当常量解
        if (ts.isIdentifier(t)) out.add(t.text);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/**
 * V296：同文件**顶层函数**里"每一条 return 都只由字符串字面量搭出来"的那些，登记成值可回收的被调函数。
 * 为什么只跟这一层：`updateRequestStatus` 的目标态不写在调用点，而写在 `aggregateControlStatus`
 * 的函数体里（V291 登记的跨过程下界）。TypeChecker 档实测拿不到——该函数签名写死 `: string`，
 * 10 个调用点的类型全被拓宽成 `string`（tmp/v296-typechecker-probe.log）。
 * 三条边界各自都有"灌水的方向"，所以都由控制钉住：①只遍历源文件的**顶层语句**——类体／块体内的
 * `function` 声明不算顶层（V296 复核指出的第一版洞：`walk` 对类体不早退，方法体里的嵌套声明会被当顶层登记）；
 * ②`scanReturns` 到嵌套函数边界就停——体内箭头／函数表达式的 return 不并进外层的值集；
 * ③同名只看**出现过几次**，不看是否登记成功（否则"第一个不纯、第二个纯"会让第二个静默胜出）。
 * 自限条件本身就是闸：任何一支 return 不是字面量（变量／属性访问／无值 return）⇒ 整条不跟，站点退回"非字面量"。
 */
function literalReturnFns(src, fileName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out = new Map();
  const seen = new Set();
  const dup = new Set();
  const isFunctionBoundary = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
    || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);
  const scanReturns = (n, vals, st) => {
    if (isFunctionBoundary(n)) return;                      // 嵌套函数的 return 不是这个函数的 return
    if (ts.isReturnStatement(n)) {
      st.count += 1;
      if (!n.expression) st.pure = false;                   // 无值 return ⇒ 不能断定它返回的是状态字面量
      else {
        const before = vals.length;
        stringLiteralLeaves(n.expression, vals);
        if (vals.length === before) st.pure = false;        // 这一支不是"只由字面量搭出来"（变量／属性访问／模板插值…）
      }
      return;                                               // return 表达式里不会再有 return
    }
    ts.forEachChild(n, (c) => scanReturns(c, vals, st));
  };
  for (const s of sf.statements) {
    if (!ts.isFunctionDeclaration(s) || !s.name || !s.body) continue;   // 重载签名没有 body，跳过
    const nm = s.name.text;
    if (seen.has(nm)) dup.add(nm);
    seen.add(nm);
    const vals = [];
    const st = { pure: true, count: 0 };
    scanReturns(s.body, vals, st);
    if (st.pure && st.count > 0) out.set(nm, vals);
  }
  dup.forEach((n) => out.delete(n));
  return out;
}

/** 调用侧：对入口函数名，收它所有调用点实参里的 status/state 字面量（对象字面量属性 / 命名属性 patch）。 */
function harvestCallers(src, fileName, fnMeta, fns) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out = [];
  const literalValues = (node, sink) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { sink.push(node.text); return; }
    if (ts.isConditionalExpression(node)) { literalValues(node.whenTrue, sink); literalValues(node.whenFalse, sink); return; }
    if (ts.isParenthesizedExpression(node)) { literalValues(node.expression, sink); return; }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      literalValues(node.left, sink); literalValues(node.right, sink); return;
    }
  };
  const scanObject = (obj) => {
    const found = [];
    const walkObj = (o) => {
      for (const prop of o.properties) {
        if (ts.isSpreadAssignment(prop)) { found.push('__spread__'); continue; }
        if (ts.isShorthandPropertyAssignment(prop)) {
          // 入口侧同样要认简写：`closeRun(db, { patch: { status } })` 里 status 是变量，
          // 它证明"这条链会写状态列"但给不出值 ⇒ 记 __dynamic__（看不见必须单列，不折成没有）。
          const sn = prop.name.text;
          if (sn === 'status' || sn === 'state') found.push('__dynamic__');
          continue;
        }
        if (!ts.isPropertyAssignment(prop)) continue;
        const n = prop.name.getText();
        if (n === 'status' || n === 'state') {
          const sink = [];
          literalValues(prop.initializer, sink);
          if (sink.length) found.push(...sink); else found.push('__dynamic__');
        } else if (n === 'patch' || n === 'outcome') {
          if (ts.isObjectLiteralExpression(prop.initializer)) walkObj(prop.initializer);
          else found.push('__dynamic__');
        }
      }
    };
    walkObj(obj);
    return found;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : null;  // 只认裸调用，属性调用不算（同名方法会跨模块吸值）
      const meta = callee ? fnMeta.get(callee) : null;
      if (meta) argStatusValues(node.arguments[meta.argIndex], meta.keyPath,
        (v, through) => out.push({ via: callee, value: v, through }), fns);
    }
    ts.forEachChild(node, visit);
    return false;
  };
  visit(sf);
  return out;
}

/**
 * V288：类方法入口的调用侧收值。只在**定义该方法的那个类体**内认 `this.<name>(...)`——
 * 跨文件、属性调用（`svc.transition(...)`）、继承来的调用一概不收，宁可少收不猜。
 * 同名类出现多次、或同一个类里该方法定义多次 ⇒ ambiguous，整条不回收（仍算 unresolved）。
 */
// V289：按入口登记的绑定只取"供给状态列的那一个实参"（keyPath 非空时取该对象实参里的 status/state 键）。
// 以前两条回收路都扫全部实参 ⇒ 同一次调用里别的字符串字面（runId/taskId/orgId…）会被当成目标态。
function argStatusValues(argNode, keyPath, push, fns) {
  if (!argNode) return;
  const core = ts.isParenthesizedExpression(argNode) ? argNode.expression : argNode;
  // V296：实参本身是一次同文件顶层函数调用、且那个函数每一条 return 都是字面量 ⇒ 跟一层，
  // 并把被调函数名交给 push 当痕迹（值写在被调函数体里，不是写在调用点）。
  if (!keyPath && fns && ts.isCallExpression(core) && ts.isIdentifier(core.expression)) {
    const got = fns.get(core.expression.text);
    if (got && got.length) { got.forEach((v) => push(v, core.expression.text)); return; }
  }
  if (keyPath) {
    if (!ts.isObjectLiteralExpression(core)) return;
    for (const prop of core.properties) {
      if (!ts.isPropertyAssignment(prop) || prop.name.getText() !== keyPath) continue;
      const inner = ts.isParenthesizedExpression(prop.initializer) ? prop.initializer.expression : prop.initializer;
      if (!ts.isObjectLiteralExpression(inner)) continue;
      for (const ip of inner.properties) {
        if (!ts.isPropertyAssignment(ip)) continue;
        const nm = ip.name.getText();
        if ((nm === 'status' || nm === 'state') && ts.isStringLiteral(ip.initializer)) push(ip.initializer.text);
      }
    }
    return;
  }
  if (ts.isStringLiteral(core)) { push(core.text); return; }
  if (ts.isConditionalExpression(core)) {
    if (ts.isStringLiteral(core.whenTrue)) push(core.whenTrue.text);
    if (ts.isStringLiteral(core.whenFalse)) push(core.whenFalse.text);
  }
}

function harvestMethodCallers(src, fileName, className, methodName, argIndex, keyPath, fns) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const found = [];
  const throughOf = new Map();     // V296：值 → 供给它的被调函数名（痕迹要能指回去复核）
  let ambiguous = false;
  const literalsInto = (node, sink) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { sink.push(node.text); return; }
    if (ts.isConditionalExpression(node)) { literalsInto(node.whenTrue, sink); literalsInto(node.whenFalse, sink); return; }
    if (ts.isParenthesizedExpression(node)) { literalsInto(node.expression, sink); return; }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      literalsInto(node.left, sink); literalsInto(node.right, sink); return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) { found.push('__spread__'); continue; }
        if (ts.isShorthandPropertyAssignment(prop)) {
          if (prop.name.text === 'status' || prop.name.text === 'state') found.push('__dynamic__');
          continue;
        }
        if (!ts.isPropertyAssignment(prop)) continue;
        const n = prop.name.getText();
        if (n === 'status' || n === 'state') { const s = []; literalsInto(prop.initializer, s); if (s.length) found.push(...s); else found.push('__dynamic__'); }
        else if (n === 'patch' || n === 'outcome') literalsInto(prop.initializer, found);
      }
    }
  };
  const classes = [];
  const walkClass = (node) => {
    if (ts.isClassDeclaration(node) && node.name && node.name.text === className) classes.push(node);
    ts.forEachChild(node, walkClass);
  };
  walkClass(sf);
  if (classes.length !== 1) return { values: [], ambiguous: true };
  let defs = 0;
  const walkDefs = (node) => {
    if (ts.isMethodDeclaration(node) && node.name && node.name.getText() === methodName) defs += 1;
    ts.forEachChild(node, walkDefs);
  };
  walkDefs(classes[0]);
  if (defs !== 1) return { values: [], ambiguous: true };
  const walkCalls = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && node.expression.name.text === methodName) {
      argStatusValues(node.arguments[argIndex], keyPath, (v, th) => { found.push(v); if (th) throughOf.set(v, th); }, fns);
    }
    ts.forEachChild(node, walkCalls);
  };
  walkCalls(classes[0]);
  void ambiguous;
  return { values: found.filter((v) => v !== '__dynamic__' && v !== '__spread__'), throughOf, ambiguous: false };
}

/**
 * V310：INSERT 侧也算"能把状态写进这张表"的路径——V299/V309 的轴①②只扫 UPDATE 的 `.set()` 侧，
 * 于是"只在创建时写入"的态（如 `pending_approval`）被误记成无写者，`ewohControlResult` 被误记成"没有状态写点"。
 * 独立一趟扫描，不侵入 harvest 的入口/常量回收逻辑；只认字面量（含三元/||/?? 的字面量分支）。
 */
// 模块级唯一一份（原先在 harvest 内，V310 的 INSERT 侧扫描也要用；留两份就会各自漂）
const nameOf = (n) => (ts.isPropertyAccessExpression(n) ? n.name.text : ts.isIdentifier(n) ? n.text : null);

function harvestInserts(src, fileName, tableSet) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'values' && ts.isCallExpression(n.expression.expression)
        && ts.isPropertyAccessExpression(n.expression.expression.expression)
        && n.expression.expression.expression.name.text === 'insert') {
      const tbl = nameOf(n.expression.expression.arguments[0]);
      if (tbl && tableSet.has(tbl)) {
        const arg = n.arguments[0];
        const objs = arg && ts.isArrayLiteralExpression(arg)
          ? arg.elements.filter(ts.isObjectLiteralExpression)
          : (arg && ts.isObjectLiteralExpression(arg) ? [arg] : []);
        for (const o of objs) {
          let touched = false;
          for (const prop of o.properties) {
            if (!ts.isPropertyAssignment(prop) || !STATE_COLS.has(nameOf(prop.name) || '')) continue;
            touched = true;
            const sink = [];
            stringLiteralLeaves(prop.initializer, sink);
            if (sink.length) sink.forEach((v) => out.push({ table: tbl, value: v, insert: true }));
            else out.push({ table: tbl, value: null, nonliteral: true, insert: true });
          }
          if (!touched) out.push({ table: tbl, noStateCol: true });   // 这条 insert 根本不碰状态列：只算"有写点"证据
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function collect(sources, tableSet) {
  const byTable = new Map();
  const ensure = (t) => {
    if (!byTable.has(t)) byTable.set(t, { direct: new Set(), via: new Map(), unresolved: 0, nonliteral: 0, viaConst: 0, insertN: 0 });
    return byTable.get(t);
  };
  const dynFns = [];
  const constMap = literalConsts(sources);
  const fileParams = new Map();
  for (const [file, src] of sources) fileParams.set(file, paramNamesOf(src, file));
  for (const [file, src] of sources) {
    for (const d of harvestInserts(src, file, tableSet)) {
      if (d.noStateCol) { ensure(d.table); continue; }
      if (d.nonliteral) { ensure(d.table).nonliteral += 1; continue; }
      ensure(d.table).direct.add(d.value); ensure(d.table).insertN += 1;
    }
    const { direct, dynamicFns, dynUnresolved } = harvest(src, file, tableSet);
    for (const d of direct) {
      if (d.nonliteral) {
        // V299 第四档：值是"全扫描面唯一的 const 字符串字面量"时解引用；被形参遮蔽的一律不解（宁可少收）
        const c = d.id && !fileParams.get(file).has(d.id) ? constMap.get(d.id) : null;
        if (c) {
          const bucket = ensure(d.table);
          if (!bucket.via.has(c.value)) bucket.via.set(c.value, new Set());
          bucket.via.get(c.value).add(`const ${d.id} = '${c.value}' @ ${c.file}:${c.line}`);
          bucket.viaConst += 1;
        } else ensure(d.table).nonliteral += 1;
        continue;
      }
      if (!d.value) continue;                       // 这条链根本没碰状态列
      ensure(d.table).direct.add(d.value);
    }
    dynUnresolved.forEach((d) => { ensure(d.table).unresolved += 1; });
    dynamicFns.forEach((d) => dynFns.push({ ...d, file }));
  }
  // 顶层函数入口与类方法入口分两条回收路：前者按裸调用名跨文件收（老行为），后者只认同文件同类。
  const fnMap = new Map();
  for (const [file, src] of sources) fnMap.set(file, literalReturnFns(src, file));
  const trace = (through, entry) => `${through ? `${through}() ← ` : ''}${entry}`;
  const fnMeta = new Map();
  for (const d of dynFns) {
    if (d.kind === 'method') continue;
    const prev = fnMeta.get(d.fn);
    if (prev && (prev.argIndex !== d.argIndex || prev.keyPath !== d.keyPath)) fnMeta.delete(d.fn);   // 同名不同绑定 ⇒ 不猜
    else fnMeta.set(d.fn, { argIndex: d.argIndex, keyPath: d.keyPath });
  }
  if (fnMeta.size) {
    for (const [file, src] of sources) {
      for (const c of harvestCallers(src, file, fnMeta, fnMap.get(file))) {
        const t = dynFns.find((d) => d.fn === c.via && d.kind !== 'method');
        if (!t) continue;
        const bucket = ensure(t.table);
        if (c.value === '__dynamic__' || c.value === '__spread__') { /* 已由 dynUnresolved 计过一次，不重复加 */ }
        else {
          if (!bucket.via.has(c.value)) bucket.via.set(c.value, new Set());
          bucket.via.get(c.value).add(trace(c.through, `${c.via}() @ ${path.basename(file)}`));
        }
      }
    }
  }
  const methodEntries = dynFns.filter((d) => d.kind === 'method');
  for (const m of methodEntries) {
    const src = sources.find(([f]) => f === m.file);
    if (!src) continue;
    const got = harvestMethodCallers(src[1], src[0], m.className, m.fn, m.argIndex, m.keyPath, fnMap.get(m.file));
    if (got.ambiguous) continue;                 // 类名/方法名在本文件里不唯一 ⇒ 不猜，留在 unresolved
    const bucket = ensure(m.table);
    for (const v of got.values) {
      if (!bucket.via.has(v)) bucket.via.set(v, new Set());
      bucket.via.get(v).add(trace(got.throughOf.get(v), `this.${m.fn}() @ ${path.basename(src[0])}#${m.className}`));
    }
  }
  return { byTable, dynFns };
}

function selfTest(tableSet) {
  const S1 = `export async function closeRun(db, input, logger) { await db.update(ewohSchedulingRun).set(input.patch).where(and(eq(runId, 1))); }
              await closeRun(db, { runId: 'r', orgId: 'o', patch: { status: 'succeeded' }, stage: 'persisted' }, log);
              await closeRun(db, { runId: 'r', orgId: 'o', patch: { status: 'failed' } }, log);
              await closeRun(db, { runId: 'r', orgId: 'o', patch: merged }, log);`;
  const S2 = `await db.update(ewohControlCommand).set({ status: 'sent' }).where(eq(id, 1));
              await db.update(ewohControlCommand).set({ status: cond ? 'expired' : 'delivered' }).where(eq(id, 2));`;
  const fails = [];
  let CHECKS = 0;
  const ck = (bad, msg) => { CHECKS += 1; if (bad) fails.push(msg); };
  const c1 = collect([['a.ts', S1]], tableSet);
  const run = c1.byTable.get('ewohSchedulingRun');
  const got1 = run ? [...new Set([...run.direct, ...run.via.keys()])].sort().join(',') : '';
  ck(got1 !== 'failed,succeeded', `入口调用侧收合期望 failed,succeeded，实得「${got1}」`);
  ck(!run || run.unresolved < 1, `传变量的那条 patch 必须计入 unresolved（看不见≠没有）`);
  const c2 = collect([['b.ts', S2]], tableSet);
  const cmd = c2.byTable.get('ewohControlCommand');
  const got2 = cmd ? [...cmd.direct].sort().join(',') : '';
  ck(got2 !== 'delivered,expired,sent', `直接 set 期望 delivered,expired,sent，实得「${got2}」`);
  const c1b = collect([['d.ts', `await db.update(ewohControlCommand).set({ status: cond }).where(eq(id,1));`]], tableSet);
  const cb = c1b.byTable.get('ewohControlCommand');
  ck(!cb || cb.direct.size || !cb.nonliteral, `非字面量值被当成状态进了集合：direct={${cb ? [...cb.direct].join(',') : '—'}} nonliteral=${cb ? cb.nonliteral : 0}`);
  const c1c = collect([['e.ts', `class S { async update(x) { await db.update(ewohSchedulingExecution).set(x).where(eq(id,1)); } }
                        await svc.update({ status: 'running' }); await this.update({ status: 'running' });`]], tableSet);
  const eb = c1c.byTable.get('ewohSchedulingExecution');
  ck(!eb || eb.via.size || eb.unresolved !== 1, `类方法同名 update() 的调用点被误收：via=${eb ? [...eb.via.keys()].join(',') : '—'} unresolved=${eb ? eb.unresolved : 0}`);
  // 反向控制：状态列不在 set 里 ⇒ 不得凭空造出集合元素
  const c3 = collect([['c.ts', `await db.update(ewohAgentTask).set({ taskJson: {} }).where(eq(id,1));`]], tableSet);
  ck(c3.byTable.has('ewohAgentTask'), '非状态写入被算进了目标态集合');
  // V287 一对：简写属性必须算状态写者（开火侧），只简写非状态列不得算（不开火侧）。
  // 这一对钉的是"站点整条消失"那一族——V284 在守卫尺上修过同样的形状，本尺当时没同步。
  const c4 = collect([['f.ts', `async function f(db, status, before) { await db.update(ewohProductionTask)`
    + `.set({ status }).where(and(eq(ewohProductionTask.id, 1), eq(ewohProductionTask.status, before))); }`]], tableSet);
  const tsk = c4.byTable.get('ewohProductionTask');
  ck(!tsk || tsk.direct.size || !tsk.nonliteral,
    `简写 .set({ status }) 必须算状态写者并记成非字面量：direct={${tsk ? [...tsk.direct].join(',') : '—'}} nonliteral=${tsk ? tsk.nonliteral : 0}`);
  const c5 = collect([['g.ts', `async function g(db, assignee) { await db.update(ewohProductionTask)`
    + `.set({ assignee }).where(eq(ewohProductionTask.id, 1)); }`]], tableSet);
  ck(c5.byTable.has('ewohProductionTask'), '只简写非状态列（assignee）不得被算进目标态集合');
  // V288 四支：类方法入口的调用侧回收——同类 this.<method>() 的字面必须收得回、必须留类名痕迹；
  // 别的类同名方法不得吸进来；同文件里类名不唯一时整条不猜（继续留在"看不见"）。
  const S6 = "class Agent { async run(x) { await this.transition('a', 'b', 'in_progress', ['created'], x); }\n"
    + "  private async transition(o, t, target, from, actor) { await db.update(ewohAgentTask)"
    + ".set({ status: target }).where(and(eq(ewohAgentTask.taskId, t), eq(ewohAgentTask.status, from[0]))).returning(); } }\n"
    + "class Other { async go() { await this.transition('x', 'y', 'NOT-A-STATE', 'w', 'v'); }\n"
    + "  private transition(a, b, c, d, e) { return 0; } }";
  const c6 = collect([['h.ts', S6]], tableSet);
  const at = c6.byTable.get('ewohAgentTask');
  ck(!at || !at.via.has('in_progress'),
    `同类 this.<method>() 的字面目标态必须收得回：via=${at ? [...at.via.keys()].join(',') : '—'}`);
  ck(!!at && at.via.has('in_progress') && ![...at.via.get('in_progress')].every((s) => /#Agent$/.test(s)),
    '回收痕迹必须点名是哪个类（否则读者无法复核是从哪处 this.调用收来的）');
  ck(!!at && at.via.has('NOT-A-STATE'), '别的类同名方法的调用点被吸进来了（跨类误收＝集合灌水）');
  // V289：回收必须绑到"供给状态列的那个实参位"——同一次调用里其它字符串实参不是状态。
  ck(!!at && (at.via.has('a') || at.via.has('b')),
    `非状态实参的字面被当成目标态（绑定丢失）：via={${at ? [...at.via.keys()].sort().join(', ') : '—'}}`);
  const S7 = "class Dup { async run(x) { await this.go('one', x); }\n"
    + "  private async go(t, x) { await db.update(ewohAgentTask).set({ status: t }).where(eq(id,1)).returning(); } }\n"
    + "class Dup { async run2(y) { await this.go('two', y); }\n"
    + "  private async go(t, y) { return 0; } }";
  const c7 = collect([['i.ts', S7]], tableSet);
  const at7 = c7.byTable.get('ewohAgentTask');
  ck(!!at7 && (at7.via.has('one') || at7.via.has('two')),
    `类名在本文件不唯一时不得猜：via=${at7 ? [...at7.via.keys()].join(',') : '—'}`);

  // ── V296 五支：被调函数的 return 字面量档（值写在被调函数体里，调用点只有 aggregateControlStatus(…)）──
  // 实物：ControlService#updateRequestStatus 的 status 形参由 aggregateControlStatus 供给，
  // 本尺此前只印「非字面量 1 处」，ewohControlRequest 的目标态集合读成 {approved} 一个。
  const ENTRY = "class T { async run(v) { await this.setIt(%CALL%, v); }\n"
    + "  private async setIt(s, x) { await db.update(ewohAgentTask).set({ status: s })"
    + ".where(eq(ewohAgentTask.id, 1)).returning(); } }";
  const v1 = collect([['v1.ts', "function pick(v) { if (v) return 'alpha'; return 'beta'; }\n"
    + ENTRY.replace('%CALL%', 'pick(v)')]], tableSet);
  const b1 = v1.byTable.get('ewohAgentTask');
  ck(!b1 || !b1.via.has('alpha') || !b1.via.has('beta'),
    `同文件纯字面量返回的被调函数必须回收：via=${b1 ? [...b1.via.keys()].sort().join(',') : '—'}`);
  ck(!!b1 && b1.via.has('alpha') && ![...b1.via.get('alpha')].every((s) => /pick\(\) ← /.test(s)),
    `回收痕迹必须点名被调函数（读者要能指回去复核值写在哪儿）：${b1 && b1.via.has('alpha') ? [...b1.via.get('alpha')].join(' | ') : '（未回收，无从看痕迹）'}`);
  const v2 = collect([['v2.ts', "function leak(v) { if (v) return 'gamma'; return v.other; }\n"
    + ENTRY.replace('%CALL%', 'leak(v)')]], tableSet);
  const b2 = v2.byTable.get('ewohAgentTask');
  ck(!!b2 && b2.via.has('gamma'),
    '被调函数只要有一条 return 不是字面量，整条就必须不跟（半字面量函数被当成可回收＝集合灌水）');
  const v3 = collect([
    ['v3def.ts', "function far(v) { return 'delta'; }"],
    ['v3use.ts', ENTRY.replace('%CALL%', 'far(v)')],
  ], tableSet);
  const b3 = v3.byTable.get('ewohAgentTask');
  ck(!!b3 && b3.via.has('delta'), '被调函数住在别的文件时不得跟（跨文件同名不猜，与类方法那条同一条纪律）');
  const v4 = collect([['v4.ts', "function two(v) { return 'eps'; }\nfunction two(v) { return 'zeta'; }\n"
    + ENTRY.replace('%CALL%', 'two(v)')]], tableSet);
  const b4 = v4.byTable.get('ewohAgentTask');
  ck(!!b4 && (b4.via.has('eps') || b4.via.has('zeta')),
    `同名顶层函数在本文件出现两次时不得猜：via=${b4 ? [...b4.via.keys()].sort().join(',') : '—'}`);

  // ── V296 复核顶出的三条边界（本轮由独立只读复核指出，逐条写成控制；见 §5.3n2 的"复核"一段）──
  const L1 = literalReturnFns("class Holder { m() { function inner(v) { return 'kilo'; } } }", 'l1.ts');
  ck(L1.has('inner'), '类体内的 function 声明不得算顶层（第一版 walk 对类体不早退，这里就是灌水入口）');
  const L2 = literalReturnFns("function outer(v) { const f = () => { return 'nested'; } if (v) return 'top'; return 'other'; }", 'l2.ts');
  ck(!L2.has('outer') || L2.get('outer').includes('nested') || L2.get('outer').length !== 2,
    `体内箭头的 return 不得并进外层的值集：outer=${L2.has('outer') ? JSON.stringify(L2.get('outer')) : '（未登记）'}`);
  const L3 = literalReturnFns("function gg(v) { return v.x; }\nfunction gg(v) { return 'zz'; }", 'l3.ts');
  ck(L3.has('gg'), '同名两次时不得让"第二个恰好纯"静默胜出（撤销要看出现过几次，不看登记成不成功）');
  // 顶层函数入口那条路（harvestCallers）此前没有跨文件夹具——五支控制全在类方法那一路，
  // 这一族补两支：同文件必须收得回（正向），住在别的文件必须收不回（负向），后者不成恒真。
  const FNENTRY = "async function ent(p, db) { await db.update(ewohAgentTask).set({ status: p })"
    + ".where(eq(ewohAgentTask.id, 1)).returning(); }\n"
    + "await ent(externalP('x'), db);";
  const f5 = collect([['f5.ts', "function externalP(v) { return 'ext'; }\n" + FNENTRY]], tableSet);
  const b5 = f5.byTable.get('ewohAgentTask');
  ck(!b5 || !b5.via.has('ext'), `同文件顶层入口的调用点也必须收得回（否则下面那支负向控制是恒真）：via=${b5 ? [...b5.via.keys()].join(',') : '—'}`);
  ck(!!b5 && b5.via.has('ext') && ![...b5.via.get('ext')].every((s) => /externalP\(\) ← ent\(\)/.test(s)),
    `顶层入口路的痕迹要同时点名被调函数与入口：${b5 && b5.via.has('ext') ? [...b5.via.get('ext')].join(' | ') : '—'}`);
  const f6 = collect([
    ['f6def.ts', "function externalP(v) { return 'ext2'; }"],
    ['f6use.ts', FNENTRY],
  ], tableSet);
  const b6 = f6.byTable.get('ewohAgentTask');
  ck(!!b6 && b6.via.has('ext2'), '顶层函数入口那条路也必须绑同文件（跨文件同名不猜，与类方法那一路同一条纪律）');

  // ── V298 两支：入口上溯要穿过匿名回调（实物＝agent.service.ts 的 resolveRow，写在
  //    `db.transaction(async (tx) => …)` 体内，V297 之前那个匿名箭头让上溯直接断掉 ⇒
  //    三个调用侧字面量从没进过集合，这张表在度量里是"空集合"）。──
  const TRANS = "class A {\n"
    + "  async go(x) { await this.resolveRow('a1', 'o', 'approved', x); }\n"
    + "  private async resolveRow(id, org, status, actor) { await this.db.transaction(async (tx) => {\n"
    + "    await tx.update(ewohAgentApproval).set({ status }).where(eq(ewohAgentApproval.id, id)).returning(); }); } }";
  const b7 = collect([['t1.ts', TRANS]], tableSet).byTable.get('ewohAgentApproval');
  ck(!b7 || !b7.via.has('approved'),
    `事务回调体内的写点必须仍归到外层具名方法并可回收：via=${b7 ? [...b7.via.keys()].join(',') : '—'}`);
  // 反向：匿名回调没有具名外层时，不许凭空造一个入口（宁可留在"非字面量"，也不给集合灌水）
  const ORPHAN = "await db.transaction(async (tx) => {\n"
    + "  await tx.update(ewohAgentApproval).set({ status: 'pending' }).where(eq(id, 1)); });";
  const b8 = collect([['t2.ts', ORPHAN]], tableSet).byTable.get('ewohAgentApproval');
  ck(!!b8 && b8.via.has('pending'), '匿名回调若无具名外层，不得凭空登记入口（直接侧字面量仍照收，但不许出现 via 回收）');
  const ORPHAN2 = "let st;\nawait db.transaction(async (tx) => {\n"
    + "  await tx.update(ewohAgentApproval).set({ status: st }).where(eq(id, 1)); });";
  const b9 = collect([['t3.ts', ORPHAN2]], tableSet).byTable.get('ewohAgentApproval');
  ck(!!b9 && b9.via.size, `无具名外层时站点只能留"非字面量"：via=${b9 ? [...b9.via.keys()].join(',') : '—'}`);

  // ── V299 四支：值是"全扫描面唯一的 const 字符串字面量"时的解引用（先量后收，读数见 §5.3n5）──
  const CF = "const K1 = 'alpha';\n"
    + "async function f(db) { await db.update(ewohAgentTask).set({ status: K1 }).where(eq(id, 1)); }";
  const cb1 = collect([['cf1.ts', CF]], tableSet).byTable.get('ewohAgentTask');
  ck(!cb1 || !cb1.via.has('alpha'), `同文件 const 字面量必须解得回：via=${cb1 ? [...cb1.via.keys()].join(',') : '—'}`);
  ck(!!cb1 && cb1.via.has('alpha') && ![...cb1.via.get('alpha')].every((s) => /const K1 = 'alpha' @ cf1\.ts:1/.test(s)),
    `常量档痕迹必须点名常量名、值与定义位置：${cb1 && cb1.via.has('alpha') ? [...cb1.via.get('alpha')].join(' | ') : '—'}`);
  const XF = [['xdf.ts', "export const K2 = 'beta';"],
              ['xuse.ts', "async function g(db) { await db.update(ewohAgentTask).set({ status: K2 }).where(eq(id, 1)); }"]];
  const cb2 = collect(XF, tableSet).byTable.get('ewohAgentTask');
  ck(!cb2 || !cb2.via.has('beta'), '跨文件但全扫描面唯一名的 const 也要解得回（实物＝TASK_PRE_DISPATCH_STATUS）');
  const DUP = "const K3 = 'gamma';\n"
    + "async function h(db) { await db.update(ewohAgentTask).set({ status: K3 }).where(eq(id, 1)); }\n"
    + "async function h2(db) { const K3 = 'delta'; await db.update(ewohProductionTask).set({ status: K3 }); }";
  const cb3 = collect([['dup.ts', DUP]], tableSet);
  ck(!!cb3.byTable.get('ewohAgentTask') && cb3.byTable.get('ewohAgentTask').via.has('gamma'),
    '同名 const 出现两次时不得猜（歧义面必须退回非字面量）');
  const SHADOW = "const S1 = 'zeta';\n"
    + "async function k(db, S1) { await db.update(ewohAgentTask).set({ status: S1 }).where(eq(id, 1)); }";
  const cb4 = collect([['sh.ts', SHADOW]], tableSet).byTable.get('ewohAgentTask');
  ck(!!cb4 && cb4.via.has('zeta'), '被形参遮蔽的标识符不得当常量解（形参那一族由入口回收管，混用＝灌水）');
  const LET = "let LV = 'reassignable';\n"
    + "async function m(db) { await db.update(ewohAgentTask).set({ status: LV }).where(eq(id, 1)); LV = 'other'; }";
  const cb5 = collect([['let.ts', LET]], tableSet).byTable.get('ewohAgentTask');
  ck(!!cb5 && (cb5.via.has('reassignable') || cb5.via.has('other')),
    'let／var 可被再赋值，不得解引用（只认 const；这一支不红说明"只认 const"那道边界没生效）');

  // ── V310 三支：INSERT 的 .values() 侧（含数组形）必须计入，且不得把非状态列当成写入 ──
  const i1 = collect([['i1.ts', "async function f(db) { await db.insert(ewohAgentTask)"
    + ".values({ status: 'created', id: 1 }); }"]], tableSet).byTable.get('ewohAgentTask');
  ck(!(!!i1 && i1.direct.has('created') && i1.insertN === 1),
    `INSERT 单对象形的字面量必须收进集合并计入"经新建"：direct=${i1 ? [...i1.direct].join(',') : '—'} insertN=${i1 ? i1.insertN : '—'}`);
  const i2 = collect([['i2.ts', "async function g(db) { await db.insert(ewohAgentTask)"
    + ".values([{ status: 'pending' }, { status: 'failed' }]); }"]], tableSet).byTable.get('ewohAgentTask');
  ck(!(!!i2 && i2.direct.has('pending') && i2.direct.has('failed')),
    `数组形 values 的每个对象都要扫到：direct=${i2 ? [...i2.direct].join(',') : '—'}`);
  const i3 = collect([['i3.ts', "async function h(db) { await db.insert(ewohAgentTask)"
    + ".values({ resultType: 'x', id: 1 }); }"]], tableSet);
  ck(!(!!i3.byTable.get('ewohAgentTask') && !i3.byTable.get('ewohAgentTask').direct.size),
    '不碰状态列的 INSERT 不得凭空造出目标态');
  const i4 = collect([['i4.ts', "const S = 'queued';\nasync function k(db, S) { await db.insert(ewohAgentTask)"
    + ".values({ status: S }); }"]], tableSet).byTable.get('ewohAgentTask');
  ck(!(!!i4 && !i4.direct.has('queued')), 'INSERT 侧也不解被形参遮蔽的标识符（与 UPDATE 侧同一条纪律）');

  return { checks: CHECKS, fails };
}

function main() {
  const args = process.argv.slice(2);
  const tableSet = new Set(FACTS.map(([k]) => k));
  if (args.includes('--self-test')) {
    const r = selfTest(tableSet);
    r.fails.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(r.fails.length ? `判据自测未全抓到（${r.fails.length}/${r.checks} 失败）` : `判据自测：${r.checks} 类形状逐格对上（含"看不见必须单列"与"非状态写入不得入集合"）`);
    process.exit(r.fails.length ? 1 : 0);
  }
  const afterSources = listTs(SCAN_ROOT).map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')])
    .filter(([f]) => !/\.spec\.ts$/.test(f) && !f.includes('__tests__'));
  const after = collect(afterSources, tableSet);

  let before = null, rev = null;
  if (args.includes('--against')) {
    rev = args[args.indexOf('--against') + 1] || 'HEAD';
    let listed;
    try {
      listed = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', SCAN_REL], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 });
    } catch {
      console.log(`不可判：git ls-tree ${rev} 失败（不把"读不到"当成"集合为空"）`);
      process.exit(3);
    }
    const srcs = listed.split('\n').filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')
      && !/\.spec\.ts$/.test(f) && !f.includes('__tests__'))
      .map((f) => {
        try { return [f, execFileSync('git', ['show', `${rev}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 })]; }
        catch { return [f, '']; }
      }).filter(([, s]) => s);
    before = collect(srcs, tableSet);
    if (!before.byTable.size) { console.log('不可判：旧树一个目标态都没抽到 ⇒ 判据在旧侧不开火'); process.exit(3); }
  }

  const show = (label, c) => {
    console.log(`【${label}】每张权威表"代码能写入的目标态集合"：`);
    for (const [k] of FACTS) {
      const b = c.byTable.get(k);
      if (!b) { console.log(`  ${k}：（本轮无静态可解析的状态写入）`); continue; }
      const direct = [...b.direct].sort();
      const via = [...b.via.keys()].sort();
      // V296：经被调函数回收的那几值是"值写在被调函数体里"的另一档，条数要单列，
      // 否则读者把 经入口 读成"全部来自调用点字面量"。
      const thru = [...b.via.entries()].filter(([, who]) => [...who].some((s) => s.includes(' ← '))).length;
      const viaConst = b.viaConst || 0;
      const insertN = b.insertN || 0;
      console.log(`  ${k}：{${[...new Set([...direct, ...via])].sort().join(', ')}}`
        + `  〔直接 ${direct.length}／经入口 ${via.length}${thru ? `（其中经被调函数 ${thru}）` : ''}`
        + `${viaConst ? `／经具名常量 ${viaConst}` : ''}`
        + `${b.nonliteral ? `／非字面量 ${b.nonliteral} 处（不是状态，不入集合）` : ''}`
        + `${b.unresolved ? `／**看不见** ${b.unresolved} 处` : ''}〕`);
      for (const [v, who] of b.via) console.log(`      · ${v} ← ${[...who].join(', ')}`);
    }
  };
  show('工作树（after）', after);
  if (before) {
    show(`旧树 ${rev}（before）`, before);
    console.log('集合差值（判据②：收口前后语义是否等价）：');
    for (const [k] of FACTS) {
      const setOf = (c) => { const b = c.byTable.get(k); return b ? new Set([...b.direct, ...b.via.keys()]) : new Set(); };
      const bs = setOf(before), as = setOf(after);
      const lost = [...bs].filter((x) => !as.has(x));
      const gained = [...as].filter((x) => !bs.has(x));
      if (!bs.size && !as.size) continue;
      console.log(`  ${k}: before {${[...bs].sort().join(', ')}} → after {${[...as].sort().join(', ')}}`
        + `${lost.length ? `  **丢失 ${lost.join(', ')}**` : ''}${gained.length ? `  新增 ${gained.join(', ')}` : ''}`
        + `${!lost.length && !gained.length ? '（等价）' : ''}`);
    }
    const unres = (c) => [...c.byTable.values()].reduce((n, b) => n + b.unresolved, 0);
    console.log(`  看不见的 patch：before ${unres(before)} 处／after ${unres(after)} 处（单列，不折算成"没有那个态"）`);
  }
  const missing = FACTS.filter(([k]) => !after.byTable.has(k)).map(([k]) => k);
  if (missing.length) console.log(`  边界 A：${missing.length} 张表本轮无静态可解析的状态写入 ⇒ 集合是"未采到"，不是"空"：${missing.join(', ')}`);
  // 边界 B：确有状态写入但集合为空 ⇒ 形状所致（目标态由形参传入 / 入口是类方法 ⇒ 调用侧不收），
  // 与"这张表写不进任何态"是两件事，必须分开印，否则读者会把量具的盲区读成代码的事实。
  const emptyButSeen = FACTS.filter(([k]) => {
    const b = after.byTable.get(k);
    return !!b && !b.direct.size && !b.via.size;
  }).map(([k]) => {
    const b = after.byTable.get(k);
    return `${k}（非字面量 ${b.nonliteral}／看不见 ${b.unresolved}）`;
  });
  if (emptyButSeen.length) console.log(`  边界 B：${emptyButSeen.length} 张表有状态写入但集合为空（目标态走形参或入口是类方法 ⇒ 调用侧不收）：${emptyButSeen.join('、')}`);
}

if (require.main === module) main();
module.exports = { harvest, harvestCallers, harvestMethodCallers, literalReturnFns, literalConsts,  paramNamesOf, stringLiteralLeaves, collect };
