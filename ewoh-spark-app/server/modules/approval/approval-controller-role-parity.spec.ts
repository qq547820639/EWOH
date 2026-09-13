/**
 * WP-I-role-decl-mismatch 回归：审批旁路**守卫与服务层同源**。
 *
 * 背景（缺陷 I2）：POST /api/approvals/:id/bypass 无方法级 @Roles，继承类级 FALLBACK
 * （ApprovalController → global_admin/workshop_lead/safety_admin）。但服务层
 * approval-persistence.service.ts `bypass()` 只认 global_admin（契约
 * contracts/state-machines/approval.yaml 的 pending→bypassed，role: high_privilege_admin）。
 * 于是 workshop_lead/safety_admin 能过守卫、却在服务层吃 403——角色面板口径与实际权限分裂。
 *
 * 本测试锁定可机器校验的不变量：
 *  **守卫放行的每一个角色，服务层都必须接受**（控制器角色集 ⊆ 服务层允许集）。
 * 修复前 FALLBACK 放行 workshop_lead/safety_admin，服务层拒绝 → 断言失败。
 */
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ewohEvent, ewohEventChain } from '@server/database/schema';
import { RolesGuard } from '../shared/roles.guard';
import { ANY_AUTHENTICATED_ROLES } from '../shared/roles.decorator';
import { ApprovalController, APPROVAL_BYPASS_ROLES } from './approval.controller';
import { ApprovalPersistenceService } from './approval-persistence.service';

const guard = new RolesGuard(new Reflector());
const bypassHandler = ApprovalController.prototype.bypass;
const instanceId = 'instance-1';

function canActivate(roles: string[]): boolean {
  const context = {
    getHandler: () => bypassHandler,
    getClass: () => ApprovalController,
    switchToHttp: () => ({
      getRequest: () => ({ userContext: { roles, userId: 'u-1', primaryOrgId: 'org-1' } }),
    }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

/** 最小行为化 mock：一条 pending 实例 + 一个 pending step，够 bypass 走通。 */
function createDbMock() {
  const now = new Date('2026-08-03T00:00:00.000Z');
  const eventRow: Record<string, unknown> = {
    eventId: instanceId,
    eventType: 'approval_instance',
    status: 'pending',
    createdAt: now,
    orgId: 'org-1',
    evidenceJson: {
      entityType: 'control_request',
      entityId: 'ctl-1',
      createdAt: now.toISOString(),
      createdBy: 'initiator-1',
    },
  };
  const chainRows: Array<Record<string, unknown>> = [
    {
      eventId: 'step-1',
      parentEventId: instanceId,
      causalType: 'approval_step',
      description: JSON.stringify({ role: 'safety_admin', status: 'pending', reason: null, delegateTo: null }),
      createdAt: now,
    },
  ];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (table === ewohEvent) return { where: jest.fn(async () => [eventRow]) };
        if (table === ewohEventChain) {
          return { where: jest.fn(() => ({ orderBy: jest.fn(async () => chainRows) })) };
        }
        throw new Error(`unexpected select table ${String(table)}`);
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn(async () => [eventRow]) })) })),
    })),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  } as never;
  return db;
}

function makeService() {
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const service = new ApprovalPersistenceService(createDbMock(), audit as never);
  return { service, audit };
}

/** 守卫实际放行的角色集合（等价于 RolesGuard.canActivate 为 true 的角色）。 */
const guardAdmitted = ANY_AUTHENTICATED_ROLES.filter((role) => canActivate([role]));

describe('缺陷 I2：bypass 守卫角色 ⊆ 服务层允许角色', () => {
  it('守卫放行的每个角色，服务层 bypass 都接受（不出现"放行即 403"）', async () => {
    for (const role of guardAdmitted) {
      const { service } = makeService();
      // 若该角色被服务层拒绝，这里会抛 ForbiddenException → 断言失败。
      await expect(
        service.bypass(instanceId, 'urgent', {
          userId: 'actor-1',
          primaryOrgId: 'org-1',
          roles: [role],
        }),
      ).resolves.toBeDefined();
    }
  });

  it('守卫放行集合 == 控制器声明角色（@Roles 确实生效，未被类级 FALLBACK 覆盖）', () => {
    expect([...guardAdmitted].sort()).toEqual([...APPROVAL_BYPASS_ROLES].sort());
  });

  it('旁路写面收敛到 global_admin：workshop_lead/safety_admin 不再过守卫', () => {
    expect(canActivate(['global_admin'])).toBe(true);
    expect(canActivate(['workshop_lead'])).toBe(false);
    expect(canActivate(['safety_admin'])).toBe(false);
  });

  it('服务层另一侧口径未被放宽：非 global_admin 调 bypass 仍 403', async () => {
    for (const role of ['workshop_lead', 'safety_admin']) {
      const { service } = makeService();
      await expect(
        service.bypass(instanceId, 'urgent', {
          userId: 'actor-1',
          primaryOrgId: 'org-1',
          roles: [role],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});
