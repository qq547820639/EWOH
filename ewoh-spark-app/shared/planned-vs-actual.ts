/* 前后端共享契约 —— 预计 vs 实际 对账（NO-57b，§7 决策层反馈腿）。
 *
 * 补的缺口：`ewoh_scheduling_execution` 里每行都有计划/实际时间与偏差类型，
 * 预测侧也有 `prediction_shadow_observation`（含 actual 回填），但**任务/工单维度**
 * 从来没有一份"预计 vs 实际"的可复盘口径：哪些可比、偏了多少、有没有系统性高估/低估。
 *
 * 三条诚实边界：
 *   1. **不可比要分类别**（缺计划/缺实际/计划为 0/未完工），不把缺失当 0 参与平均；
 *   2. **样本不足不给比率**（`rate=null` + `note`），不拿 2 条数据算"偏差率 4%"；
 *   3. 只报事实与分布，不替现场下"排产不准"的结论（原因在偏差类型与人审里）。
 */

export const PLANNED_VS_ACTUAL_MIN_SAMPLE = 5;

/** 单行可比性判定（封闭词表，供页面逐行解释"为什么这条不算"）。 */
export const COMPARABILITY_REASONS = [
  'comparable',
  'missing_planned',
  'missing_actual',
  'zero_planned',
  'not_finished',
] as const;
export type ComparabilityReason = (typeof COMPARABILITY_REASONS)[number];

export interface PlannedVsActualRow {
  assignmentId: string;
  taskId: string | null;
  planId: string | null;
  /** 计划时长（毫秒）；来自计划开始/结束（或计划移动+等待）。 */
  plannedMs: number | null;
  /** 实际时长（毫秒）；来自实际开始/结束。 */
  actualMs: number | null;
  deviationType: string | null;
  status: string | null;
}

export interface PlannedVsActualRowView {
  assignmentId: string;
  taskId: string | null;
  planId: string | null;
  plannedMs: number | null;
  actualMs: number | null;
  /** 实际 − 计划（毫秒，正=超时）；不可比时为 null。 */
  deltaMs: number | null;
  /** 相对偏差（delta / planned）；不可比时 null。 */
  pctError: number | null;
  comparability: ComparabilityReason;
  deviationType: string | null;
}

