/* ReasoningConsole 纯逻辑测试（NO-25a 实时风险面）。
 *
 * 钉死：结论排序（critical 优先且稳定）、依据摘要可读、台账 id 关联、
 * 未采用数据的六类原因可读化、以及"没有命中也要说清楚"的汇总文案。
 */
/// <reference types="jest" />
import {
  buildRiskRows,
  buildSkippedRows,
  riskSummary,
  ruleLabel,
  sortConclusions,
} from './reasoningConsoleLogic';

const evidence = (overrides: Record<string, unknown> = {}) => ({
  evidenceId: 'sensor:ENV-1-1789',
  subjectId: 'device:ENV-1',
  capability: 'observe.vibration',
  field: 'vibration',
  value: 9.2,
  threshold: 7.1,
  unit: 'mm/s',
  observedAt: '2026-09-12T10:00:00.000Z',
  ageMs: 60_000,
  dataQuality: 'FRESH' as const,
  dataConfidence: 1,
  sourceType: 'real',
  ...overrides,
});

const conclusion = (overrides: Record<string, unknown> = {}) => ({
  conclusionId: 'decision:rt-live-1-vibration-risk-deviceENV-1',
  ruleId: 'rule:machine-vibration-risk',
  subjectId: 'device:ENV-1',
  severity: 'critical',
  explanation: '设备 device:ENV-1 振动超过阈值',
  evidenceIds: ['sensor:ENV-1-1789'],
  ...overrides,
});

describe('ruleLabel / sortConclusions', () => {
  it('未注册规则原样透出（不把未知说成已知）', () => {
    expect(ruleLabel('rule:machine-vibration-risk')).toBe('设备振动风险');
    expect(ruleLabel('rule:unknown-x')).toBe('rule:unknown-x');
  });

  it('结论按严重度排序，同级按规则名稳定排序', () => {
    const sorted = sortConclusions([
      conclusion({ ruleId: 'rule:b', severity: 'low' }),
      conclusion({ ruleId: 'rule:c', severity: 'critical' }),
      conclusion({ ruleId: 'rule:a', severity: 'high' }),
      conclusion({ ruleId: 'rule:a2', severity: 'high' }),
    ]);
    expect(sorted.map((c) => c.ruleId)).toEqual(['rule:c', 'rule:a', 'rule:a2', 'rule:b']);
  });
});

describe('buildRiskRows', () => {
  it('依据摘要给出数值/阈值/数据质量/来源，并关联台账 id', () => {
    const rows = buildRiskRows(
      [conclusion()],
      [evidence()],
      [{ conclusionId: 'decision:rt-live-1-vibration-risk-deviceENV-1', inferenceId: 'inf-1' }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ruleLabel: '设备振动风险',
      subjectId: 'device:ENV-1',
      severity: 'critical',
      evidenceCount: 1,
      inferenceId: 'inf-1',
    });
    expect(rows[0].evidenceSummary).toContain('vibration=9.2mm/s');
    expect(rows[0].evidenceSummary).toContain('阈值 7.1mm/s');
    expect(rows[0].evidenceSummary).toContain('FRESH');
    expect(rows[0].evidenceSummary).toContain('real');
  });

  it('感知门控：禁止强建议 → 结论带"仅提示（原因）"（页面必须显式可见）', () => {
    const rows = buildRiskRows([
      conclusion({
        advisoryOnly: true,
        advisoryReason: '感知融合不许强建议：一致性 conflict / 置信度 low / 冲突 2 条',
      }),
    ], []);
    expect(rows[0].advisoryOnly).toBe(true);
    expect(rows[0].advisoryLabel).toContain('仅提示');
    expect(rows[0].advisoryLabel).toContain('不许强建议');
  });

  it('没有门控字段 = 平台未评估 → 不标"仅提示"，也**不显示成"可信"**', () => {
    const rows = buildRiskRows([conclusion()], []);
    expect(rows[0].advisoryOnly).toBe(false);
    expect(rows[0].advisoryLabel).toBeNull();
  });

  it('门控允许（advisoryOnly=false）与未评估都是不显示徽标，但语义不同（由字段是否存在区分）', () => {
    const gated = buildRiskRows([conclusion({ advisoryOnly: false, advisoryReason: null })], []);
    expect(gated[0].advisoryOnly).toBe(false);
    expect(gated[0].advisoryLabel).toBeNull();
  });

  it('只有 advisoryOnly 没有原因 → 用契约缺省文案，不显示空白徽标', () => {
    const rows = buildRiskRows([conclusion({ advisoryOnly: true, advisoryReason: '   ' })], []);
    expect(rows[0].advisoryLabel).toContain('门控不允许强建议');
  });

  it('没有依据/解释时如实说明，不编造', () => {
    const rows = buildRiskRows([conclusion({ explanation: undefined })], []);
    expect(rows[0].evidenceCount).toBe(0);
    expect(rows[0].evidenceSummary).toBe('');
    expect(rows[0].explanation).toContain('未给出解释文本');
    expect(rows[0].inferenceId).toBeNull();
  });
});

