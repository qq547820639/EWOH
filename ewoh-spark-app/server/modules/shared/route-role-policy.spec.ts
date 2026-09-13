/* route-role.policy FALLBACK 角色映射完整性 + 控制器角色声明零遗漏守卫
 *
 * 背景（v0.7）：SchedulerMetricsController 无 @Roles 且不在 FALLBACK 表 →
 * RolesGuard 默认拒绝 → /api/scheduler/metrics* 全部 403（Prometheus 端点不可用）。
 *
 * 背景（WP-A，2026-09-13）：同一根因再次复发——TelemetryController 既无
 * @Roles/@FallbackRoles 也不在 FALLBACK 表 → /api/telemetry/batch 与
 * /api/telemetry/summary 对**所有**登录用户恒 403，而前端静默吞掉失败，
 * 埋点从未落库。原测试只断言"SchedulerController/TaskController/AlertController
 * 存在映射"，覆盖检查太弱，抓不到这类新增遗漏。
 *
 * 本测试改为**零遗漏**守卫：扫描 server/modules/**\/*.controller.ts，逐一检查
 * 每个 controller 是否满足下列其一，否则失败：
 *   1. 类级或方法级 @Roles(...) 非空；
 *   2. 类级或方法级 @FallbackRoles(...) 非空；
 *   3. 类级或方法级 @Public()（公开端点，无需角色）；
 *   4. FALLBACK_CONTROLLER_ROLES[类名] 非空。
 * 这样任何"新 controller 忘声明角色"都会在 CI 被捕获，而不是等线上 403。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import 'reflect-metadata';
import { ANY_AUTHENTICATED_ROLES, FALLBACK_ROLES_KEY, ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { FALLBACK_CONTROLLER_ROLES } from './route-role.policy';

/** 递归收集目录下所有 *.controller.ts（排除 .d.ts）。 */
function collectControllerFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectControllerFiles(full, out);
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
}

interface ControllerDeclaration {
  /** 相对 ewoh-spark-app 根的路径。 */
  file: string;
  className: string;
  /** 类级或方法级 @Roles 非空。 */
  hasRoles: boolean;
  /** 类级或方法级 @FallbackRoles 非空。 */
  hasFallbackRoles: boolean;
  /** 类级或方法级 @Public。 */
  isPublic: boolean;
  /** FALLBACK_CONTROLLER_ROLES 中有非空条目。 */
  hasFallbackMapEntry: boolean;
}

/**
 * 从类的原型上收集方法级元数据；类级元数据另取。
 * 返回该 controller 是否声明了角色/公开标记。
 */
function inspectControllerClass(relFile: string, cls: Function): ControllerDeclaration {
  const proto = cls.prototype as Record<string, unknown>;
  const meta = Reflect as typeof Reflect & {
    getMetadata: (key: string, target: object, propertyKey?: string | symbol) => unknown;
  };

  let hasRoles = Boolean(
    (meta.getMetadata(ROLES_KEY, cls) as unknown[] | undefined)?.length,
  );
  let hasFallbackRoles = Boolean(
    (meta.getMetadata(FALLBACK_ROLES_KEY, cls) as unknown[] | undefined)?.length,
  );
  let isPublic = meta.getMetadata(IS_PUBLIC_KEY, cls) === true;

  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const handler = proto[key];
    if (typeof handler !== 'function') continue;
    // 关键：Nest 的 SetMetadata 作用于方法装饰器时，把元数据 define 在
    // **方法函数本身**（descriptor.value）而非 (prototype, propertyKey) 上，
    // 与 RolesGuard 的 context.getHandler() 取值方式一致。
    if ((meta.getMetadata(ROLES_KEY, handler) as unknown[] | undefined)?.length) {
      hasRoles = true;
    }
    if ((meta.getMetadata(FALLBACK_ROLES_KEY, handler) as unknown[] | undefined)?.length) {
      hasFallbackRoles = true;
    }
    if (meta.getMetadata(IS_PUBLIC_KEY, handler) === true) {
      isPublic = true;
    }
  }

  const mapEntry = FALLBACK_CONTROLLER_ROLES[cls.name];
  return {
    file: relFile,
    className: cls.name,
    hasRoles,
    hasFallbackRoles,
    isPublic,
    hasFallbackMapEntry: Boolean(mapEntry && mapEntry.length > 0),
  };
}

