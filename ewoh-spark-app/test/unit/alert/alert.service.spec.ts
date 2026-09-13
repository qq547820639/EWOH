import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AlertService,
  nextAlertStatus,
} from '../../../server/modules/alert/alert.service';

function sqlContains(
  condition: unknown,
  column: string,
  value: string,
): boolean {
  const strings: string[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string') strings.push(node);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(condition);
  return strings.includes(column) && strings.includes(value);
}

function createDbMock(selectRows: unknown[], updateRows: unknown[]) {
  const updateReturning = jest.fn().mockResolvedValue(updateRows);
  const updateWhere = jest.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  return {
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue(selectRows),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
    } as never,
    updateWhere,
  };
}

describe('alert state machine', () => {
  it('walks acknowledge/process/close and reopen（ADR-031 角色条件）', () => {
    expect(nextAlertStatus('open', 'acknowledge', 'dispatcher')).toBe('acknowledged');
    expect(nextAlertStatus('acknowledged', 'process', 'workshop_lead')).toBe('processing');
    expect(nextAlertStatus('processing', 'close', 'device_ops')).toBe('closed');
    expect(nextAlertStatus('closed', 'reopen', 'safety_admin')).toBe('reopened');
    expect(nextAlertStatus('reopened', 'process', 'dispatcher')).toBe('processing');
  });

  it('reopen 角色强制：非 safety_admin 拒绝', () => {
    expect(nextAlertStatus('closed', 'reopen', 'dispatcher')).toBeNull();
    expect(nextAlertStatus('closed', 'reopen')).toBeNull();
  });

  it('rejects illegal transitions', () => {
    expect(nextAlertStatus('open', 'close')).toBeNull();
    expect(nextAlertStatus('closed', 'acknowledge')).toBeNull();
  });

  // 为什么必须钉死：global_admin 的超管语义是"满足一切角色条件"（纯 global_admin
  // 账号不含 handler/safety_admin 也能处置），不是"跳出状态机"——open→closed 在
  // alert.yaml 里没有这条边，放行它等于确认/处置两步审计被整段跳过（非法转移被拒
  // 的契约失效，且与 oee.transitionAndon 永远走转移表的行为分叉）。
  it('global_admin 不豁免转移拓扑：open 上 close 仍被拒（非法转移，alert.yaml）', async () => {
    const before = { eventId: 'EVT-GA-1', status: 'open', title: 'alert' };
    const { db, updateWhere } = createDbMock([before], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AlertService(db, audit as never);

    const error = await service
      .transitionAlert('EVT-GA-1', 'close', {
        userId: 'admin-1',
        primaryOrgId: 'org-1',
        // 纯 global_admin 账号（不含 handler/safety_admin 角色）
        roles: ['global_admin'],
        isGlobalAdmin: true,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('not allowed');
    // 非法转移必须在写库前被拒绝：状态行与审计都不能动
    expect(updateWhere).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('global_admin 仍可执行合法转移（豁免的是角色条件，无需 handler 角色）', async () => {
    const before = { eventId: 'EVT-GA-2', status: 'acknowledged', title: 'alert' };
    const after = { ...before, status: 'processing' };
    const { db } = createDbMock([before], [after]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AlertService(db, audit as never);

    const result = await service.transitionAlert('EVT-GA-2', 'process', {
      userId: 'admin-1',
      primaryOrgId: 'org-1',
      roles: ['global_admin'],
      isGlobalAdmin: true,
    });

    // acknowledged→processing 是转移表里真实存在的边：超管免角色放行
    expect(result.status).toBe('processing');
  });

  it('returns 409 STATE_CONFLICT when the conditional update affects zero rows', async () => {
    const before = { eventId: 'EVT-1', status: 'processing', title: 'alert' };
    const { db, updateWhere } = createDbMock([before], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AlertService(db, audit as never);

    const error = await service
      .transitionAlert('EVT-1', 'close', {
        userId: 'user-1',
        primaryOrgId: 'org-1',
        // SH-004 联动：alert 状态机 role fail-closed，处置必须携带角色
        // （NEST-409/410：AccessTokenGuard 注入 roles 数组）。
        roles: ['device_ops'],
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(error.message).toContain('STATE_CONFLICT');
    expect(
      sqlContains(updateWhere.mock.calls[0][0], 'status', 'processing'),
    ).toBe(true);
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('records actor/org/before/after audit after closing an alert', async () => {
    const before = { eventId: 'EVT-1', status: 'processing', title: 'alert' };
    const after = { ...before, status: 'closed' };
    const { db } = createDbMock([before], [after]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AlertService(db, audit as never);

    const result = await service.transitionAlert('EVT-1', 'close', {
      userId: 'user-1',
      primaryOrgId: 'org-1',
      // SH-004 联动：alert 状态机 role fail-closed，处置必须携带角色
      // （NEST-409/410：AccessTokenGuard 注入 roles 数组）。
      roles: ['device_ops'],
    });

    expect(result.status).toBe('closed');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'alert.close',
        entityType: 'alert',
        entityId: 'EVT-1',
        before: { status: 'processing' },
        after: { status: 'closed' },
      }),
    );
  });
});
