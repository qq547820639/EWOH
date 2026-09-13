/* PlannedVsActualService：读执行事实并给出对账口径（NO-57b）。 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ewohSchedulingExecution } from '@server/database/schema';
import { PlannedVsActualService } from '../../../server/modules/scheduler/planned-vs-actual.service';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';

const ORG = 'bbbbbbbb-1111-4111-8111-111111111111';
const ACTOR = { userId: 'dispatcher.wang', primaryOrgId: ORG, roles: ['dispatcher'] } as never;
const BASE = Date.parse('2026-09-12T08:00:00.000Z');

function execution(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    assignmentId: `ASG-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'T-1',
    planId: 'PLAN-1',
    plannedStartAt: new Date(BASE - 3_600_000),
    plannedEndAt: new Date(BASE),
    actualStartAt: new Date(BASE - 3_600_000),
    actualEndAt: new Date(BASE + 1_800_000),
    deviationType: 'late_finish',
    status: 'completed',
    createdAt: new Date(BASE - 3_600_000),
    ...overrides,
  };
}

function createDb(rows: Array<Record<string, unknown>>) {
  const matches = makeConditionMatcher({ org_id: 'orgId', _created_at: 'createdAt', status: 'status' });
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => ({
          orderBy: () => ({
            limit: async (n: number) => (table === ewohSchedulingExecution ? rows.filter((r) => matches(cond, r)).slice(0, n) : []),
          }),
        }),
      }),
    }),
  };
  return { db };
}

describe('PlannedVsActualService.summarize', () => {
  it('读执行事实 → 计划/实际时长与偏差（样本足够时给出比率）', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => execution({ assignmentId: `ASG-${i}` }));
    const { db } = createDb(rows);
    const service = new PlannedVsActualService(db as never);
    const summary = await service.summarize(ACTOR, { windowDays: 30 });
    expect(summary.totalRows).toBe(6);
    expect(summary.comparableRows).toBe(6);
    expect(summary.meanAbsPctError).toBeCloseTo(0.5, 4);
    expect(summary.overrunCount).toBe(6);
    expect(summary.byDeviationType.late_finish).toBe(6);
    expect(summary.coverage).toBe(1);
  });

  it('缺实际时间且未完工 → not_finished（不算偏差，也不当 0）', async () => {
    const { db } = createDb([
      execution({ actualStartAt: null, actualEndAt: null, status: 'executing' }),
      execution({ actualStartAt: null, actualEndAt: null, status: 'completed' }),
    ]);
    const service = new PlannedVsActualService(db as never);
    const summary = await service.summarize(ACTOR, {});
    expect(summary.byReason.not_finished).toBe(1);
    expect(summary.byReason.missing_actual).toBe(1);
    expect(summary.comparableRows).toBe(0);
    expect(summary.coverage).toBe(0);
    expect(summary.notes.join(' ')).toContain('没有任何可比行');
  });

  it('读取触顶时显式说明"不是全体"', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => execution({ assignmentId: `ASG-${i}` }));
    const { db } = createDb(rows);
    const service = new PlannedVsActualService(db as never);
    const summary = await service.summarize(ACTOR, { limit: 3 });
    expect(summary.notes.join(' ')).toContain('读取触顶');
  });

  it('缺 org 上下文 → 400（fail-closed）', async () => {
    const { db } = createDb([]);
    const service = new PlannedVsActualService(db as never);
    await expect(service.summarize(undefined)).rejects.toThrow(BadRequestException);
  });
});
