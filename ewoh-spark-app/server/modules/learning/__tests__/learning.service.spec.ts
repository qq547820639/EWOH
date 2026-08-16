/* LearningService 契约行为测试（ADR-021 / NO-09a，Phase 12 Continuous Learning）。
 *
 * 覆盖：契约校验 fail-closed（倒置周期 / 未知类型 / org 缺失）、七项指标
 * 真实事实聚合（建议接受率 / 事件结局 / override 计数 + KpiService 复用）、
 * modelAccuracy 显式 unknown（null，绝不伪造）、KpiService 失败 → 指标 null
 * 不伪造、幂等重评估（唯一键冲突回读不重发事件）、LearningEvaluationRecorded
 * 事件、租户作用域列表/latest。
 * DB 以 fake 替换（execute 返回按 SQL 片段匹配的聚合结果）；KpiService mock。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { LearningService } from '../learning.service';
import { ewohLearningEvaluation, ewohEvent, ewohAiSuggestion, ewohSchedulingFeedback } from '@server/database/schema';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const KPIS = {
  delivery: { completionRate: 0.9, latenessP95Ms: 45000 },
  solver: { heuristicFallbackRate: 0.12 },
};

function createLearningDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
  let nextInsertError: unknown = null;
  function sqlText(query: unknown): string {
    const q = query as { queryChunks?: unknown[] };
    if (Array.isArray(q?.queryChunks)) {
      return q.queryChunks
        .map((c) => {
          if (typeof c === 'string') return c;
          const chunk = c as { value?: unknown };
          if (Array.isArray(chunk?.value)) return chunk.value.filter((x) => typeof x === 'string').join('');
          return '';
        })
        .join('');
    }
    return '';
  }
  function collectOrgs(node: unknown, set: Set<string>, seen: WeakSet<object>): void {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const x of node) collectOrgs(x, set, seen);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value' && typeof value === 'string' && value.startsWith('org-')) set.add(value);
      else collectOrgs(value, set, seen);
    }
  }
  function matchesOrg(cond: unknown, row: Record<string, unknown>): boolean {
    const set = new Set<string>();
    collectOrgs(cond, set, new WeakSet());
    if (set.size === 0) return true;
    return set.has(String(row.orgId));
  }
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    execute: jest.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('ewoh_ai_suggestion')) return [{ total: 4, accepted: 3 }];
      if (text.includes('ewoh_event')) return [{ total: 5, closed: 4 }];
      if (text.includes('ewoh_scheduling_feedback')) return [{ total: 10, overrides: 2 }];
      return [];
    }),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        // ADR-078：聚合面 drizzle 链式假库（学习三聚合返回聚合行形状）。
        const aggregateRows: unknown[] =
          table === ewohAiSuggestion
            ? [{ total: 4, accepted: 3 }]
            : table === ewohEvent
              ? [{ total: 5, closed: 4 }]
              : table === ewohSchedulingFeedback
                ? [{ total: 10, overrides: 2 }]
                : state.rows;
        const q: any = Promise.resolve(aggregateRows);
        q.where = (cond: unknown) =>
          thenable(
            table === ewohLearningEvaluation
              ? state.rows.filter((r) => matchesOrg(cond, r))
              : aggregateRows,
          );
        return q;
      }),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (nextInsertError) {
          const err = nextInsertError;
          nextInsertError = null;
          throw err;
        }
        if (table === ewohLearningEvaluation) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    __failNextInsertWith: (err: unknown) => {
      nextInsertError = err;
    },
  };
  const kpi = { aggregate: jest.fn().mockResolvedValue(KPIS) };
  const service = new LearningService(db as never, kpi as never);
  return { db, kpi, events, rows: state.rows, service };
}

describe('LearningService（NO-09a 持续学习回路）', () => {
  it('org 缺失显式失败（RLS 下不静默写全局）', async () => {
    const { service } = createLearningDb();
    await expect(service.evaluate({}, '')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('倒置周期 fail-closed 拒绝', async () => {
    const { service } = createLearningDb();
    await expect(
      service.evaluate({ periodStartMs: 2000, periodEndMs: 1000 }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('未知 evaluationType fail-closed 拒绝', async () => {
    const { service } = createLearningDb();
    await expect(
      service.evaluate({ evaluationType: 'teleport' as never }, ORG_A),
    ).rejects.toThrow('unknown_evaluation_type');
  });

  it('评估成功：七项指标真实聚合 + modelAccuracy 显式 unknown + 事件落库', async () => {
    const { rows, events, service } = createLearningDb();
    const result = await service.evaluate(
      { evaluationType: 'periodic', periodStartMs: 1, periodEndMs: 2 },
      ORG_A,
    );
    const record = result.record as Record<string, unknown>;
    expect(result.created).toBe(true);
    const metrics = record.metrics as Record<string, unknown>;
    expect(metrics.recommendationAcceptanceRate).toBeCloseTo(0.75);
    expect(metrics.riskOutcomeRate).toBeCloseTo(0.8);
    expect(metrics.humanOverrideRate).toBeCloseTo(0.2);
    expect(metrics.planSuccessRate).toBeCloseTo(0.9);
    expect(metrics.taskDelayP95Ms).toBe(45000);
    expect(metrics.schedulerQualityRate).toBeCloseTo(0.12);
    expect(metrics.modelAccuracy).toBeNull();
    expect(record.evalId).toBe('le:periodic:1970-01-01T00:00:00.001Z');
    expect(rows).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('LearningEvaluationRecorded');
  });

  it('KpiService 聚合失败 → 相关指标显式 null（不伪造）', async () => {
    const { kpi, service } = createLearningDb();
    kpi.aggregate.mockRejectedValueOnce(new Error('db down'));
    const result = await service.evaluate({}, ORG_A);
    const metrics = (result.record as Record<string, unknown>).metrics as Record<string, unknown>;
    expect(metrics.planSuccessRate).toBeNull();
    expect(metrics.schedulerQualityRate).toBeNull();
    expect(metrics.recommendationAcceptanceRate).toBeCloseTo(0.75);
  });

  it('幂等重评估：唯一键冲突回读既有行且不重发事件', async () => {
    const existing = {
      id: '00000000-0000-4000-8000-000000000001',
      orgId: ORG_A,
      evalId: 'le:periodic:1970-01-01T00:00:00.001Z',
      evaluationType: 'periodic',
      periodStart: new Date(1),
      periodEnd: new Date(2),
      engineVersion: '1.0.0',
      metricsJson: { modelAccuracy: null },
      basisJson: ['x'],
      createdAt: new Date(),
    };
    const { db, events, service } = createLearningDb([existing]);
    db.__failNextInsertWith({ code: '23505' });
    const result = await service.evaluate(
      { evaluationType: 'periodic', periodStartMs: 1, periodEndMs: 2 },
      ORG_A,
    );
    expect(result.created).toBe(false);
    expect(result.record?.evalId).toBe('le:periodic:1970-01-01T00:00:00.001Z');
    expect(events).toHaveLength(0);
  });

  it('latest 返回最近评估；list 租户作用域', async () => {
    const a = {
      id: '1', orgId: ORG_A, evalId: 'le:a', evaluationType: 'periodic',
      periodStart: new Date(1), periodEnd: new Date(2), engineVersion: '1.0.0',
      metricsJson: { modelAccuracy: null }, basisJson: ['x'], createdAt: new Date(1),
    };
    const b = {
      id: '2', orgId: ORG_B, evalId: 'le:b', evaluationType: 'periodic',
      periodStart: new Date(3), periodEnd: new Date(4), engineVersion: '1.0.0',
      metricsJson: { modelAccuracy: null }, basisJson: ['x'], createdAt: new Date(3),
    };
    const { service } = createLearningDb([a, b]);
    const latest = await service.latest(ORG_A);
    expect(latest?.evalId).toBe('le:a');
    const list = await service.listEvaluations(ORG_A);
    expect(list.map((r) => r.evalId)).toEqual(['le:a']);
  });
});
