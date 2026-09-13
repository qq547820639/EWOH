/**
 * WP-I-role-decl-mismatch 回归：班次域**写面收敛**。
 *
 * 背景（缺陷 I1）：ShiftController 类级仅声明 ANY_AUTHENTICATED_ROLES，两个 POST
 * （登记班次定义 / 登记交接）继承类级角色 → viewer/worker 也能写。班次定义是全厂
 * 排班与"当前班"口径的输入，读者不需要写权限。
 *
 * 本测试锁定两个不变量：
 *  1. 写面（POST）拒绝 worker/viewer，只对班次工作台入口角色开放；
 *  2. 读面（GET）保持 broad（worker 仍可读）。
 * 修复前断言 1 失败（写面 = ANY_AUTHENTICATED_ROLES，worker 放行）。
 */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../shared/roles.guard';
import { ANY_AUTHENTICATED_ROLES } from '../shared/roles.decorator';
import { ShiftController, SHIFT_WRITE_ROLES } from './shift.controller';

const guard = new RolesGuard(new Reflector());

/** 复刻 RolesGuard 的真实判定（方法级 @Roles 优先于类级）。 */
function canActivate(handler: unknown, roles: string[]): boolean {
  const context = {
    getHandler: () => handler,
    getClass: () => ShiftController,
    switchToHttp: () => ({
      getRequest: () => ({ userContext: { roles, userId: 'u-1', primaryOrgId: 'org-1' } }),
    }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

const listHandler = ShiftController.prototype.list;
const currentHandler = ShiftController.prototype.current;
const upsertHandler = ShiftController.prototype.upsert;
const handoversHandler = ShiftController.prototype.handovers;
const createHandoverHandler = ShiftController.prototype.createHandover;

describe('缺陷 I1：班次写面收敛（POST 拒绝 worker/viewer）', () => {
  it.each([['worker'], ['viewer']])('POST /api/shifts 拒绝 %s（登记班次定义是写面）', (role) => {
    expect(canActivate(upsertHandler, [role])).toBe(false);
  });

  it.each([['worker'], ['viewer']])('POST /api/shifts/handovers 拒绝 %s（登记交接是写面）', (role) => {
    expect(canActivate(createHandoverHandler, [role])).toBe(false);
  });

  it('写面对班次工作台入口角色开放（global_admin/dispatcher/workshop_lead/safety_admin）', () => {
    for (const role of SHIFT_WRITE_ROLES) {
      expect(canActivate(upsertHandler, [role])).toBe(true);
      expect(canActivate(createHandoverHandler, [role])).toBe(true);
    }
  });

  it('写面角色集是类级读面角色集的真子集（写面确实被收敛）', () => {
    // 写面若等于 ANY_AUTHENTICATED_ROLES，说明收敛没生效。
    expect(new Set(SHIFT_WRITE_ROLES).size).toBeLessThan(ANY_AUTHENTICATED_ROLES.length);
    for (const role of SHIFT_WRITE_ROLES) {
      expect(ANY_AUTHENTICATED_ROLES).toContain(role);
    }
  });

  it('读面保持 broad：worker 仍可读班次列表/当前班/交接记录', () => {
    expect(canActivate(listHandler, ['worker'])).toBe(true);
    expect(canActivate(currentHandler, ['worker'])).toBe(true);
    expect(canActivate(handoversHandler, ['worker'])).toBe(true);
  });
});
