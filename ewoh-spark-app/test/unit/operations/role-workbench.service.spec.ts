import { RoleWorkbenchService } from '../../../server/modules/operations/role-workbench.service';
import {
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohSpatialEntity,
} from '@server/database/schema';

describe('RoleWorkbenchService', () => {
  /**
   * The dashboard now runs real org-scoped PostgreSQL aggregates, so the mock
   * resolves each query from a resolver keyed by { table, isCount, groupBy }.
   * `isCount` is true only for `select({ count })` aggregate queries.
   */
  function createService(
    resolve: (cfg: {
      table: unknown;
      isCount: boolean;
      groupBy: boolean;
      limit: number | null;
    }) => unknown[],
  ) {
    const db = {
      select: jest.fn((selection?: unknown) => {
        const isCount =
          !!selection &&
          typeof selection === 'object' &&
          'count' in (selection as Record<string, unknown>) &&
          Object.keys(selection as Record<string, unknown>).length === 1;
        const cfg: {
          table: unknown;
          isCount: boolean;
          groupBy: boolean;
          limit: number | null;
        } = { table: null, isCount, groupBy: false, limit: null };
        const chain = {
          from: jest.fn((table: unknown) => {
            cfg.table = table;
            return chain;
          }),
          where: jest.fn(() => chain),
          groupBy: jest.fn(() => {
            cfg.groupBy = true;
            return chain;
          }),
          orderBy: jest.fn(() => chain),
          limit: jest.fn((n: number) => {
            cfg.limit = n;
            return chain;
          }),
          offset: jest.fn(() => chain),
          then: (onFulfilled: (v: unknown[]) => void) =>
            onFulfilled(resolve(cfg)),
        };
        return chain;
      }),
    };
    return new RoleWorkbenchService(db as never);
  }

  it('returns operator tasks, SOP pending, and exceptions for the assigned person', async () => {
    const steps = [
      {
        stepId: 'S1',
        scheduleTaskId: 'WO-1',
        name: '装配',
        status: 'in_progress',
        assignedPersonId: 'P-1',
        resultJson: {
          sop: { sopId: 'SOP-1', mandatory: true },
          exception: { code: 'MATERIAL_MISSING' },
        },
      },
      {
        stepId: 'S2',
        scheduleTaskId: 'WO-1',
        name: '质检',
        status: 'pending',
        assignedPersonId: 'P-2',
        resultJson: null,
      },
    ];
    const service = createService((cfg) => {
      if (cfg.table === ewohScheduleTaskStep && !cfg.isCount) {
        // The real SQL filters to the caller + active statuses; the resolver
        // simulates that predicate so the service maps only the caller's rows.
        return steps.filter(
          (s) =>
            s.assignedPersonId === 'P-1' &&
            ['pending', 'in_progress', 'paused'].includes(s.status),
        );
      }
      return [];
    });

    const result = await service.getWorkbench('operator', 'P-1', {
      userId: 'P-1',
      primaryOrgId: 'org-1',
      roles: ['worker'],
    });

    expect(result.role).toBe('operator');
    expect(result.simulating).toBe(false);
    expect(result.canDebug).toBe(false);
    expect(result.authorizedRoles).toEqual(['operator']);
    expect(result.dataFreshness).toEqual(expect.any(String));
    const data = result.data as {
      mySteps: Array<{ stepId: string; sopPending: boolean; exception: boolean }>;
      sopPendingCount: number;
      exceptionCount: number;
    };
    expect(data.mySteps).toHaveLength(1);
    expect(data.mySteps[0].stepId).toBe('S1');
    expect(data.mySteps[0].sopPending).toBe(true);
    expect(data.mySteps[0].exception).toBe(true);
    expect(data.sopPendingCount).toBe(1);
    expect(data.exceptionCount).toBe(1);
  });

  it('aggregates manager risk from SQL counts for delayed orders, quality, and device faults', async () => {
    const service = createService((cfg) => {
      if (cfg.isCount) {
        if (cfg.table === ewohScheduleTask) return [{ count: 1 }]; // orderDeliveryRisk
        if (cfg.table === ewohScheduleTaskStep) return [{ count: 1 }]; // capacityBottleneck
        if (cfg.table === ewohResourceBinding) return [{ count: 0 }]; // materialShortage
        if (cfg.table === ewohSpatialEntity) return [{ count: 1 }]; // oeeAnomalies
        return [{ count: 0 }];
      }
      if (cfg.table === ewohEvent) return [{ total: 1, pass: 0, fail: 1 }]; // qualityLoss
      return [];
    });

    const result = await service.getWorkbench('manager', undefined, {
      userId: 'M-1',
      primaryOrgId: 'org-1',
      roles: ['global_admin'],
    });
    expect(result.role).toBe('manager');
    expect(result.simulating).toBe(false);
    expect(result.canDebug).toBe(true);
    expect(result.authorizedRoles).toEqual([
      'operator',
      'team_lead',
      'quality',
      'equipment',
      'manager',
    ]);
    const data = result.data as {
      orderDeliveryRisk: number;
      capacityBottleneck: number;
      qualityLoss: number;
      oeeAnomalies: number;
      riskTrend: { status: string; source: string };
    };
    expect(data.orderDeliveryRisk).toBe(1);
    expect(data.capacityBottleneck).toBe(1);
    expect(data.qualityLoss).toBe(1);
    expect(data.oeeAnomalies).toBe(1);
    // Placeholder metrics carry an explicit availability marker, not a fake value.
    expect(data.riskTrend).toMatchObject({ status: 'no_data', source: 'none' });
  });

  it('rejects unknown workbench roles', async () => {
    const service = createService(() => []);
    await expect(service.getWorkbench('nobody')).rejects.toThrow(
      'role must be one of',
    );
  });

  // TR-9.1: a forged `role` query param must be rejected server-side.
  it('rejects a forged manager role for an ordinary worker (server-side RBAC)', async () => {
    const service = createService(() => []);
    await expect(
      service.getWorkbench('manager', undefined, {
        userId: 'P-1',
        primaryOrgId: 'org-1',
        roles: ['worker'],
      }),
    ).rejects.toThrow('not authorized');
  });

  it('rejects a forged quality role for a device_ops user', async () => {
    const service = createService(() => []);
    await expect(
      service.getWorkbench('quality', undefined, {
        userId: 'D-1',
        primaryOrgId: 'org-1',
        roles: ['device_ops'],
      }),
    ).rejects.toThrow('not authorized');
  });

  it('rejects querying another operator unless the caller is an admin', async () => {
    const service = createService(() => []);
    await expect(
      service.getWorkbench('operator', 'OTHER-USER', {
        userId: 'P-1',
        primaryOrgId: 'org-1',
        roles: ['worker'],
      }),
    ).rejects.toThrow('only query your own operator workbench');
  });

  it('allows an admin to simulate another role', async () => {
    const service = createService((cfg) => {
      if (cfg.table === ewohSpatialEntity && !cfg.isCount) return [];
      return [];
    });

    const result = await service.getWorkbench('equipment', undefined, {
      userId: 'A-1',
      primaryOrgId: 'org-1',
      roles: ['global_admin'],
    });
    // Admin's own role is manager; viewing equipment is a simulation.
    expect(result.simulating).toBe(true);
    expect(result.canDebug).toBe(true);
    expect(result.role).toBe('equipment');
    const data = result.data as {
      abnormalDevices: number;
      currentDowntime: number;
      maintenanceTasks: { status: string; source: string };
    };
    expect(data.abnormalDevices).toBe(0);
    expect(data.currentDowntime).toBe(0);
    expect(data.maintenanceTasks).toMatchObject({
      status: 'no_data',
      source: 'none',
    });
  });
});