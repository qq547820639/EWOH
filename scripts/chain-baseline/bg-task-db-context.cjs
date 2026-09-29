#!/usr/bin/env node
/**
 * 后台周期任务的数据库上下文判据（V208 候选，只出读数，不接共享门禁）。
 * 一问：**服务端每个 setInterval 站点在"没有人调它"的情况下自己跑起来时，它碰数据库的那几行
 * 是不是带着能看见权威事实的上下文？**
 *
 * 为什么值得机检（V207 实测 WORKER-05）：`ApprovalExpiryWorkerService.tick()` 调服务内部的跨租户
 * `SELECT DISTINCT org_id FROM ewoh_event`，后台无请求上下文而该表开 RLS ⇒ 返回 0 行且不报错，
 * 授权到期提醒在生产里从未产出过一条。同一形状的**约定**仓里早就写过
 * （`simulator/retention.service.ts` 2026-08-19「读空删空（静默失效）」）⇒ 约定有、强制无。
 *
 * 四种被认可的上下文形态（逐个都在本仓真实存在，不是设想）：
 *   ctx-tx      触点被 `runInTransaction` / `systemGlobalAdminTransaction` / `systemTransaction` 包住。
 *               **注意：上下文是调用方建立的**，所以 inTx 必须沿调用路径向下继承
 *               （worker 里包一层、真正碰库的是 service 的方法体；只从触点往上走祖先会把它误判成 red——
 *                这条是本量具第一版自测就顶出来的错法）。
 *   definer-fn  该条 SQL 读的是 SECURITY DEFINER 受控函数（`ewoh_open_andon_orgs()` 等，授权在库里）
 *   own-pool    用的是本地 `postgres(...)` 另开的句柄（表 owner 默认绕过 RLS）；另报有无 fail-closed
 *   no-db       这个周期站点根本不碰数据库
 * 判 red 只有一种：走注入的 drizzle/运行时句柄**且**上面三种都不成立 ⇒ `bare-runtime-handle`。
 *
 * V210 补上三样（V208 那 5 处假 red 的盲点来源，登记在 §5.3fh 与 BGCTX-02）：
 *   ① 二跳包装跟随：「private withGuc(op){ return this.rdb.systemGlobalAdminTransaction(op) }」
 *      这类**本类内**包装，其调用点实参闭包按已在事务内处理；
 *   ② 库侧 RLS 事实：触点落到物理表后，查仓内唯一权威量具 `scripts/audit-unrls-tenant-tables.js`
 *      （「含 org_id 却显式裁决不开 RLS」的清单）＋ schema 里有没有 orgId 列
 *      ⇒ 新增一档 `bare-nonrls-only`（没上下文也不会有"静默读空"）；**事实取不到时一律不清 red**；
 *   ③ 噪声分诊：本地／相对 import 的裸函数要展开（原实现只"有名字就闭嘴"⇒ 那是假 green 面）、
 *      `new Date().toISOString()` 不得伪装成裸调用、形参回调（`return op()`）不算解不开、
 *      数组型数据成员不算解不开、接口注入**唯一实现**才跟随（多实现照旧不可判并点名实现数）。
 * 解不开的调用单列 `indeterminate`，既不折算成 ok 也不折算成 red。Σ档位 == 分母，硬断言。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

let ROOT = path.resolve(__dirname, '../..');
if (!fs.existsSync(path.join(ROOT, 'ewoh-spark-app'))) ROOT = path.resolve(__dirname, '..');
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');

const TX_WRAPPERS = ['runInTransaction', 'systemGlobalAdminTransaction', 'systemTransaction'];
// `db.transaction(cb)` 只开事务、**不设租户 GUC**，所以它算一次 DB 触点（要不要红由形态判），
// 不能当成"已经有上下文"的豁免形态。
const DRIZZLE_METHODS = ['execute', 'insert', 'update', 'delete', 'select', 'transaction'];
const POOL_METHODS = ['unsafe', 'query', 'begin', 'release'];
const MAX_DEPTH = 6;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}
function eachClass(sf, fn) {
  (function visit(n) {
    if (ts.isClassDeclaration(n) && n.name) fn(n);
    ts.forEachChild(n, visit);
  })(sf);
}
/** 接口名 → 实现它的类（唯一实现才敢跟随；多实现不猜）。 */
function ifaceImplementations(files) {
  const m = new Map();
  for (const f of files) {
    const sf = parse(f);
    eachClass(sf, (c) => {
      for (const hc of c.heritageClauses || []) {
        if (hc.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const t of hc.types) {
          const name = t.expression.getText();
          const cur = m.get(name) || [];
          cur.push({ file: f, cls: c.name.text });
          m.set(name, cur);
        }
      }
    });
  }
  return m;
}

/** 类名 → 文件（重名标 dup，跨文件解析时宁可 indeterminate）。 */
function classIndex(files) {
  const idx = new Map();
  for (const f of files) {
    const sf = parse(f);
    eachClass(sf, (c) => {
      const name = c.name.text;
      const cur = idx.get(name);
      if (!cur) idx.set(name, f);
      else if (cur !== f) idx.set(name, null);
    });
  }
  return idx;
}
function findClass(sf, className) {
  let hit = null;
  eachClass(sf, (c) => { if (!hit && c.name.text === className) hit = c; });
  return hit;
}
function memberMaps(sf, className) {
  const methods = new Map(), props = new Map(), ctor = new Map();
  const cls = findClass(sf, className);
  if (!cls) return { methods, props, ctor };
  for (const m of cls.members) {
    if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.body) methods.set(m.name.text, m);
    if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
      props.set(m.name.text, m.type ? m.type.getText() : null);
      if (m.initializer) props.set(m.name.text + '#init', m.initializer.getText());
    }
  }
  const c = cls.members.find((m) => ts.isConstructorDeclaration(m));
  if (c) {
    for (const p of c.parameters) {
      if (!p.name || !ts.isIdentifier(p.name)) continue;
      const mods = (p.modifiers || []).map((x) => x.getText());
      const owned = mods.some((x) => ['private', 'public', 'protected', 'readonly'].includes(x));
      if (owned && p.type) ctor.set(p.name.text, p.type.getText().replace(/<[\s\S]*$/, '').trim());
    }
  }
  return { methods, props, ctor };
}
function ownerClass(sf, node) {
  let cur = node;
  while (cur) {
    if (ts.isClassDeclaration(cur) && cur.name) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

/** 接收者像不像一个数据库句柄（第一版把 `this.store.update(...)`、`this.seenEventIds.delete(...)`
 *  这种内存结构也算成 DB 触点 ⇒ 三个红里两个是假的。名字白名单 + 声明里的类型/初值）。 */
const DB_NAME_RE = /^(db|drizzle|database|client|pool|sql|conn|sqlx)$/i;
function receiverKind(name, ctor, props) {
  const type = ctor.get(name) || props.get(name) || '';
  const init = props.get(name + '#init') || '';
  if (/postgres\s*\(/.test(init)) return 'pool';
  if (DB_NAME_RE.test(name) || /drizzle|database/i.test(type)) return 'drizzle-or-injected';
  return null;
}
/** 同文件里的函数/箭头常量体（SQL 常由 `buildXxxQuery()` 这种 helper 拼装，只看调用点参数会漏判 definer-fn）。 */
function helperBodies(sf) {
  if (sf.__helpers) return sf.__helpers;
  const m = new Map();
  (function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) m.set(n.name.text, n.getText());
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) m.set(n.name.text, n.initializer.getText());
    ts.forEachChild(n, visit);
  })(sf);
  sf.__helpers = m;
  return m;
}
/** 顶层函数/箭头函数的**节点**（V210：原 `helperBodies` 只存文本，用来"闭嘴"而不展开 ⇒
 *  本地 helper 里藏的触点会被静默放过，那是假 green）。 */
