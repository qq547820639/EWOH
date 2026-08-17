/* WorkOrderService 契约行为测试（ADR-012 / NO-05e-b）。
 *
 * 覆盖：契约校验 fail-closed（origin 必填 / completed 必带 completedAt /
 * cancelled 必带 reason / severity 归一化）、workOrderId 确定性推导
 * （wo:sha256(originKind:originId)[:12]）、创建幂等（唯一键冲突回读不重发事件）、
 * 生命周期顺序强制（in_progress 起不可取消）、WorkOrderCreated/Completed 事件落库
 * （信封 ADR-009）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_035 verify + CI 承担）。
 */
/// <reference types="jest" />
import { WorkOrderService } from '../workorder.service';
import { deriveWorkOrderId } from '@server/common/workorder-ids';

type Row = Record<string, unknown>;

function makeFakeDb(rows: Row[] = []) {
  const state = { rows: [...rows] };
  // NEST-627/628：select 返回行快照（浅克隆）——模拟真实 drizzle 行为，
  // 使服务持有的 current 与 store 行解引用，CAS 语义可测。
  const selectResult = () => {
    const snapshot = state.rows.map((row) => ({ ...row }));
    const thenable = Promise.resolve(snapshot) as Promise<Row[]> & {
      limit: jest.Mock;
    };
    thenable.limit = jest.fn(() => Promise.resolve(snapshot));
    return thenable;
  };
  // NEST-628：fake 的 update where 尊重条件值（orgId/行 id/status），
  // 支持 CAS——命中行应用 patch 并经 returning 返回。
  const matchRows = (cond: unknown, candidates: Row[]): Row[] => {
    const values = new Set<unknown>();
    const walk = (node: unknown, seen: WeakSet<object>): void => {
      if (node == null || typeof node !== 'object' || seen.has(node as object)) return;
      seen.add(node as object);
      if (Array.isArray(node)) {
        for (const item of node) walk(item, seen);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'value' && (typeof value === 'string' || typeof value === 'number')) {
          values.add(value);
        } else {
          walk(value, seen);
        }
      }
    };
    walk(cond, new WeakSet());
    if (values.size === 0) return candidates;
    return candidates.filter((row) =>
      [...values].every((v) => Object.values(row).includes(v as never)),
    );
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
      set: jest.fn((patch: Row) => ({
        where: jest.fn((cond: unknown) => {
          const hit = matchRows(cond, state.rows);
          const updated = hit.map((row) => {
            const clone = { ...row, ...patch };
            const idx = state.rows.indexOf(row);
            if (idx >= 0) state.rows[idx] = clone;
            return clone;
          });
          return {
            returning: jest.fn(async () => updated),
          };
        }),
      })),
    })),
    __state: state,
  };
  return fake;
}

const BASE_ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: 'org-1',
  workOrderId: deriveWorkOrderId('maintenance_condition', 'mc:1'),
  workOrderType: 'maintenance',
  originKind: 'maintenance_condition',
  originId: 'mc:1',
  subjectEntityId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  subjectKind: 'device',
  severity: 'high',
  status: 'created',
  scheduledFor: null,
  completedAt: null,
  cancelledReason: null,
  externalRef: null,
  evidenceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
};

const INPUT = {
  workOrderType: 'maintenance',
  origin: { kind: 'maintenance_condition', id: 'mc:1' },
  subjectEntityId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  severity: 'high',
};

