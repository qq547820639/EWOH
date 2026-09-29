#!/usr/bin/env node
/**
 * 副本普查（V129 起，试点第 19 号量具）：用 AST（不用正则猜）把"把一张表的字段值写进另一张表"
 * 的位点逐条判定，并**如实报告静态可枚举面只有多大**——这份读数的用途是给"能不能建副本一致性门禁"
 * 定上限，而不是给出一个可以直接钉住的清单（可见面 ~13%，其中能归因来源表的更少）。
 * 复算入口：`make chain-baseline-copy-census`（先跑 17 项判据自测，再出全仓读数）。
 *
 * 判定链（每步都可解释、可核对）：
 *  1. 目标表：`.update(T)` / `.insert(T)` / `.delete(T)` 的实参是 schema.ts 里的 pgTable 导出变量；
 *  2. 写入列：紧跟其后的 `.set({...})` / `.values({...})`，或 upsert 的
 *     `.onConflictDoUpdate({ set: {...} })`（Drizzle 两种写入形状，缺一不可）；
 *  3. 来源：属性值是 `obj.col` 形状时，在同一函数体内找 `obj` 的声明，
 *     声明初始化里若有 `.from(T2)` ⇒ 来源表 = T2（conf=var，硬证据）；
 *     若整个函数只有唯一一处 `.from(T2)` ⇒ 标 conf=fn-unique（函数级归因，只作线索不作结论）；
 *     变量声明里查了多张表 ⇒ conf=multi；函数内多处 `.from` 且归因不到变量 ⇒ conf=ambiguous；
 *     函数内没有 `.from` ⇒ conf=no-source（参数传入、外部作用域）。
 *  4. 分类：srcTable !== destTable ⇒ 跨表副本候选（按置信度分档报告，不混成一个数）。
 *
 * 用法：node scripts/chain-baseline/copy-census.cjs [--self-test] [--verbose]
 * 退出码：0 正常；1 判据不成立（解析异常 / 自测未抓到 / 计数器有死桶）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require(path.join(process.cwd(), 'ewoh-spark-app', 'node_modules', 'typescript'));

const ROOT = process.cwd();
const SELF = process.argv.includes('--self-test');
const VERBOSE = process.argv.includes('--verbose');
const SCHEMA = path.join(ROOT, 'ewoh-spark-app/server/database/schema.ts');
const SRV = path.join(ROOT, 'ewoh-spark-app/server');
/** 状态/聚合族列——投影一致性只在"一个表的值被抄成另一个表的状态或统计量"时才成问题。 */
const STATEISH = /(^|_)(status|state|count|total|sum|score|rate|ratio|percent|json|snapshot|version|summary|verdict|result|duration|elapsed|metric)/;
const WRITE_METHODS = ['update', 'insert', 'delete'];

function parseSchema(src) {
  const varToTable = new Map();
  const re = /export const (\w+) = pgTable\("([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) varToTable.set(m[1], m[2]);
  return varToTable;
}

function walkTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'test', '__tests__'].includes(e.name)) continue;
      walkTs(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function enclosingFunction(node) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return n;
    n = n.parent;
  }
  return null;
}

/** 剥掉不影响取值的包装：括号、as/ satisfies/ 非空断言。 */
function unwrap(e) {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)
    || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  return n;
}

/**
 * 写入列的"值从哪来"形状分类。这一层决定检测器能看见多少副本：
 * 只有 `member`（`x.field`，且 x 是标识符）能被归因到来源表；`identifier`（先赋给局部变量再写）、
 * `shorthand`、`call`、`deep-member`（`a.b.c` / `this.x.y`）、`await`、`expr`、`index`、
 * `composite`、`literal`、`spread` 都是**检测器看不见**的通路——必须数出来，
 * 否则"普查到 1 处"会被读成"只有 1 处"，那正是 V128 要避免的那种误读。
 */
function classifyInit(init) {
  if (ts.isPropertyAccessExpression(init)) {
    if (ts.isIdentifier(init.expression)) return 'member';
    return 'deep-member';
  }
  if (ts.isIdentifier(init)) return 'identifier';
  if (ts.isCallExpression(init)) return 'call';
  if (ts.isAwaitExpression(init)) return 'await';
  if (ts.isElementAccessExpression(init)) return 'index';
  if (ts.isConditionalExpression(init) || ts.isBinaryExpression(init) || ts.isPrefixUnaryExpression(init)
    || ts.isPostfixUnaryExpression(init)) return 'expr';
  if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isTemplateExpression(init)
    || ts.isTemplateHead(init) || ts.isNoSubstitutionTemplateLiteral(init)) return 'composite';
  if (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || init.kind === ts.SyntaxKind.TrueKeyword
    || init.kind === ts.SyntaxKind.FalseKeyword || init.kind === ts.SyntaxKind.NullKeyword
    || ts.isBigIntLiteral(init)) return 'literal';
  return 'other';
}

