/// <reference types="jest" />
/* UR1-mes-erp-orders 对抗审查回归：
 *
 * 1) doQualityInspection 的 resultJson 读-改-写必须带状态 CAS（eq(status, 读取时
 *    状态)）。原先 UPDATE 仅按 stepId(+org) 命中：质检请求与工序 report/pause 等
 *    转移并发时，质检会在锁等待后把整份 resultJson（含并发方刚写入的 report 记录）
 *    用自己读到的旧快照覆写——工单状态已 reported 但报工记录被静默抹掉。
 *    修复后：并发转移先行提交 → CAS 未命中 → 409 STATE_CONFLICT（与
 *    doTransitionStep 同语义）；状态未变的复检不受影响。
 *
 * 2) forceResolveStep 的缺省幂等 key 不得是"冲突无关"的
 *    force-resolve:{orderId}:{stepId}:{resolution}——同一工序稍后的另一次冲突会
 *    lookup 命中旧记录，把过期的 serverValue 当"当前服务端状态"返回（伪造确定事实）。
 *    修复后缺省 key 绑定"本次冲突的本地操作"（action + payload 指纹）：
 *    同一冲突重放命中记录（幂等），不同冲突拿到新鲜裁决。
 */
import { ConflictException } from '@nestjs/common';
import { MesService } from '../mes.service';
import { IdempotencyService } from '../../shared/idempotency.service';
import {
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohResourceBinding,
} from '@server/database/schema';

type Row = Record<string, unknown>;

/** 递归收集 drizzle 条件里的绑定参数（仅原始值，供 CAS 命中判定）。 */
function collectParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const withChunks = node as { queryChunks?: unknown[] };
  if (Array.isArray(withChunks.queryChunks)) {
    for (const chunk of withChunks.queryChunks) {
      collectParams(chunk, out);
    }
    return out;
  }
  if ('value' in (node as Record<string, unknown>)) {
    const value = (node as { value: unknown }).value;
    if (typeof value === 'string' || typeof value === 'number') out.push(value);
  }
  return out;
}

/**
 * 行命中判定：条件里的每个原始参数都必须出现在行字段值里（模拟真实 SQL 等值
 * 谓词）。stepId/orgId/status 任一等值条件对不上 → 该行不可见（CAS 未命中）。
 */
function matchRow(cond: unknown, row: Row): boolean {
  const params = collectParams(cond);
  if (params.length === 0) return true;
  const values = Object.values(row);
  return params.every((p) => values.includes(p as never));
}

interface FakeDbHandlers {
  /** select 返回的行（按表）。 */
  rowsByTable: Map<symbol, Row[]>;
  /** update 命中的"当前行"（模拟 DB 里的最新版本，可能与读快照不同）。 */
  liveStepRow: Row;
  onUpdateApplied?: (patch: Row) => void;
  insertedEvents: Row[];
}

function makeDb(handlers: FakeDbHandlers) {
  const selectFrom = (table: unknown) => ({
    where: (cond: unknown) => {
      const rows = (handlers.rowsByTable.get(tableKey(table)) ?? []).filter((row) =>
        matchRow(cond, row),
      );
      const result = Promise.resolve(rows);
      return Object.assign(result, {
        orderBy: () => result,
      });
    },
  });
  const updateImpl = () => ({
    set: (patch: Row) => ({
      where: (cond: unknown) => {
        const hit = matchRow(cond, handlers.liveStepRow);
        const result = Promise.resolve(hit ? [{ ...handlers.liveStepRow, ...patch }] : []);
        return Object.assign(result, {
          returning: () => {
            if (hit) handlers.onUpdateApplied?.(patch);
            return result;
          },
        });
      },
    }),
  });
  const insertImpl = () => ({
    values: (v: Row) => {
      handlers.insertedEvents.push(v);
      return Promise.resolve();
    },
  });
  const txDb = {
    update: jest.fn(updateImpl),
    insert: jest.fn(insertImpl),
  };
  const db = {
    select: jest.fn(() => ({ from: selectFrom })),
    update: jest.fn(updateImpl),
    insert: jest.fn(insertImpl),
    transaction: jest.fn(async (fn: (tx: typeof txDb) => Promise<unknown>) => fn(txDb)),
  };
  return { db, txDb };
}

const TABLE_KEYS = new Map<unknown, symbol>([
  [ewohScheduleTask, Symbol('task')],
  [ewohScheduleTaskStep, Symbol('step')],
  [ewohResourceBinding, Symbol('binding')],
]);

function tableKey(table: unknown): symbol {
  return TABLE_KEYS.get(table)!;
}

const ACTOR = {
  userId: 'u-lead',
  primaryOrgId: 'org-a',
  accessibleOrgIds: ['org-a'],
  roles: ['workshop_lead'],
  isGlobalAdmin: false,
};

function makeService(db: unknown) {
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  // 真实 IdempotencyService（默认内存 store），保证 lookup/store/指纹行为与线上一致。
  const service = new MesService(
    db as never,
    audit as never,
    new IdempotencyService(),
  );
  return { service, audit };
}

function workOrderRow(): Row {
  return {
    id: 't-1',
    scheduleTaskId: 'WO-1',
    orgId: 'org-a',
    title: '工单1',
    status: 'in_progress',
    source: 'mes',
  };
}

