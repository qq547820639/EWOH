import {
  DATA_QUALITY_BACKLOG_MIN_OPEN,
  DEVIATION_REPEAT_MIN_COUNT,
  LEARNING_SIGNAL_VERSION,
  SIGNAL_MIN_SAMPLE,
  deriveLearningSignals,
  learningSignalId,
  proposalIdForSignal,
  validateLearningSignal,
  type LearningMemoryInput,
} from './learning-signal';
import type { NotificationGovernanceSummary } from './notification-metrics';

function governance(overrides: Partial<NotificationGovernanceSummary> = {}): NotificationGovernanceSummary {
  return {
    generatedAt: '2026-09-12T08:00:00.000Z',
    windowDays: 30,
    minSample: 5,
    scanned: 0,
    truncated: false,
    totals: { total: 0, pending: 0, read: 0, resolved: 0, failedDelivery: 0 },
    dispositionRate: null,
    medianTimeToResolveMs: null,
    meanTimeToResolveMs: null,
    comparable: 0,
    notComparable: 0,
    aging: [],
    byKind: [],
    topSources: [],
    notes: [],
    ...overrides,
  } as NotificationGovernanceSummary;
}

function kindGroup(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'session_long_running',
    label: '会话连续佩戴过久',
    total: 12,
    pending: 6,
    read: 2,
    resolved: 1,
    failedDelivery: 0,
    comparable: 6,
    notComparable: 0,
    medianTimeToResolveMs: 3_600_000,
    meanTimeToResolveMs: 3_600_000,
    oldestPendingAgeMs: 26 * 3_600_000,
    ...overrides,
  } as NotificationGovernanceSummary['byKind'][number];
}

