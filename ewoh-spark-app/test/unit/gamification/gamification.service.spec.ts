import { GamificationService } from '../../../server/modules/gamification/gamification.service';
import {
  ewohDevice,
  ewohEvent,
  ewohSchedulePlan,
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
