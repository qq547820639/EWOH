/* 复盘/运行记忆契约测试（standalone_075，DR-3）：六段组装结构 + 记录校验
 * fail-closed（缺失段/词表外 scope/narrationSource 不冒充）。 */
import {
  validateAssembledRetrospective,
  validateRetrospectiveRecord,
  type AssembledRetrospective,
} from '../../../shared/retrospective';

function assembled(): AssembledRetrospective {
  return {
    perception: {
      summary: '设备离线触发', triggerEventId: 'EVT-1', detectedAt: '2026-09-11T08:00:00Z',
      source: 'ingest', evidenceIds: ['EVT-1'],
    },
    dataQuality: { level: 'good', confirmation: null, freshnessNote: 'WS-20260911-0001', evidenceIds: [] },
    decision: {
      affectedTaskIds: ['T1'], affectedPersonIds: [], affectedDeviceIds: ['D1'], affectedStationIds: [],
      chosenPlanId: 'P1', alternativePlanIds: [], objectivesSummary: '{}', constraintsConsidered: [],
      risks: [], confidence: { level: 'medium', basis: 'solverStatus=HEURISTIC' }, evidenceIds: ['P1'],
    },
    authorization: { mode: 'human_approval', approvedBy: 'u1', approvedAt: '2026-09-11T09:00:00Z', policyVersion: '1', evidenceIds: ['P1'] },
    execution: { dispatchedAssignmentCount: 1, receiptSummary: { completed: 1, failed: 0, inProgress: 0, cancelled: 0, unknown: 0 }, deviations: [], evidenceIds: ['EX1'] },
    feedback: { plannedVsActualSummary: '1/1 准时', kpi: { onTimeRate: 1 }, outcomeAnnotationIds: [], lessons: [], evidenceIds: [] },
    gaps: [],
  };
}

describe('validateAssembledRetrospective', () => {
  it('完整六段 + gaps 通过', () => {
    expect(validateAssembledRetrospective(assembled())).toEqual([]);
  });

  it('缺失任一段 fail-closed（错误码含段名）', () => {
    const bad = assembled() as unknown as Record<string, unknown>;
    delete bad.authorization;
    expect(validateAssembledRetrospective(bad)).toEqual(['missing_segment:authorization']);
  });

  it('gaps 非数组被拒绝（缺口必须显式结构化）', () => {
    const bad = { ...assembled(), gaps: 'none' } as unknown;
    expect(validateAssembledRetrospective(bad)).toEqual(['gaps_must_be_array']);
  });
});

describe('validateRetrospectiveRecord', () => {
  const base = {
    retrospectiveId: 'RETRO-1',
    scope: 'plan',
    targetId: 'P1',
    title: '复盘：P1',
    status: 'draft',
    assembled: assembled(),
  };

  it('合法记录通过（narrationSource 可为 llm/rule_fallback/null）', () => {
    expect(validateRetrospectiveRecord({ ...base, narrativeSource: 'llm' })).toEqual([]);
    expect(validateRetrospectiveRecord({ ...base, narrativeSource: 'rule_fallback' })).toEqual([]);
    expect(validateRetrospectiveRecord({ ...base, narrativeSource: null })).toEqual([]);
  });

  it('词表外 scope / status / narrativeSource fail-closed', () => {
    expect(validateRetrospectiveRecord({ ...base, scope: 'everything' })).toEqual(['unknown_scope']);
    expect(validateRetrospectiveRecord({ ...base, status: 'done' })).toEqual(['unknown_status']);
    expect(validateRetrospectiveRecord({ ...base, narrativeSource: 'magic' })).toEqual([
      'unknown_narrative_source',
    ]);
  });

  it('空 id / 空 title / 组装结构坏 → 拒绝', () => {
    expect(validateRetrospectiveRecord({ ...base, retrospectiveId: ' ' })).toEqual(['bad_retrospective_id']);
    expect(validateRetrospectiveRecord({ ...base, title: '' })).toEqual(['bad_title']);
    expect(
      validateRetrospectiveRecord({ ...base, assembled: { perception: {} } }),
    ).toEqual(['missing_segment:dataQuality']);
  });
});
