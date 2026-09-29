// 契约事件**载荷形状**普查（V136 建立，常驻可复算）：目录声明的 payload.required vs 两条承载面的实际供给
// 用法：make chain-baseline-event-payload
//
// 问的问题：目录为**全部 70 条**都声明了 payload.properties 与 payload.required（PyYAML 解析核对，
// 与 scripts/audit-event-catalog.js 的断言同一份权威），但没有任何位点把实际发出的载荷与 required 对账：
// 边缘 contracts/envelope.py:validate_envelope 只查信封字段 + eventType ∈ 目录；服务端 ingest 只查
// isCatalogEventType；shared/event-envelope.ts 的 payload 是**可选**参数。
//
// 两条承载面（读源码得，形参位与列名都在这里）：
//   A. outbox：outbox.service.ts:40 `enqueue(eventType, entityId, payload, orgId, sequence?, opts?)`
//      ⇒ 名字 arg0、实体 arg1、载荷 arg2；落 ewoh_outbox（eventId/entityId/orgId/payloadJson 各是独立列），
//      opts 里 snapshotVersion/planId/occurredAt/correlationId 会被**并进 payload**。
//   B. 云侧信封：buildEventEnvelope(opts) ⇒ 落 ewoh_event，该表**没有 payload 列**，envelope 整体进 evidenceJson。
//
// 自测（--self-test）走的是**同一条** collectEnvelope/collectSeed 代码路径，不是复制品；
// 尤其要证明 B 面"能看到 payload"，否则"21 处 0 传"是量具瞎而不是事实。
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..', '..');   // scripts/chain-baseline/ → 仓库根
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');
const TEST_RE = /(\.spec\.|\.test\.|__tests__)/;
// 用 Map：对象字面量的原型链会让 meth==='constructor' 命中 Object 构造器（本轮实测崩过一次）
const SEEDS = new Map([['enqueue', [0, 2]], ['enqueueThrottled', [0, 2]]]);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(e.name) && !TEST_RE.test(e.name)) out.push(full);
  }
  return out;
}

function objectKeys(obj) {
  const keys = new Set();
  let spread = 0;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) { spread += 1; continue; }
    if (ts.isShorthandPropertyAssignment(p)) { keys.add(p.name.text); continue; }
    if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.add(p.name.text);
  }
  return { keys, spread };
}
function litStr(n) {
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
}
/**
 * 只取**值位置**上的字符串字面量：字面量本身、三元的两个分支、括号/断言、`||` 两侧。
 * 刻意不下探条件表达式、调用实参、属性名——`const t = x === 'a' ? 'A' : 'B'` 里
 * 'a' 是比较数，不是会被发出去的名字（本轮先踩了"递归被截断"，又踩了"什么都收"）。
 * 另一条同族陷阱：ts.forEachChild 的回调**返回真值即停止遍历**，所以递归调用必须包成语句体。
 */
function unwrap(n) {
  let c = n;
  while (c && (ts.isParenthesizedExpression(c) || ts.isAsExpression(c)
    || ts.isSatisfiesExpression(c) || ts.isTypeAssertionExpression(c) || ts.isNonNullExpression(c))) c = c.expression;
  return c;
}
function literalsIn(node, out = new Set()) {
  const n = unwrap(node);
  if (!n) return out;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { out.add(n.text); return out; }
  if (ts.isConditionalExpression(n)) {
    literalsIn(n.whenTrue, out); literalsIn(n.whenFalse, out); return out;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    literalsIn(n.left, out); literalsIn(n.right, out); return out;
  }
  return out;      // 其他形状一律不下探：宁可漏（记 unresolved），不要假名
}
function enclosingFunc(node) {
  let cur = node.parent;
  while (cur && !ts.isFunctionDeclaration(cur) && !ts.isMethodDeclaration(cur)
    && !ts.isFunctionExpression(cur) && !ts.isArrowFunction(cur)) cur = cur.parent;
  return cur;
}
function paramNames(fn) {
  if (!fn || !fn.parameters) return [];
  return fn.parameters.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null)).filter(Boolean);
}
function lineOf(sf, n) { return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1; }
function textOf(sf, n) { return n ? n.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 80) : null; }
function objPropKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null)).filter(Boolean);
}