/**
 * 函数内的"局部别名/解绑"事实表：`const st = row.status`、`const { status } = row`、
 * `const [r] = await db.select().from(T)`、`const r = await db.select().from(T)...` 四类。
 * 用途：把 `set({ status: st })` / `set({ status })` 这类**值形状是标识符或简写**的写入列
 * 追一跳回到来源表。只跟一跳（V88 的同一口径），并且必须把"一跳后仍归因不到"单独记账，
 * 不许静默丢弃。
 */
function collectVarFacts(fnNode, varToTable) {
  /** @type {Map<string, {table: string|null, field: string|null, objVar: string|null, via: string}>} */
  const facts = new Map();
  const tableOfExpr = (e) => {
    if (!e) return null;
    const tabs = [];
    const v = (x) => {
      if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.arguments[0]
        && ts.isIdentifier(x.arguments[0]) && x.expression.name.text === 'from') tabs.push(x.arguments[0].text);
      ts.forEachChild(x, v);
    };
    v(e);
    const uniq = [...new Set(tabs)].map((t) => varToTable.get(t) || null);
    return uniq.length === 1 ? uniq[0] : null;
  };
  const objOfExpr = (e) => {
    if (!e) return null;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return { objVar: e.expression.text, field: e.name.text };
    return null;
  };
  const bind = (target, init) => {
    if (ts.isIdentifier(target)) {
      const oe = objOfExpr(init);
      if (oe) facts.set(target.text, { table: null, field: oe.field, objVar: oe.objVar, via: 'alias' });
      else {
        const t = tableOfExpr(init);
        if (t) facts.set(target.text, { table: t, field: null, objVar: null, via: 'query' });
      }
      return;
    }
    if (!ts.isObjectBindingPattern(target) && !ts.isArrayBindingPattern(target)) return;
    // `const { a, b } = row` / `const [r] = await q`：把每个绑定名挂到同一个来源上
    const oe = objOfExpr(init);
    // 右侧是**已在前面绑定过的变量**时继承它（`const order = await q.from(T)` 之后的 `const { status } = order`）：
    // 不继承就会把最常见的"解绑后再简写写入"整条通路判成不可见。
    const inh = !oe && ts.isIdentifier(init) ? (facts.get(init.text) || null) : null;
    const t = oe ? null : (inh ? (inh.table || null) : tableOfExpr(init));
    const objVar = oe ? oe.objVar : (inh ? inh.objVar : null);
    if (!oe && !t && !inh) return;
    for (const el of target.elements) {
      if (!ts.isBindingElement(el) || !ts.isIdentifier(el.propertyName ?? el.name)) continue;
      const nm = (el.propertyName ?? el.name).text;
      if (ts.isObjectBindingPattern(target)) {
        const fld = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : nm;
        facts.set(nm, (objVar && !t) ? { table: null, field: fld, objVar, via: 'objbind-alias' }
          : { table: t, field: fld, objVar: null, via: 'objbind-query' });
      } else {
        facts.set(nm, (objVar && !t) ? { table: null, field: null, objVar, via: 'arrbind-alias' }
          : { table: t, field: null, objVar: null, via: 'arrbind-query' });
      }
    }
  };
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) || ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) {
        let init = unwrap(n.initializer);
        if (ts.isAwaitExpression(init)) init = unwrap(init.expression);
        bind(n.name, init);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return facts;
}

/** 沿调用链往回走：链上是否出现 update/insert/delete（是"写入语句"，与表能否解析无关）。 */
function chainHasWrite(startNode) {
  let cur = startNode;
  while (cur) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)
      && WRITE_METHODS.includes(cur.expression.name.text)) return true;
    cur = ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
  }
  return false;
}

/** 沿同一调用链找目标表；解析不到返回 null（表未映射或不是 schema 变量）。 */
function destFromChain(startNode, varToTable) {
  let cur = startNode;
  while (cur) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)
      && WRITE_METHODS.includes(cur.expression.name.text)
      && cur.arguments[0] && ts.isIdentifier(cur.arguments[0])) {
      const t = varToTable.get(cur.arguments[0].text);
      if (t) return t;
    }
    cur = ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
  }
  return null;
}