describe('buildSkippedRows', () => {
  it('六类原因可读化，明细原样保留', () => {
    const rows = buildSkippedRows([
      { sensorId: 'ENV-1', subjectId: 'ENV-1', field: 'vibration', reason: 'stale_reading', detail: '读数已过期 30 分钟' },
      { sensorId: 'ENV-2', subjectId: 'ENV-2', field: 'vibration', reason: 'low_confidence', detail: 'data_confidence=0.2' },
      { sensorId: 'ENV-3', subjectId: null, field: 'vibration', reason: 'unknown_subject', detail: '世界模型中没有该设备' },
      { sensorId: 'ENV-4', subjectId: 'ENV-4', field: 'vibration', reason: 'capability_not_declared', detail: '未声明 observe.vibration' },
      { sensorId: 'ENV-5', subjectId: 'ENV-5', field: 'vibration', reason: 'no_value', detail: '该帧没有 vibration 读数' },
      { sensorId: 'ENV-6', subjectId: 'ENV-6', field: 'vibration', reason: 'weird_reason', detail: '未知原因' },
      { sensorId: 'MAT-1', subjectId: 'material:MAT-1', field: 'inventory', reason: 'no_threshold', detail: '未声明再订货点' },
      { sensorId: 'MAT-2', subjectId: 'material:MAT-2', field: 'inventory', reason: 'mixed_units', detail: 'kg 与 件' },
      { sensorId: 'ERP-X-1', subjectId: null, field: 'inventory', reason: 'unparsable_material_movement', detail: 'legacy' },
    ]);
    expect(rows.map((r) => r.reasonLabel)).toEqual([
      '读数已过期',
      '数据置信度不足',
      '世界模型中没有该对象',
      '未声明对应观测能力',
      '该帧没有此读数',
      'weird_reason',
      '未声明再订货点（不判定短缺）',
      '计量单位不一致（无法合并数量）',
      '历史物料载荷不可解析',
    ]);
    // 没有 subjectId 时回退到传感器号（不显示空白）
    expect(rows[2].subject).toBe('ENV-3');
  });
});

describe('riskSummary', () => {
  it('有命中：给出严重度计数与依据/未采用条数', () => {
    const rows = buildRiskRows(
      [conclusion(), conclusion({ ruleId: 'rule:worker-overload', subjectId: 'person:P-1', severity: 'high' })],
      [evidence()],
    );
    const summary = riskSummary(rows, 1, 2);
    expect(summary).toMatchObject({ total: 2, critical: 1, high: 1, evidenceCount: 1, skippedCount: 2 });
    expect(summary.label).toContain('实时风险 2 条');
    expect(summary.label).toContain('未采用数据 2 条');
  });

  it('无命中也要说清楚（不是空白）', () => {
    expect(riskSummary([], 0, 0).label).toContain('当前没有规则命中');
  });
});
