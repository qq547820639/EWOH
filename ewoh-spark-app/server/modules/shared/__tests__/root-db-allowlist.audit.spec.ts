/* 根数据库句柄（STANDALONE_ROOT_DATABASE）访问白名单审计
 *
 * 背景（7.3）：STANDALONE_ROOT_DATABASE 是无 RLS / 无组织 GUC 的根句柄，任何
 * Nest 服务都能通过 @Global 的 StandaloneDatabaseModule 注入它。业务模块一旦
 * 直接引用它并执行裸查询，就绕过了 app.current_org_id 租户隔离。
 *
 * 本测试对 server/modules/** 与 server/database/**（及 test/helpers/e2e-app.ts）
 * 做静态源码扫描：凡 import/引用 STANDALONE_ROOT_DATABASE（来自
 * request-database-context）的文件，必须命中显式 allowlist，否则测试失败。
 *
 * allowlist 语义：
 *  - server/database/request-database-context.ts         —— token 定义处；
 *  - server/database/standalone-database.module.ts        —— @Global 导出处；
 *  - server/database/standalone.provider.ts               —— 工厂提供处；
 *  - server/modules/work-orchestration/domain-persistence.service.ts
 *    —— 业务消费者：经 RequestDatabaseContext.systemTransaction
 *      （显式系统事务 API，7.1/7.2）访问根句柄；
 *  - server/modules/auth/auth.service.ts
 *      —— 业务消费者（CFG-01，2026-09-22）：登录/令牌复核在身份与租户建立之前，
 *      读 SECURITY DEFINER 函数 ewoh_find_active_user；不开兜底时它落在
 *      「请求上下文内无事务 store」的格子，开兜底则整条链起不来（见基线文档 §5.3q）。
 *  - server/modules/health/health.controller.ts
 *      —— 业务消费者（CFG-01b，2026-09-22 链外普查）：`@Public` 就绪探针同样落在
 *      「有请求上下文、无事务 store」的格子里，读的是 `select 1`（不涉租户数据）。
 *      不开显式系统事务 ⇒ 打开推荐兜底后就绪探针恒 503（见基线文档 §5.3u）。
 *  - test/helpers/e2e-app.ts                              —— 测试助手（关闭连接池）。
 *
 * 新增任何其他模块引用根句柄 → 测试失败（回归捕获，可靠）。
 * 静态启发式局限：仅证明"文件文本含 token 引用"，无法证明"引用被正确包裹在
 * systemTransaction 内"——后者由 7.2 重构 + 运行时审计兜底。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';

/** 根句柄 token 文本。 */
const ROOT_TOKEN = 'STANDALONE_ROOT_DATABASE';

/** systemTransaction 调用文本（NEST-509 扩展，2026-08-17）。 */
const SYSTEM_TX_TOKEN = '.systemTransaction(';

/** 识别对 request-database-context 模块的 import/re-export（相对或 @server 别名）。 */
const IMPORT_FROM_CONTEXT = /from\s+['"][^'"]*request-database-context['"]/;

/**
 * 显式 allowlist：key = 相对 ewoh-spark-app 根目录的路径。
 * 命中列表的文件允许引用根句柄；其余文件引用即违规。
 */
const ALLOWLIST = new Set<string>([
  'server/database/request-database-context.ts',
  'server/database/standalone-database.module.ts',
  'server/database/standalone.provider.ts',
  'server/modules/work-orchestration/domain-persistence.service.ts',
  'test/helpers/e2e-app.ts',
  // 审计夹具自身：仅在测试字符串/注释中引用 token（无真实 import）。
  'server/modules/shared/__tests__/root-db-allowlist.audit.spec.ts',
]);

export interface RootTokenViolation {
  file: string;
  line: number;
}

/**
 * 扫描单个源文件：若文本引用根句柄且从 request-database-context 导入，返回
 * 违规（文件不在 allowlist 时）。无引用 / 命中 allowlist 返回空数组。
 */
export function auditSource(fileName: string, sourceText: string): RootTokenViolation[] {
  if (!sourceText.includes(ROOT_TOKEN)) return [];
  if (!IMPORT_FROM_CONTEXT.test(sourceText)) return [];
  const rel = fileName.replace(/\\/g, '/');
  if (ALLOWLIST.has(rel)) return [];
  const lines = sourceText.split('\n');
  const line =
    lines.findIndex((l) => l.includes(ROOT_TOKEN) || IMPORT_FROM_CONTEXT.test(l)) + 1;
  return [{ file: rel, line }];
}

/** 递归收集目录下所有 .ts 文件（排除 .d.ts）。 */
function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

