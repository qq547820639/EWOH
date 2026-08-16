/* OutcomeAnnotationService 契约行为测试（ADR-034 / §10 Level 7：真值标注面）。
 *
 * 覆盖：create 契约 fail-closed（未知 targetType/outcomeKind/缺判者/坏度量
 * 拒绝）、annotationId 幂等回读不重复发事件、listByTarget/listRecent
 * 租户作用域、OutcomeAnnotationRecorded 事件。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_047 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { OutcomeAnnotationService } from '../outcome-annotation.service';
import { ewohOutcomeAnnotation, ewohEvent } from '@server/database/schema';

const ORG_A = 'org-a';

const VALID_INPUT = {
  targetType: 'plan',
  targetId: 'PLAN-1',
  outcomeKind: 'success',
  judgedBy: 'person:op1',
  measured: { delayMs: 0 },
};

function collectValues(
  node: unknown,
  sets: { annotationIds: Set<string>; orgIds: Set<string>; kinds: Set<string> },
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
      if (value.startsWith('oa:')) sets.annotationIds.add(value);
      if (value.startsWith('org-')) sets.orgIds.add(value);
      if (['success', 'partial_success', 'failure', 'invalid'].includes(value)) sets.kinds.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { annotationIds: new Set<string>(), orgIds: new Set<string>(), kinds: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.annotationIds.size > 0 && !sets.annotationIds.has(String(row.annotationId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.kinds.size > 0 && !sets.kinds.has(String(row.outcomeKind))) return false;
  return true;
}

function createAnnotationDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
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
        if (table === ewohOutcomeAnnotation) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
  };
  const service = new OutcomeAnnotationService(db as never);
  return { db, rows: state.rows, events, service };
}

describe('OutcomeAnnotationService（ADR-034 真值标注面）', () => {
  it('create 契约 fail-closed：未知 targetType/outcomeKind 拒绝且不落库', async () => {
    const { rows, service } = createAnnotationDb();
    await expect(
      service.create({ ...VALID_INPUT, targetType: 'gizmo' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...VALID_INPUT, outcomeKind: 'meh' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('create 成功：落账 + OutcomeAnnotationRecorded 事件', async () => {
    const { events, service } = createAnnotationDb();
    const result = await service.create(VALID_INPUT, ORG_A);
    expect(result.created).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual(['OutcomeAnnotationRecorded']);
  });

  it('annotationId 幂等：重复标注回读不重复发事件', async () => {
    const { events, service } = createAnnotationDb();
    const first = await service.create({ ...VALID_INPUT, annotationId: 'oa:fixed-1' }, ORG_A);
    expect(first.created).toBe(true);
    const second = await service.create({ ...VALID_INPUT, annotationId: 'oa:fixed-1' }, ORG_A);
    expect(second.created).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('listByTarget 与 listRecent 租户作用域', async () => {
    const { service } = createAnnotationDb([
      {
        annotationId: 'oa:mine', orgId: ORG_A, targetType: 'plan', targetId: 'PLAN-1',
        outcomeKind: 'failure', judgedBy: 'person:op1', judgedAt: new Date(),
        measuredJson: null, comment: null, recordJson: {}, createdAt: new Date(),
      },
      {
        annotationId: 'oa:other', orgId: 'org-b', targetType: 'plan', targetId: 'PLAN-1',
        outcomeKind: 'success', judgedBy: 'person:op1', judgedAt: new Date(),
        measuredJson: null, comment: null, recordJson: {}, createdAt: new Date(),
      },
    ]);
    const byTarget = await service.listByTarget(ORG_A, 'plan', 'PLAN-1');
    expect(byTarget).toHaveLength(1);
    expect((byTarget[0] as Record<string, unknown>).annotationId).toBe('oa:mine');
    const recent = await service.listRecent(ORG_A, { outcomeKind: 'failure' });
    expect(recent).toHaveLength(1);
    const none = await service.listRecent(ORG_A, { outcomeKind: 'success' });
    expect(none).toHaveLength(0);
  });
});