function helperNodes(sf) {
  if (sf.__helperNodes) return sf.__helperNodes;
  const m = new Map();
  (function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) m.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) m.set(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  })(sf);
  sf.__helperNodes = m;
  return m;
}

/** 本文件的具名 import → 本地文件绝对路径（解析不到算 local-unresolved），非相对说明符算 external。 */
function importMap(sf) {
  if (sf.__imports) return sf.__imports;
  const map = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.name) continue;
    const spec = String(st.moduleSpecifier.text);
    const named = st.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    let file = null;
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(sf.fileName), spec);
      file = [base + '.ts', path.join(base, 'index.ts')].find((c) => fs.existsSync(c)) || null;
    }
    for (const e of named.elements) map.set(e.name.text, file ? { file } : { external: !spec.startsWith('.') });
  }
  sf.__imports = map;
  return map;
}

/** 该名字的调用是否落在"它自己是某个函数形参"的作用域里（`private withGuc(op){ … return op() … }`）。 */
function isParameterOfEnclosing(node, name) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      return p.parameters.some((d) => d.name && ts.isIdentifier(d.name) && d.name.text === name);
    }
  }
  return false;
}

function sqlText(sf, ch) {
  let text = ch.arguments.map((a) => a.getText()).join(' ');
  for (const a of ch.arguments) {
    let nm = null;
    if (ts.isIdentifier(a)) nm = a.text;
    else if (ts.isCallExpression(a) && ts.isIdentifier(a.expression)) nm = a.expression.text;
    if (!nm) continue;
    const body = helperBodies(sf).get(nm);
    if (body) text += ' ' + body;
    for (const inner of (body || '').matchAll(/([A-Za-z0-9_$]+)\s*\(/g)) {
      const b2 = helperBodies(sf).get(inner[1]);
      if (b2) text += ' ' + b2;
    }
  }
  return text;
}

/** 本类里"body 内部调用过 TX 包装"的方法名（`private withGuc(op){ return this.rdb.systemGlobalAdminTransaction(op) }`
 *  这类**回调解耦**的二跳包装）。不跟随它 ⇒ 明明有上下文的站点被判 red（V208 五处假 red 之一），
 *  而同一形状的假 green 也就无从判起 ⇒ 这根轴必须先能看见。 */
const CTX_METHOD_CACHE = new Map();
function ctxMethodNames(sf, cls) {
  const key = `${sf.fileName}#${cls}`;
  if (CTX_METHOD_CACHE.has(key)) return CTX_METHOD_CACHE.get(key);
  const names = new Set();
  if (cls) {
    const { methods } = memberMaps(sf, cls);
    for (const [name, node] of methods) {
      (function visit(n) {
        if (ts.isCallExpression(n)) {
          const t = n.expression.getText().replace(/\s+/g, '');
          if (TX_WRAPPERS.some((w) => t === w || t.endsWith('.' + w))) names.add(name);
        }
        ts.forEachChild(n, visit);
      })(node);
    }
  }
  CTX_METHOD_CACHE.set(key, names);
  return names;
}

/** 从周期回调出发按调用路径闭包展开；inTx 沿路径继承（上下文由调用方建立）。 */
function reach(rootSf, rootClass, start, cidx, iidx) {
  const cache = new Map([[rootSf.fileName, rootSf]]);
  const getSf = (f) => { if (!cache.has(f)) cache.set(f, parse(f)); return cache.get(f); };
  const seen = new Set();
  const hits = [];
  const unresolved = [];
  const unionNotes = [];   // 多实现接口取并集时记下跟了哪几个实现
  const external = [];
  const wrapperOf = (node) => {
    const t = node.expression.getText();
    return TX_WRAPPERS.find((w) => t === w || t.endsWith('.' + w)) || null;
  };
  (function visit(sf, node, depth, inTx) {
    if (!node || depth > MAX_DEPTH) return;
    // 去重键必须用 getStart()：TS 的 `node.pos` 含前导 trivia，`stmt` 与它的唯一子表达式
    // （如 `void this.tick();` 里的 VoidExpression）pos 相同 ⇒ 拿 pos 当键会把递归直接掐死
    // （夹具的正例因此零命中、自测 4/8；这类"量具自己看不见"的错法比误报更危险）。
    const key = sf.fileName + ':' + node.getStart(sf) + ':' + node.end;
    if (seen.has(key)) return;
    seen.add(key);
    const cls = ownerClass(sf, node) || rootClass;
    if (process.argv.includes('--debug')) console.error('TRACE visit', path.basename(sf.fileName), ts.SyntaxKind[node.kind], 'd=' + depth, 'cls=' + cls, 'inTx=' + inTx);
    const { methods, props, ctor } = memberMaps(sf, cls);
    ts.forEachChild(node, (ch) => {
      if (process.argv.includes('--debug')) console.error('  child', path.basename(sf.fileName), ts.SyntaxKind[ch.kind], ts.isCallExpression(ch) ? ch.expression.getText() : '');
      if (!ts.isCallExpression(ch)) { visit(sf, ch, depth, inTx); return; }
      // `this.tick().catch(...这类 promise 链：外层成员调用不是新事实，回到里层那个调用再看
      let call = ch;
      while (ts.isPropertyAccessExpression(call.expression) && ts.isCallExpression(call.expression.expression)) {
        call = call.expression.expression;
      }
      // 跨行链式写法（`await this.db\n  .select()...`）的 getText() 里带换行：不先把空白折掉，
      // `^this\\.[A-Za-z0-9_$]+$` 这类正则永远不命中，真实触点会被报成"未解析的成员调用"
      // （本轮 9 处 indeterminate 里 8 处是这个形状）。再截到第一个 `(` 之前，留下最左接收者链。
      const callee = call.expression.getText().replace(/\s+/g, '').replace(/\?\./g, '.').split('(')[0];
      // 二跳包装：`this.withGuc(() => …)` 的上下文在 withGuc **体内**建立，所以实参闭包必须按
      // "已在事务内"处理；不跟随这一跳 ⇒ 有上下文的站点被判 red（V208 五处假 red 的形状之一）。
      // 只跟随**本类内**的包装（仓内真实形状）；跨类"传回调给别人的包装方法"仍是盲区，写在限度里。
      const selfMethod = /^this\.([A-Za-z0-9_$]+)$/.exec(callee);
      const viaCtxMethod = Boolean(selfMethod) && ctxMethodNames(sf, cls).has(selfMethod[1]);
      const ctxForArgs = Boolean(wrapperOf(call)) || viaCtxMethod || inTx;
      for (const a of call.arguments) visit(sf, a, depth + 1, ctxForArgs);
      const two = /^this\.([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)$/.exec(callee);
      const one = /^this\.([A-Za-z0-9_$]+)$/.exec(callee);
      const rec = {
        line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1,
        // sql 取**整条链**的原文而不是被拆开后那一层的实参：`this.db.select().from(t)` 的表名在 `.from(...)` 里，
        // 只留 `select()` 的实参就永远认不出表 ⇒ RLS 事实无从判（V210 实测卡在 outbox／workbench 两站）。
        callee, inTx: Boolean(inTx), sql: ch.getText().replace(/\s+/g, ' ').slice(0, 400), srcFile: sf.fileName,
      };
      const isDbMethod = two && (DRIZZLE_METHODS.includes(two[2]) || POOL_METHODS.includes(two[2]));
      const kind = two ? receiverKind(two[1], ctor, props) : (one ? receiverKind(one[1], ctor, props) : null);
      if (two && kind && isDbMethod) {
        hits.push({ ...rec, recv: 'this.' + two[1], handle: kind, init: props.get(two[1] + '#init') || null });
      } else if (two && ctxForArgs && wrapperOf(call)) {
        // 上下文包装调用本身（`this.rdb.runInTransaction(settings, cb)`）不是 DB 触点，
        // 而且 rdb/db 这类句柄常标成 any ⇒ 不往 unresolved 里塞噪声。
      } else if (two && (ctor.get(two[1]) || (props.get(two[1]) && /^[A-Z]/.test(props.get(two[1]))))) {
        const typeName = ctor.get(two[1]) || props.get(two[1]);
        const target = cidx.get(typeName);
        if (target) {
          const tsf = getSf(target);
          const sub = memberMaps(tsf, typeName).methods.get(two[2]);
          if (sub) visit(tsf, sub, depth + 1, ctxForArgs);
          else unresolved.push(`${typeName}.${two[2]} 方法未找到`);
        } else if (/^(Map|Set|Array|Promise|Date|Object|Function|string|number|boolean)$/.test(typeName) || /\[\]$/.test(typeName)) {
          // 内建容器成员、以及**数组型数据成员**（`devices: DeviceRuntime[]`）：不是 DB 触点，也不算解不开
        } else if ((iidx.get(typeName) || []).length === 1) {
          // 接口注入且唯一实现 ⇒ 可以跟随（V210：`sink: AuditLogSink` 这类此前顶住了 4/12 个站点）
          const impl = iidx.get(typeName)[0];
          const tsf = getSf(impl.file);
          const sub2 = memberMaps(tsf, impl.cls).methods.get(two[2]);
          if (sub2) visit(tsf, sub2, depth + 1, ctxForArgs);
          else unresolved.push(`${impl.cls}.${two[2]} 方法未找到（${typeName} 的唯一实现）`);
        } else if ((iidx.get(typeName) || []).length > 1) {
          // 多实现接口：**不猜是哪一个，而是取并集**——每个实现都跟进去看触点。
          // 对"有没有人裸碰 RLS 表"这个问题，并集是**安全的上界**：只会看到更多触点，
          // 既不会替代码编造上下文，也不会因为"选错实现"而漏红。代价是可能把"实际不会被注入的那一支"
          // 也算进来 ⇒ 判红时按"存在一支裸碰"说，不按"这一支一定被用"说。
          const impls = iidx.get(typeName);
          let followed = 0;
          for (const impl of impls) {
            const tsf = getSf(impl.file);
            const sub3 = memberMaps(tsf, impl.cls).methods.get(two[2]);
            if (sub3) { visit(tsf, sub3, depth + 1, ctxForArgs); followed += 1; }
          }
          if (!followed) unresolved.push(`${two[1]}:${typeName} 的 ${impls.length} 个实现都没有 ${two[2]} 方法`);
          else unionNotes.push(`${two[1]}:${typeName} 取 ${impls.length} 个实现的并集（${impls.map((x) => x.cls).join('/')}）`);
        } else {
          unresolved.push(`${two[1]}:${typeName} 实现文件不定（无类、无接口实现）`);
        }
      } else if (two && /^(any|unknown)$/.test(ctor.get(two[1]) || props.get(two[1]) || '')) {
        unresolved.push(`${callee} 接收者标成 any ⇒ 看不见它碰不碰库`);
      } else if (two) {
        // 数据成员上的普通方法（`this.buf.slice(1)`）不是 DB 触点，也不算解不开
      } else if (one && methods.has(one[1])) {
        visit(sf, methods.get(one[1]), depth + 1, ctxForArgs);
      } else if (one && kind) {
        hits.push({ ...rec, recv: 'this.' + one[1], handle: kind });
      } else if (one) {
        // `this.someField()`：既不是方法也不是句柄，留在"看不见"里但不算解不开的协作者
      } else if (/^this\./.test(callee)) {
        unresolved.push(`未解析的成员调用 ${callee}`);
      } else if (/^[A-Za-z0-9_$]+$/.test(callee) && !/\bnew\s/.test(call.expression.getText())
        && !['require', 'Number', 'String', 'Boolean', 'Array', 'Set', 'Map', 'Date', 'Object', 'JSON', 'parseInt', 'isNaN'].includes(callee)) {
        // 注意：`new Date().toISOString()` 这类"构造结果的成员调用"经"折空白＋截到第一个 ("归一后
        // 会变成裸调用 `newDate`，而仓里根本没有这个函数 ⇒ 必须先按原文里有没有 `new ` 排掉，
        // 否则每个 worker 都背着一条假"解不开"（V210 实测：这一条噪声顶住了 9/12 个站点）。
        // V210：裸调用分三种处置——本地定义要**展开**（原实现只靠 helperBodies 有名字就闭嘴 ⇒
        // helper 里藏的触点会被静默放过）；相对 import 解析到文件后同样展开；
        // 从包导入的构造器（drizzle 的 `eq/or/sql`、`randomUUID` 等）不跟随但**不阻塞判决**，
        // 因为 DB 句柄只能来自构造注入或本文件的 `postgres(...)`，包里的纯函数造不出句柄（记在限度里）。
        const local = helperNodes(sf).get(callee);
        const imp = importMap(sf).get(callee);
        if (local) visit(sf, local, depth + 1, ctxForArgs);
        else if (imp && imp.file) {
          const tsf = getSf(imp.file);
          const fn = helperNodes(tsf).get(callee);
          if (fn) visit(tsf, fn, depth + 1, ctxForArgs);
          else unresolved.push(`${callee} 从相对路径导入，但目标文件里没有顶层定义（可能是类静态方法）`);
        } else if (imp && imp.external) external.push(callee);
        else if (isParameterOfEnclosing(call, callee)) {
          // 包装方法体里 `return op()` 那种"把形参当函数调"：回调内容**已经在调用点展开过**，
          // 在这里再算一条"解不开"只会把已经判对的站点顶成不可判（V210 实测卡在 channel-dispatcher）。
          external.push(`${callee}(形参回调，内容在调用点展开)`);
        }
        else if (!helperBodies(sf).has(callee)) unresolved.push(`裸调用 ${callee}() 既不在本文件定义、也没有可解析的 import`);
      }
    });
  })(rootSf, start, 0, false);
  return { hits, unresolved, external: [...new Set(external)], union: unionNotes };
}

function formsOf(hit) {
  const forms = [];
  if (hit.inTx) forms.push('ctx-tx');
  if (/ewoh_[a-z0-9_]+["'`]?\s*\(/.test(hit.sql)) forms.push('definer-fn');
  if (hit.handle === 'pool') forms.push('own-pool'); // 声明初值里有 postgres( 才算本地句柄（见 receiverKind）
  return forms;
}

function analyze(root, facts) {
  CTX_METHOD_CACHE.clear(); // 夹具会在同一批路径上改写文件后复算 ⇒ 缓存必须随 analyze 作废
  DYN_TABLE_CACHE.clear();  // 同上：动态表句柄的同文件字面量索引
  const stbl = (facts && facts.stbl) || new Map();
  const files = walk(path.join(root, 'ewoh-spark-app/server'));
  const cidx = classIndex(files);
  const iidx = ifaceImplementations(files);
  const sites = [];
  for (const f of files) {
    const sf = parse(f);
    const src = fs.readFileSync(f, 'utf8');
    (function visit(n) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'setInterval') {
        const cb = n.arguments[0];
        const cls = ownerClass(sf, n);
        const { hits, unresolved, external = [], union = [] } = cb
          ? reach(sf, cls, cb, cidx, iidx)
          : { hits: [], unresolved: ['setInterval 无回调实参'], external: [], union: [] };
        const withForms = hits.map((h) => ({ ...h, forms: formsOf(h) }));
        const bare = withForms.filter((h) => h.forms.length === 0);
        for (const h of bare) h.rls = rlsOf(h, stbl, facts || {});
        const risky = bare.filter((h) => h.rls === 'rls');
        const unknown = bare.filter((h) => h.rls === 'unknown');
        const forms = new Set(withForms.flatMap((h) => h.forms));
        let verdict;
        let indKind = null;
        if (withForms.length === 0 && unresolved.length === 0) verdict = 'no-db';
        else if (risky.length > 0) verdict = 'bare-runtime-handle';
        else if (unresolved.length > 0 && bare.length === 0) { verdict = 'indeterminate'; indKind = '解不开的路径里可能有触点（本站点没确认到任何 DB 触点）'; }
        else if (unknown.length > 0) { verdict = 'indeterminate'; indKind = `${unknown.length} 处触点的表名认不出 ⇒ RLS 事实不可判`; }
        else if (unresolved.length > 0) { verdict = 'indeterminate'; indKind = `确认到 ${bare.length} 处 bare 且都被库侧事实判为无害，但另有 ${unresolved.length} 条解不开的路径可能藏着别的触点`; }
        else if (bare.length > 0) verdict = 'bare-nonrls-only';
        else verdict = [...forms].sort().join('+') || 'no-db';
        sites.push({
          file: path.relative(root, f),
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          cls, verdict, indKind, hits: withForms, bare: bare.length, risky: risky.length, unknownRls: unknown.length,
          external: external.length, externalNames: external.slice(0, 6),
          failClosed: /if\s*\(\s*!\s*this\.[A-Za-z0-9_$]+\s*\)/.test(src),
          unresolved: [...new Set(unresolved)],
          unionNotes: [...new Set((union || []))],
        });
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return sites;
}

/** drizzle 符号 → 物理表名与"有没有 orgId 列"。只用来把触点落到表上，不参与 RLS 判决。 */
function schemaTables(root) {
  const map = new Map();
  for (const f of walk(path.join(root, 'ewoh-spark-app/server'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*pgTable\(\s*['"`]([^'"`]+)['"`]/g)) {
      const start = m.index;
      const end = src.indexOf('\n});', start) < 0 ? src.length : src.indexOf('\n});', start);
      map.set(m[1], { phys: m[2], orgId: /\borgId\s*:/.test(src.slice(start, end)) });
    }
  }
  return map;
}

/**
 * 「含 org_id 却**故意**不开 RLS」的表清单——一律取仓内唯一权威量具 `scripts/audit-unrls-tenant-tables.js`
 * 的现场输出，不在本件里重抄一份解析（V208/V209 两次实测：自己重写的正则把 107 读成 64、把 118 读成 113）。
 * 该量具本身 fail-closed 断言"每张含 org_id 的表要么开 RLS、要么在这张清单里"，所以
 * `orgId ∧ ¬清单 ⇒ RLS 之下` 这条推论是它给的，不是我猜的。取不到 ⇒ 事实不可得，**不**清任何 red。
 */
function rlsAllowlist(root) {
  try {
    const out = require('child_process').execFileSync(
      process.execPath, [path.join('scripts', 'audit-unrls-tenant-tables.js')],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const set = new Set();
    for (const m of out.matchAll(/·\s+([a-z0-9_]+)（org_id，RLS\s+off）/g)) set.add(m[1]);
    const declared = Number(/未开 RLS\s+(\d+)\s+张/.exec(out)?.[1] ?? NaN);
    if (!Number.isFinite(declared) || declared !== set.size) {
      return { ok: false, reason: `解析到 ${set.size} 条，但量具自报 ${out.match(/未开 RLS\s+\d+\s+张/)?.[0] || '无表头'}` };
    }
    return { ok: true, set, header: out.split('\n')[0].trim() };
  } catch (e) {
    return { ok: false, reason: `调用权威量具失败：${String(e.message).slice(0, 90)}` };
  }
}

/** 一次触点碰到哪些表：drizzle 用符号（`.from(ewohNotification)`），裸 SQL 用物理表名。
 *  一个都认不出 ⇒ unknown（不许折算成"没碰 RLS 表"）。 */
/* 动态表句柄：`.from(cfg.table)` 这类"表名不在 SQL 文本里、而在注册表对象字面量里"的写法。
 * 解析口径：只认**同一文件内** `table: <drizzle 符号>` 的字面量并集（V215 的并集同一方向：只会多看触点，
 * 不会少看）。跨文件的注册表仍然 unknown——宁可留一条不可判，不许靠猜把 red 清掉。 */
const DYN_TABLE_CACHE = new Map();
function dynTableProps(file) {
  if (DYN_TABLE_CACHE.has(file)) return DYN_TABLE_CACHE.get(file);
  const out = new Map();
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { src = ''; }
  for (const m of src.matchAll(/(?:^|[{,\s])([A-Za-z0-9_$]+)\s*:\s*([A-Za-z0-9_$]+)\s*(?:[,}]|$)/gm)) {
    if (!out.has(m[1])) out.set(m[1], new Set());
    out.get(m[1]).add(m[2]);
  }
  DYN_TABLE_CACHE.set(file, out);
  return out;
}

function touchedTables(hit, stbl) {
  const sql = hit.sql || '';
  const found = [];
  for (const [sym, info] of stbl) {
    if (new RegExp(`\\b${sym}\\b`).test(sql) || new RegExp(`\\b${info.phys}\\b`).test(sql)) found.push(info);
  }
  if (found.length === 0) {
    // 直读认不出 ⇒ 再试动态句柄 `.from(<recv>.<prop>)`，按同文件字面量取并集
    for (const m of sql.matchAll(/\.from\(\s*[A-Za-z0-9_$]+\.([A-Za-z0-9_$]+)\s*\)/g)) {
      const names = [...(dynTableProps(hit.srcFile).get(m[1]) || [])].filter((n) => stbl.has(n));
      const tables = names.map((n) => stbl.get(n)).filter(Boolean);
      if (!tables.length) continue;
      found.push(...tables);
      hit.dynFrom = m[1];
      hit.dynSymbols = names.join('/');
    }
  }
  return found;
}

/** RLS 事实：rls（无上下文会静默读空）／safe（不受租户约束）／unknown。 */
function rlsOf(hit, stbl, facts) {
  if (!facts.allow?.ok) return 'unknown';
  const t = touchedTables(hit, stbl);
  if (t.length === 0) return 'unknown';
  let sawRls = false;
  for (const info of t) {
    if (!info.orgId) continue;                        // 无 orgId 列 ⇒ 无从按租户过滤
    else if (facts.allow.set.has(info.phys)) continue; // 显式裁决过"故意不开"
    else sawRls = true;
  }
  return sawRls ? 'rls' : 'safe';
}

/* ---------------- 判据自测（一次性夹具树）：一条必须开火 + 五条必须按预期不开火 ---------------- */
function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgctx-'));
  const sv = path.join(root, 'ewoh-spark-app/server/modules');
  fs.mkdirSync(sv, { recursive: true });
  const w = (rel, body) => {
    const p = path.join(sv, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  const IMPORT = `declare const setInterval: any, postgres: any, buildGucSettings: any, process: any;\n`;

  w('bad/a.worker.ts', IMPORT + `
import { BadService } from './bad.service';
export class AWorker { constructor(private readonly bad: BadService) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.bad.list(); } }
`);
  w('bad/bad.service.ts', IMPORT + `
export class BadService { constructor(private readonly db: any) {}
  async list() { return this.db.execute('SELECT DISTINCT org_id FROM ewoh_event'); } }
`);
  w('ok1/ok1.worker.ts', IMPORT + `
import { Ok1Service } from './ok1.service';
export class BWorker { constructor(private readonly rdb: any, private readonly svc: Ok1Service) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() {
    await this.rdb.systemGlobalAdminTransaction(async () => await this.svc.list());
    await this.rdb.runInTransaction(buildGucSettings({}), async () => await this.svc.sweep());
  } }
`);
  w('ok1/ok1.service.ts', IMPORT + `
export class Ok1Service { constructor(private readonly db: any) {}
  async list() { return this.db.execute('SELECT 1 FROM ewoh_event'); }
  async sweep() { return this.db.execute('SELECT 2 FROM ewoh_event'); } }
`);
  w('ok2/ok2.worker.ts', IMPORT + `
import { Ok2Service } from './ok2.service';
export class CWorker { constructor(private readonly svc: Ok2Service) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.svc.orgs(); } }
`);
  w('ok2/ok2.service.ts', IMPORT + `
export class Ok2Service { constructor(private readonly db: any) {}
  async orgs() { return this.db.execute('SELECT org_id FROM "ewoh_open_andon_orgs"($1)'); } }
`);
  w('ok3/ok3.worker.ts', IMPORT + `
export class DWorker {
  private readonly client = process.env.OWNER_URL ? postgres(process.env.OWNER_URL) : null;
  init() { setInterval(() => { void this.clean(); }, 3600000); }
  private async clean() { if (!this.client) return; await this.client.unsafe('DELETE FROM t'); } }
`);
  w('ok4/ok4.worker.ts', IMPORT + `
export class EWorker { private buf: number[] = [];
  init() { setInterval(() => { this.buf = this.buf.slice(1); void new Date().toISOString(); }, 1000); } }
`);
  w('ok5/ok5.worker.ts', IMPORT + `
declare function unknownHelper(): void;
export class FWorker { init() { setInterval(() => { void unknownHelper(); }, 300000); } }
`);
  // —— V210 新增对照：二跳包装跟随 与 库侧 RLS 事实 ——
  w('ok6/ok6.worker.ts', IMPORT + `
export class GWorker { constructor(private readonly rdb: any, private readonly db: any) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private withGuc<T>(op: () => Promise<T>): Promise<T> { return this.rdb.systemGlobalAdminTransaction(op); }
  private async tick() { await this.withGuc(async () => { await this.db.execute('SELECT 1 FROM ewoh_event'); }); } }
`);
  w('bad2/bad2.worker.ts', IMPORT + `
export class HWorker { constructor(private readonly db: any) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private withGuc<T>(op: () => Promise<T>): Promise<T> { return op(); }
  private async tick() { await this.withGuc(async () => { await this.db.execute('SELECT 1 FROM ewoh_event'); }); } }
`);
  w('nonrls/nonrls.worker.ts', IMPORT + `
export class IWorker { constructor(private readonly db: any) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.db.execute('SELECT * FROM ewoh_outbox'); } }
`);
  w('agnostic/agnostic.worker.ts', IMPORT + `
export class JWorker { constructor(private readonly db: any) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.db.execute('SELECT * FROM ewoh_config'); } }
`);
  w('unknown-tbl/unknown-tbl.worker.ts', IMPORT + `
export class KWorker { constructor(private readonly db: any) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.db.execute('SELECT * FROM mystery_table'); } }
`);
  // 接口注入：唯一实现要跟随；多实现不许猜（真语料里 `AuditLogSink` 有 2 个实现 ⇒ 那 4 站"该不可判"）
  w('iface/iface.worker.ts', IMPORT + `
interface IAudit { write(): Promise<unknown> }
export class NWorker { constructor(private readonly sink: IAudit) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.sink.write(); } }
export class OnlySink implements IAudit { constructor(private readonly db: any) {}
  async write() { return this.db.execute('SELECT 1 FROM ewoh_event'); } }
`);
  w('two/two.worker.ts', IMPORT + `
interface ITwo { write(): Promise<unknown> }
export class OWorker { constructor(private readonly sink: ITwo) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.sink.write(); } }
export class SinkA implements ITwo { constructor(private readonly db: any) {} async write() { return this.db.execute('SELECT 1 FROM ewoh_event'); } }
export class SinkB implements ITwo { constructor(private readonly db: any) {} async write() { return this.db.execute('SELECT 2 FROM ewoh_event'); } }
`);
  // 多实现且**都不干净**：并集必须把站点顶成 red（这才是我们真正想拦的形状）
  w('twodirty/twodirty.worker.ts', IMPORT + `
interface ITD { write(): Promise<unknown> }
export class QWorker { constructor(private readonly sink: ITD) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.sink.write(); } }
export class TdA implements ITD { constructor(private readonly db: any) {} async write() { return this.db.execute('SELECT 1 FROM ewoh_event'); } }
export class TdB implements ITD { constructor(private readonly db: any) {} async write() { return this.db.select().from(ewohEvent); } }
`);
  // 多实现但一支不碰库、一支在事务里 ⇒ 并集之后仍不得 red（红是"存在一支裸碰"，不是"有多支"）
  w('twoclean/twoclean.worker.ts', IMPORT + `
interface ITC { write(): Promise<unknown> }
export class RWorker { constructor(private readonly rdb: any, private readonly sink: ITC) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.rdb.runInTransaction({}, async () => { await this.sink.write(); }); } }
export class TcA implements ITC { async write() { return 'memory'; } }
export class TcB implements ITC { constructor(private readonly db: any) {} async write() { return this.db.execute('SELECT 1 FROM ewoh_event'); } }
`);
  // 动态表句柄 `.from(cfg.table)`：同文件注册表里含一张 RLS 表 ⇒ 并集必须看见并判红（V218 新盲点）
  w('dynrls/dynrls.worker.ts', IMPORT + `
const SRCS: Record<string, any> = { tasks: { table: ewohEvent }, cfg: { table: ewohConfig } };
export class DyWorker { constructor(private readonly db: any) {}
  init() { setInterval(() => { void this.tick(SRCS.tasks); }, 1000); }
  private async tick(cfg: any) { return this.db.select().from(cfg.table); } }
`);
  // 同形状但注册表里两张都不受租户约束（一张无 orgId、一张显式不开）⇒ 不得 red，也不得留在不可判
  w('dynclean/dynclean.worker.ts', IMPORT + `
const SRCS2: Record<string, any> = { ob: { table: ewohOutbox }, cfg: { table: ewohConfig } };
export class DcWorker { constructor(private readonly db: any) {}
  init() { setInterval(() => { void this.tick(SRCS2.ob); }, 1000); }
  private async tick(cfg: any) { return this.db.select().from(cfg.table); } }
`);
  // 数组型数据成员不得伪装成"解不开"的噪声
  w('arr/arr.worker.ts', IMPORT + `
interface Row { id: string }
export class PWorker { private readonly rows: Row[] = [];
  init() { setInterval(() => { this.rows.push({ id: 'x' }); }, 1000); } }
`);

  // 相对 import 的裸函数：**解得开就不许再算"解不开"**（V210 前，10/12 个站点就是被这类噪声顶成 indeterminate）
  w('imp/imp.worker.ts', IMPORT + `
import { drainNote } from './imp.helper';
export class LWorker { init() { setInterval(() => { void drainNote(); }, 1000); } }
`);
  w('imp/imp.helper.ts', IMPORT + `
export function drainNote(): number { return 1; }
`);
  // 反向对照：既不在本文件、也没有可解析 import 的裸调用 ⇒ 必须仍算解不开
  w('noimp/noimp.worker.ts', IMPORT + `
export class MWorker { init() { setInterval(() => { void mysteryFn(); }, 1000); } }
`);

  // 夹具事实表：`ewoh_event` 受 RLS 约束、`ewoh_outbox` 是"含 org_id 但显式裁决不开"的那张、
  // `ewoh_config` 根本没有 orgId 列。真跑时这两样由 schemaTables()/rlsAllowlist() 现取。
  const FIX = {
    stbl: new Map([
      ['ewohEvent', { phys: 'ewoh_event', orgId: true }],
      ['ewohOutbox', { phys: 'ewoh_outbox', orgId: true }],
      ['ewohConfig', { phys: 'ewoh_config', orgId: false }],
    ]),
    allow: { ok: true, set: new Set(['ewoh_outbox']) },
  };
  const sites = analyze(root, FIX);
  if (process.argv.includes('--debug')) {
    console.log(JSON.stringify(sites.map((s) => ({ file: s.file, cls: s.cls, verdict: s.verdict, hits: s.hits.map((h) => h.callee + '|' + h.handle + '|inTx=' + h.inTx), unresolved: s.unresolved })), null, 1));
  }
  const has = (v, frag) => sites.some((s) => s.verdict === v && s.file.includes(frag));
  const none = (v, frag) => !sites.some((s) => s.verdict === v && s.file.includes(frag));
  const cases = [];
  const push = (name, ok) => cases.push({ name, ok });
  push('正例：worker→service 里裸 this.db.execute ⇒ 必须判 bare-runtime-handle', has('bare-runtime-handle', 'bad/'));
  push('反例 1：上下文由调用方建立（inTx 沿路径继承进 service 方法体）⇒ 不得开火',
    none('bare-runtime-handle', 'ok1/') && has('ctx-tx', 'ok1/'));
  push('反例 2：SECURITY DEFINER 受控函数 ⇒ 不得开火', none('bare-runtime-handle', 'ok2/'));
  push('反例 3：本地 postgres() 句柄 + fail-closed ⇒ 不得开火', none('bare-runtime-handle', 'ok3/'));
  push('反例 4：不碰库 ⇒ 落 no-db（含 `new Date().toISOString()` 这种构造结果的成员调用，不得伪装成裸调用）', has('no-db', 'ok4/'));
  push('反例 5：解不开的调用 ⇒ 只能 indeterminate（不得并成 ok 或 red）', has('indeterminate', 'ok5/'));
  push('对账：Σ档位 == 站点数（夹具 20 个 setInterval（V215 加 twodirty/twoclean、V218 加 dynrls/dynclean））',
    sites.length === 20 && new Set(sites.map((s) => s.file)).size === 20);
  push('V218 动态表句柄：.from(cfg.table) 且同文件注册表含一张 RLS 表 ⇒ 必须判红并记下并集',
    sites.some((x) => x.file.includes('dynrls/dynrls.worker') && x.verdict === 'bare-runtime-handle'
      && x.hits.some((h) => h.dynFrom === 'table' && /ewohEvent/.test(h.dynSymbols || ''))));
  push('V218 动态表句柄：同形状但注册表两张都不受租户约束 ⇒ 必须判 bare-nonrls-only，不得 red 也不得不可判',
    sites.some((x) => x.file.includes('dynclean/dynclean.worker') && x.verdict === 'bare-nonrls-only' && x.risky === 0 && x.unknownRls === 0));
  push('V210 接口注入且唯一实现 ⇒ 跟随到实现，那条裸触点必须被看见（判 red）',
    has('bare-runtime-handle', 'iface/iface.worker'));
  // V215 改判：多实现不再"不可判"，而是取并集。方向是**往更严**（并集只会看到更多触点），
  // 所以三条对照分别钉住"该红的红、不该红的不红、并集要留痕"。
  push('V215 接口多实现：两支都裸碰 RLS 表 ⇒ 并集必须把站点判红，且记下并集（不许再退回不可判）',
    sites.some((x) => x.file.includes('twodirty/twodirty.worker') && x.verdict === 'bare-runtime-handle' && (x.risky || 0) > 0)
      && sites.some((x) => x.file.includes('twodirty/twodirty.worker') && (x.unionNotes || []).some((u) => /2 个实现的并集/.test(u))));
  push('V215 接口多实现：一支不碰库、一支在事务里 ⇒ 并集后不得 red（红是"存在一支裸碰"，不是"有多支"）',
    sites.some((x) => x.file.includes('twoclean/twoclean.worker') && x.verdict === 'ctx-tx' && x.risky === 0));
  push('V215 老用例作废核对：two/two.worker（两支都碰 ewoh_event）现在必须是已判而不是 indeterminate',
    sites.some((x) => x.file.includes('two/two.worker') && x.verdict !== 'indeterminate'));
  push('V210 数组型数据成员（rows: Row[]）不得制造"解不开"噪声（本站点不碰库 ⇒ no-db）',
    has('no-db', 'arr/arr.worker'));
  push('反向对照：把 ok1 的包装去掉必须翻成 red', (() => {
    fs.writeFileSync(path.join(sv, 'ok1/ok1.worker.ts'), IMPORT + `
import { Ok1Service } from './ok1.service';
export class BWorker { constructor(private readonly svc: Ok1Service) {}
  init() { setInterval(() => { void this.tick(); }, 300000); }
  private async tick() { await this.svc.list(); } }
`);
    const again = analyze(root, FIX);
    return again.some((s) => s.verdict === 'bare-runtime-handle' && s.file.includes('ok1/'));
  })());
  // —— V210：二跳包装跟随 与 库侧 RLS 事实，两根轴各配正反对照 ——
  push('V210 正例：本类二跳包装（withGuc→systemGlobalAdminTransaction）⇒ 判 ctx-tx，不得开火',
    none('bare-runtime-handle', 'ok6/') && has('ctx-tx', 'ok6/'));
  push('V210 反向对照：包装体里不建上下文（`return op()`）⇒ 必须仍判 red',
    has('bare-runtime-handle', 'bad2/'));
  push('库侧事实：表在「含 org_id 但显式不开 RLS」清单里 ⇒ 落 bare-nonrls-only（既不并成 red，也不冒充有上下文）',
    has('bare-nonrls-only', 'nonrls/'));
  push('库侧事实：表没有 orgId 列（租户无关）⇒ 同样落 bare-nonrls-only',
    has('bare-nonrls-only', 'agnostic/'));
  push('表名认不出 ⇒ 只能 indeterminate，不许折算成"没碰 RLS 表"',
    has('indeterminate', 'unknown-tbl/'));
  // 注意夹具名：'noimp/' 里含子串 'imp/'，用目录前缀当 frag 会互相命中 ⇒ 这里必须点到文件名
  push('V210 相对 import 的裸函数可解析 ⇒ 不再冒充"解不开"（本站点确实不碰库 ⇒ no-db）',
    has('no-db', 'imp/imp.worker') && !sites.some((s) => s.verdict === 'indeterminate' && s.file.includes('imp/imp.worker')));
  push('V210 反向对照：既不在本文件也无可解析 import 的裸调用 ⇒ 必须仍 indeterminate',
    has('indeterminate', 'noimp/noimp.worker'));
  fs.rmSync(root, { recursive: true, force: true });
  const bad = cases.filter((c) => !c.ok);
  console.log(`[bg-task-db-context] 判据自测 ${cases.length - bad.length}/${cases.length} 通过`);
  for (const c of cases) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}`);
  return bad.length === 0;
}

/* ---------------- main ---------------- */
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  if (!selfTest()) process.exit(1);
  if (!args.includes('--reading')) { console.log('[bg-task-db-context] 自测通过'); process.exit(0); }
}
const stbl = schemaTables(ROOT);
const allow = rlsAllowlist(ROOT);
const sites = analyze(ROOT, { stbl, allow });
const bucket = new Map();
for (const s of sites) bucket.set(s.verdict, (bucket.get(s.verdict) || 0) + 1);
const total = sites.length;
let sum = 0;
for (const [, n] of bucket) sum += n;
if (sum !== total) {
  console.error(`[bg-task-db-context] 读数作废：档位加总 ${sum} != 分母 ${total}`);
  process.exit(2);
}
const red = sites.filter((s) => s.verdict === 'bare-runtime-handle');
const ind = sites.filter((s) => s.verdict === 'indeterminate');
const cleared = sites.filter((s) => s.verdict === 'bare-nonrls-only');
if (args.includes('--json')) {
  process.stdout.write(JSON.stringify({
    total, bucket: Object.fromEntries(bucket),
    rlsFacts: { ok: allow.ok, tables: allow.set ? [...allow.set] : null, reason: allow.reason || null, drizzleTables: stbl.size },
    sites,
  }, null, 2) + '\n');
} else {
  console.log(`[bg-task-db-context] 分母＝服务端 setInterval 站点 ${total} 个（不含 *.spec.ts）`);
  console.log(`  RLS 事实源：${allow.ok ? `权威量具 audit-unrls-tenant-tables（${allow.set.size} 张显式不开）` : `不可得（${allow.reason}）⇒ 不清任何 blind spot，red 全留`}`);
  console.log(`  drizzle 表符号：${stbl.size} 个（触点靠它落到物理表）`);
  for (const [k, v] of [...bucket].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  console.log(`  合计 ${sum} == 分母 ${total}`);
  console.log('\n—— red：碰着 RLS 表、又没有任何上下文形态（必须逐条读码定档）');
  for (const s of red) {
    console.log(`  RED ${s.file}:${s.line} 类=${s.cls}`);
    for (const h of s.hits) console.log(`        ${path.relative(ROOT, h.srcFile)}:${h.line} ${h.callee} forms=[${h.forms.join(',')}] rls=${h.rls || '-'}${h.dynFrom ? ` 动态句柄 .from(x.${h.dynFrom}) 取同文件字面量并集：${h.dynSymbols}` : ''} ${h.sql.replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  console.log('\n—— indeterminate（单列不折算；三种子档各自点名，避免"把假红清掉"其实是把一切都变成不可判）');
  console.log('   子档计数：' + ['解不开的路径里可能有触点', '处触点的表名认不出', '确认到'].map((k) => `${k}=${ind.filter((s) => (s.indKind || '').startsWith(k)).length}`).join(' '));
  for (const s of ind) {
    console.log(`  ?  ${s.file}:${s.line} 类=${s.cls}｜bare=${s.bare} risky=${s.risky} 表不可判=${s.unknownRls} 解不开=${s.unresolved.length}`);
    console.log(`        为什么不可判：${s.indKind || '（未标）'}`);
    console.log(`        头两条未解：${s.unresolved.slice(0, 2).join('; ') || '（无）'}`);
    if ((s.unionNotes || []).length) console.log(`        并集：${s.unionNotes.join('; ')}`);
  }
  console.log('\n—— bare 但被库侧事实清掉（碰的表不受租户约束：无 orgId 列，或在显式裁决清单里）');
  for (const s of cleared) {
    const tabs = [...new Set(s.hits.filter((h) => h.forms.length === 0).flatMap((h) => touchedTables(h, stbl).map((t) => `${t.phys}${t.orgId ? '(显式不开 RLS)' : '(无 orgId)'}`)))];
    console.log(`  ○  ${s.file}:${s.line} 类=${s.cls} ← ${tabs.join('、') || '（事实待读）'}`);
  }
  console.log('\n—— own-pool 的 fail-closed 面（缺串时是跳过还是静默读空）');
  for (const s of sites.filter((x) => x.hits.some((h) => h.forms.includes('own-pool')))) {
    console.log(`  ${s.file}:${s.line} 类=${s.cls} fail-closed=${s.failClosed ? '有' : '未见'}`);
  }
  console.log(`
限度（第一轮读数不接门禁）：
- 只有 setInterval 一根轴。已实测仓内无 @Interval/@Cron/SchedulerRegistry；外部编排（compose/PM2 起的一次性脚本）不在面上。
- 跨文件解析靠"类名唯一 + 构造函数参数有显式类型标注"；接口/抽象注入、动态属性一律落 indeterminate（不是 red 也不是 ok）。
- 二跳包装只跟随**本类内**的方法（「private withGuc(op){ return this.rdb.systemGlobalAdminTransaction(op) }」这一真实形状）；
  把回调交给**别的类**的包装方法仍看不见 ⇒ 那一格既不会红也不会绿，属量具盲区，引用读数时按"下界"说。
- own-pool 只判"句柄是不是本地 postgres()"，不判那个角色的真实权限（要读部署期连接串＝库外事实）。
- inTx 沿调用路径继承，因此"包了 wrapper 但 wrapper 里其实是空转"这类骗不过 SQL 层的写法看不见；判据是下界。
- bare-nonrls-only 只说明"这张表没有租户谓词可读空"，**不**说明那次读正确：无 orgId 的表越权面另算（见 GLOBAX-01）。`);
}
// --report-only：第一轮读数是分诊清单，red 存在不等于本轮失败（不用 `|| true` 吞退出码）
process.exit(args.includes("--report-only") ? 0 : (red.length > 0 ? 1 : 0));