describe('D7 根数据库句柄访问白名单审计（STANDALONE_ROOT_DATABASE）', () => {
  const appRoot = path.join(__dirname, '..', '..', '..', '..');
  const scanRoots = [
    path.join(appRoot, 'server', 'modules'),
    path.join(appRoot, 'server', 'database'),
    path.join(appRoot, 'test', 'helpers'),
  ];

  it('除 allowlist 外没有任何模块引用 STANDALONE_ROOT_DATABASE', () => {
    const files: string[] = [];
    for (const root of scanRoots) {
      if (fs.existsSync(root)) collectTsFiles(root, files);
    }
    const violations: RootTokenViolation[] = [];
    for (const file of files) {
      const rel = path.relative(appRoot, file).replace(/\\/g, '/');
      violations.push(...auditSource(rel, fs.readFileSync(file, 'utf8')));
    }
    expect(violations).toEqual([]);
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        '非 allowlist 模块引用根句柄：',
        violations.map((v) => `${v.file}:${v.line}`),
      );
    }
  });

  it('新增业务模块引用根句柄 → 被审计捕获（反例验证）', () => {
    const badSource = `
      import { STANDALONE_ROOT_DATABASE } from '@server/database/request-database-context';
      export class EvilTenantBypass {
        constructor(@Inject(STANDALONE_ROOT_DATABASE) private readonly db: unknown) {}
        async leak() {
          return this.db.select().from(ewohResourceLocks);
        }
      }
    `;
    const violations = auditSource('server/modules/evil/evil.service.ts', badSource);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].file).toBe('server/modules/evil/evil.service.ts');
  });

  it('allowlist 内文件引用根句柄不被误报（正例）', () => {
    const allowedSource = `
      import {
        RequestDatabaseContext,
        STANDALONE_ROOT_DATABASE,
      } from './request-database-context';
      @Injectable()
      export class RequestDatabaseContextConsumer {
        constructor(@Inject(STANDALONE_ROOT_DATABASE) private readonly root: unknown) {}
      }
    `;
    expect(auditSource('server/database/standalone-database.module.ts', allowedSource)).toEqual(
      [],
    );
  });

  it('无根句柄引用的文件不被误报（正例）', () => {
    const cleanSource = `
      import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
      @Injectable()
      export class TenantAwareService {
        constructor(@Inject(DRIZZLE_DATABASE) private readonly db: unknown) {}
      }
    `;
    expect(auditSource('server/modules/shared/tenant-aware.service.ts', cleanSource)).toEqual(
      [],
    );
  });

  // ===== NEST-509 扩展（2026-08-17）：systemTransaction 调用白名单审计 =====
  // systemTransaction 绕过租户 GUC（显式系统事务 API），调用方必须命中白名单。
  // 白名单 = 上述 ALLOWLIST 中会消费根句柄的业务文件（request-database-context
  // 自身是定义处）。新增业务调用方 → 测试失败。
  it('除 allowlist 外没有任何模块调用 systemTransaction', () => {
    const files: string[] = [];
    for (const root of scanRoots) {
      if (fs.existsSync(root)) collectTsFiles(root, files);
    }
    const systemTxAallowlist = new Set([
      'server/database/request-database-context.ts',
      'server/modules/work-orchestration/domain-persistence.service.ts',
      // CFG-01（2026-09-22）：登录/令牌复核发生在**身份与租户上下文建立之前**，
      // 而读的是 SECURITY DEFINER 的 ewoh_find_active_user（standalone_078，本就设计为
      // 跨租户可调）——这正是 systemTransaction 的约定用途。
      // 刻意不用 systemGlobalAdminTransaction：那会在一个尚未鉴权完成的请求里
      // 打开 app.is_global_admin=true，比所需权限更大。
      'server/modules/auth/auth.service.ts',
      // CFG-01b（2026-09-22 链外普查）：`/health/ready` 是 `@Public` 探活——OrgContextInterceptor
      // 只在 request.userContext 存在时建事务，所以它天然落在"有请求上下文、无事务 store"的格子里。
      // 读的是 `select 1`（无任何租户数据），属"进程/基础设施跨切面"用法 ⇒ 显式系统事务是正解；
      // 不开它就等于：按注释建议打开 EWOH_DB_REQUIRE_TX=1 后，就绪探针永远 503（实测 A/B：
      // 同一 spec 关=32 passed、开=health/ready 503）。刻意仍不用 systemGlobalAdminTransaction
      // ——匿名探活不需要、也不该拿到 `app.is_global_admin=true` 这种更大权限。
      'server/modules/health/health.controller.ts',
      // AUTH-02（2026-09-24 链行为基线 §5.3em）：AccessTokenGuard 的 org 层级解析发生在
      // 身份与租户上下文建立之前——守卫先于 TracingInterceptor（请求上下文建立点）与
      // OrgContextInterceptor（请求事务建立点）执行，读的是 SECURITY DEFINER 的
      // ewoh_find_org*（本就设计为身份前可调）⇒ 与 auth.service.ts 同款收口：
      // 显式 systemTransaction（无 GUC），不用 systemGlobalAdminTransaction（授权面
      // 解析不需要、也不该在鉴权完成前打开 is_global_admin）。V189 实测（隔离集群
      // Bearer → /api/auth/me 两档开关）：授权面在两档下都是全层级，零行为变化。
      'server/modules/shared/access-token.guard.ts',
      'server/modules/shared/__tests__/root-db-allowlist.audit.spec.ts',
    ]);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(appRoot, file).replace(/\\/g, '/');
      if (systemTxAallowlist.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes(SYSTEM_TX_TOKEN)) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error('非 allowlist 模块调用 systemTransaction：', violations);
    }
  });
});
