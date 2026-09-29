#!/usr/bin/env node
/**
 * 「@Optional() 兜底」暴露面普查（V211）。
 *
 * 一问：**产品码里每一个 `@Optional()` 注入点，少装配时会走哪条路——静默降级、跳过功能、还是 fail-closed？**
 * 再问一个更窄但会真的要命的问题：**对"带内存兜底"的那些消费者类，有没有哪个 Nest 模块本地重新 provide 了它，
 * 却拿不到那个持久依赖？** 拿不到时构造器里的 `sink ?? new InMemoryX()` 就生效：照常打日志、**永远不落库**。
 *
 * 为什么值得机检（仓内已有两次现场后果，都只写在注释里当"纪律"）：
 *   · `server/modules/control/control.module.ts:16` ——“不要在这里本地 provide AuditService（2026-09-13 实测回归）：
 *     SharedModule 虽是 @Global，但 `DatabaseAuditSink` **不在 exports 里**……审计照常打日志、永远不落库”；
 *   · `server/modules/shared/shared.module.ts:28` —— `IDEMPOTENCY_PAYLOAD_STORE` 与 `IDEMPOTENCY_STORE` 必须成对注册，
 *     漏一个就静默回落 `InMemoryPayloadStore`（注释自称 durable，实际不是——「缺陷 D」）。
 *   两条都是"约定守住了"，但**没有任何东西拦住第三次**：新模块加一行 `providers: [AuditService]` 就把
 *   一次已修过的静默数据丢失重新装回去，而只有恰好覆盖那条路径的用例会红。
 *
 * 八档（Σ＝分母，硬断言）：
 *   silent-degrade  构造器体里把缺失的依赖兜底成另一个对象（`x ?? new InMemoryX()`、`if (!x) x = …`）
 *   skip-path       体里以 `if (!x) return`／`x?.method()` 形式跳过（功能不做，但不冒充做了）
 *   fail-closed     体里缺依赖就抛（最想要的那档）
 *   default-value   标量/令牌兜底成字面量（`maxRecords ?? 500`）：阈值悄悄变了，不是"少了持久依赖还装作做了"
 *   alt-impl        兜底成同一接口的**另一个实现**（模块级函数/共享单例）⇒ 事照做，但绕开了容器
 *   mixed           同一类里既有守卫内使用、又有裸访问 ⇒ 方向要逐点读，判据不替人挑软的那一侧
 *   unknown         六种都没读到 ⇒ 单列，不折算成任何一侧
 * 另出一张「本地重提供 × 持久依赖不可达」的暴露表，档位 OK / EXPOSED / UNKNOWN（图解析不到 ⇒ UNKNOWN，
 * **绝不**因为"没证据"就判 OK）。
 *
 * 限度（第一轮读数不接门禁）：
 *   · 只认 `*.module.ts` 里的静态 `@Module({providers/exports/imports})`；`DynamicModule.dynamicRegister()`、
 *     `forwardRef`、数组展开、外部包提供的模块一律解析不到 ⇒ 落 UNKNOWN 并点名原因。
 *   · 依赖是否"可达"按 Nest 的作用域近似：本模块 providers ∪ @Global 模块的 **providers**（@Global 把自己的
 *     providers 全局可见）∪ 被 import 模块的 exports。这与 Nest 实现一致，但前提是没有自定义 provider 名字/别名。
 *   · 构造器体里只找 `@Optional()` 形参相关的兜底写法，赋值给字段后又改写的那种看不见。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

let ROOT = path.resolve(__dirname, '../..');
if (!fs.existsSync(path.join(ROOT, 'ewoh-spark-app'))) ROOT = path.resolve(__dirname, '..');
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');

function walk(dir, out = [], pred = (f) => f.endsWith('.ts')) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, pred);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}
const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
const txt = (sf, n) => n ? n.getText(sf).replace(/\s+/g, ' ').trim() : '';

/** TS 5 起装饰器落在 `modifiers` 里（`.decorators` 已废弃且恒为空）——只读 `.decorators` 会把每个模块
 *  都解析成「没有装饰器」，于是整张装配图为空、可达性判据拿到默认值＝**假绿**。
 *  本轮自测的反向对照（fixture 里 mods=0）把它顶了出来，所以另配一条分母自证。 */