/** 扫描并实例化期前的静态检查：读取每个 controller 类的装饰器元数据。 */
export function collectControllerDeclarations(modulesRoot: string, appRoot: string): ControllerDeclaration[] {
  const files: string[] = [];
  collectControllerFiles(modulesRoot, files);
  const declarations: ControllerDeclaration[] = [];
  for (const file of files) {
    const rel = path.relative(appRoot, file).replace(/\\/g, '/');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const cls = exported as Function;
      // 只认 controller 类（export class XxxController）。
      if (!/Controller$/.test(cls.name)) continue;
      declarations.push(inspectControllerClass(rel, cls));
    }
  }
  return declarations;
}

describe('route-role.policy: FALLBACK 角色映射完整性', () => {
  it('SchedulerMetricsController 有角色映射（metrics 端点可用）', () => {
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerMetricsController).toBeDefined();
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerMetricsController.length).toBeGreaterThan(0);
    // 观测端点应至少允许 global_admin 读取
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerMetricsController).toContain('global_admin');
  });

  it('FALLBACK 表所有映射非空且含有效角色', () => {
    for (const [controller, roles] of Object.entries(FALLBACK_CONTROLLER_ROLES)) {
      // jest expect 仅接受 1 个参数；角色非空断言失败时附 controller 名便于定位。
      const message = `${controller} 应有角色`;
      try {
        expect(roles.length).toBeGreaterThan(0);
      } catch (err) {
        throw new Error(`${message}: ${(err as Error).message}`);
      }
    }
  });

  it('核心 controller 均有映射（不因缺映射被默认拒绝）', () => {
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerController).toBeDefined();
    expect(FALLBACK_CONTROLLER_ROLES.TaskController).toBeDefined();
    expect(FALLBACK_CONTROLLER_ROLES.AlertController).toBeDefined();
  });
});

describe('route-role.policy: 控制器角色声明零遗漏（RolesGuard default-deny 守卫）', () => {
  const appRoot = path.join(__dirname, '..', '..', '..');
  const modulesRoot = path.join(appRoot, 'server', 'modules');

  it('每个 controller 都有 @Roles/@FallbackRoles/@Public 或 FALLBACK 表映射', () => {
    const declarations = collectControllerDeclarations(modulesRoot, appRoot);
    // 底线：确实扫到了 controller（防止路径写错导致空跑通过）。
    expect(declarations.length).toBeGreaterThan(50);

    const undecorated = declarations.filter(
      (d) => !d.hasRoles && !d.hasFallbackRoles && !d.isPublic && !d.hasFallbackMapEntry,
    );
    expect(undecorated.map((d) => `${d.file} (${d.className})`)).toEqual([]);
  });

  it('TelemetryController 已被守卫登记（本 work item 的回归锚点）', () => {
    const declarations = collectControllerDeclarations(modulesRoot, appRoot);
    const telemetry = declarations.find((d) => d.className === 'TelemetryController');
    expect(telemetry).toBeDefined();
    // 显式声明角色（不再是 default-deny 的死端点）。
    expect(telemetry?.hasRoles).toBe(true);
  });

  it('ANY_AUTHENTICATED_ROLES 覆盖全部已知业务角色（batch 上报的语义前提）', () => {
    expect([...ANY_AUTHENTICATED_ROLES]).toEqual(
      expect.arrayContaining([
        'viewer',
        'worker',
        'dispatcher',
        'workshop_lead',
        'safety_admin',
        'device_ops',
        'global_admin',
      ]),
    );
  });
});
