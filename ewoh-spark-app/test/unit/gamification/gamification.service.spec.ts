import { NotFoundException } from '@nestjs/common';
import { GamificationService } from '../../../server/modules/gamification/gamification.service';
import {
  ewohDevice,
  ewohEvent,
  ewohSchedulePlan,
  ewohScheduleAudit,
} from '@server/database/schema';

function createDispatchDb(planRows: unknown[], deviceRows: unknown[]) {
  const updateWhere = jest.fn().mockResolvedValue([]);
  const auditReturning = jest.fn().mockResolvedValue([
    { auditId: 'AUDIT-1', planId: 'P-1' },
  ]);
  const insertRows: Array<{
    table: unknown;
    row: Record<string, unknown>;
  }> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === ewohSchedulePlan) {
            return { limit: jest.fn().mockResolvedValue(planRows) };
          }
          const devicePromise = Promise.resolve(deviceRows);
          (
            devicePromise as Promise<unknown[]> & {
              limit: jest.Mock;
            }
          ).limit = jest.fn().mockResolvedValue(deviceRows);
          return devicePromise;
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        return { returning: auditReturning };
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: updateWhere,
      })),
    })),
  };
  return { db, updateWhere, auditReturning, insertRows };
}

describe('GamificationService player roles', () => {
  const originalRole = process.env.EWOH_PLAYER_ROLE;
  const originalName = process.env.EWOH_PLAYER_NAME;

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.EWOH_PLAYER_ROLE;
    } else {
      process.env.EWOH_PLAYER_ROLE = originalRole;
    }
    if (originalName === undefined) {
      delete process.env.EWOH_PLAYER_NAME;
    } else {
      process.env.EWOH_PLAYER_NAME = originalName;
    }
  });

  it('maps workshop director permissions from the environment role', () => {
    process.env.EWOH_PLAYER_ROLE = 'workshop_director';
    process.env.EWOH_PLAYER_NAME = '车间主任';
    const service = new GamificationService({} as never);

    const role = service.getRole();
    expect(role.role).toBe('workshop_director');
    expect(role.roleName).toBe('车间主任');
    expect(role.permissions).toContain('dispatch_plan');
    expect(role.permissions).not.toContain('adjust_weights');
  });

  it('defaults to shift leader when no role is configured', () => {
    delete process.env.EWOH_PLAYER_ROLE;
    const service = new GamificationService({} as never);
    expect(service.getRole().role).toBe('shift_leader');
    expect(service.getRole().permissions).toContain('confirm_plan');
    expect(service.getRole().permissions).not.toContain('dispatch_plan');
  });
});

describe('GamificationService dispatch and feedback', () => {
  it('dispatches a confirmed plan when linked devices are online', async () => {
    const plan = {
      id: 'row-1',
      planId: 'P-1',
      status: 'confirmed',
      metricsJson: { assignedEntities: ['EXO-1'] },
    };
    const devices = [
      { deviceId: 'EXO-1', online: true, workerName: 'W-1' },
    ];
    const { db, updateWhere } = createDispatchDb([plan], devices);
    const service = new GamificationService(db as never);

    const result = await service.dispatchPlan('P-1', {
      operator: 'supervisor',
    });

    expect(result.status).toBe('dispatched');
    expect(result.conflicts).toEqual([]);
    expect(updateWhere).toHaveBeenCalled();
  });

  it('returns conflict and refuses dispatch when a linked device is offline', async () => {
    const plan = {
      id: 'row-1',
      planId: 'P-1',
      status: 'confirmed',
      metricsJson: { assignedEntities: ['EXO-1'] },
    };
    const devices = [
      { deviceId: 'EXO-1', online: false, workerName: 'W-1' },
    ];
    const { db, updateWhere } = createDispatchDb([plan], devices);
    const service = new GamificationService(db as never);

    const result = await service.dispatchPlan('P-1', {
      operator: 'supervisor',
    });

    expect(result.status).toBe('conflict');
    expect(result.conflicts[0]).toContain('离线');
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it('rejects exoskeleton feedback for an offline device', async () => {
    const { db } = createDispatchDb([], [
      { deviceId: 'EXO-1', online: false },
    ]);
    const service = new GamificationService(db as never);

    const result = await service.sendExoFeedback('EXO-1', {
      type: 'tactile',
      tactilePattern: 'vibrate_high',
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toBe('设备离线');
  });

  it('records exoskeleton feedback events for online devices', async () => {
    const { db, insertRows } = createDispatchDb([], [
      { deviceId: 'EXO-1', online: true },
    ]);
    const service = new GamificationService(db as never);

    const result = await service.sendExoFeedback('EXO-1', {
      type: 'voice',
      message: '负荷过高，请休息',
      priority: 'high',
    });

    expect(result.accepted).toBe(true);
    expect(result.delivered).toBe(true);
    expect(
      insertRows.some((entry) => entry.table === ewohEvent),
    ).toBe(true);
  });
});

describe('GamificationService helpers', () => {
  it('normalizes load balance and extracts assigned entity ids', () => {
    const service = new GamificationService({} as never);
    const instance = service as unknown as {
      computeStdDevNormalized(values: number[]): number;
      extractEntityIds(metrics: Record<string, unknown>): string[];
    };
    expect(instance.computeStdDevNormalized([0.5, 0.5])).toBe(1);
    expect(
      instance.extractEntityIds({
        allocatedEntities: ['A', 'A'],
        assignedEntities: ['B'],
      }),
    ).toEqual(['A', 'B']);
  });
});

/** ADR-071（NO-13v）：allocate/orchestrate 直插路径的 db mock（insert/update 捕获）。 */
function createPlanWriteDb() {
  const insertRows: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const updateTables: unknown[] = [];
  function whereResult() {
    const groupBy = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockResolvedValue([]);
    const t = Promise.resolve([]) as Promise<unknown[]> & {
      groupBy: jest.Mock;
      limit: jest.Mock;
    };
    t.groupBy = groupBy;
    t.limit = limit;
    return t;
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        innerJoin: jest.fn(() => ({
          where: jest.fn(whereResult),
        })),
        where: jest.fn(whereResult),
      })),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => {
          updateTables.push(table);
          return [];
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        const t = Promise.resolve([row]) as Promise<unknown[]> & {
          returning: jest.Mock;
        };
        t.returning = jest.fn().mockResolvedValue([row]);
        return t;
      }),
    })),
  };
  return { db, insertRows, updateTables };
}