export interface PlannedVsActualSummary {
  windowDays: number;
  totalRows: number;
  comparableRows: number;
  /** 可比覆盖率 = comparable / total（无行时为 null，不显示 0%）。 */
  coverage: number | null;
  /** 偏差统计仅在样本足够时给出（否则 null + note）。 */
  meanAbsPctError: number | null;
  medianAbsPctError: number | null;
  p90AbsPctError: number | null;
  meanSignedMs: number | null;
  overrunCount: number;
  underrunCount: number;
  onTimeCount: number;
  byReason: Record<string, number>;
  byDeviationType: Record<string, number>;
  /** 系统性倾向：样本足够且 |meanSigned| 显著时给提示（只报事实）。 */
  biasNote: string | null;
  notes: string[];
  rows: PlannedVsActualRowView[];
  generatedAt: string;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 单行判定：计划/实际时长都可算且计划 > 0 才算可比。 */
export function classifyComparability(row: PlannedVsActualRow): {
  reason: ComparabilityReason;
  plannedMs: number | null;
  actualMs: number | null;
  deltaMs: number | null;
  pctError: number | null;
} {
  const plannedMs = finite(row.plannedMs);
  const actualMs = finite(row.actualMs);
  if (plannedMs === null || plannedMs <= 0) {
    return {
      reason: plannedMs === null || plannedMs === 0 ? 'missing_planned' : 'zero_planned',
      plannedMs,
      actualMs,
      deltaMs: null,
      pctError: null,
    };
  }
  if (actualMs === null) {
    // 未完工（status 非终态）与"缺实际时间"是两件事，分开报。
    const status = String(row.status ?? '').toLowerCase();
    const finished = status === 'completed' || status === 'closed' || status === 'failed';
    return {
      reason: finished ? 'missing_actual' : 'not_finished',
      plannedMs,
      actualMs,
      deltaMs: null,
      pctError: null,
    };
  }
  const deltaMs = actualMs - plannedMs;
  return {
    reason: 'comparable',
    plannedMs,
    actualMs,
    deltaMs,
    pctError: deltaMs / plannedMs,
  };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * 预计 vs 实际 汇总（纯函数；同输入必得同输出）。
 *
 * 样本不足（可比行 < `minSample`）时**所有比率给 null** 并写明原因——
 * 宁可说"证据不足"，也不拿两三条数据编出"偏差率"。
 */
export function summarizePlannedVsActual(
  rows: readonly PlannedVsActualRow[],
  options: { windowDays?: number; now?: string; minSample?: number } = {},
): PlannedVsActualSummary {
  const minSample = Number.isFinite(options.minSample)
    ? Math.max(1, Math.trunc(Number(options.minSample)))
    : PLANNED_VS_ACTUAL_MIN_SAMPLE;
  const view: PlannedVsActualRowView[] = rows.map((row) => {
    const verdict = classifyComparability(row);
    return {
      assignmentId: row.assignmentId,
      taskId: row.taskId,
      planId: row.planId,
      plannedMs: verdict.plannedMs,
      actualMs: verdict.actualMs,
      deltaMs: verdict.deltaMs,
      pctError: verdict.pctError,
      comparability: verdict.reason,
      deviationType: row.deviationType,
    };
  });
  const comparable = view.filter((row) => row.comparability === 'comparable');
  const byReason: Record<string, number> = {};
  for (const row of view) byReason[row.comparability] = (byReason[row.comparability] ?? 0) + 1;
  const byDeviationType: Record<string, number> = {};
  for (const row of rows) {
    const type = String(row.deviationType ?? '').trim();
    if (type === '') continue;
    byDeviationType[type] = (byDeviationType[type] ?? 0) + 1;
  }
  const notes: string[] = [];
  let meanAbsPctError: number | null = null;
  let medianAbsPctError: number | null = null;
  let p90AbsPctError: number | null = null;
  let meanSignedMs: number | null = null;
  let biasNote: string | null = null;
  if (view.length === 0) {
    // 没有任何执行事实：既不给比率，也不说"证据不足"——那是"还没有数据可谈"。
  } else if (comparable.length < minSample) {
    notes.push(
      `可比样本 ${comparable.length} 条 < 门槛 ${minSample}：**不给偏差比率**`
      + `（缺失/未完工 ${view.length - comparable.length} 条已按原因分类）`,
    );
  } else {
    const absPct = comparable.map((row) => Math.abs(row.pctError as number)).sort((a, b) => a - b);
    const deltas = comparable.map((row) => row.deltaMs as number);
    meanAbsPctError = absPct.reduce((sum, value) => sum + value, 0) / absPct.length;
    medianAbsPctError = percentile(absPct, 50);
    p90AbsPctError = percentile(absPct, 90);
    meanSignedMs = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const meanPlanned = comparable.reduce((sum, row) => sum + (row.plannedMs as number), 0) / comparable.length;
    const signedRatio = meanPlanned > 0 ? meanSignedMs / meanPlanned : 0;
    if (signedRatio > 0.1) {
      biasNote = `系统性超时倾向：平均实际比计划多 ${Math.round(signedRatio * 100)}%（样本 ${comparable.length} 条）——先看偏差类型分布再谈排产口径`;
    } else if (signedRatio < -0.1) {
      biasNote = `系统性提前倾向：平均实际比计划少 ${Math.round(Math.abs(signedRatio) * 100)}%（样本 ${comparable.length} 条）`;
    }
  }
  if (view.length > 0 && comparable.length === 0) {
    notes.push('没有任何可比行：先确认计划与实际时间戳都在回执里上报（缺失不许当 0）');
  }
  return {
    windowDays: Number.isFinite(options.windowDays) ? Math.max(1, Math.trunc(Number(options.windowDays))) : 30,
    totalRows: view.length,
    comparableRows: comparable.length,
    coverage: view.length === 0 ? null : comparable.length / view.length,
    meanAbsPctError,
    medianAbsPctError,
    p90AbsPctError,
    meanSignedMs,
    overrunCount: comparable.filter((row) => (row.deltaMs as number) > 0).length,
    underrunCount: comparable.filter((row) => (row.deltaMs as number) < 0).length,
    onTimeCount: comparable.filter((row) => (row.deltaMs as number) === 0).length,
    byReason,
    byDeviationType,
    biasNote,
    notes,
    rows: view,
    generatedAt: options.now ?? new Date().toISOString(),
  };
}
