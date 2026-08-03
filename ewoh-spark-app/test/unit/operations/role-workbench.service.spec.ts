import { RoleWorkbenchService } from '../../../server/modules/operations/role-workbench.service';
import {
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohSpatialEntity,
  ewohWorldState,
} from '@server/database/schema';

describe('RoleWorkbenchService', () => {
  function createService(rows: Map<unknown, unknown[]>) {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => {
          const chain = {
            orderBy: jest.fn(() => chain),
            limit: jest.fn(() => chain),
            then: (resolve: (value: unknown[]) => void) =>
              resolve(rows.get(table) ?? []),
          };
          return chain;
        }),
      })),
    };
    return new RoleWorkbenchService(db as never);
  }

  it('returns operator tasks, SOP pending, and exceptions for the assigned person', async () => {
    const rows = new Map<unknown, unknown[]>();
    rows.set(ewohScheduleTask, []);
    rows.set(ewohScheduleTaskStep, [
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
    ]);
    rows.set(ewohEvent, []);
    rows.set(ewohSpatialEntity, []);
    rows.set(ewohWorldState, []);
    rows.set(ewohResourceBinding, []);
    const service = createService(rows);

    const result = await service.getWorkbench('operator', 'P-1', {
      userId: 'P-1',
      primaryOrgId: 'org-1',
    });

    expect(result.role).toBe('operator');
    const data = result.data as {
      mySteps: Array<{ stepId: string; sopPending: boolean; exception: boolean }>;
      sopPendingCount: number;
      exceptionCount: number;
    };
    expect(data.mySteps).toHaveLength(1);
    expect(data.mySteps[0].sopPending).toBe(true);
    expect(data.mySteps[0].exception).toBe(true);
    expect(data.sopPendingCount).toBe(1);
    expect(data.exceptionCount).toBe(1);
  });

  it('aggregates manager risk from delayed orders, quality, and device faults', async () => {
    const now = new Date();
    const rows = new Map<unknown, unknown[]>();
    rows.set(ewohScheduleTask, [
      {
        scheduleTaskId: 'WO-1',
        title: '延迟工单',
        status: 'released',
        planEnd: new Date(now.getTime() - 60 * 60 * 1000),
      },
    ]);
    rows.set(ewohScheduleTaskStep, [
      { stepId: 'S1', status: 'in_progress' },
    ]);
    rows.set(ewohEvent, [
      {
        eventType: 'quality',
        status: 'open',
        evidenceJson: { result: 'fail', defectCode: 'SCRATCH' },
      },
    ]);
    rows.set(ewohSpatialEntity, [
      { entityId: 'EXO-1', entityType: 'device', name: '外骨骼' },
    ]);
    rows.set(ewohWorldState, [
      {
        entityId: 'EXO-1',
        ts: now,
        stateJson: { entity_type: 'device', status: 'fault' },
      },
    ]);
    rows.set(ewohResourceBinding, []);
    const service = createService(rows);

    const result = await service.getWorkbench('manager');
    const data = result.data as {
      orderDeliveryRisk: number;
      capacityBottleneck: number;
      qualityLoss: number;
      oeeAnomalies: number;
    };
    expect(data.orderDeliveryRisk).toBe(1);
    expect(data.capacityBottleneck).toBe(1);
    expect(data.qualityLoss).toBe(1);
    expect(data.oeeAnomalies).toBe(1);
  });

  it('rejects unknown workbench roles', async () => {
    const service = createService(new Map());
    await expect(service.getWorkbench('nobody')).rejects.toThrow(
      'role must be one of',
    );
  });
});