/** A 面：种子调用点 → 名字 / 实体实参原文 / 载荷键 / opts 键 / 是否包装函数 */
function collectSeed(n, sf, file, sink, wrapperHits) {
  if (!(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression))) return;
  const cfg = SEEDS.get(n.expression.name.text);
  if (!cfg) return;
  const [ni, pi] = cfg;
  const nameArg = n.arguments[ni];
  const payArg = n.arguments[pi];
  const payload = payArg && ts.isObjectLiteralExpression(payArg) ? objectKeys(payArg) : null;
  const names = litStr(nameArg) ? [litStr(nameArg)] : [...literalsIn(nameArg)];
  const fn = enclosingFunc(n);
  const wraps = !!(fn && nameArg && ts.isIdentifier(nameArg) && paramNames(fn).includes(nameArg.text));
  sink.push({
    file, line: lineOf(sf, n), seed: n.expression.name.text,
    names, unresolvedName: names.length === 0,
    payloadKeys: payload ? [...payload.keys] : null, spread: payload ? payload.spread : 0,
    entityText: textOf(sf, n.arguments[1]), optsKeys: objPropKeys(n.arguments[5]),
    wrapper: wraps && fn.name ? fn.name.text : null,
  });
  if (wraps && fn.name) wrapperHits.set(fn.name.text, { file, line: lineOf(sf, n) });
}

/** B 面：buildEventEnvelope 调用点 → 名字 / 是否传 payload / payload 键 */
function collectEnvelope(n, sf, file, sink) {
  if (!(ts.isCallExpression(n) && ts.isIdentifier(n.expression))) return;
  if (n.expression.text !== 'buildEventEnvelope') return;
  const opts = n.arguments[0];
  const rec = { file, line: lineOf(sf, n), eventType: [], hasPayload: false, payloadKeys: null, spread: 0 };
  if (opts && ts.isObjectLiteralExpression(opts)) {
    for (const p of opts.properties) {
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
      if (key === 'payload') {
        rec.hasPayload = true;
        const init = ts.isPropertyAssignment(p) ? p.initializer : null;
        if (init && ts.isObjectLiteralExpression(init)) {
          const k = objectKeys(init);
          rec.payloadKeys = [...k.keys]; rec.spread = k.spread;
        }
      }
      if (key === 'eventType') {
        const init = ts.isPropertyAssignment(p) ? p.initializer : null;
        const lit = init ? literalsIn(init) : new Set();
        if (lit.size) rec.eventType.push(...lit);
        else if (ts.isShorthandPropertyAssignment(p)) {
          const fn = enclosingFunc(n);       // `eventType,` 简写 ⇒ 回同函数取 `const eventType = …` 初值
          if (fn) {
            const find = (x) => {
              if (ts.isVariableDeclaration(x) && x.name && x.name.text === 'eventType' && x.initializer) {
                rec.eventType.push(...literalsIn(x.initializer));
              }
              ts.forEachChild(x, find);
            };
            find(fn);
          }
        }
      }
    }
  }
  sink.push(rec);
}

