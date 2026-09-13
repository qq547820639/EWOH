/* RetrospectiveService 回归测试（standalone_075 / DR-3）。
 *
 * 覆盖两个已修复缺陷：
 *   1. toRecord 误用 RETROSPECTIVE_STATUSES 校验 scope——合法 scope
 *      'incident'/'shift' 会被错误改写成 'plan'（读面篡改台账事实）；
 *   2. updateLessons 只写 lessons_json 列，assembled_json.feedback.lessons
 *      不更新——GET/PATCH 返回的 assembled 仍带 AI 生成的旧 lessons，
 *      人工修订"写入成功但读不回来"（读面与台账脱节）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG）。
 */
/// <reference types="jest" />
import { RetrospectiveService } from '../retrospective.service';
import { ewohRetrospective } from '@server/database/schema';

const ORG_A = 'org-a';
const USER = 'person:operator-1';

function retroRow(overrides: Record<string, unknown> = {}) {
  const assembled = {
    perception: { summary: 's', triggerEventId: null, detectedAt: null, source: null, evidenceIds: [] },
    dataQuality: { level: null, confirmation: null, freshnessNote: null, evidenceIds: [] },
    decision: {
      affectedTaskIds: [], affectedPersonIds: [], affectedDeviceIds: [], affectedStationIds: [],
      chosenPlanId: 'plan-1', alternativePlanIds: [], objectivesSummary: '', constraintsConsidered: [],
      risks: [], confidence: { level: 'unknown', basis: '' }, evidenceIds: [],
    },
    authorization: { mode: 'unknown', approvedBy: null, approvedAt: null, policyVersion: null, evidenceIds: [] },
    execution: { dispatchedAssignmentCount: 0, receiptSummary: { completed: 0, failed: 0, inProgress: 0, cancelled: 0, unknown: 0 }, deviations: [], evidenceIds: [] },
    feedback: {
      plannedVsActualSummary: '',
      kpi: {},
      outcomeAnnotationIds: [],
      // AI 组装时写入的旧经验条目（人工修订前的事实）。
      lessons: [{ title: 'AI 旧条目', detail: 'd', severity: 'info', evidenceIds: [] }],
      evidenceIds: [],
    },
    gaps: [],
  };
  return {
    id: '00000000-0000-4000-8000-0000000000r1',
    orgId: ORG_A,
    retrospectiveId: 'RETRO-AAAA1111',
    scope: 'plan',
    targetId: 'plan-1',
    title: '复盘：plan-1',
    periodStart: new Date(),
    periodEnd: new Date(),
    triggerEventId: null,
    status: 'draft',
    assembledJson: assembled,
    narrative: 'n',
    narrativeSource: 'rule_fallback',
    narrativeModel: null,
    lessonsJson: assembled.feedback.lessons,
    publishedAt: null,
    createdBy: USER,
    createdAt: new Date(),
    ...overrides,
  };
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  // 收集条件里出现的等值字段（orgId / retrospectiveId / status）做宽松匹配。
  const orgIds = new Set<string>();
  const retroIds = new Set<string>();
  const statuses = new Set<string>();
  const walk = (node: unknown, seen: WeakSet<object>): void => {
    if (node == null || typeof node !== 'object' || seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach((x) => walk(x, seen));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value' && typeof value === 'string') {
        if (value.startsWith('org-')) orgIds.add(value);
        else if (value.startsWith('RETRO-')) retroIds.add(value);
        else if (value === 'draft' || value === 'published' || value === 'superseded') statuses.add(value);
      } else {
        walk(value, seen);
      }
    }
  };
  walk(cond, new WeakSet());
  if (orgIds.size > 0 && !orgIds.has(String(row.orgId))) return false;
  if (retroIds.size > 0 && !retroIds.has(String(row.retrospectiveId))) return false;
  if (statuses.size > 0 && !statuses.has(String(row.status))) return false;
  return true;
}

function createDb(rows: Array<Record<string, unknown>>) {
  const state = { rows: [...rows] };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          return {
            limit: jest.fn(async () => hit.slice(0, 1)),
            orderBy: jest.fn(() => ({ limit: jest.fn(async () => hit.slice(0, 50)) })),
          };
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          return { returning: jest.fn(async () => hit) };
        }),
      })),
    })),
  };
  const ctxDeps = {
    requestDatabaseContext: { runInTransaction: async (_guc: unknown, cb: () => Promise<unknown>) => cb() },
    auditService: { appendAuditLog: jest.fn(async () => ({})) },
  };
  const service = new RetrospectiveService(
    db as never,
    ctxDeps.requestDatabaseContext as never,
    ctxDeps.auditService as never,
    undefined,
  );
  return { db, state, service };
}

const ACTOR = { userId: USER, primaryOrgId: ORG_A } as never;

describe('RetrospectiveService 回归（scope 词表 + 人工 lessons 读回）', () => {
  it('toRecord 不再误用状态词表校验 scope：incident 行原样透出（不被改写成 plan）', async () => {
    const { service } = createDb([retroRow({ retrospectiveId: 'RETRO-BBBB2222', scope: 'incident' })]);
    const record = await service.get('RETRO-BBBB2222', ACTOR);
    expect(record.scope).toBe('incident');
  });

  it('updateLessons 同步更新 assembled_json.feedback.lessons：PATCH 响应与随后的 GET 都能读到人工修订', async () => {
    const { state, service } = createDb([retroRow()]);
    const cleaned = [{ title: '人工修订条目', detail: '现场确认', severity: 'warning', evidenceIds: ['event:e1'] }];
    const updated = await service.updateLessons('RETRO-AAAA1111', cleaned as never, ACTOR);
    // PATCH 响应必须带修订后的条目（原先读 assembled_json → 永远返回 AI 旧条目）。
    expect(updated.assembled.feedback.lessons).toEqual(cleaned);
    // 台账两处事实源一致：lessons_json 与 assembled_json.feedback.lessons。
    const row = state.rows[0] as Record<string, unknown>;
    expect(row.lessonsJson).toEqual(cleaned);
    expect((row.assembledJson as Record<string, unknown>).feedback).toEqual(
      expect.objectContaining({ lessons: cleaned }),
    );
    // 随后的 GET 同样可读（读面唯一路径 assembled_json）。
    const fetched = await service.get('RETRO-AAAA1111', ACTOR);
    expect(fetched.assembled.feedback.lessons).toEqual(cleaned);
  });

  it('updateLessons 过滤非法条目且不覆盖其余 assembled 段（gaps/决策段保持不变）', async () => {
    const { state, service } = createDb([retroRow()]);
    await service.updateLessons(
      'RETRO-AAAA1111',
      [
        { title: '有效条目', detail: 'd', severity: 'critical', evidenceIds: [] },
        { title: '', detail: '缺标题，应被丢弃' },
        { title: '缺detail', severity: 'info' },
      ] as never,
      ACTOR,
    );
    const row = state.rows[0] as Record<string, unknown>;
    const assembled = row.assembledJson as Record<string, unknown>;
    expect((assembled.feedback as Record<string, unknown>).lessons).toEqual([
      { title: '有效条目', detail: 'd', severity: 'critical', evidenceIds: [] },
    ]);
    // 其余段不被破坏。
    expect((assembled.decision as Record<string, unknown>).chosenPlanId).toBe('plan-1');
    expect(assembled.gaps).toEqual([]);
  });
});