function input(overrides: Partial<LearningMemoryInput> = {}): LearningMemoryInput {
  return {
    orgId: 'org-1',
    windowDays: 30,
    detectedAt: '2026-09-12T08:00:00.000Z',
    notification: governance(),
    thresholds: [
      { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', effective: 0.7, source: 'engine_default' },
    ],
    quality: { openAlerts: 0, pendingReminders: 0 },
    deviations: [],
    ...overrides,
  };
}

describe('deriveLearningSignals（运行记忆 → 信号）', () => {
  it('提醒积压 + 样本充足 + 处置率低 → raise 方向 + 可执行（基线来自生效阈值）', () => {
    const signals = deriveLearningSignals(
      input({ notification: governance({ byKind: [kindGroup()], topSources: [{ externalRef: 'exo-session:S1', kind: 'session_long_running', kindLabel: '会话连续佩戴过久', total: 3, pending: 2, resolved: 1 }] }) }),
    );
    expect(signals).toHaveLength(1);
    const [signal] = signals;
    expect(signal.kind).toBe('notification_fatigue');
    expect(signal.severity).toBe('high');
    expect(signal.confidence).toBe('medium');
    expect(signal.actionable).toMatchObject({
      ruleId: 'rule:worker-overload',
      parameter: 'workloadThreshold',
      direction: 'raise',
      baselineValue: 0.7,
    });
    expect(signal.notActionableReason).toBeNull();
    expect(signal.evidenceRefs.map((e) => e.type)).toEqual([
      'notification_kind',
      'notification_source',
      'threshold_baseline',
    ]);
    expect(validateLearningSignal({ ...signal, status: 'open' })).toEqual([]);
  });

  it('样本不足 → 不给可信度、不给方向，但**必须**说明理由（原则 7）', () => {
    const signals = deriveLearningSignals(
      input({
        notification: governance({
          byKind: [kindGroup({ comparable: SIGNAL_MIN_SAMPLE - 2, pending: 4, oldestPendingAgeMs: 10 * 3_600_000 })],
        }),
      }),
    );
    const [signal] = signals;
    expect(signal.confidence).toBeNull();
    expect(signal.actionable).toBeNull();
    expect(signal.notActionableReason).toContain('证据不足');
    expect(signal.narrative.missing.join(' ')).toContain('可比样本');
    expect(validateLearningSignal(signal)).toEqual([]);
  });

  it('不可映射的提醒类型（数据质量提醒）即使积压也不生成阈值提案', () => {
    const signals = deriveLearningSignals(
      input({
        notification: governance({
          byKind: [kindGroup({ kind: 'data_quality', label: '数据质量待核实', pending: 9, resolved: 1, comparable: 9, oldestPendingAgeMs: 30 * 3_600_000 })],
        }),
      }),
    );
    const [signal] = signals;
    expect(signal.kind).toBe('notification_fatigue');
    expect(signal.actionable).toBeNull();
    expect(signal.notActionableReason).toContain('没有确定映射');
  });

  it('生效阈值未知 → 不拿未知值当基线（actionable=null + 说明）', () => {
    const signals = deriveLearningSignals(
      input({
        thresholds: [
          { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', effective: null, source: 'engine_default_unknown' },
        ],
        notification: governance({ byKind: [kindGroup()] }),
      }),
    );
    expect(signals[0].actionable).toBeNull();
    expect(signals[0].notActionableReason).toContain('生效阈值未知');
  });

  it('未达门槛（积压条数或时长不够）→ 不产生噪音信号', () => {
    expect(
      deriveLearningSignals(input({ notification: governance({ byKind: [kindGroup({ pending: 2 })] }) })),
    ).toEqual([]);
    expect(
      deriveLearningSignals(
        input({ notification: governance({ byKind: [kindGroup({ oldestPendingAgeMs: 3 * 3_600_000 })] }) }),
      ),
    ).toEqual([]);
  });

  it('取数被截断 → 显式写进 missing（不是全体）', () => {
    const signals = deriveLearningSignals(
      input({ notification: governance({ byKind: [kindGroup()], truncated: true }) }),
    );
    expect(signals[0].narrative.missing.join(' ')).toContain('不是全体');
  });

  it('数据质量积压 → 一条信号，永远不可提案（只是运营问题）', () => {
    const signals = deriveLearningSignals(
      input({ quality: { openAlerts: DATA_QUALITY_BACKLOG_MIN_OPEN + 3, pendingReminders: 4 } }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('data_quality_backlog');
    expect(signals[0].actionable).toBeNull();
    expect(signals[0].notActionableReason).toContain('不是策略阈值问题');
    expect(validateLearningSignal(signals[0])).toEqual([]);
  });

  it('偏差复发 → 按次数取前 3，带证据时间（未知则显式 null）', () => {
    const signals = deriveLearningSignals(
      input({
        deviations: [
          { objectType: 'device', objectId: 'EXO-1', deviationType: 'late_start', count: 5, lastAt: '2026-09-11T02:00:00.000Z' },
          { objectType: 'device', objectId: 'EXO-2', deviationType: 'late_start', count: 4, lastAt: null },
          { objectType: 'person', objectId: 'P-1', deviationType: 'absent', count: 3, lastAt: '2026-09-10T02:00:00.000Z' },
          { objectType: 'device', objectId: 'EXO-3', deviationType: 'late_start', count: 1, lastAt: null },
        ],
      }),
    );
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.kind === 'deviation_repeat')).toBe(true);
    expect(signals[0].metrics.count).toBe(5);
    expect(signals[0].actionable).toBeNull();
    expect(signals[1].evidenceRefs[0].at).toBeNull();
    expect(signals.every((s) => s.sampleSize >= DEVIATION_REPEAT_MIN_COUNT)).toBe(true);
  });

  it('确定性：同一输入两次派生结果完全一致（含信号号）', () => {
    const memory = input({
      notification: governance({ byKind: [kindGroup()] }),
      quality: { openAlerts: 6, pendingReminders: 3 },
      deviations: [{ objectType: 'device', objectId: 'EXO-1', deviationType: 'late_start', count: 4, lastAt: null }],
    });
    const first = deriveLearningSignals(memory);
    const second = deriveLearningSignals(memory);
    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
  });

  it('严重度升级 → 信号号变化（"变严重了"是新事实，不会被旧的忽略决定吞掉）', () => {
    const medium = learningSignalId('notification_fatigue', 'andon', 30, 'medium');
    const high = learningSignalId('notification_fatigue', 'andon', 30, 'high');
    expect(medium).not.toBe(high);
    expect(medium).toContain('SIG-NOTIFICATION_FATIGUE-andon-30d-medium');
    expect(proposalIdForSignal(medium)).toBe('LP-NOTIFICATION_FATIGUE-andon-30d-medium');
  });
});

describe('validateLearningSignal（fail-closed）', () => {
  const base = () =>
    deriveLearningSignals(input({ notification: governance({ byKind: [kindGroup()] }) }))[0];

  it('可执行但没有可信度 → 拒绝', () => {
    const signal = { ...base(), confidence: null };
    expect(validateLearningSignal(signal)).toContain('actionable_requires_confidence');
  });

  it('不可执行且没有理由 → 拒绝（不许藏着结论）', () => {
    const signal = { ...base(), actionable: null, notActionableReason: null };
    expect(validateLearningSignal(signal)).toContain('not_actionable_requires_reason');
  });

  it('没有证据引用 → 拒绝', () => {
    expect(validateLearningSignal({ ...base(), evidenceRefs: [] })).toContain('missing_evidence');
  });

  it('空指标快照 → 拒绝（原则 5：没有来源就没有建议）', () => {
    expect(validateLearningSignal({ ...base(), metrics: {} })).toContain('empty_metrics');
  });

  it('未知版本字段/未知类型/未知状态 → 拒绝', () => {
    expect(validateLearningSignal({ ...base(), kind: 'magic' })).toContain('unknown_kind');
    expect(validateLearningSignal({ ...base(), status: 'archived' })).toContain('unknown_status');
    expect(validateLearningSignal(null)).toContain('record_must_be_object');
  });

  it('契约版本存在（前端展示用）', () => {
    expect(LEARNING_SIGNAL_VERSION).toBe('1.0.0');
  });
});