describe('GamificationService plan org isolation (ADR-071 / NO-13v)', () => {
  it('allocateResources 写方案行 orgId=primaryOrgId（ctx 归属，不再落全局行）', async () => {
    const { db, insertRows } = createPlanWriteDb();
    const service = new GamificationService(db as never);
    await service.allocateResources(
      {
        allocations: [
          { entityId: 'EXO-1', targetType: 'workstation', targetId: 'station:s1' },
        ],
        operator: 'op',
      },
      { userId: 'u1', primaryOrgId: 'ORG-1' },
    );
    const planRow = insertRows.find((e) => e.table === ewohSchedulePlan);
    expect(planRow?.row.orgId).toBe('ORG-1');
    // ADR-075：audit 行归属同源注入（001 ewoh_org_visible RLS 对齐）。
    const auditRow = insertRows.find((e) => e.table === ewohScheduleAudit);
    expect(auditRow?.row.orgId).toBe('ORG-1');
  });

  it('allocateResources 无 actor → orgId null（与 persistPlan 语义一致）', async () => {
    const { db, insertRows } = createPlanWriteDb();
    const service = new GamificationService(db as never);
    await service.allocateResources({
      allocations: [
        { entityId: 'EXO-1', targetType: 'workstation', targetId: 'station:s1' },
      ],
    });
    const planRow = insertRows.find((e) => e.table === ewohSchedulePlan);
    expect(planRow?.row.orgId).toBeNull();
  });

  it('orchestrateTask 写方案行 orgId=primaryOrgId（ctx 归属）', async () => {
    const { db, insertRows } = createPlanWriteDb();
    const service = new GamificationService(db as never);
    await service.orchestrateTask(
      {
        orderId: 'WO-1',
        nodes: [
          {
            nodeId: 'n1',
            name: '装配',
            order: 1,
            assignedWorkstationId: 'station:s1',
            assignedPersonId: 'person:p1',
            estimatedTakt: 60,
            dependencies: [],
          },
        ],
      },
      { userId: 'u1', primaryOrgId: 'ORG-1' },
    );
    const planRow = insertRows.find((e) => e.table === ewohSchedulePlan);
    expect(planRow?.row.orgId).toBe('ORG-1');
    const auditRow = insertRows.find((e) => e.table === ewohScheduleAudit);
    expect(auditRow?.row.orgId).toBe('ORG-1');
  });

  it('dispatchPlan 跨租户 → NotFound（守卫先于业务校验，零状态变更）', async () => {
    const { db, updateWhere } = createDispatchDb(
      [
        {
          id: 'row-1',
          planId: 'P-1',
          status: 'confirmed',
          metricsJson: {},
          orgId: 'ORG-1',
        },
      ],
      [],
    );
    const service = new GamificationService(db as never);
    await expect(
      service.dispatchPlan(
        'P-1',
        { operator: 'supervisor' },
        { userId: 'u2', primaryOrgId: 'ORG-2' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it('dispatchPlan NULL orgId 存量行 + actor → 放行（standalone_025 过渡边界）', async () => {
    const { db } = createDispatchDb(
      [
        {
          id: 'row-1',
          planId: 'P-1',
          status: 'confirmed',
          metricsJson: {},
        },
      ],
      [],
    );
    const service = new GamificationService(db as never);
    const result = await service.dispatchPlan(
      'P-1',
      { operator: 'supervisor' },
      { userId: 'u2', primaryOrgId: 'ORG-2' },
    );
    expect(result.status).toBe('dispatched');
  });
});
