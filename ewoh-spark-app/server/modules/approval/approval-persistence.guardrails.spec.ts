/**
 * R2-SMI-003/004/011 单测：审批护栏——服务端角色映射 + 发起人回避
 * （segregation of duties）、step/instance 同事务、global_admin 单条读放行。
 */
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ewohEvent, ewohEventChain } from '@server/database/schema';
import {
  ApprovalPersistenceService,
  APPROVAL_ROLE_POLICY,
} from './approval-persistence.service';

const now = new Date('2026-08-03T00:00:00.000Z');
const instanceId = 'instance-1';

interface Mocks {
  db: never;
  transaction: jest.Mock;
  eventInsertValues: jest.Mock;
  chainInsertValues: jest.Mock;
  eventUpdateWhere: jest.Mock;
  chainUpdateWhere: jest.Mock;
}

/**
 * 行为化 mock：事件/步骤行可变存储（select 回读 + 条件更新按eventId命中），
 * 事务回调以同一 db 执行并记录。
 */
function createDbMock(seed: {
  event?: Record<string, unknown>;
  chains?: Array<Record<string, unknown>>;
} = {}): Mocks {
  const eventRow: Record<string, unknown> = seed.event ?? {
    eventId: instanceId,
    eventType: 'approval_instance',
    title: 'Approval for control_request ctl-1',
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
  const chainRows: Array<Record<string, unknown>> = seed.chains ?? [
    {
      eventId: 'step-1',
      parentEventId: instanceId,
      causalType: 'approval_step',
      description: JSON.stringify({
        role: 'safety_admin',
        status: 'pending',
        reason: null,
        delegateTo: null,
      }),
      createdAt: now,
    },
  ];

  const eventInsertValues = jest.fn(async (values: Record<string, unknown>) => {
    Object.assign(eventRow, values, { _inserted: true });
    return [eventRow];
  });
  const chainInsertValues = jest.fn(async (rows: Array<Record<string, unknown>>) => {
    chainRows.push(...rows);
    return rows;
  });
  const eventUpdateWhere = jest.fn(() => ({
    returning: jest.fn(async () => [eventRow]),
  }));
  const chainUpdateWhere = jest.fn(() => ({
    returning: jest.fn(async () => [{}]),
  }));
  const eventWhere = jest.fn(async () => [eventRow]);
  const chainWhere = jest.fn(() => ({
    orderBy: jest.fn(async () => chainRows),
  }));

  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (table === ewohEvent) return { where: eventWhere };
        if (table === ewohEventChain) return { where: chainWhere };
        throw new Error(`unexpected select table ${String(table)}`);
      }),
    })),
    insert: jest.fn((table: unknown) => {
      if (table === ewohEvent) return { values: eventInsertValues };
      if (table === ewohEventChain) return { values: chainInsertValues };
      throw new Error(`unexpected insert table ${String(table)}`);
    }),
    update: jest.fn((table: unknown) => {
      if (table === ewohEvent) {
        return { set: jest.fn(() => ({ where: eventUpdateWhere })) };
      }
      if (table === ewohEventChain) {
        return { set: jest.fn(() => ({ where: chainUpdateWhere })) };
      }
      throw new Error(`unexpected update table ${String(table)}`);
    }),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  } as never;

  return {
    db,
    transaction: (db as unknown as { transaction: jest.Mock }).transaction,
    eventInsertValues,
    chainInsertValues,
    eventUpdateWhere,
    chainUpdateWhere,
  };
}

function createAuditMock() {
  return { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
}

describe('R2-SMI-003：服务端审批角色映射', () => {
  it('control_request → safety_admin（客户端 roles 被忽略）', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    const instance = await service.createApproval(
      { entityType: 'control_request', entityId: 'ctl-1', roles: ['dispatcher'] },
      { userId: 'initiator-1', primaryOrgId: 'org-1', roles: ['dispatcher'] },
    );

    expect(instance.steps).toHaveLength(1);
    expect(instance.steps[0].role).toBe('safety_admin');
    expect(APPROVAL_ROLE_POLICY.control_request).toEqual(['safety_admin']);
  });

  it('未登记 entityType → 400（不可自造审批类型）', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    await expect(
      service.createApproval(
        { entityType: 'arbitrary_type', entityId: 'x', roles: ['dispatcher'] },
        { userId: 'u1', primaryOrgId: 'org-1', roles: ['dispatcher'] },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.eventInsertValues).not.toHaveBeenCalled();
  });
});