function selfTest() {
  let fails = 0, checks = 0;                       // 条数由计数器给出，不手抄
  const ck = (name, cond, got) => {
    checks += 1;
    console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : ' ⇒ ' + JSON.stringify(got)}`);
    if (!cond) fails += 1;
  };
  const fx = `
async function f(evtType) {
  const eventType = evtType === 'a' ? 'ThingHappened' : 'ThingFailed';
  const e = buildEventEnvelope({
    eventId: 'X-1', eventType, source: 'cloud:test', occurredAt: 't', receivedAt: 't',
    payload: { orgId: 'o1', thingId: 't1', occurredAt: 't' },
  });
  const g = buildEventEnvelope({ eventId: 'X-2', eventType: 'OtherThing', source: 's', occurredAt: 't', receivedAt: 't' });
  return [e, g];
}`;
  const s1 = ts.createSourceFile('fixture.ts', fx, ts.ScriptTarget.Latest, true);
  const env = [];
  const v = (n) => { collectEnvelope(n, s1, 'fixture.ts', env); ts.forEachChild(n, v); };
  v(s1);
  ck('B 面：带 payload 的调用必须报 hasPayload=true 且键集合可见（否则"0 传"是量具瞎）',
    env.length === 2 && env[0].hasPayload === true
    && JSON.stringify((env[0].payloadKeys || []).slice().sort()) === JSON.stringify(['occurredAt', 'orgId', 'thingId']),
    env.map((x) => [x.hasPayload, x.payloadKeys]));
  ck('B 面：不传 payload 的调用必须报 false（两档可分，不是恒真/恒假）',
    env[1] && env[1].hasPayload === false && env[1].payloadKeys === null, env[1]);
  ck('B 面：`eventType,` 简写要回到同函数的三元初值取到两个字面量',
    env[0].eventType.length === 2 && env[0].eventType.includes('ThingHappened')
    && env[0].eventType.includes('ThingFailed'), env[0].eventType);
  ck('B 面：比较数不得混进名字（`evtType === \'a\'` 里的 a 不是会发出去的名字）',
    !env[0].eventType.includes('a'), env[0].eventType);

  const fx2 = `
class Svc {
  outboxService;
  async go(ctx) {
    await this.outboxService.enqueue('thing.happened', 'ID-1', { thingId: 't1', count: 2 }, ctx.orgId, undefined, { occurredAt: 't' });
    return 1;
  }
  async emitSse(eventType, row, orgId) {
    await this.outboxService.enqueue(eventType, row.assignmentId, { thingId: row.id }, orgId);
  }
  async caller() { await this.emitSse('thing.via-wrapper', { id: 'x' }, 'o'); }
}`;
  const s2 = ts.createSourceFile('svc.ts', fx2, ts.ScriptTarget.Latest, true);
  const sites = [], wh = new Map();
  const v2 = (n) => { collectSeed(n, s2, 'svc.ts', sites, wh); ts.forEachChild(n, v2); };
  v2(s2);
  const direct = sites.find((x) => x.names.includes('thing.happened'));
  ck('A 面：字面量名字取到', !!direct, sites.map((x) => x.names));
  ck('A 面：arg2 的载荷键取到（不是 arg1/arg3）',
    direct && JSON.stringify(direct.payloadKeys) === JSON.stringify(['thingId', 'count']), direct && direct.payloadKeys);
  ck('A 面：arg5 opts 的键取到（occurredAt 并进 payload 那条路）',
    direct && direct.optsKeys.includes('occurredAt'), direct && direct.optsKeys);
  ck('A 面：entityId 实参原文留痕（承载映射判定要用）',
    direct && direct.entityText === "'ID-1'", direct && direct.entityText);
  ck('A 面：包装函数要被认出来（nameArg 是自己的形参）',
    !!wh.get('emitSse') && sites.some((x) => x.wrapper === 'emitSse'), [...wh.keys()]);
  ck('A 面：包装函数体内的实体实参也要留痕',
    sites.some((x) => x.wrapper === 'emitSse' && /assignmentId/.test(x.entityText || '')),
    sites.filter((x) => x.wrapper).map((x) => x.entityText));
  ck('A 面：名字不是字面量时如实记 unresolved（不许静默丢）',
    sites.some((x) => x.unresolvedName), sites.map((x) => [x.names, x.unresolvedName]));
  console.log(`判据自测 ${fails ? '未过' : '通过'}（${checks} 项）`);
  return fails ? 1 : 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const files = [];
  for (const d of ['ewoh-spark-app/server', 'ewoh-spark-app/shared']) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  const rel = files.map((f) => path.relative(ROOT, f));
  const sites = [], wrapperHits = new Map(), envSites = [];
  for (const f of rel) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const a = (n) => { collectSeed(n, sf, f, sites, wrapperHits); ts.forEachChild(n, a); };
    const b = (n) => { collectEnvelope(n, sf, f, envSites); ts.forEachChild(n, b); };
    a(sf); b(sf);
  }
  const emits = [];
  for (const s of sites) {
    if (s.wrapper) continue;                 // 包装函数体内那份由调用点代表（载荷取自包装体）
    for (const nm of (s.names.length ? s.names : [null])) {
      emits.push({ file: s.file, line: s.line, via: s.seed, name: nm, payloadKeys: s.payloadKeys,
        spread: s.spread, entityText: s.entityText, optsKeys: s.optsKeys });
    }
  }
  for (const [wname] of wrapperHits) {
    const inner = sites.find((s) => s.wrapper === wname);
    for (const f of rel) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
      const v = (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && n.expression.name.text === wname) {
          for (const nm of literalsIn(n.arguments[0])) {
            emits.push({ file: f, line: lineOf(sf, n), via: wname, name: nm,
              payloadKeys: inner ? inner.payloadKeys : null, spread: inner ? inner.spread : 0,
              entityText: inner ? inner.entityText : null, optsKeys: inner ? inner.optsKeys : [] });
          }
        }
        ts.forEachChild(n, v);
      };
      v(sf);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'tmp/v136-ts-emits.json'), JSON.stringify(
    { emits, envelopeSites: envSites, wrappers: [...wrapperHits.keys()], filesScanned: rel.length }, null, 1));
  const named = emits.filter((e) => e.name);
  console.log(`扫描生产 .ts ${rel.length} 个；闭包出的包装函数：${[...wrapperHits.keys()].join(' ') || '（无）'}`);
  console.log(`A 面 outbox 发射点 ${emits.length} 条（具名 ${named.length}、名字解析不到 ${emits.length - named.length}）`
    + `，事件名 ${new Set(named.map((e) => e.name)).size} 个`);
  console.log(`B 面 buildEventEnvelope ${envSites.length} 处：具名 ${envSites.filter((e) => e.eventType.length).length}`
    + `、传 payload ${envSites.filter((e) => e.hasPayload).length}`);
  console.log('机器可读：tmp/event-payload.json');

  // ---- 承载比对：required 字段落到哪一档（读源码得的承载模型，见文件头） ----
  const yaml = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('js-yaml');
  const cat = yaml.load(fs.readFileSync(path.join(ROOT, 'contracts/events/event-catalog.yaml'), 'utf8'));
  const chanMsg = {};
  for (const [ch, v] of Object.entries(cat.channels)) {
    const ref = (((v || {}).publish || {}).message || {}).$ref || '';
    if (ref) chanMsg[ch] = ref.split('/').pop();
  }
  const msgs = cat.components.messages;
  const COLUMN = new Set(['eventId', 'orgId']);            // ewoh_outbox 有独立列（eventId 由 enqueue 生成）
  const OPTS = new Set(['occurredAt', 'planId', 'snapshotVersion', 'correlationId']);
  const chanFor = (name) => {
    for (const [ch, msg] of Object.entries(chanMsg)) if (name === ch || name === ch.replace(/\./g, '_') || name === msg) return ch;
    return null;
  };
  const rows = [], undeclared = [];
  for (const e of emits) {
    const ch = chanFor(e.name || '');
    if (!ch) { if (e.name) undeclared.push({ name: e.name, site: `${e.file}:${e.line}` }); continue; }
    const req = (msgs[chanMsg[ch]].payload || {}).required || [];
    const props = new Set(Object.keys(((msgs[chanMsg[ch]].payload || {}).properties) || {}));
    const pay = new Set(e.payloadKeys || []);
    const inj = new Set((e.optsKeys || []).filter((k) => OPTS.has(k)));
    const ent = e.entityText || '';
    const inPay = req.filter((k) => pay.has(k) || inj.has(k));
    const cols = req.filter((k) => COLUMN.has(k));
    const viaEnt = req.filter((k) => !inPay.includes(k) && !cols.includes(k) && ent.includes(k));
    const gap = req.filter((k) => !inPay.includes(k) && !cols.includes(k) && !viaEnt.includes(k));
    rows.push({ channel: ch, site: `${e.file}:${e.line}`, required: req,
      inPayload: inPay, columns: cols, viaEntityId: viaEnt, gap,
      extraNotDeclared: [...pay].filter((k) => !props.has(k) && !inj.has(k)) });
  }
  const gapped = rows.filter((r) => r.gap.length);
  console.log('');
  console.log(`A 面具名发射点 ${rows.length} 条：required 有字段**无任何承载位**的 ${gapped.length} 条`
    + `；发出目录未声明键的 ${rows.filter((r) => r.extraNotDeclared.length).length} 条`);
  for (const r of gapped) console.log(`  缺 ${r.gap.join(',')}  ⇒ ${r.channel}（${r.site.split('/').pop()}）`);
  const viaEnt = rows.filter((r) => r.viaEntityId.length);
  console.log(`  靠顶层 entityId 列满足 required 的 ${viaEnt.length} 条（目录未写这层承载映射）：`
    + viaEnt.map((r) => `${r.channel}←${r.viaEntityId.join('/')}`).join('，'));
  console.log(`A 面反向：发射点里不在目录的名字 ${undeclared.length} 个 ⇒ ${[...new Set(undeclared.map((u) => u.name))].join(', ')}`);
  console.log(`B 面 buildEventEnvelope ${envSites.length} 处：传 payload ${envSites.filter((e) => e.hasPayload).length} 处`
    + `（ewoh_event 无 payload 列，envelope 整体进 evidence_json ⇒ 该面 payload 无承载位）`);
  fs.writeFileSync(path.join(ROOT, 'tmp/event-payload.json'),
    JSON.stringify({ rows, gapped: gapped.map((r) => [r.channel, r.gap]), undeclared, envSites, emits }, null, 1));
}

if (require.main === module) main();
module.exports = { collectSeed, collectEnvelope };
