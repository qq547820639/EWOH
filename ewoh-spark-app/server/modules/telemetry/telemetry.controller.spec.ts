/* TelemetryController 路由角色声明回归（WP-A，2026-09-13）
 *
 * 实故障：全局 RolesGuard 是 default-deny，而 TelemetryController 既无 @Roles
 * 也无 FALLBACK 映射 → /api/telemetry/batch 与 /api/telemetry/summary 对所有
 * 登录角色恒 403。前端 api/telemetry.ts 静默吞掉失败，于是埋点从未落库却无人
 * 察觉（文档/CHANGELOG 却宣称"埋点落库已真正可用"）。
 *
 * 本测试用**真实 RolesGuard** 走一遍两个端点，锁定：
 *  - 上报（batch）对所有已登录角色放行（登录即可写）；
 *  - 聚合读取（summary）只对管理/观测角色放行，worker/viewer 被拒。
 * 修复前 batch 对 worker 也必须返回 false（default-deny），故本测试修复前失败。
 */
/// <reference types="jest" />
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TelemetryController } from './telemetry.controller';
import type { TelemetryService } from './telemetry.service';
import { RolesGuard } from '../shared/roles.guard';
import { ANY_AUTHENTICATED_ROLES, ROLES_KEY } from '../shared/roles.decorator';

/** 构造仅含 RolesGuard 所需字段的 ExecutionContext。 */
function makeContext(
  handler: (...args: never[]) => unknown,
  userRoles: string[],
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TelemetryController,
    switchToHttp: () => ({
      getRequest: () => ({ userContext: { roles: userRoles } }),
    }),
  } as unknown as ExecutionContext;
}

describe('TelemetryController 路由角色声明（WP-A）', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  // 控制器行为测试不触达服务，只验证守卫判定。
  const controller = new TelemetryController({} as TelemetryService);

  it('POST batch：显式 @Roles(ANY_AUTHENTICATED_ROLES)，不再被 default-deny 误伤', () => {
    const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      TelemetryController.prototype.recordBatch,
      TelemetryController,
    ]);
    expect(Array.isArray(roles)).toBe(true);
    expect(roles).toHaveLength(ANY_AUTHENTICATED_ROLES.length);
    for (const role of ANY_AUTHENTICATED_ROLES) {
      expect(roles).toContain(role);
    }
  });

  it('GET summary：维持限角色（非任意登录可读）', () => {
    const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      TelemetryController.prototype.summary,
      TelemetryController,
    ]);
    expect(roles).toEqual(
      expect.arrayContaining(['global_admin', 'safety_admin', 'dispatcher', 'workshop_lead']),
    );
    expect(roles).not.toContain('worker');
  });

  it('RolesGuard 放行：任意已登录角色可上报 batch（修复前恒 false）', () => {
    expect(controller).toBeDefined();
    for (const role of ANY_AUTHENTICATED_ROLES) {
      const ctx = makeContext(
        TelemetryController.prototype.recordBatch as (...a: never[]) => unknown,
        [role],
      );
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('RolesGuard 放行：dispatcher 可读 summary', () => {
    const ctx = makeContext(
      TelemetryController.prototype.summary as (...a: never[]) => unknown,
      ['dispatcher'],
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('RolesGuard 拒绝：worker 不可读 summary；无角色一律拒绝', () => {
    const workerCtx = makeContext(
      TelemetryController.prototype.summary as (...a: never[]) => unknown,
      ['worker'],
    );
    expect(guard.canActivate(workerCtx)).toBe(false);

    const anonCtx = makeContext(
      TelemetryController.prototype.recordBatch as (...a: never[]) => unknown,
      [],
    );
    expect(guard.canActivate(anonCtx)).toBe(false);
  });
});