describe('R2-SMI-003：发起人回避（segregation of duties）', () => {
  it('发起人自己 approve → 403（即使角色匹配/为 global_admin）', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    await expect(
      service.stepAction(instanceId, 'step-1', 'approve', 'self-approve', undefined, {
        userId: 'initiator-1',
        primaryOrgId: 'org-1',
        roles: ['safety_admin'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.chainUpdateWhere).not.toHaveBeenCalled();
  });

  it('非发起人且角色匹配 → 放行', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    const result = await service.stepAction(
      instanceId,
      'step-1',
      'approve',
      'ok',
      undefined,
      { userId: 'safety-officer', primaryOrgId: 'org-1', roles: ['safety_admin'] },
    );

    expect(result.status).toBe('approved');
    expect(result.steps[0].status).toBe('approved');
  });

  it('legacy 行无 createdBy → 回避不适用（不锁死存量实例）', async () => {
    const mocks = createDbMock({
      event: {
        eventId: instanceId,
        eventType: 'approval_instance',
        status: 'pending',
        createdAt: now,
        orgId: 'org-1',
        evidenceJson: { entityType: 'control_request', entityId: 'ctl-1' },
      },
    });
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    const result = await service.stepAction(
      instanceId,
      'step-1',
      'approve',
      undefined,
      undefined,
      { userId: 'anyone', primaryOrgId: 'org-1', roles: ['safety_admin'] },
    );
    expect(result.status).toBe('approved');
  });
});

describe('R2-SMI-004：step/instance 双写同事务', () => {
  it('createApproval：event+chain INSERT 在同一事务内提交', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    await service.createApproval(
      { entityType: 'control_request', entityId: 'ctl-9', roles: [] },
      { userId: 'u1', primaryOrgId: 'org-1', roles: [] },
    );

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.eventInsertValues).toHaveBeenCalled();
    expect(mocks.chainInsertValues).toHaveBeenCalled();
  });

  it('stepAction：step UPDATE 与 instance UPDATE 在同一事务内', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    await service.stepAction(instanceId, 'step-1', 'approve', undefined, undefined, {
      userId: 'safety-officer',
      primaryOrgId: 'org-1',
      roles: ['safety_admin'],
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.chainUpdateWhere).toHaveBeenCalledTimes(1);
    expect(mocks.eventUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('bypass：全部 step 跳过 + instance 置 bypassed 同事务', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    await service.bypass(instanceId, 'urgent', {
      userId: 'root',
      primaryOrgId: 'org-1',
      roles: ['global_admin'],
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.chainUpdateWhere).toHaveBeenCalledTimes(1);
    expect(mocks.eventUpdateWhere).toHaveBeenCalledTimes(1);
  });
});

describe('R2-SMI-011：global_admin 单条读放行（列表/详情语义一致）', () => {
  it('跨租户单条读：global_admin 放行，普通租户 404', async () => {
    const mocks = createDbMock();
    const service = new ApprovalPersistenceService(mocks.db, createAuditMock() as never);

    const asGlobalAdmin = await service.getApproval(instanceId, {
      userId: 'g1',
      primaryOrgId: 'org-other',
      roles: ['global_admin'],
      isGlobalAdmin: true,
    });
    expect(asGlobalAdmin.id).toBe(instanceId);

    await expect(
      service.getApproval(instanceId, {
        userId: 'u9',
        primaryOrgId: 'org-other',
        roles: ['safety_admin'],
      }),
    ).rejects.toThrow(/not found/);
  });
});
