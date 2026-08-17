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

/**
 * NEST-333（2026-08-17 审计整改）：fake DB 的 where 子句必须被尊重——
 * 聚合表（ewoh_ai_suggestion / ewoh_event / ewoh_scheduling_feedback）
 * 按种子行的 orgId 过滤后聚合（原先恒返回硬编码行，org 过滤从未被测到）。
 */
function createLearningDb(
  rows: Array<Record<string, unknown>> = [],
  seeds: {
    aiSuggestions?: Array<Record<string, unknown>>;
    events?: Array<Record<string, unknown>>;
    feedback?: Array<Record<string, unknown>>;
  } = {},
) {
  const state = { rows: [...rows] };
  const aiSuggestions = seeds.aiSuggestions ?? [
    { orgId: 'org-a', planContent: 'x' },
    { orgId: 'org-a', planContent: null },
    { orgId: 'org-a', planContent: 'y' },
    { orgId: 'org-a', planContent: null },
  ];
  const eventRows = seeds.events ?? [
    { orgId: 'org-a', severity: 'critical', status: 'handled' },
    { orgId: 'org-a', severity: 'high', status: 'open' },
    { orgId: 'org-a', severity: 'critical', status: 'handled' },
    { orgId: 'org-a', severity: 'high', status: 'handled' },
    { orgId: 'org-a', severity: 'critical', status: 'handled' },
  ];
  const feedbackRows = seeds.feedback ?? [
    { orgId: 'org-a', overrideCount: 1 },
    { orgId: 'org-a', overrideCount: 1 },
    ...Array.from({ length: 8 }, () => ({ orgId: 'org-a', overrideCount: 0 })),
  ];
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
  function orgsOf(cond: unknown): Set<string> {
    const set = new Set<string>();
    collectOrgs(cond, set, new WeakSet());
    return set;
  }
  function filterByOrg<T extends Record<string, unknown>>(cond: unknown, rows: T[]): T[] {
    const orgs = orgsOf(cond);
    if (orgs.size === 0) return rows;
    return rows.filter((r) => orgs.has(String(r.orgId)));
  }
  function matchesOrg(cond: unknown, row: Record<string, unknown>): boolean {
    const orgs = orgsOf(cond);
    if (orgs.size === 0) return true;
    return orgs.has(String(row.orgId));
  }
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const aggregateFor = (table: unknown, cond: unknown): Record<string, number>[] => {
    if (table === ewohAiSuggestion) {
      const scoped = filterByOrg(cond, aiSuggestions);
      const accepted = scoped.filter((r) => r.planContent != null).length;
      return [{ total: scoped.length, accepted }];
    }
    if (table === ewohEvent) {
      const scoped = filterByOrg(cond, eventRows);
      const closed = scoped.filter((r) => String(r.status) !== 'open').length;
      return [{ total: scoped.length, closed }];
    }
    if (table === ewohSchedulingFeedback) {
      const scoped = filterByOrg(cond, feedbackRows);
      const overrides = scoped.reduce((sum, r) => sum + Number(r.overrideCount ?? 0), 0);
      return [{ total: scoped.length, overrides }];
    }
    return [];
  };
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
        const q: any = Promise.resolve(
          table === ewohLearningEvaluation ? state.rows : aggregateFor(table, undefined),
        );
        q.where = (cond: unknown) =>
          thenable(
            table === ewohLearningEvaluation
              ? state.rows.filter((r) => matchesOrg(cond, r))
              : aggregateFor(table, cond),
          );
        return q;
      }),
    })),
    // NEST-345：事务透传（回调直接拿 db 句柄执行）。
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
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
    // 种子数据（NEST-333 fake）：4 建议 2 接受 = 0.5。
    expect(metrics.recommendationAcceptanceRate).toBeCloseTo(0.5);
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
    expect(metrics.recommendationAcceptanceRate).toBeCloseTo(0.5);
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

  it('NEST-333: 聚合 where 尊重 orgId——他租户行不进入本租户指标', async () => {
    const { service } = createLearningDb(
      [],
      {
        // org-a：4 建议 2 接受、3 事件 2 结案、2 override/10 行；
        // org-b：2 建议 2 接受、1 事件 1 结案、5 override/5 行（若泄漏将拉偏 org-a 指标）。
        aiSuggestions: [
          { orgId: ORG_A, planContent: 'x' },
          { orgId: ORG_A, planContent: null },
          { orgId: ORG_A, planContent: 'y' },
          { orgId: ORG_A, planContent: null },
          { orgId: ORG_B, planContent: 'z' },
          { orgId: ORG_B, planContent: 'w' },
        ],
        events: [
          { orgId: ORG_A, severity: 'critical', status: 'handled' },
          { orgId: ORG_A, severity: 'high', status: 'open' },
          { orgId: ORG_A, severity: 'critical', status: 'handled' },
          { orgId: ORG_B, severity: 'critical', status: 'handled' },
        ],
        feedback: [
          { orgId: ORG_A, overrideCount: 1 },
          { orgId: ORG_A, overrideCount: 1 },
          { orgId: ORG_B, overrideCount: 5 },
        ],
      },
    );
    const result = await service.evaluate({}, ORG_A);
    const metrics = result.record.metrics as Record<string, unknown>;
    expect(metrics.recommendationAcceptanceRate).toBeCloseTo(0.5); // 2/4，不含 org-b
    expect(metrics.riskOutcomeRate).toBeCloseTo(2 / 3); // 不含 org-b 事件
    expect(metrics.humanOverrideRate).toBeCloseTo(1); // 2/2，不含 org-b 的 5
  });
});
