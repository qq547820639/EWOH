/* MaintenanceService 契约行为测试（ADR-010 / NO-05b）。
 *
 * 覆盖：契约校验 fail-closed（坏 subject / 未知 conditionType / 未知 severity）、
 * 缺租户上下文拒绝、severity 归一化（L1→critical）、生命周期顺序强制
 * （resolved 前必须 work_order_created）、逾期判定（dueAt < now 且未 resolved）、
 * 事件落库（detected/resolved 写 ewoh_event，信封 ADR-009）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_034 verify + CI 承担）。
 */
/// <reference types="jest" />
import { MaintenanceService } from '../maintenance.service';

type Row = Record<string, unknown>;

function makeFakeDb(rows: Row[] = []) {
  const state = { rows: [...rows] };
  const selectResult = () => {
    const thenable = Promise.resolve(state.rows) as Promise<Row[]> & {
      limit: jest.Mock;
    };
    thenable.limit = jest.fn(() => Promise.resolve(state.rows));
    return thenable;
  };
  const fake = {
    select: jest.fn(() => fake),
    from: jest.fn(() => fake),
    where: jest.fn(() => selectResult()),
    insert: jest.fn(() => ({
      values: jest.fn((v: Row) => ({
        returning: jest.fn(() => {
          const row = { ...v };
          state.rows.push(row);
          return Promise.resolve([row]);
        }),
        onConflictDoUpdate: jest.fn(() => Promise.resolve([])),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
    __state: state,
  };
  return fake;
}

const BASE_ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: 'org-1',
  conditionId: 'mc:1',
  subjectEntityId: 'device:00000000-0000-4000-8000-00000000000a',
  subjectKind: 'device',
  conditionType: 'wear',
  severity: 'critical',
  status: 'detected',
  dueAt: null,
  detectedAt: new Date('2026-08-14T08:00:00Z'),
  resolvedAt: null,
  workOrderRef: null,
  evidenceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
};

const INPUT = {
  conditionId: 'mc:1',
  subjectEntityId: 'device:00000000-0000-4000-8000-00000000000a',
  conditionType: 'wear',
  severity: 'high',
};

function makeWorkOrderService() {
  return {
    createWorkOrder: jest.fn().mockResolvedValue({ record: {}, created: true }),
  };
}

describe('MaintenanceService', () => {
  it('契约校验 fail-closed：非规范身份拒绝', async () => {
    const service = new MaintenanceService(makeFakeDb() as never, makeWorkOrderService() as never);
    await expect(
      service.createCondition({ ...INPUT, subjectEntityId: 'not-canonical' }, 'org-1'),
    ).rejects.toThrow(/违反契约/);
  });

  it('契约校验 fail-closed：未知 conditionType 拒绝', async () => {
    const service = new MaintenanceService(makeFakeDb() as never, makeWorkOrderService() as never);
    await expect(
      service.createCondition({ ...INPUT, conditionType: 'unknown_type' }, 'org-1'),
    ).rejects.toThrow(/违反契约/);
  });

  it('缺租户上下文拒绝（fail-closed）', async () => {
    const service = new MaintenanceService(makeFakeDb() as never, makeWorkOrderService() as never);
    await expect(service.createCondition(INPUT, '')).rejects.toThrow(/orgId 缺失/);
  });

  it('创建：插入条件行 + MaintenanceConditionDetected 事件；severity 归一化（L1→critical）', async () => {
    const fake = makeFakeDb();
    const service = new MaintenanceService(fake as never, makeWorkOrderService() as never);
    const row = await service.createCondition({ ...INPUT, severity: 'L1' }, 'org-1');
    expect(row.severity).toBe('critical');
    expect(fake.insert).toHaveBeenCalledTimes(2);
  });

  it('非法转移拒绝：detected → resolved 直接跳（契约 lifecycle 顺序强制）', async () => {
    const service = new MaintenanceService(makeFakeDb([{ ...BASE_ROW }]) as never, makeWorkOrderService() as never);
    await expect(
      service.transitionCondition('mc:1', { to: 'resolved' }, 'org-1'),
    ).rejects.toThrow(/非法状态转移/);
  });

  it('合法转移：acknowledged → work_order_created（带工单引用，委托 WorkOrderService 建单）', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW, status: 'acknowledged' }]);
    const workOrderService = makeWorkOrderService();
    const service = new MaintenanceService(fake as never, workOrderService as never);
    const result = await service.transitionCondition(
      'mc:1',
      { to: 'work_order_created', workOrderRef: 'wo:123' },
      'org-1',
    );
    expect(result).toEqual({ conditionId: 'mc:1', from: 'acknowledged', to: 'work_order_created' });
    expect(fake.update).toHaveBeenCalled();
    // NO-05e-b（ADR-012）：工单唯一权威写路径（内部 ID 确定性推导，外部号作 alias）
    expect(workOrderService.createWorkOrder).toHaveBeenCalledTimes(1);
    const [inputArg, orgArg] = (workOrderService.createWorkOrder as jest.Mock).mock.calls[0];
    expect(orgArg).toBe('org-1');
    expect(inputArg).toMatchObject({
      workOrderId: expect.stringMatching(/^wo:[0-9a-f]{12}$/),
      workOrderType: 'maintenance',
      origin: { kind: 'maintenance_condition', id: 'mc:1' },
      subjectEntityId: BASE_ROW.subjectEntityId,
      severity: 'critical',
      externalRef: 'wo:123',
    });
    // 事件已移入 WorkOrderService：本服务不再直接写 ewoh_event
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it('合法转移：acknowledged → work_order_created（无工单引用不建单）', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW, status: 'acknowledged' }]);
    const workOrderService = makeWorkOrderService();
    const service = new MaintenanceService(fake as never, workOrderService as never);
    await service.transitionCondition('mc:1', { to: 'work_order_created' }, 'org-1');
    expect(fake.update).toHaveBeenCalled();
    expect(workOrderService.createWorkOrder).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
  });

  it('resolved 转移写 MaintenanceConditionResolved 事件', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW, status: 'work_order_created', workOrderRef: 'wo:123' }]);
    const service = new MaintenanceService(fake as never, makeWorkOrderService() as never);
    await service.transitionCondition('mc:1', { to: 'resolved' }, 'org-1');
    expect(fake.update).toHaveBeenCalled();
    expect(fake.insert).toHaveBeenCalledTimes(1);
  });

  it('逾期判定：dueAt 已过且未 resolved → overdue=true；resolved → false', async () => {
    const overdueRow = { ...BASE_ROW, dueAt: new Date('2026-08-01T00:00:00Z') };
    const service = new MaintenanceService(makeFakeDb([overdueRow]) as never, makeWorkOrderService() as never);
    const list = await service.listConditions('org-1');
    expect(list[0].overdue).toBe(true);

    const resolved = new MaintenanceService(
      makeFakeDb([
        {
          ...BASE_ROW,
          dueAt: new Date('2026-08-01T00:00:00Z'),
          status: 'resolved',
          resolvedAt: new Date('2026-08-10T00:00:00Z'),
        },
      ]) as never,
      makeWorkOrderService() as never,
    );
    const list2 = await resolved.listConditions('org-1');
    expect(list2[0].overdue).toBe(false);
  });
});