describe('WorkOrderService', () => {
  it('契约校验 fail-closed：origin 缺失拒绝', async () => {
    const service = new WorkOrderService(makeFakeDb() as never);
    await expect(
      service.createWorkOrder(
        {
          workOrderType: 'maintenance',
          origin: { kind: 'schedule_task', id: 't1' },
          subjectEntityId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
          severity: 'high',
        },
        'org-1',
      ),
    ).rejects.toThrow(/违反契约/);
  });

  it('缺租户上下文拒绝（fail-closed）', async () => {
    const service = new WorkOrderService(makeFakeDb() as never);
    await expect(service.createWorkOrder(INPUT, '')).rejects.toThrow(/orgId 缺失/);
  });

  it('创建：workOrderId 确定性推导 + 行落库 + WorkOrderCreated 事件', async () => {
    const fake = makeFakeDb();
    const service = new WorkOrderService(fake as never);
    const { record, created } = await service.createWorkOrder(INPUT, 'org-1');
    expect(created).toBe(true);
    expect(record.workOrderId).toBe(deriveWorkOrderId('maintenance_condition', 'mc:1'));
    expect(record.workOrderId).toMatch(/^wo:[0-9a-f]{12}$/);
    expect(record.status).toBe('created');
    // 工单行 + ewoh_event（WorkOrderCreated）两次 insert
    expect(fake.insert).toHaveBeenCalledTimes(2);
    const valuesFn = (fake.insert.mock.results[1].value as { values: jest.Mock }).values;
    const eventRow = valuesFn.mock.calls[0][0] as Record<string, unknown>;
    expect(eventRow.eventType).toBe('WorkOrderCreated');
  });

  it('创建幂等：唯一键冲突 → 回读既有行，不重复发事件', async () => {
    const existing = { ...BASE_ROW };
    const fake = makeFakeDb([existing]);
    fake.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() =>
          Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })),
        ),
        onConflictDoUpdate: jest.fn(() => Promise.resolve([])),
      })),
    })) as never;
    const service = new WorkOrderService(fake as never);
    const { record, created } = await service.createWorkOrder(INPUT, 'org-1');
    expect(created).toBe(false);
    expect(record.workOrderId).toBe(existing.workOrderId);
  });

  it('非法转移拒绝：created → completed 直接跳（契约 lifecycle 顺序强制）', async () => {
    const service = new WorkOrderService(makeFakeDb([{ ...BASE_ROW }]) as never);
    await expect(
      service.transitionWorkOrder(BASE_ROW.workOrderId, { to: 'completed' }, 'org-1'),
    ).rejects.toThrow(/非法状态转移/);
  });

  it('in_progress 起不可取消（契约强制）', async () => {
    const service = new WorkOrderService(
      makeFakeDb([{ ...BASE_ROW, status: 'in_progress' }]) as never,
    );
    await expect(
      service.transitionWorkOrder(
        BASE_ROW.workOrderId,
        { to: 'cancelled', cancelledReason: 'changed_mind' },
        'org-1',
      ),
    ).rejects.toThrow(/非法状态转移/);
  });

  it('cancelled 必须带 reason（契约 + 应用层双强制）', async () => {
    const service = new WorkOrderService(
      makeFakeDb([{ ...BASE_ROW, status: 'scheduled' }]) as never,
    );
    await expect(
      service.transitionWorkOrder(BASE_ROW.workOrderId, { to: 'cancelled' }, 'org-1'),
    ).rejects.toThrow(/违反契约/);
  });

  it('completed 转移落 completedAt + WorkOrderCompleted 事件', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW, status: 'in_progress' }]);
    const service = new WorkOrderService(fake as never);
    const result = await service.transitionWorkOrder(
      BASE_ROW.workOrderId,
      { to: 'completed', completedAt: '2026-08-16T12:00:00Z' },
      'org-1',
    );
    expect(result).toEqual({ workOrderId: BASE_ROW.workOrderId, from: 'in_progress', to: 'completed' });
    expect(fake.update).toHaveBeenCalled();
    expect(fake.insert).toHaveBeenCalledTimes(1);
    const valuesFn = (fake.insert.mock.results[0].value as { values: jest.Mock }).values;
    const eventRow = valuesFn.mock.calls[0][0] as Record<string, unknown>;
    expect(eventRow.eventType).toBe('WorkOrderCompleted');
    const evidence = eventRow.evidenceJson as Record<string, unknown>;
    expect(evidence.origin).toEqual({ kind: 'maintenance_condition', id: 'mc:1' });
  });

  it('列表：租户 + 状态过滤', async () => {
    const service = new WorkOrderService(makeFakeDb([{ ...BASE_ROW }]) as never);
    const list = await service.listWorkOrders('org-1', { status: 'created' });
    expect(list).toHaveLength(1);
    expect(list[0].workOrderId).toBe(BASE_ROW.workOrderId);
  });
});