function collectFromTables(fnNode) {
  // 函数体内所有 `变量 = ... .from(T)` 的归因表 + 全量 .from(T) 列表
  const byVar = new Map();
  const all = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'from') {
      const arg = n.arguments[0];
      if (ts.isIdentifier(arg)) all.push(arg.text);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const inner = [];
      const v2 = (x) => {
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
          && x.arguments[0] && ts.isIdentifier(x.arguments[0]) && x.expression.name.text === 'from') inner.push(x.arguments[0].text);
        ts.forEachChild(x, v2);
      };
      v2(n.initializer);
      if (inner.length) byVar.set(n.name.text, [...new Set(inner)]);
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return { byVar, all: [...new Set(all)] };
}

/**
 * 纯函数：一份源码 → 副本位点判定 + 写入面总账（varToTable 由调用方注入，自测可用合成 schema）。
 *
 * 为什么必须带总账：只报"普查到 N 处"就等于把"看不见"静默算成"不存在"。分类账分开记：
 *   judged        可判定形状（对象字面量 / upsert 的 set 字面量），逐列判了；
 *   blind         写入面上但形状判定不了（`.set(payload)` 传变量）；
 *   unmappedWrite 写入链上的表不在 schema.ts 映射里（legacy/有意不映射，见 NEST-513 那类）；
 *   nonWriteNamed 名字相同但链上没有写入方法（HTTP 头 `.set('x-request-id')`、Map.set 等）⇒ 不进分母。
 */
