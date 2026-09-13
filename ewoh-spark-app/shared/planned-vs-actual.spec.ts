import {
  PLANNED_VS_ACTUAL_MIN_SAMPLE,
  classifyComparability,
  summarizePlannedVsActual,
  type PlannedVsActualRow,
} from './planned-vs-actual';

function row(overrides: Partial<PlannedVsActualRow> = {}): PlannedVsActualRow {
  return {
    assignmentId: 'ASG-1',
    taskId: 'T-1',
    planId: 'PLAN-1',
    plannedMs: 3_600_000,
    actualMs: 4_320_000,
    deviationType: 'late_finish',
    status: 'completed',
    ...overrides,
  };
}

describe('classifyComparability（可比性判定）', () => {
  it('计划与实际都可算且计划>0 → comparable（给出 delta 与相对偏差）', () => {
    const verdict = classifyComparability(row());
    expect(verdict.reason).toBe('comparable');
    expect(verdict.deltaMs).toBe(720_000);
    expect(verdict.pctError).toBeCloseTo(0.2, 4);
  });

  it('缺计划/计划为 0/缺实际/未完工 → 各自分类，不混为一谈', () => {
    expect(classifyComparability(row({ plannedMs: null })).reason).toBe('missing_planned');
    expect(classifyComparability(row({ plannedMs: 0 })).reason).toBe('missing_planned');
    expect(classifyComparability(row({ actualMs: null, status: 'completed' })).reason).toBe('missing_actual');
    expect(classifyComparability(row({ actualMs: null, status: 'executing' })).reason).toBe('not_finished');
    expect(classifyComparability(row({ actualMs: null, status: null })).reason).toBe('not_finished');
  });
});

describe('summarizePlannedVsActual（预计 vs 实际汇总）', () => {
  it('样本足够：给出中位/均值/P90 与超时-提前计数', () => {
    const rows = [
      row({ assignmentId: 'A', actualMs: 3_600_000 }), // 0%
      row({ assignmentId: 'B', actualMs: 4_320_000 }), // +20%
      row({ assignmentId: 'C', actualMs: 2_880_000 }), // -20%
      row({ assignmentId: 'D', actualMs: 5_400_000 }), // +50%
      row({ assignmentId: 'E', actualMs: 3_600_000 }), // 0%
    ];
    const summary = summarizePlannedVsActual(rows, { now: '2026-09-12T08:00:00.000Z' });
    expect(summary.totalRows).toBe(5);
    expect(summary.comparableRows).toBe(5);
    expect(summary.coverage).toBe(1);
    expect(summary.medianAbsPctError).toBeCloseTo(0.2, 4);
    expect(summary.p90AbsPctError).toBeCloseTo(0.5, 4);
    expect(summary.overrunCount).toBe(2);
    expect(summary.underrunCount).toBe(1);
    expect(summary.onTimeCount).toBe(2);
    expect(summary.notes).toEqual([]);
  });

  it('样本不足 → 所有比率 null 并写明门槛（不拿两条数据编偏差率）', () => {
    const summary = summarizePlannedVsActual([row(), row({ assignmentId: 'A2' })]);
    expect(summary.comparableRows).toBe(2);
    expect(summary.meanAbsPctError).toBeNull();
    expect(summary.medianAbsPctError).toBeNull();
    expect(summary.p90AbsPctError).toBeNull();
    expect(summary.notes.join(' ')).toContain(`< 门槛 ${PLANNED_VS_ACTUAL_MIN_SAMPLE}`);
    expect(summary.notes.join(' ')).toContain('不给偏差比率');
  });

  it('不可比按原因分类（缺计划/缺实际/未完工），不参与统计', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row({ assignmentId: `C${i}`, actualMs: 3_960_000 })),
      row({ assignmentId: 'M1', plannedMs: null }),
      row({ assignmentId: 'M2', actualMs: null, status: 'completed' }),
      row({ assignmentId: 'M3', actualMs: null, status: 'executing' }),
    ];
    const summary = summarizePlannedVsActual(rows);
    expect(summary.comparableRows).toBe(5);
    expect(summary.byReason).toMatchObject({ comparable: 5, missing_planned: 1, missing_actual: 1, not_finished: 1 });
    expect(summary.coverage).toBeCloseTo(5 / 8, 4);
    expect(summary.byDeviationType.late_finish).toBe(8);
  });

  it('系统性超时倾向只报事实（>10% 才提示，并提示先看偏差类型）', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ assignmentId: `S${i}`, actualMs: 4_680_000 })); // +30%
    const summary = summarizePlannedVsActual(rows);
    expect(summary.biasNote).toContain('系统性超时倾向');
    expect(summary.biasNote).toContain('先看偏差类型分布');
    const balanced = summarizePlannedVsActual(
      Array.from({ length: 6 }, (_, i) => row({ assignmentId: `B${i}`, actualMs: 3_660_000 })), // +1.7%
    );
    expect(balanced.biasNote).toBeNull();
  });

  it('没有任何行 → coverage=null（不显示 0%），也不给"证据不足"结论（还没有数据可谈）', () => {
    const summary = summarizePlannedVsActual([]);
    expect(summary.coverage).toBeNull();
    expect(summary.totalRows).toBe(0);
    // 没有任何行时既不给比率也不下"不可比"结论——那是"还没有执行事实"，不是"数据缺失"
    expect(summary.notes).toEqual([]);
    expect(summary.meanAbsPctError).toBeNull();
  });

  it('有行但零可比 → 提示"没有任何可比行"', () => {
    const summary = summarizePlannedVsActual([row({ plannedMs: null }), row({ actualMs: null, status: 'executing' })]);
    expect(summary.comparableRows).toBe(0);
    expect(summary.coverage).toBe(0);
    expect(summary.notes.join(' ')).toContain('没有任何可比行');
  });
});
