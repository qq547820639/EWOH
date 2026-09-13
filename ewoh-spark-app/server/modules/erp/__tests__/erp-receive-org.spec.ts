/// <reference types="jest" />
/* UR1-mes-erp-orders 对抗审查回归：
 *
 * 1) receiveOrder 落 ewoh_schedule_task / ewoh_schedule_task_step 必须显式携带
 *    orgId（NEST-302 口径）。缺失时：租户上下文（RLS WITH CHECK
 *    ewoh_org_visible(NULL)=false）直接拒写 → ERP 接单 500；global_admin 上下文
 *    （is_global_admin=true）写入 org_id=NULL 行 → 本租户 RLS/app 谓词双重不可见，
 *    订单"接收成功"但工单永远查不到。
 * 2) receiveOrder / receiveOutbound 的 findByEvidence 去重是 check-then-act
 *    （evidence jsonb 上无唯一索引兜底）：并发双提交同单号会双双判"不存在"→
 *    双写 ERP_ORDER（物料需求投影双计）/ ERP_OUTBOUND（库存投影双计，伪造库存）。
 *    修复后必须先取 (org, 单号) 事务级 advisory lock 再查重（HTTP 请求整体运行在
 *    单事务中，锁持有到请求提交，后到者串行化后读到已提交行 → duplicate 返回）。
 */
import { ErpService } from '../erp.service';
import { MesService } from '../../mes/mes.service';

type Row = Record<string, unknown>;

/** 递归收集 drizzle 条件/SQL 模板里的绑定参数（Param.value / 装箱 String）。 */
function collectParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    // 原始 sql`...` 模板的绑定参数以装箱 String 传入（postgres-js 驱动约定）。
    out.push(node);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node instanceof String) {
    out.push(node.toString());
    return out;
  }
  const withChunks = node as { queryChunks?: unknown[] };
  if (Array.isArray(withChunks.queryChunks)) {
    for (const chunk of withChunks.queryChunks) {
      collectParams(chunk, out);
    }
    return out;
  }
  if ('value' in (node as Record<string, unknown>)) {
    out.push((node as { value: unknown }).value);
  }
  return out;
}

function makeDb() {
  const calls: string[] = [];
  const insertedEventRows: Row[] = [];
  const db = {
    /** advisory lock 走 db.execute —— 记录调用序。 */
    execute: jest.fn(async (query: unknown) => {
      calls.push(`execute:${collectParams(query).join('|')}`);
      return [];
    }),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          calls.push(`select:${collectParams(cond).join('|')}`);
          return {
            limit: () => Promise.resolve([] as Row[]),
            then: (res: (r: Row[]) => void) => Promise.resolve([] as Row[]).then(res),
          };
        }),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((v: Row) => ({
        returning: jest.fn(async () => {
          insertedEventRows.push(v);
          return [{ ...v, eventId: 'ERP-O-1' }];
        }),
      })),
    })),
  };
  return { db, calls, insertedEventRows };
}

const ACTOR = {
  userId: 'u-erp',
  primaryOrgId: 'org-a',
  accessibleOrgIds: ['org-a'],
  roles: ['workshop_lead'],
  isGlobalAdmin: false,
};

const ORDER_BODY = {
  externalOrderId: 'EXT-1',
  productCode: 'P-100',
  quantity: 10,
};

function makeService(db: ReturnType<typeof makeDb>['db']) {
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const mes = {
    writeScheduleOrder: jest.fn().mockResolvedValue({ scheduleTaskId: 'WO-ERP-X' }),
  } as unknown as MesService & { writeScheduleOrder: jest.Mock };
  const service = new ErpService(db as never, audit as never, mes as never);
  return { service, mes };
}

describe('ERP receiveOrder：调度表写入必须显式带租户 orgId（NEST-302 口径）', () => {
  it('task 与 step 都携带 actor 的 primaryOrgId', async () => {
    const { db, calls } = makeDb();
    const { service, mes } = makeService(db);
    await service.receiveOrder(ORDER_BODY, ACTOR as never);

    expect(mes.writeScheduleOrder).toHaveBeenCalledTimes(1);
    const [task, steps] = mes.writeScheduleOrder.mock.calls[0] as [Row, Row[]];
    expect(task.orgId).toBe('org-a');
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.orgId).toBe('org-a');
    }
    // 事件行归属本租户（既有行为，回归钉死）。
    expect(insertedEventOrgId(db)).toBe('org-a');
    expect(calls.length).toBeGreaterThanOrEqual(0);
  });
});

describe('ERP 接单/出站去重：先取 (org, 单号) 事务级 advisory lock 再查重', () => {
  it('receiveOrder：advisory lock 先于 findByEvidence，参数含 org + externalOrderId', async () => {
    const { db, calls } = makeDb();
    const { service } = makeService(db);
    await service.receiveOrder(ORDER_BODY, ACTOR as never);

    const lockCall = calls.find((c) => c.startsWith('execute:'));
    const selectCall = calls.find((c) => c.startsWith('select:'));
    expect(lockCall).toBeDefined();
    expect(selectCall).toBeDefined();
    expect(calls.indexOf(lockCall!)).toBeLessThan(calls.indexOf(selectCall!));
    expect(lockCall).toContain('org-a');
    expect(lockCall).toContain('EXT-1');
  });

  it('receiveOutbound：advisory lock 先于 findByEvidence，参数含 org + outboundId', async () => {
    const { db, calls } = makeDb();
    const { service } = makeService(db);
    await service.receiveOutbound(
      {
        outboundId: 'OUT-1',
        type: 'inventory_receipt',
        externalOrderId: 'EXT-1',
        payload: { materialId: 'M-1', quantity: 5 },
      },
      ACTOR as never,
    );

    const lockCall = calls.find((c) => c.startsWith('execute:'));
    const selectCall = calls.find((c) => c.startsWith('select:'));
    expect(lockCall).toBeDefined();
    expect(selectCall).toBeDefined();
    expect(calls.indexOf(lockCall!)).toBeLessThan(calls.indexOf(selectCall!));
    expect(lockCall).toContain('org-a');
    expect(lockCall).toContain('OUT-1');
  });
});

/** 从 fake db 里取出事件插入行的 orgId。 */
function insertedEventOrgId(db: ReturnType<typeof makeDb>['db']): unknown {
  const insertMock = db.insert as jest.Mock;
  const valuesFn = (insertMock.mock.results[0].value as { values: jest.Mock }).values;
  return (valuesFn.mock.calls[0][0] as Row).orgId;
}