function censusFile(label, text, varToTable) {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const stat = { suspectExcluded: [], suspectTmp: 0, writeFaces: 0, judged: 0, blind: 0, unmappedWrite: 0, nonWriteNamed: 0, upsertFaces: 0, upsertJudged: 0, upsertBlind: 0, props: 0,
    hop1Resolved: 0, hop1Unresolved: 0, noLocalFact: 0,
    kinds: { member: 0, 'deep-member': 0, identifier: 0, call: 0, await: 0, index: 0, expr: 0, composite: 0, literal: 0, other: 0, shorthand: 0, spread: 0 } };
  const fromsOf = (n) => {
    const fn = enclosingFunction(n);
    return fn ? { ...collectFromTables(fn), facts: collectVarFacts(fn, varToTable) }
      : { byVar: new Map(), all: [], facts: new Map() };
  };
  const recordProps = (literal, dest, froms) => {
    const facts = froms.facts;
    // 归因优先级：变量声明里直接 .from(T)（direct）> 一跳局部别名/解绑（hop1）> 函数级唯一 .from（低置信）。
    const attribute = (name) => {
      if (froms.byVar.has(name)) {
        const t = froms.byVar.get(name);
        if (t.length === 1) return { srcTable: varToTable.get(t[0]) || null, conf: 'var', via: 'direct' };
        return { srcTable: null, conf: 'multi', via: 'direct' };
      }
      const f = facts.get(name);
      if (f) {
        if (f.table) return { srcTable: f.table, conf: 'hop1', via: 'hop1' };
        if (f.objVar && froms.byVar.has(f.objVar)) {
          const t = froms.byVar.get(f.objVar);
          if (t.length === 1) return { srcTable: varToTable.get(t[0]) || null, conf: 'hop1', via: 'hop1' };
          return { srcTable: null, conf: 'multi', via: 'hop1' };
        }
        if (f.objVar) return { srcTable: null, conf: 'hop1-no-table', via: 'hop1' };
      }
      if (froms.all.length === 1) return { srcTable: varToTable.get(froms.all[0]) || null, conf: 'fn-unique', via: 'direct' };
      if (froms.all.length > 1) return { srcTable: null, conf: 'ambiguous', via: 'direct' };
      return { srcTable: null, conf: 'no-source', via: 'direct' };
    };
    const push = (col, srcVar, srcCol, a, line0, kind) => {
      const line = sf.getLineAndCharacterOfPosition(line0.getStart(sf)).line + 1;
      out.push({ dest, col, srcVar, srcCol, srcTable: a.srcTable, conf: a.conf, via: a.via, kind, at: `${label}:${line}` });
      if (a.via === 'hop1') { if (a.srcTable) stat.hop1Resolved++; else stat.hop1Unresolved++; }
    };
    for (const prop of literal.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        stat.kinds.shorthand++;
        const nm = prop.name.text;
        if (facts.has(nm)) {
          const f = facts.get(nm);
          push(nm, nm, f.field || nm, attribute(nm), prop, 'shorthand');
        } else stat.noLocalFact++;
        continue;
      }
      if (ts.isSpreadAssignment(prop)) { stat.kinds.spread++; continue; }
      if (!ts.isPropertyAssignment(prop)) { stat.kinds.other++; continue; }
      stat.props++;
      const init = unwrap(prop.initializer);
      const kind = classifyInit(init);
      stat.kinds[kind]++;
      const col = ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (!col) continue;
      if (kind === 'member') {
        const srcVar = init.expression.text;
        push(col, srcVar, init.name.text, attribute(srcVar), prop, 'member');
      } else if (kind === 'identifier') {
        // `const st = row.status; set({ status: st })`——值形状是局部别名，一跳可回表
        if (facts.has(init.text)) push(col, init.text, facts.get(init.text).field || col, attribute(init.text), prop, 'identifier');
        else stat.noLocalFact++;
      }
    }
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const meth = n.expression.name.text;
      const recv = n.expression.expression;
      // 形状 ①：.set() / .values()
      if (meth === 'set' || meth === 'values') {
        if (!chainHasWrite(recv)) {
          stat.nonWriteNamed++;
          // 被排除的同名调用里，凡是接收方"像数据库句柄"（db/tx/trx/query/conn/drizzle 或链上有 .select/.update/.insert）
          // 都要逐条列出来——否则"排除 303 处没有误伤"这句话只是作者的自信，不是可复算的读数。
          const rt = recv.getText(sf).replace(/\s+/g, ' ');
          if (/\bdb|\btx\b|trx|query|conn|database|drizzle|\.select\(|\.update\(|\.insert\(/i.test(rt)) {
            stat.suspectExcluded.push(`${label}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${rt.slice(0, 60)}`);
          }
        } else {
          stat.writeFaces++;
          const dest = destFromChain(recv, varToTable);
          const isLiteral = n.arguments.length === 1 && ts.isObjectLiteralExpression(n.arguments[0]);
          if (!isLiteral) {
            stat.blind++;
          } else if (dest === null) {
            stat.unmappedWrite++;
            recordProps(n.arguments[0], null, fromsOf(n));
          } else {
            stat.judged++;
            recordProps(n.arguments[0], dest, fromsOf(n));
          }
        }
      }
      // 形状 ②：.onConflictDoUpdate({ set: {...} })
      if (meth === 'onConflictDoUpdate') {
        stat.upsertFaces++;
        const arg = n.arguments[0];
        const setProp = ts.isObjectLiteralExpression(arg)
          ? arg.properties.find((p) => ts.isPropertyAssignment(p)
            && (ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : '') === 'set')
          : null;
        const dest = destFromChain(recv, varToTable);
        if (setProp && ts.isObjectLiteralExpression(setProp.initializer)) {
          stat.upsertJudged++;
          recordProps(setProp.initializer, dest, fromsOf(n));
        } else {
          stat.upsertBlind++;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { rows: out, suspectExcluded: stat.suspectExcluded, ...stat };
}

if (SELF) {
  const VARS = new Map([['ewohOrder', 'ewoh_order'], ['ewohSummary', 'ewoh_summary'], ['ewohOther', 'ewoh_other']]);
  const SRC = `
async function a1(db: any, rows: any[]) {
  const order = await db.select().from(ewohOrder).where(x);
  await db.update(ewohSummary).set({ status: order.status, note: order.note });
}
async function a2(db: any, incoming: any) {
  await db.insert(ewohSummary).values({ status: incoming.status });
}
async function a3(db: any) {
  const x = await db.select().from(ewohOrder).where(y);
  const z = await db.select().from(ewohOther).where(w);
  await db.update(ewohSummary).set({ status: z.status });
}
// multi：同一变量声明里查了两张表 ⇒ 不许挑一张
async function a4(db: any) {
  const both = await db.select().from(ewohOrder).union(db.select().from(ewohOther));
  await db.update(ewohSummary).set({ score: both.score });
}
// fn-unique：函数内只有一处 .from，但来源变量是入参 ⇒ 只能函数级归因，标低置信
async function a5(db: any, row: any) {
  const only = await db.select().from(ewohOrder).where(q);
  await db.update(ewohSummary).set({ status: row.status });
}
// ambiguous：函数内两处 .from 且都不在变量声明里 ⇒ 不许归因到任一表
async function a6(db: any, row: any) {
  await log(db.select().from(ewohOrder));
  await keep(db.select().from(ewohOther));
  await db.update(ewohSummary).set({ verdict: row.verdict });
}
// 形状外：.set(变量) 判定不了，但必须记进 blind 而不是消失
async function a7(db: any, payload: any) {
  await db.update(ewohSummary).set(payload);
  await db.update(ewohSummary).set({ ...payload, status: payload.status });
}
// upsert 形：set 是**属性**不是方法——只有形状 ② 的检测器能看见
async function a8(db: any) {
  const src = await db.select().from(ewohOrder).where(u);
  await db.insert(ewohSummary).values({ count_total: 0 })
    .onConflictDoUpdate({ target: ewohSummary.id, set: { count_total: src.count_total } });
}
// 同名非写入调用：HTTP 头 .set() 不许进写入面分母
async function a9(res: any) {
  res.set('x-request-id', 'abc');
}
// 排除项抽查的负向控制：链上没有 update/insert，但接收方像数据库句柄 ⇒ 必须被点名（证明"0 误伤"是可复算读数而非自信）
async function a9b() {
  await this.dbClient.set({ status: 'x' });
}
// 未映射表上的写入：链上有 update 但表不在 schema 映射里 ⇒ 单列记账
async function a10(db: any) {
  const src = await db.select().from(ewohOrder).where(v);
  await db.update(ewohLegacyNotMapped).set({ status: src.status });
}
// 值形状分桶：每种"看不见"的通路都要被数出来（检测器可见的只有 member 那一格）
async function a11(db: any, o: any, n: number, count: number, arr: string[]) {
  await db.update(ewohSummary).set({
    status: o.status,
    state: o.deep.field,
    count_a: n,
    total_b: compute(n),
    sum_c: await fetchIt(),
    score_d: arr[0],
    rate_e: n > 1 ? 1 : 2,
    json_f: { a: 1 },
    snapshot_g: 'fixed',
    metric_new: new Date(),
    ...o.rest,
    verdict: o.verdict as string,
    count,
  });
}
// hop1 ①：标量别名 const st = order.status → set({ status: st })
async function b1(db: any) {
  const order = await db.select().from(ewohOrder).where(x);
  const st = order.status;
  await db.update(ewohSummary).set({ status: st });
}
// hop1 ②：对象解绑 const { status } = order → 简写 set({ status })
async function b2(db: any) {
  const order = await db.select().from(ewohOrder).where(x);
  const { status } = order;
  await db.update(ewohSummary).set({ status });
}
// hop1 ③：数组解构自查询 const [run] = await db.select().from(T) → set({ status: run.status })
async function b3(db: any) {
  const [run] = await db.select().from(ewohOrder).where(x);
  await db.update(ewohSummary).set({ status: run.status });
}
// hop1 追不到表：别名来自入参对象，记 hop1Unresolved 而不凭空造来源
async function b4(db: any, src: any) {
  const st = src.status;
  await db.update(ewohSummary).set({ status: st });
}
`;
  const r = censusFile('fixture.ts', SRC, VARS);
  const res = r.rows;
  let bad = 0;
  const t = (name, ok, detail) => { console.log(`${ok ? '✅' : '❌'} 自测 ${name}${detail ? ` :: ${detail}` : ''}`); if (!ok) bad++; };
  const sigAll = res.filter((x) => STATEISH.test(x.col));
  t('①跨表副本被识别（order.status → ewoh_summary，源表解析到 ewoh_order）',
    res.some((x) => x.col === 'status' && x.srcTable === 'ewoh_order' && x.dest === 'ewoh_summary' && x.conf === 'var'),
    JSON.stringify(res.filter((x) => x.col === 'status').map((x) => [x.at, x.dest, x.srcTable, x.conf])));
  // 双向断言：note 必须"被记录后被 STATEISH 筛掉"——只断言"结果里没有"会把"漏扫"误证成"过滤正确"。
  t('②非状态族列被记录后被筛掉（双向：raw 有 note ⇒ 不是漏扫；sig 无 note ⇒ 过滤成立）',
    res.some((x) => x.col === 'note') && !sigAll.some((x) => x.col === 'note'),
    `raw=${res.length}（note ${res.filter((x) => x.col === 'note').length}）sig=${sigAll.length}`);
  t('③参数来源且函数内无 .from ⇒ no-source，不硬造来源',
    res.some((x) => x.srcVar === 'incoming' && x.conf === 'no-source' && x.srcTable === null),
    JSON.stringify(res.filter((x) => x.srcVar === 'incoming').map((x) => [x.conf, x.srcTable])));
  t('④变量声明查两表 ⇒ multi，不许挑一张',
    res.some((x) => x.srcVar === 'both' && x.conf === 'multi' && x.srcTable === null),
    JSON.stringify(res.filter((x) => x.srcVar === 'both').map((x) => [x.conf, x.srcTable])));
  t('⑤函数级唯一 .from 但来源是入参 ⇒ fn-unique（低置信，不得混进硬证据）',
    res.some((x) => x.srcVar === 'row' && x.col === 'status' && x.conf === 'fn-unique' && x.srcTable === 'ewoh_order'),
    JSON.stringify(res.filter((x) => x.srcVar === 'row' && x.col === 'status').map((x) => [x.conf, x.srcTable])));
  t('⑥函数内多处 .from 且无法归因 ⇒ ambiguous',
    res.some((x) => x.srcVar === 'row' && x.col === 'verdict' && x.conf === 'ambiguous'),
    JSON.stringify(res.filter((x) => x.srcVar === 'row' && x.col === 'verdict').map((x) => [x.conf, x.srcTable])));
  t('⑦upsert 的 set 属性被判定（只有形状 ② 检测器能抓到 count_total: src.count_total）',
    res.some((x) => x.col === 'count_total' && x.dest === 'ewoh_summary' && x.srcTable === 'ewoh_order' && x.conf === 'var')
    && r.upsertFaces === 1 && r.upsertJudged === 1,
    `upsertFaces=${r.upsertFaces} upsertJudged=${r.upsertJudged} 实测 ${JSON.stringify(res.filter((x) => x.col === 'count_total').map((x) => [x.dest, x.srcTable, x.conf]))}`);
  t('⑧同名非写入调用不进写入面（HTTP 头 .set 记为 nonWriteNamed）',
    r.nonWriteNamed === 2 && !res.some((x) => x.col === 'x-request-id'),
    `nonWriteNamed=${r.nonWriteNamed}`);
  t('⑰排除项抽查会响：像数据库句柄的被排除调用必须逐条点名（"无误伤"要可复算）',
    r.suspectExcluded.length === 1 && /dbClient/.test(r.suspectExcluded[0]),
    JSON.stringify(r.suspectExcluded));
  t('⑨形状外写入被记为 blind 而不是消失（a7 的 set(payload)）',
    r.blind === 1, `blind=${r.blind}（writeFaces=${r.writeFaces} judged=${r.judged}）`);
  t('⑩未映射表上的写入单列记账（不混进已判定，也不混进同名调用）',
    r.unmappedWrite === 1, `unmappedWrite=${r.unmappedWrite}`);
  // 判据链的每一桶都要有夹具：桶里没有位点 = 这条判据从未被验证过，读数就不可信。
  const CONFS = ['var', 'no-source', 'multi', 'fn-unique', 'ambiguous'];
  const hit = new Set(res.map((x) => x.conf));
  const dead = CONFS.filter((b) => !hit.has(b));
  t(`⑪置信度桶全部有夹具经过（${CONFS.join('/')}）`, dead.length === 0,
    `实测 ${JSON.stringify([...hit].sort())}${dead.length ? `｜死桶 ${dead.join(',')}` : ''}`);
  const ZEROS = ['writeFaces', 'judged', 'blind', 'unmappedWrite', 'nonWriteNamed', 'upsertFaces', 'upsertJudged', 'hop1Resolved', 'hop1Unresolved', 'noLocalFact'].filter((k) => r[k] === 0);
  t('⑫写入面计数器无死桶（每类账都有夹具触发）', ZEROS.length === 0,
    ZEROS.length ? `未触发 ${ZEROS.join(',')}` : JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'rows' && k !== 'kinds'))));
  // 值形状分桶必须逐项对上夹具真值：只断言"非零"会让"把 identifier 误并入 member"这类错误过关。
  const EXPECT = { member: 13, 'deep-member': 1, identifier: 3, call: 1, await: 1, index: 1, expr: 1, composite: 1, literal: 2, other: 1, shorthand: 2, spread: 2 };
  const kd = Object.keys(EXPECT).filter((k) => r.kinds[k] !== EXPECT[k]);
  t('⑬写入列值形状逐项对上夹具真值（member 是可归因形状，其余是不可见通路）',
    kd.length === 0, kd.length ? kd.map((k) => `${k} 期望${EXPECT[k]} 实得${r.kinds[k]}`).join('｜') : JSON.stringify(r.kinds));
  // 分区恒等式：判定行 = member 行 + identifier 行 + shorthand 行；一跳命中数 = 非 member 行 + 其中走一跳的 member 行。
  const byKind = (k) => res.filter((x) => x.kind === k).length;
  const memberHop = res.filter((x) => x.kind === 'member' && x.via === 'hop1').length;
  t('⑭分区恒等式：行数按值形状对账（member 13 / identifier 2 / shorthand 1），一跳命中不重复计',
    res.length === byKind('member') + byKind('identifier') + byKind('shorthand')
    && byKind('member') === EXPECT.member && byKind('identifier') === 2 && byKind('shorthand') === 1
    && r.hop1Resolved + r.hop1Unresolved === byKind('identifier') + byKind('shorthand') + memberHop,
    `rows=${res.length} member=${byKind('member')}（其中走一跳 ${memberHop}）identifier=${byKind('identifier')} shorthand=${byKind('shorthand')} hop1=${r.hop1Resolved}/${r.hop1Unresolved}`);
  t('⑮一跳解析：三种局部形状都回得到表，且追不到表时记 hop1Unresolved 而不是造来源',
    r.hop1Resolved === 3 && r.hop1Unresolved === 1
    && res.filter((x) => x.conf === 'hop1' && x.srcTable === 'ewoh_order' && x.dest === 'ewoh_summary').length === 3
    && res.some((x) => x.conf === 'hop1-no-table' && x.srcTable === null),
    `hop1Resolved=${r.hop1Resolved} hop1Unresolved=${r.hop1Unresolved} noLocalFact=${r.noLocalFact} 位点 ${JSON.stringify(res.filter((x) => x.via === 'hop1').map((x) => [x.at.split(':').pop(), x.col, x.srcVar, x.srcTable, x.conf]))}`);
  // 增量对照：同一份夹具在"关掉一跳"的旧口径下少几条——证明加深买到的是覆盖，不是换个说法多报几条。
  const directOnly = res.filter((x) => x.via === 'direct' && x.srcTable).length;
  const withHop = res.filter((x) => x.srcTable).length;
  t('⑯增量可证：with-hop 归因数严格大于 direct-only（差值即一跳买到的位点数）',
    withHop > directOnly, `direct-only=${directOnly} with-hop=${withHop} 增量=${withHop - directOnly}`);
  console.log(bad ? `副本普查判据自测：不通过（${bad} 项）` : '副本普查判据自测：通过（18 项）');
  process.exit(bad ? 1 : 0);
}

const varToTable = parseSchema(fs.readFileSync(SCHEMA, 'utf8'));
if (varToTable.size < 80) throw new Error(`schema 只解析出 ${varToTable.size} 个表变量 ⇒ 解析器不成立，读数作废`);
const files = walkTs(SRV);
const rows = [];
const acc = { suspectExcluded: [], writeFaces: 0, judged: 0, blind: 0, unmappedWrite: 0, nonWriteNamed: 0, upsertFaces: 0, upsertJudged: 0, upsertBlind: 0, props: 0,
  kinds: { member: 0, 'deep-member': 0, identifier: 0, call: 0, await: 0, index: 0, expr: 0, composite: 0, literal: 0, other: 0, shorthand: 0, spread: 0 } };
for (const f of files) {
  const r = censusFile(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'), varToTable);
  rows.push(...r.rows);
  for (const k of Object.keys(acc)) if (k !== 'kinds' && k !== 'suspectExcluded') acc[k] += r[k];
  acc.suspectExcluded.push(...r.suspectExcluded);
  for (const [k, v] of Object.entries(r.kinds)) acc.kinds[k] += v;
}
const byKindN = (k) => rows.filter((x) => x.kind === k).length;
const sig = rows.filter((r) => STATEISH.test(r.col));
const cross = sig.filter((r) => r.dest && r.srcTable && r.srcTable !== r.dest);
const same = sig.filter((r) => r.dest && r.srcTable && r.srcTable === r.dest);
const unresolved = sig.filter((r) => !r.srcTable);
const noDest = sig.filter((r) => !r.dest);
// 分档报告：硬证据（变量声明归因）与低置信（函数级唯一 .from 的猜测）不得混成一个数——
// V128 的教训正是"清单是样本就不能报召回"；这里"档位不同"同理，混档等于再造一个不可信分母。
const crossHard = cross.filter((r) => r.conf === 'var');
const crossLow = cross.filter((r) => r.conf === 'fn-unique');
const totalFaces = acc.writeFaces + acc.upsertFaces;
const totalJudged = acc.judged + acc.upsertJudged;

console.log(`schema 表变量 ${varToTable.size} 个｜解析 ${files.length} 个 .ts（不含 spec/test/__tests__）`);
console.log(`写入面总账 ${totalFaces} 处：判定 ${totalJudged}（普通 ${acc.judged} + upsert ${acc.upsertJudged}）`);
console.log(`  形状外不判定 ${acc.blind + acc.upsertBlind}｜表未映射 ${acc.unmappedWrite}｜同名非写入调用（不进分母）${acc.nonWriteNamed}，其中"接收方像数据库句柄"的抽查 = ${acc.suspectExcluded.length}${acc.suspectExcluded.length ? '（逐条列出，需人工判定是否误伤）' : '（⇒ 排除无误伤，此项为常驻读数）'}`);
for (const t of acc.suspectExcluded) console.log(`    ⚠️ 可疑排除 ${t}`);
console.log(`写入列总数 ${acc.props + acc.kinds.shorthand + acc.kinds.spread} 处（键值 ${acc.props} + 简写 ${acc.kinds.shorthand} + 展开 ${acc.kinds.spread}）`);
const allProps = acc.props + acc.kinds.shorthand + acc.kinds.spread;
const invisible = allProps - acc.kinds.member;
console.log(`  值形状：可归因 member ${acc.kinds.member}｜不可见通路 ${invisible}（局部变量 ${acc.kinds.identifier}、深层 ${acc.kinds['deep-member']}、函数调用 ${acc.kinds.call}、await ${acc.kinds.await}、下标 ${acc.kinds.index}、表达式 ${acc.kinds.expr}、复合 ${acc.kinds.composite}、字面量 ${acc.kinds.literal}、简写 ${acc.kinds.shorthand}、展开 ${acc.kinds.spread}、其他 ${acc.kinds.other}）`);
const hopRows = rows.filter((x) => x.via === 'hop1' && x.srcTable).length;
const directRows = rows.filter((x) => x.via !== 'hop1' && x.srcTable).length;
const visN = acc.kinds.member + byKindN('identifier') + byKindN('shorthand');
console.log(`  ⇒ 可见面（direct-only，只看 x.field 形状）= ${acc.kinds.member}/${allProps} = ${(acc.kinds.member * 100 / allProps).toFixed(1)}%`);
console.log(`  ⇒ 加一跳局部别名/解绑后 = ${visN}/${allProps} = ${(visN * 100 / allProps).toFixed(1)}%｜其中真正带回来源表的位点：一跳 ${hopRows} 条 vs direct-only ${directRows} 条`);
console.log(`  ⇒ 剩余 ${allProps - visN} 列的值来自调用结果/表达式/字面量/展开，需数据流分析才谈得上判定；"普查到 N 处"只是可见面内的数，不得读成全仓副本数`);
console.log(`逐列判定 ${rows.length} 处（member ${acc.kinds.member} + 别名/解绑命中 ${byKindN('identifier') + byKindN('shorthand')}）｜状态/聚合族列 ${sig.length} 处`);
console.log(`  跨表副本候选 ${cross.length}＝硬证据 ${cross.filter((r)=>r.conf==='var').length}（conf=var）+ 一跳 ${cross.filter((r)=>r.conf==='hop1').length}（conf=hop1）+ 函数级 ${crossLow.length}（conf=fn-unique，只作线索）`);
console.log(`  同表内拷贝 ${same.length}｜来源未解析 ${unresolved.length}｜目标表未解析 ${noDest.length}`);
const byConf = {};
for (const r of sig) byConf[r.conf] = (byConf[r.conf] || 0) + 1;
console.log(`  置信度分布 ${JSON.stringify(byConf)}`);
const grouped = new Map();
for (const r of cross) {
  const k = `${r.srcTable} → ${r.dest}.${r.col}`;
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(`${r.at}(${r.conf})`);
}
console.log(`\n跨表副本组合 ${grouped.size} 种：`);
for (const [k, v] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k}  ×${v.length}${VERBOSE ? '' : `  例 ${v[0]}`}`);
  if (VERBOSE) for (const s of v) console.log(`      ${s}`);
}
const groupedHard = new Map([...grouped].map(([k, v]) => [k, v.filter((s) => s.endsWith('(var)'))]).filter(([, v]) => v.length));
console.log(`\n其中"硬证据（conf=var）"的组合 ${groupedHard.size} 种：`);
for (const [k, v] of [...groupedHard.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k}  ×${v.length}${VERBOSE ? '' : `  例 ${v[0]}`}`);
  if (VERBOSE) for (const s of v) console.log(`      ${s}`);
}
fs.writeFileSync(path.join(ROOT, 'tmp/copy-census.json'), JSON.stringify(
  { acc, sig, cross, crossHard, crossLow, same, unresolved: unresolved.length }, null, 1));
console.log('\n机器可读结果：tmp/copy-census.json');
