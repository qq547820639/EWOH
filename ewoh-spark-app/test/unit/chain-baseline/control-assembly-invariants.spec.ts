/**
 * 控制请求创建路径的**装配不变量**门禁（V308）。
 *
 * 为什么要有：V307 把"高危控制请求的创建整笔进租户事务、第二步与第三步失败都全回滚"读成了结论，
 * 但那是**当前 module 组合**下的事实——一旦有人给创建路由加 `@Public()`、把它做成流式端点、
 * 或从 standalone-app.module 摘掉 `OrgContextInterceptor`，事务就没了、V306 否证掉的孤儿态会重新可达，
 * 而**没有任何机器读者会发现**（这正是本试点反复登记的"隐式业务规则"形状）。
 *
 * 形状：纯检测函数（吃源码文本 → 违规清单）＋夹具双向证明（放宽必须红、原样必须绿）＋真文件复算。
 * 与本仓其它 harness 用例同一规矩：`--self-test` 式的"只跑真文件"不算防回归，必须有一条**故意做坏**的夹具
 * 证明检测器真会开火。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const APP = path.resolve(__dirname, '../../..');          // ewoh-spark-app
const CTRL = path.join(APP, 'server/modules/control/control.controller.ts');
const SVC = path.join(APP, 'server/modules/control/control.service.ts');
const INTERCEPTOR = path.join(APP, 'server/modules/shared/org-context.interceptor.ts');
const STANDALONE = path.join(APP, 'server/standalone-app.module.ts');

const FORBIDDEN_ON_CREATE = ['Public', 'Sse', 'StreamingResponse'];

/** 控制器装饰器里 @Controller('api/control/requests') 那个类，及其 create 方法。 */
function findCreateRoute(source: string, fileName: string) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let target: { className: string; decorators: string[]; methodDecorators: string[] } | null = null;
  // 保留装饰器**全文**（含实参）：违规消息要能指出是谁被塞进 UseGuards，
  // 只截名字会让 "IngestGuard" 这类关键信息在消息里消失（V308 第一版就是这么漏的）。
  const decNames = (list: readonly ts.ModifierLike[] | undefined) => (list ?? [])
    .filter((m): m is ts.Decorator => ts.isDecorator(m))
    .map((d) => '@' + d.expression.getText());
  const walk = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name) {
      const cls = (n.modifiers ?? []).filter((m): m is ts.Decorator => ts.isDecorator(m)).map((d) => d.expression.getText());
      const isRequests = cls.some((c) => /Controller\(\s*['"]api\/control\/requests['"]/.test(c));
      if (isRequests) {
        let methodDecs: string[] = [];
        for (const m of n.members) {
          if (ts.isMethodDeclaration(m) && m.name && m.name.getText() === 'create') {
            methodDecs = decNames(m.modifiers);
          }
        }
        target = { className: n.name.text, decorators: decNames(n.modifiers), methodDecorators: methodDecs };
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return target;
}

/** 违规 1：创建路由（类级或方法级）带了会让它掉出租户事务/守卫的装饰器。 */
export function createRouteViolations(source: string, fileName = 'control.controller.ts'): string[] {
  const route = findCreateRoute(source, fileName) as
    | { className: string; decorators: string[]; methodDecorators: string[] }
    | null;
  if (!route) return ['找不到 @Controller(\'api/control/requests\') 类（检测器要跟着路由改名一起改）'];
  const out: string[] = [];
  for (const d of [...route.decorators, ...route.methodDecorators]) {
    if (FORBIDDEN_ON_CREATE.some((f) => new RegExp(`\\b${f}\\b`).test(d))) out.push(`创建路由带豁免装饰器 ${d}`);
    if (/\bUseGuards\b/.test(d) && /IngestGuard/.test(d)) out.push(`创建路由改用 ${d}（绕开 AccessTokenGuard ⇒ 无 userContext ⇒ 拦截器直通不包事务）`);
  }
  return out;
}

/** 违规 2：`createRequest` 冒出第二个生产调用方（新调用方可能不经 HTTP 拦截器）。 */
export function extraCreateRequestCallers(entries: Array<[string, string]>): string[] {
  const hits = entries
    .filter(([, src]) => /\.createRequest\(/.test(src))
    .map(([f]) => f);
  return hits.length === 1 && hits[0].endsWith('control.controller.ts') ? [] : [`createRequest 调用方=${hits.join(', ') || '（0 处）'}`];
}

/** 违规 3：拦截器不再对"缺请求级 DB 上下文"fail-closed（=偷偷退回池化连接）。 */
export function interceptorFallbackViolations(source: string): string[] {
  const out: string[] = [];
  if (!/runInTransaction\s*\(/.test(source)) out.push('拦截器里找不到 runInTransaction 调用');
  if (!/throw new InternalServerErrorException\(\s*\n?\s*'RequestDatabaseContext is required/.test(source)) {
    out.push('缺 RequestDatabaseContext 时不再显式 500（可能出现池化兜底）');
  }
  return out;
}

/** 违规 4：全局装配里摘掉了 OrgContextInterceptor 或任何 APP_GUARD。 */
export function appAssemblyViolations(source: string): string[] {
  const out: string[] = [];
  // 名字出现在 import 行不等于注册了：必须匹配 provider 本体（must-fire 夹具抓到这一点）
  if (!/provide:\s*APP_INTERCEPTOR,[\s\S]{0,80}?useClass:\s*OrgContextInterceptor/.test(source)) {
    out.push('standalone-app.module 里没有把 OrgContextInterceptor 注册成 APP_INTERCEPTOR');
  }
  // 同上：APP_GUARD 这个符号也会出现在 import 行，必须匹配 provider 本体
  if (!/provide:\s*APP_GUARD/.test(source)) out.push('standalone-app.module 不再有任何 APP_GUARD（未认证也能进 handler ⇒ 无 userContext ⇒ 不包事务）');
  return out;
}

function prodTsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') prodTsFiles(p, acc); continue; }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

describe('控制请求创建路径的装配不变量（ASM-01）', () => {
  it('ASM-01 真产物必须一条违规都没有', () => {
    const ctrl = fs.readFileSync(CTRL, 'utf8');
    const svcDir = prodTsFiles(path.join(APP, 'server'));
    const entries = svcDir.map((p) => [path.relative(APP, p), fs.readFileSync(p, 'utf8')] as [string, string]);
    const found: string[] = [
      ...createRouteViolations(ctrl),
      ...extraCreateRequestCallers(entries),
      ...interceptorFallbackViolations(fs.readFileSync(INTERCEPTOR, 'utf8')),
      ...appAssemblyViolations(fs.readFileSync(STANDALONE, 'utf8')),
    ];
    expect(found).toEqual([]);
  });

  it('ASM-01 四条检测各配一支"故意做坏"的夹具，必须各自开火（否则上面的绿什么都不证明）', () => {
    const real = fs.readFileSync(CTRL, 'utf8');
    // ① 给创建路由的类加 @Public()
    const pub = real.replace(/@Controller\('api\/control\/requests'\)/, "@Public()\n@Controller('api/control/requests')");
    expect(pub).not.toBe(real);
    expect(createRouteViolations(pub).some((v) => v.includes('Public'))).toBe(true);
    // ①b 创建路由改用 IngestGuard
    const ingest = real.replace(/@Controller\('api\/control\/requests'\)/,
      "@UseGuards(IngestGuard)\n@Controller('api/control/requests')");
    expect(createRouteViolations(ingest).some((v) => v.includes('IngestGuard'))).toBe(true);
    // ② 多一个调用方
    expect(extraCreateRequestCallers([['a/control.controller.ts', 'x.createRequest(b)'],
      ['b/worker.ts', 'y.createRequest(b)']]).length).toBeGreaterThan(0);
    expect(extraCreateRequestCallers([['a/control.controller.ts', 'x.createRequest(b)']])).toEqual([]);
    // ③ 拦截器改成静默直通
    const itc = fs.readFileSync(INTERCEPTOR, 'utf8');
    expect(interceptorFallbackViolations(itc)).toEqual([]);
    const weakened = itc.replace(/throw new InternalServerErrorException\(\s*\n\s*'RequestDatabaseContext is required[^)]*\);/, 'return next.handle();');
    expect(weakened).not.toBe(itc);
    expect(interceptorFallbackViolations(weakened).some((v) => v.includes('500'))).toBe(true);
    // ④ 装配里摘掉拦截器
    const mod = fs.readFileSync(STANDALONE, 'utf8');
    expect(appAssemblyViolations(mod)).toEqual([]);
    const swapped = mod.replace(/useClass: OrgContextInterceptor,/, 'useClass: MetricsInterceptor,');
    expect(swapped).not.toBe(mod);
    expect(appAssemblyViolations(swapped).some((v) => v.includes('APP_INTERCEPTOR'))).toBe(true);
    expect(appAssemblyViolations(mod.replace(/useClass: OrgContextInterceptor,/, '// 已摘除')).length).toBeGreaterThan(0);
    expect(appAssemblyViolations(mod.replace(/provide: APP_GUARD,/g, 'provide: NOT_A_GUARD,')).some((v) => v.includes('APP_GUARD'))).toBe(true);
  });

  it('ASM-01 找不到创建控制器时必须报违规（检测器不许静默空转）', () => {
    expect(createRouteViolations('export class Whatever {}', 'other.ts').length).toBe(1);
  });
});