const decos = (n) => (n && n.modifiers ? n.modifiers.filter((m) => ts.isDecorator(m)) : []);

/** 构造器里带 @Optional() 的形参：名字 + 声明类型文本。 */
function optionalParams(sf, cls) {
  const ctor = (cls.members || []).find((m) => ts.isConstructorDeclaration(m) && m.body);
  if (!ctor) return [];
  const out = [];
  for (const p of ctor.parameters) {
    const decos = (p.modifiers || []).filter((m) => ts.isDecorator(m));
    const isOpt = decos.some((d) => /@Optional\(/.test(txt(sf, d)));
    if (!isOpt) continue;
    const name = ts.isParameter(p) && ts.isIdentifier(p.name) ? p.name.text : '';
    if (!name) continue;
    const inj = decos.map((d) => txt(sf, d)).find((t) => /@Inject\(/.test(t));
    const token = inj ? inj.replace(/^@Inject\(\s*/, '').replace(/\s*\)$/, '') : '';
    out.push({ name, type: txt(sf, p.type).replace(/^\?\s*/, ''), token, line: sf.getLineAndCharacterOfPosition(p.getStart()).line + 1 });
  }
  return out;
}

/** 构造器形参是不是 TS `private readonly x` 这种"属性形参"（没有赋值语句，字段自动存在）。 */
function isPropertyParam(sf, p) {
  return (p.modifiers || []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword
    || m.kind === ts.SyntaxKind.PublicKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
    || m.kind === ts.SyntaxKind.ReadonlyKeyword);
}
/** 依赖是不是"可注入的类/令牌"。标量与 `any` 是配置值，不是持久依赖 ⇒ 不参与可达性判断。 */
function isInjectableDep(dep) {
  return !!dep && !/^(number|string|boolean|any|unknown|object)$/.test(dep)
    && !/[<(|]/.test(dep) && /^[A-Za-z_$][\w$]*$/.test(dep.replace(/\[\]$/, ''));
}

/** 只含该形参的兜底写法 ⇒ 档位。 */
function classifyFallback(sf, cls, p) {
  const ctor = (cls.members || []).find((m) => ts.isConstructorDeclaration(m) && m.body);
  const body = txt(sf, ctor && ctor.body);
  const n = p.name;
  const esc = n.replace(/[$]/g, '\\$');
  const param = (ctor ? ctor.parameters : []).find((x) => ts.isIdentifier(x.name) && x.name.text === n);
  const propForm = param ? isPropertyParam(sf, param) : false;
  // **先判守卫，再判兜底**：`if (!a && !b) throw …; this.x = a ?? new Impl(b!)` 是 fail-closed
  // （NEST-513 的写法：缺依赖就在构造期失败）。把 throw 守卫排在 `?? new` 之前，否则整个仓的
  // "带守卫的兜底"都会被读成静默降级——本轮真语料唯一那条 EXPOSED 正是这么来的假报（OrgScopeService）。
  const guardThrow = new RegExp(`if\\s*\\(\\s*[^)]*!\\s*(this\\.)?${esc}\\b[^)]*\\)\\s*\\{?\\s*[^}]*throw`);
  if (guardThrow.test(body)) return 'fail-closed';
  const guardSkip = new RegExp(`if\\s*\\(\\s*[^)]*!\\s*(this\\.)?${esc}\\b[^)]*\\)\\s*\\{?\\s*return`);
  if (guardSkip.test(body)) return 'skip-path';
  // silent-degrade：`x ?? new Y()` / `x || new Y()` / `if (!x) x = new Y()` / `x = x || defaultObj`。
  // 只有"可注入依赖"才算这一档：标量/`any` 配 `?? 某默认值` 是 default-value（阈值变了），
  // 把它们混进 silent-degrade 会让真语料的暴露表出现 `但 number 拿不到` 这种假报（第一版实测 3 处）。
  const injectable = isInjectableDep(p.token || p.type);
  if (injectable && (new RegExp(`${esc}\\s*(\\?\\?|\\|\\|)\\s*new\\s+[A-Za-z]`).test(body)
    || new RegExp(`if\\s*\\(\\s*!\\s*${esc}\\s*\\)\\s*(this\\.)?${esc}?\\s*=?\\s*new\\s+[A-Za-z]`).test(body)
    || new RegExp(`(this\\.)?${esc}\\s*=\\s*${esc}\\s*(\\?\\?|\\|\\|)`).test(body))) return 'silent-degrade';
  // alt-impl：兜底成**同一接口的另一个实现**（`transport ?? realLarkTransport` 这种模块级常量/函数），
  // 或构造器里对形参做三元分支、两支都把事做了（`emailConnector ? sendEmail(a,c) : sendEmail(a)`）。
  // 这档既不是"静默不做"也不是"少装配就抛"，而是**绕开容器照做** ⇒ DI 少装配在生产里完全看不见，
  // 好处是不会缺行为、坏处是"谁真的被注入了"这条问题在运行时无解。真语料 2 处，都是通知通道。
  if (injectable && (new RegExp(`${esc}\\s*(\\?\\?|\\|\\|)\\s*(?!new)(?!(?:undefined|null)\\b)[A-Za-z_$][\\w$]*`).test(body)
    || new RegExp(`${esc}\\s*\\?\\s*[^.:]`).test(body))) return 'alt-impl';
  // 字段别名：构造器把形参存成**另一个名字**（`this.larkTransport = transport ?? …`）时，少装配的行为
  // 写在 `this.larkTransport` 上；只搜形参名会把有守卫的点读成 unknown（本轮真语料 12 处 unknown 里
  // 至少 2 处是这个形状，另有 2 处是正向真值守卫 `if (this.f) { this.f!.m() }`）。
  const names = [esc];
  for (const m of body.matchAll(new RegExp(`this\\.([A-Za-z_$][\\w$]*)\\s*=\\s*${esc}\\b`, 'g'))) {
    const a = m[1].replace(/[$]/g, '\\$');
    if (!names.includes(a)) names.push(a);
  }
  const na = names.join('|');
  // 存字段（或 TS 属性形参 `constructor(@Optional() private readonly r?: X)`，它根本没有赋值语句）：
  // 少装配时的行为写在方法体里，只能看用法——正向真值守卫与 `?.`＝跳过，直接访问＝少装配就抛。
  const methAll = (cls.members || []).filter((m) => ts.isMethodDeclaration(m)).map((m) => txt(sf, m.body)).join(' ; ');
  if (propForm || names.length > 1) {
    const meth = methAll;
    // 一根轴：看见「守卫跳过」（正向真值守卫或 `?.`）＝soft；看见「不加守卫就访问」（裸 `this.x.`、
    // 无正向守卫的 `this.x!.`、或负向守卫配 throw）＝hard。**两者都有 ⇒ mixed**——判据不替人挑软的那一侧
    // （补上正向守卫后实测：`ark.service.ts` 104 行守卫内用、168 行裸用，硬判成 skip-path 就是替代码说话）。
    const posGuard = new RegExp(`if\\s*\\(\\s*(?:this\\.)?(?:${na})\\s*\\)`).test(meth);
    const optUse = new RegExp(`this\\.(?:${na})\\s*\\?`).test(meth);
    const bareDot = new RegExp(`this\\.(?:${na})\\s*\\.`).test(meth);
    const bangUse = new RegExp(`this\\.(?:${na})\\s*!`).test(meth);
    const negThrow = new RegExp(`if\\s*\\(\\s*[^)]*!\\s*(?:this\\.)?(?:${na})\\b[^)]*\\)\\s*\\{?\\s*[^}]*throw`).test(meth);
    const soft = posGuard || optUse;
    const hard = bareDot || negThrow || (bangUse && !posGuard);
    if (soft && hard) return 'mixed';
    if (soft) return 'skip-path';
    if (hard) return 'fail-closed';
  }
  // TS **形参默认值**（`@Optional() cfg?: CpSatSolverConfig = {}`）：少装配时拿到的是空壳配置而不是 undefined，
  // 同属"值悄悄变了"这一档（真语料 1 处，代码注释自称"CP-SAT 可禁用（合规显式降级）"）。
  if (param && param.initializer) return 'default-value';
  // 标量/令牌兜底（`maxRecords ?? 500`、`limit ?? DEFAULT_LIMIT`）：是"阈值悄悄变了"，
  // 不是"少了持久依赖还装作做了"。非注入依赖只要有 `??`/`||` 就落这一档。
  if (!injectable && new RegExp(`${esc}\\s*(\\?\\?|\\|\\|)`).test(body)) return 'default-value';
  if (new RegExp(`${esc}\\s*(\\?\\?|\\|\\|)\\s*(\\d|['\"\`\\[])`).test(body)) return 'default-value';
  // delegated：本类**不决定**少装配时的行为——字段既没被解引用也没被守卫，而是作为实参交给别人
  // （`new HeuristicSolver(this.durationPrediction, …)`）或被指派给局部别名（`const p = this.predictionProvider`）。
  // 这一档不折算成任何一侧：真正的兜底写法在被委托方的构造器里，量具在这里只能说到"决定不在本类"。
  const passed = new RegExp(`this\\.(?:${na})\\s*[,)]`).test(methAll) || new RegExp(`=\\s*this\\.(?:${na})\\b`).test(methAll)
    || new RegExp(`${esc}\\s*[,)]`).test(body);
  if (passed) return 'delegated';
  return 'unknown';
}

/** 全部模块的静态装配图。 */
function moduleGraph(root) {
  const files = walk(path.join(root, 'ewoh-spark-app/server'), [], (f) => f.endsWith('.module.ts'));
  const mods = new Map();
  for (const f of files) {
    const sf = parse(f);
    (function visit(n) {
      if (ts.isClassDeclaration(n) && n.name && decos(n).length) {
        const dec = decos(n).find((d) => /@Module\(/.test(txt(sf, d)));
        if (dec) {
          const arg = dec.expression.arguments[0];
          const props = arg && ts.isObjectLiteralExpression(arg)
            ? new Map(arg.properties.map((pr) => [txt(sf, pr.name), pr.initializer])) : new Map();
          const list = (k) => {
            const v = props.get(k);
            if (!v || !ts.isArrayLiteralExpression(v)) return v ? ['<非数组字面量>'] : [];
            return v.elements.map((e) => txt(sf, e).replace(/^.*\./, '').replace(/\(\)$/, ''));
          };
          const glb = decos(n).some((d) => /@Global\(/.test(txt(sf, d)));
          mods.set(n.name.text, {
            file: path.relative(root, f), cls: n.name.text, global: glb,
            providers: list('providers'), exports: list('exports'), imports: list('imports'),
            unpar: !props.get('providers') && !props.get('exports') ? ['providers/exports 不是对象字面量能读的形状'] : [],
          });
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return mods;
}

/** 某模块里 token 是否可达（Nest 作用域近似）。 */
function reachable(mods, modCls, token, seen = new Set()) {
  if (!modCls || seen.has(modCls + ':' + token)) return { ok: false, why: '递归保护' };
  seen.add(modCls);
  const m = mods.get(modCls);
  if (!m) return { ok: false, why: `模块 ${modCls} 不在解析到的装配图里` };
  if (m.providers.includes(token)) return { ok: true, via: `${modCls}.providers` };
  if (m.exports.includes(token)) return { ok: true, via: `${modCls}.exports(自身即提供)` };
  for (const g of mods.values()) if (g.global && g.providers.includes(token)) return { ok: true, via: `@Global ${g.cls}.providers` };
  for (const imp of m.imports) {
    if (imp.startsWith('<')) continue;
    const im = mods.get(imp);
    if (im && im.exports.includes(token)) return { ok: true, via: `imports ${imp}.exports` };
  }
  const unresolvedImports = m.imports.filter((x) => x.startsWith('<') || !mods.has(x));
  return { ok: false, why: `${modCls} 内没有 ${token}；已 import 的模块也没导出它`
    + (unresolvedImports.length ? `；另有 ${unresolvedImports.length} 个 import 解析不到（DynamicModule/外部包）⇒ 不可判` : '') };
}

function analyze(root) {
  const files = walk(path.join(root, 'ewoh-spark-app/server')).filter((f) => !/\.module\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f));
  const mods = moduleGraph(root);
  const sites = [];
  for (const f of files) {
    const sf = parse(f);
    (function visit(n) {
      if (ts.isClassDeclaration(n) && n.name) {
        for (const p of optionalParams(sf, n)) {
          const verdict = classifyFallback(sf, n, p);
          const dep = p.token || p.type;
          const providers = [...mods.values()].filter((m) => m.providers.includes(n.name.text));
          // 可达性只对"真依赖"判：标量配置（maxRecords?: number）与 any 不参与，
          // 否则会把"@Optional() 一个数字缺省"报成"持久依赖拿不到"（第一版真语料就假报了 3 处）。
          const exposure = (verdict === 'silent-degrade' && isInjectableDep(dep))
            ? providers.map((m) => { const r = reachable(mods, m.cls, dep); return { mod: m.cls, file: m.file, ok: r.ok, via: r.via || '', why: r.why || '' }; })
            : [];
          sites.push({
            file: path.relative(root, f), cls: n.name.text, param: p.name, type: p.type, token: p.token,
            line: p.line, verdict, dep, consumers: providers.length, exposure,
          });
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return { sites, mods };
}

/* ---------------- 判据自测（一次性夹具树）：必须开火 + 必须按预期不开火 ---------------- */
function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optfb-'));
  const sv = path.join(root, 'ewoh-spark-app/server/modules');
  const w = (rel, body) => { const p = path.join(sv, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  const HEAD = `declare function Injectable(x?: any): any; declare function Module(x: any): any;
declare function Global(): any; declare function Optional(): any; declare function Inject(t: any): any;
declare const setInterval: any;`;
  w('shared/shared.module.ts', HEAD + `
@Global() @Module({ providers: [DatabaseAuditSink, AuditService], exports: [AuditService] })
export class SharedModule {}
`);
  // 消费者类：@Optional + 内存兜底 ⇒ silent-degrade
  w('shared/audit.service.ts', HEAD + `
export class DatabaseAuditSink {}
class InMemoryAuditSink { append() {} }
@Injectable() export class AuditService {
  private readonly sink: any;
  constructor(@Optional() @Inject(DatabaseAuditSink) sink?: any) { this.sink = sink ?? new InMemoryAuditSink(); }
}
`);
  // 本地重提供 AuditService 的模块：DatabaseAuditSink 不在 @Global 的 exports 里（只 providers）——
  // 但 Nest 的 @Global 会把 providers 全局可见，所以**可达** ⇒ 该模块不得判 EXPOSED（正向对照）
  w('ok/ok.module.ts', HEAD + `
@Module({ providers: [AuditService] }) export class OkModule {}
`);
  // 反向对照：把 sink 从 @Global 里摘掉（改成一个不 global 的模块提供）⇒ 必须判 EXPOSED
  const good = fs.readFileSync(path.join(sv, 'shared/shared.module.ts'), 'utf8');
  w('exposed/exposed.module.ts', HEAD + `
@Module({ providers: [AuditService] }) export class ExposedModule {}
`);
  // 注意：**这里不改装配图**。摘 @Global 的突变放在下面的反向对照里做，
  // 否则第一次 analyze 拿到的就已经是改过的图，"@Global 生效时不该判 EXPOSED"那条正向对照会变成假绿。
  // skip-path / fail-closed 两档的形状
  w('misc/misc.service.ts', HEAD + `
@Injectable() export class Skipper { constructor(@Optional() private readonly r?: any) { if (!this.r) return; } use() { return this.r && this.r.x(); } }
@Injectable() export class Thrower { constructor(@Optional() private readonly r?: any) { if (!this.r) throw new Error('no r'); } }
@Injectable() export class NumHolder { n = 0; constructor(@Optional() maxRecords?: number) { this.n = maxRecords ?? 500; } }
// 守卫优先于兜底：NEST-513 形状（先因缺依赖抛，之后才「?? new Impl()」）必须判 fail-closed
@Injectable() export class GuardedHolder { constructor(@Optional() a?: any, @Optional() b?: any) { if (!a && !b) { throw new Error('need a or b'); } this.p = a ?? new ImplFor(b); } }
// 字段别名＋正向真值守卫（V211 真盲点：shift.service.ts 写的就是 if (this.responsibilities) { this.responsibilities!.… }）
@Injectable() export class AliasGuard { resp: any; constructor(@Optional() responsibilities?: DeviceResponsibilityService) { this.resp = responsibilities; }
  cov(orgId: any) { if (this.resp) { return this.resp!.coverageForShift(orgId); } return []; } }
// 只有别名字段、没有守卫：少装配就在 undefined.run() 上抛 ⇒ fail-closed
@Injectable() export class AliasBang { f: any; constructor(@Optional() svc?: FooService) { this.f = svc; } go() { return this.f!.run(); } }
// 兜底成同接口的另一个实现 ⇒ alt-impl（事照做，但绕开容器）
@Injectable() export class AltImpl { t: any; constructor(@Optional() transport?: LarkTransport) { this.t = transport ?? realLarkTransport; } send(m: any) { return this.t(m); } }
// 本类不决定：字段只作为实参交出去 ⇒ delegated
@Injectable() export class Delegator { constructor(@Optional() private readonly inner?: InnerSolver) {} run(x: any) { return makeSolver(this.inner).solve(x); } }
// 形参默认值是空壳对象 ⇒ default-value（少装配拿到的是 {}，不是 undefined）
@Injectable() export class ParamDefault { cfg: any; constructor(@Optional() cfg?: CpSatSolverConfig = {}) { this.cfg = cfg; } }
// 两种形状都在（守卫内用一次、另一处裸用）⇒ 必须 mixed，不许替代码挑软的那一侧（ark.service.ts 实测就是这个形状）
@Injectable() export class MixedUse { d: any; constructor(@Optional() db?: SomeDb) { this.d = db; }
  a(orgId: any) { if (this.d) { return this.d.q(orgId); } return []; } b() { return this.d.raw(); } }
`);
  const run = () => analyze(root);
  const a = run();
  const at = (cls) => a.sites.find((s) => s.cls === cls) || {};
  if (process.env.OPTFB_DEBUG) console.error('DEBUG sites=', JSON.stringify(a.sites.map((x)=>x.cls+'.'+x.param+'='+x.verdict)));
  // 装配图一变，读数必须重算：`expIn` 只认传进来的那一次结果，不缓存上一次（否则反向对照会拿旧图判"没暴露"）
  const expIn = (res, mod) => {
    const s = res.sites.find((x) => x.cls === 'AuditService');
    return ((s && s.exposure) || []).find((e) => e.mod === mod) || { ok: true, why: '该模块没出现在 exposure 里' };
  };
  const cases = [];
  const push = (n, ok) => cases.push({ n, ok });
  push('分母自洽：@Optional 站点全都有档位（Σ＝sites 数）',
    a.sites.length > 0 && a.sites.every((s) => ['silent-degrade', 'alt-impl', 'skip-path', 'fail-closed', 'mixed', 'delegated', 'default-value', 'unknown'].includes(s.verdict)));
  push('档位：`sink ?? new InMemoryAuditSink()` 必须判 silent-degrade', at('AuditService').verdict === 'silent-degrade');
  push('档位：`if (!this.r) return` 必须判 skip-path', at('Skipper').verdict === 'skip-path');
  push('档位：`if (!this.r) throw` 必须判 fail-closed', at('Thrower').verdict === 'fail-closed');
  push('档位：标量 `maxRecords ?? 500` 判 default-value，且不进可达性判断（真语料第一版在这里假报过 3 处）',
    at('NumHolder').verdict === 'default-value'
      && !((a.sites.find((x) => x.cls === 'NumHolder') || { exposure: [] }).exposure || []).length);
  push('优先级：`if (!a && !b) throw` + `a ?? new Impl(b!)` 必须判 fail-closed（守卫排在兜底之前）',
    at('GuardedHolder').verdict === 'fail-closed');
  push('字段别名：`this.resp = responsibilities` ＋方法里 `if (this.resp) { this.resp!.… }` 必须判 skip-path'
    + '（V211 真盲点：只搜形参名时这种点落 unknown，真语料 12 处 unknown 里有它的份）',
    at('AliasGuard').verdict === 'skip-path');
  push('字段别名反向对照：只有 `this.f = svc`、方法里裸 `this.f!.run()`（无真值守卫）⇒ 必须判 fail-closed 而不是 skip-path',
    at('AliasBang').verdict === 'fail-closed');
  push('极性不替人挑：同一类里既有 `if (this.d) { this.d.q() }` 又有裸 `this.d.raw()` ⇒ 必须判 mixed'
    + '（V211 补正向守卫时顶出来的：把它判成 skip-path 等于替代码说话，真语料 `ark.service.ts` 就是这个形状）',
    at('MixedUse').verdict === 'mixed');
  push('档位：`transport ?? realLarkTransport`（兜底成同接口的另一个实现）必须判 alt-impl，不得混进 silent-degrade',
    at('AltImpl').verdict === 'alt-impl');
  push('档位：字段只被当作实参交出去（`makeSolver(this.inner)`）⇒ 必须 delegated，不许冒充"本类已判过方向"',
    at('Delegator').verdict === 'delegated');
  push('档位：TS 形参默认值 `cfg?: Cfg = {}` 必须判 default-value（少装配拿到空壳而不是 undefined）',
    at('ParamDefault').verdict === 'default-value');
  push('分母自证：fixture 解析出 3 个模块、AuditService 的 exposure 至少 2 条（缺这条，下面的"不判 EXPOSED"就是假绿）',
    a.mods.size === 3
      && ((a.sites.find((x) => x.cls === 'AuditService') || { exposure: [] }).exposure || []).length >= 2);
  push('@Global 的 providers 全局可见 ⇒ OkModule 与 ExposedModule 都不得判 EXPOSED',
    expIn(a, 'OkModule').ok === true && expIn(a, 'ExposedModule').ok === true);
  fs.writeFileSync(path.join(sv, 'shared/shared.module.ts'), good.replace('@Global() @Module', '@Module'));
  const b = run();
  if (process.env.OPTFB_DEBUG) console.error('DEBUG b exposure=', JSON.stringify((b.sites.find((x)=>x.cls==='AuditService')||{}).exposure), 'mods=', JSON.stringify([...b.mods.values()].map((m)=>({c:m.cls,g:m.global,p:m.providers,e:m.exports}))));
  push('反向对照：把 SharedModule 的 @Global 摘掉（sink 只在它的 providers 里、没人导出）⇒ 必须 EXPOSED',
    expIn(b, 'ExposedModule').ok === false );
  fs.writeFileSync(path.join(sv, 'shared/shared.module.ts'), good); // 复位
  const c = run();
  push('复位后两档都不该再红（判据跟着装配图走，不是记住上一次结果）',
    expIn(c, 'ExposedModule').ok === true && expIn(c, 'OkModule').ok === true);
  fs.writeFileSync(path.join(sv, 'shared/shared.module.ts'),
    good.replace('providers: [DatabaseAuditSink, AuditService]', 'providers: [AuditService]')
      .replace('@Global()', ''));
  const d = run();
  push('再一反向：@Global 留着但不提供 sink ⇒ 仍必须 EXPOSED（不是"看到 @Global 就放行"）',
    expIn(d, 'OkModule').ok === false);
  fs.rmSync(root, { recursive: true, force: true });
  const bad = cases.filter((c) => !c.ok);
  console.log(`[optional-fallback-exposure] 判据自测 ${cases.length - bad.length}/${cases.length} 通过`);
  for (const c of cases) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.n}`);
  return bad.length === 0;
}

/* ---------------- main ---------------- */
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  if (!selfTest()) process.exit(1);
  if (!args.includes('--reading')) { console.log('[optional-fallback-exposure] 自测通过'); process.exit(0); }
}
const { sites, mods } = analyze(ROOT);
const bucket = new Map();
for (const s of sites) bucket.set(s.verdict, (bucket.get(s.verdict) || 0) + 1);
let sum = 0; for (const [, n] of bucket) sum += n;
if (sum !== sites.length) { console.error(`[optional-fallback-exposure] 读数作废：档位加总 ${sum} != 分母 ${sites.length}`); process.exit(2); }
const exposed = sites.flatMap((s) => s.exposure.filter((e) => e.ok === false).map((e) => ({ ...e, cls: s.cls, dep: s.dep, param: s.param })));
const unresolvedSites = sites.filter((s) => s.verdict === 'unknown');
if (args.includes('--json')) {
  process.stdout.write(JSON.stringify({ total: sites.length, modules: mods.size, bucket: Object.fromEntries(bucket), exposed, sites }, null, 2) + '\n');
} else {
  console.log(`[optional-fallback-exposure] 分母＝产品码里的 @Optional() 注入点 ${sites.length} 个｜解析到模块 ${mods.size} 个（*.module.ts 静态字面量）`);
  for (const [k, v] of [...bucket].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  console.log(`  合计 ${sum} == 分母 ${sites.length}`);
  console.log('\n—— EXPOSED：本地重新 provide 了带内存兜底的消费者，而持久依赖在该模块作用域内不可达');
  if (!exposed.length) console.log('  （0 处）');
  for (const e of exposed) console.log(`  ! ${e.file} 里 provide ${e.cls}，但 ${e.dep} 拿不到 ⇒ 构造器回落内存实现：${e.why}`);
  console.log('\n—— silent-degrade 清单（少装配就静默降级的那些点）');
  for (const s of sites.filter((x) => x.verdict === 'silent-degrade')) {
    console.log(`  · ${s.file}:${s.line} ${s.cls}(this.${s.param}) ⇐ ${s.dep}｜该消费者被 ${s.consumers} 个模块 provide`);
  }
  console.log('\n—— alt-impl（兜底成同接口的另一个实现：事照做，但绕开容器，DI 少装配在运行时看不见）');
  for (const s of sites.filter((x) => x.verdict === 'alt-impl')) {
    console.log(`  ~ ${s.file}:${s.line} ${s.cls}(this.${s.param}) ⇐ ${s.dep}`);
  }
  console.log('\n—— mixed（同一类里守卫内使用与裸访问并存，方向要逐点读）');
  for (const s of sites.filter((x) => x.verdict === 'mixed')) console.log(`  # ${s.file}:${s.line} ${s.cls}(this.${s.param})`);
  console.log('\n—— delegated（本类不决定方向：字段被交出去或起了局部别名）');
  for (const s of sites.filter((x) => x.verdict === 'delegated')) console.log(`  > ${s.file}:${s.line} ${s.cls}(this.${s.param}) ⇐ ${s.dep}`);
  console.log('\n—— unknown（兜底写法没读到，单列不折算）');
  for (const s of unresolvedSites.slice(0, 40)) console.log(`  ? ${s.file}:${s.line} ${s.cls}.${s.param} : ${s.type}${s.token ? ` @Inject(${s.token})` : ''}`);
  if (unresolvedSites.length > 40) console.log(`  …另 ${unresolvedSites.length - 40} 条（--json 全给）`);
  console.log(`
限度：只认静态 @Module 字面量；DynamicModule/forwardRef/外部包模块解析不到 ⇒ 那些 import 参与判"不可达"时一律降级成"不可判"而不是 EXPOSED。
      @Optional 之外的条件装配（env 开关、configService 缺省）不在面上；字段被后续改写看不见。`);
}
process.exit(args.includes('--report-only') ? 0 : (exposed.length > 0 ? 1 : 0));
