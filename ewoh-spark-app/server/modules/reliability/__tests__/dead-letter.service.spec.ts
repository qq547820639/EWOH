/* DeadLetterService 契约行为测试（ADR-024 / NO-11a，§20 Reliability）。
 *
 * 覆盖：record 契约 fail-closed（未知 reason/缺 envelope）/org 缺失、
 * letterId 确定性幂等（唯一键冲突回读不重发事件）、DeadLetterRecorded
 * 事件、人审 requeue（无 handler 拒绝/执行 handler + attempts+1/非 pending
 * 拒绝）、discard 理由强制/终态。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_043 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { DeadLetterService } from '../dead-letter.service';
import { ewohDeadLetter, ewohEvent } from '@server/database/schema';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const VALID_INPUT = {
  sourceId: 'cloud:ingest',
  reason: 'unknown_event_type',
  envelope: { eventId: 'EVT-1', eventType: 'TeleportEvent', source: 'edge:world-projection' },
  correlationId: null,
};

function collectValues(
  node: unknown,
  sets: { letterIds: Set<string>; orgIds: Set<string> },
  seen: WeakSet<object>,
): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, sets, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      if (value.startsWith('dl:')) sets.letterIds.add(value);
      if (value.startsWith('org-')) sets.orgIds.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { letterIds: new Set<string>(), orgIds: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.letterIds.size > 0 && !sets.letterIds.has(String(row.letterId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  return true;
}

function rowOf(letterId: string, orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId,
    letterId,
    sourceId: 'cloud:ingest',
    reason: 'unknown_event_type',
    attempts: 1,
    status: 'pending',
    envelopeJson: { eventId: 'EVT-1' },
    correlationId: null,
    discardedReason: null,
    recordJson: {},
    createdAt: new Date(),
    ...overrides,
  };
}

function createDeadLetterDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
  let nextInsertError: unknown = null;
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(state.rows.filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (nextInsertError) {
          const err = nextInsertError;
          nextInsertError = null;
          throw err;
        }
        if (table === ewohDeadLetter) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) =>
          Promise.resolve(
            table === ewohDeadLetter
              ? state.rows.filter((r) => matches(cond, r)).map((r) => Object.assign(r, patch))
              : [],
          ),
        ),
      })),
    })),
    __failNextInsertWith: (err: unknown) => {
      nextInsertError = err;
    },
  };
  const service = new DeadLetterService(db as never);
  return { db, rows: state.rows, events, service };
}

describe('DeadLetterService（NO-11a 死信终态台账）', () => {
  it('record 契约 fail-closed：未知 reason 拒绝且不落库', async () => {
    const { rows, service } = createDeadLetterDb();
    await expect(
      service.record({ ...VALID_INPUT, reason: 'teleport' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('org 缺失显式失败（RLS 下不静默写全局）', async () => {
    const { rows, service } = createDeadLetterDb();
    await expect(service.record(VALID_INPUT, '')).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('record 成功：确定性 letterId + DeadLetterRecorded 事件', async () => {
    const { rows, events, service } = createDeadLetterDb();
    const result = await service.record(VALID_INPUT, ORG_A);
    expect(result.created).toBe(true);
    expect(String(result.record?.letterId)).toMatch(/^dl:[0-9a-f]{12}:EVT-1$/);
    expect(rows).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('DeadLetterRecorded');
  });

  it('幂等重放：唯一键冲突回读既有行且不重发事件', async () => {
    const { db, events, service } = createDeadLetterDb();
    const first = await service.record(VALID_INPUT, ORG_A);
    expect(first.created).toBe(true);
    expect(events).toHaveLength(1);
    db.__failNextInsertWith({ code: '23505' });
    const result = await service.record(VALID_INPUT, ORG_A);
    expect(result.created).toBe(false);
    expect(result.record?.letterId).toBe(first.record?.letterId);
    expect(events).toHaveLength(1); // 不重复发事件
  });

  it('requeue：无 handler 显式失败（不假装重放成功）', async () => {
    const { service } = createDeadLetterDb([rowOf('dl:abc123:EVT-1', ORG_A)]);
    await expect(
      service.requeue(ORG_A, 'dl:abc123:EVT-1'),
    ).rejects.toThrow('no_requeue_handler:cloud:ingest');
  });

  it('requeue：注册 handler 后执行重放 + attempts+1 + 状态 requeued；非 pending 拒绝', async () => {
    const { rows, service } = createDeadLetterDb([rowOf('dl:abc123:EVT-1', ORG_A)]);
    const handler = jest.fn().mockResolvedValue(undefined);
    service.registerHandler('cloud:ingest', handler);
    const result = await service.requeue(ORG_A, 'dl:abc123:EVT-1');
    expect(result.to).toBe('requeued');
    expect(result.attempts).toBe(2);
    expect(handler).toHaveBeenCalledWith(ORG_A, { eventId: 'EVT-1' });
    expect(rows[0]?.status).toBe('requeued');
    expect(rows[0]?.attempts).toBe(2);
    await expect(
      service.requeue(ORG_A, 'dl:abc123:EVT-1'),
    ).rejects.toThrow('非法重放');
  });

  it('discard：缺理由拒绝；带理由落账 discarded；重复丢弃拒绝', async () => {
    const { rows, service } = createDeadLetterDb([rowOf('dl:abc123:EVT-1', ORG_A)]);
    await expect(service.discard(ORG_A, 'dl:abc123:EVT-1', '')).rejects.toBeInstanceOf(BadRequestException);
    const result = await service.discard(ORG_A, 'dl:abc123:EVT-1', '固件错误人工确认丢弃');
    expect(result.to).toBe('discarded');
    expect(rows[0]?.discardedReason).toBe('固件错误人工确认丢弃');
    await expect(
      service.discard(ORG_A, 'dl:abc123:EVT-1', 'x'),
    ).rejects.toThrow('already_discarded');
  });

  it('list 租户作用域：他租户行不可见', async () => {
    const mine = rowOf('dl:m1:EVT-1', ORG_A);
    const other = rowOf('dl:o1:EVT-2', ORG_B);
    const { service } = createDeadLetterDb([mine, other]);
    const list = await service.listLetters(ORG_A);
    expect(list.map((r) => r.letterId)).toEqual(['dl:m1:EVT-1']);
  });

  it('handler 重复注册显式拒绝（重放语义唯一）', () => {
    const { service } = createDeadLetterDb();
    service.registerHandler('cloud:ingest', jest.fn());
    expect(() => service.registerHandler('cloud:ingest', jest.fn())).toThrow(
      'dead_letter_handler_already_registered',
    );
  });
});