function stepRow(overrides: Row = {}): Row {
  return {
    id: 's-1',
    stepId: 'WO-1-S1',
    scheduleTaskId: 'WO-1',
    orgId: 'org-a',
    name: '工序1',
    status: 'in_progress',
    resultJson: null,
    assignedPersonId: null,
    assignedDeviceId: null,
    ...overrides,
  };
}

function seedDb(db: unknown, handlers: FakeDbHandlers): void {
  const fake = db as { __handlers?: FakeDbHandlers };
  void fake;
}

describe('质检 resultJson 写入的状态 CAS（并发 report 不被静默覆写）', () => {
  it('工序已被并发 report（in_progress→reported）：质检 CAS 未命中 → 409，不覆写', async () => {
    const snapshot = stepRow({ status: 'in_progress' });
    const live = stepRow({ status: 'reported', resultJson: { report: { quantity: 8 } } });
    const handlers: FakeDbHandlers = {
      rowsByTable: new Map<symbol, Row[]>([
        [tableKey(ewohScheduleTask), [workOrderRow()]],
        [tableKey(ewohScheduleTaskStep), [snapshot]],
        [tableKey(ewohResourceBinding), []],
      ]),
      liveStepRow: live,
      insertedEvents: [],
    };
    const { db } = makeDb(handlers);
    seedDb(db, handlers);
    const { service } = makeService(db);

    await expect(
      service.qualityInspection(
        'WO-1',
        { stepId: 'WO-1-S1', result: 'pass' },
        ACTOR as never,
      ),
    ).rejects.toThrow(ConflictException);
    // 事件也不落库（同事务回滚）。
    expect(handlers.insertedEvents).toHaveLength(0);
  });

  it('状态未变的复检（in_progress 仍 in_progress）：正常写入质检结果与事件', async () => {
    const snapshot = stepRow({ status: 'in_progress' });
    const handlers: FakeDbHandlers = {
      rowsByTable: new Map<symbol, Row[]>([
        [tableKey(ewohScheduleTask), [workOrderRow()]],
        [tableKey(ewohScheduleTaskStep), [snapshot]],
        [tableKey(ewohResourceBinding), []],
      ]),
      liveStepRow: stepRow({ status: 'in_progress' }),
      insertedEvents: [],
    };
    const { db } = makeDb(handlers);
    seedDb(db, handlers);
    const { service } = makeService(db);

    const result = await service.qualityInspection(
      'WO-1',
      { stepId: 'WO-1-S1', result: 'pass' },
      ACTOR as never,
    );
    expect(result.result).toBe('pass');
    expect(handlers.insertedEvents).toHaveLength(1);
    expect(handlers.insertedEvents[0].eventType).toBe('quality');
  });
});

describe('forceResolveStep 缺省幂等 key 绑定本次冲突的本地操作', () => {
  it('同一工序先后两次不同冲突：第二次不得返回第一次的过期 serverValue', async () => {
    const stepA = stepRow({ status: 'in_progress' });
    const handlers: FakeDbHandlers = {
      rowsByTable: new Map<symbol, Row[]>([
        [tableKey(ewohScheduleTask), [workOrderRow()]],
        [tableKey(ewohScheduleTaskStep), [stepA]],
        [tableKey(ewohResourceBinding), []],
      ]),
      liveStepRow: stepA,
      insertedEvents: [],
    };
    const { db } = makeDb(handlers);
    seedDb(db, handlers);
    const { service } = makeService(db);

    const first = await service.forceResolveStep(
      'WO-1',
      'WO-1-S1',
      { resolution: 'server', payload: { localStatus: 'in_progress', localQty: 1 } },
      ACTOR as never,
    );
    expect(first.applied).toBe(false);

    // 工序随后被他人推进（服务端状态变化），又出现一次新的冲突。
    const stepB = stepRow({ status: 'reported', resultJson: { report: { quantity: 8 } } });
    handlers.rowsByTable.set(tableKey(ewohScheduleTaskStep), [stepB]);

    const second = await service.forceResolveStep(
      'WO-1',
      'WO-1-S1',
      { resolution: 'server', payload: { localStatus: 'in_progress', localQty: 99 } },
      ACTOR as never,
    );
    expect((second.serverValue as Row).status).toBe('reported');
  });

  it('同一冲突的重放（同 payload）：仍返回已记录结果（幂等保留）', async () => {
    const stepA = stepRow({ status: 'in_progress' });
    const handlers: FakeDbHandlers = {
      rowsByTable: new Map<symbol, Row[]>([
        [tableKey(ewohScheduleTask), [workOrderRow()]],
        [tableKey(ewohScheduleTaskStep), [stepA]],
        [tableKey(ewohResourceBinding), []],
      ]),
      liveStepRow: stepA,
      insertedEvents: [],
    };
    const { db } = makeDb(handlers);
    seedDb(db, handlers);
    const { service } = makeService(db);

    const body = { resolution: 'server' as const, payload: { localStatus: 'in_progress' } };
    const first = await service.forceResolveStep('WO-1', 'WO-1-S1', body, ACTOR as never);
    const second = await service.forceResolveStep('WO-1', 'WO-1-S1', body, ACTOR as never);
    expect(second).toEqual(first);
  });
});
