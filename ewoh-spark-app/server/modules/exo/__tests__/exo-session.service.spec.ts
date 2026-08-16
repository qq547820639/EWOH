/* ExoSessionService 契约行为测试（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 * 覆盖：start 契约 fail-closed（非规范身份拒绝）、活跃冲突显式
 * （23505 → conflict_exo_session_active，§7 绝不静默双绑定）、
 * end/abort 状态机（endedBy 必填/终态不可复开/actualEndAt 落账）、
 * 租户作用域、ExoSessionStarted/Ended 双事件。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_046 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ExoSessionService } from '../exo-session.service';
import { ewohExoSession, ewohEvent } from '@server/database/schema';

const ORG_A = 'org-a';
const EXO_ID = 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';
const PERSON_ID = 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

function collectValues(
  node: unknown,
  sets: { sessionIds: Set<string>; orgIds: Set<string>; statuses: Set<string> },
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
      if (value.startsWith('exo-session:')) sets.sessionIds.add(value);
      if (value.startsWith('org-')) sets.orgIds.add(value);
      if (['active', 'ended', 'aborted'].includes(value)) sets.statuses.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { sessionIds: new Set<string>(), orgIds: new Set<string>(), statuses: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.sessionIds.size > 0 && !sets.sessionIds.has(String(row.sessionId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.statuses.size > 0 && !sets.statuses.has(String(row.status))) return false;
  return true;
}

function rowOf(sessionId: string, orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId,
    sessionId,
    exoId: EXO_ID,
    personId: PERSON_ID,
    status: 'active',
    startedAt: new Date('2026-08-16T08:00:00Z'),
    expectedEndAt: null,
    actualEndAt: null,
    endedBy: null,
    reason: null,
    operatorId: null,
    recordJson: { sessionId, exoId: EXO_ID, personId: PERSON_ID, status: 'active', startedAt: '2026-08-16T08:00:00Z', auditTrail: true },
    createdAt: new Date(),
    ...overrides,
  };
}

function createExoDb(rows: Array<Record<string, unknown>> = []) {
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
        if (table === ewohExoSession) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          return { returning: jest.fn(async () => hit) };
        }),
      })),
    })),
    __failNextInsertWith: (err: unknown) => {
      nextInsertError = err;
    },
  };
  const service = new ExoSessionService(db as never);
  return { db, rows: state.rows, events, service };
}

describe('ExoSessionService（ADR-032 / §7）', () => {
  it('start 契约 fail-closed：非规范身份拒绝且不落库', async () => {
    const { rows, service } = createExoDb();
    await expect(
      service.start({ exoId: 'EXO-1', personId: PERSON_ID }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('start 成功：active 落账 + ExoSessionStarted 事件', async () => {
    const { events, service } = createExoDb();
    const result = await service.start({ exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    expect(result.status).toBe('active');
    expect(events.map((e) => e.eventType)).toEqual(['ExoSessionStarted']);
  });

  it('活跃冲突显式：同外骨骼第二个 active 会话 → conflict_exo_session_active（§7 绝不静默双绑定）', async () => {
    const { db, service } = createExoDb();
    await service.start({ exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    db.__failNextInsertWith({ code: '23505' });
    await expect(
      service.start({ exoId: EXO_ID, personId: 'person:other-1' }, ORG_A),
    ).rejects.toThrow('conflict_exo_session_active');
  });

  it('end：状态机 + endedBy 必填 + actualEndAt 落账 + ExoSessionEnded；终态不可复开', async () => {
    const { rows, events, service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    await expect(service.endSession(ORG_A, 'exo-session:s1', '')).rejects.toThrow('endedBy 必填');
    const result = await service.endSession(ORG_A, 'exo-session:s1', 'person:op1', '班次结束');
    expect(result.status).toBe('ended');
    expect(result.actualEndAt).toBeDefined();
    expect(rows[0]?.status).toBe('ended');
    expect(rows[0]?.actualEndAt).toBeInstanceOf(Date);
    expect(events.map((e) => e.eventType)).toEqual(['ExoSessionEnded']);
    // 终态不可复开（新绑定 = 新会话，§7）
    await expect(service.abortSession(ORG_A, 'exo-session:s1', 'person:op1')).rejects.toThrow('非法会话转移');
  });

  it('abort：状态机 + 理由留痕', async () => {
    const { service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    const result = await service.abortSession(ORG_A, 'exo-session:s1', 'person:op1', '设备故障');
    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('设备故障');
  });


  it('ADR-033 幂等：同 sessionId 重复 start 回读（应用层幂等，at-least-once 安全）', async () => {
    const { service } = createExoDb();
    const first = await service.start({ sessionId: 'exo-session:fixed-1', exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    const second = await service.start({ sessionId: 'exo-session:fixed-1', exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    expect((second as Record<string, unknown>).sessionId).toBe(first.sessionId);
    expect((second as Record<string, unknown>).status).toBe('active');
  });

  it('ADR-033 幂等：重复 ended 原样返回（不报错）', async () => {
    const { service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    await service.endSession(ORG_A, 'exo-session:s1', 'person:op1');
    const again = await service.endSession(ORG_A, 'exo-session:s1', 'person:op2');
    expect((again as Record<string, unknown>).status).toBe('ended');
  });

  it('租户作用域：他租户会话不可见', async () => {
    const { service } = createExoDb([
      rowOf('exo-session:s1', ORG_A),
      rowOf('exo-session:s2', 'org-b'),
    ]);
    const list = await service.listSessions(ORG_A);
    expect(list).toHaveLength(1);
    expect((list[0] as Record<string, unknown>).sessionId).toBe('exo-session:s1');
    await expect(service.getSession(ORG_A, 'exo-session:s2')).rejects.toBeInstanceOf(BadRequestException);
  });
});
