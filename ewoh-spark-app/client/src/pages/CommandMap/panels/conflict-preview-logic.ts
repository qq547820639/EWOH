/* Phase 4 / P4-PREVIEW：ConflictPreviewPanel 纯逻辑（避免渲染环境依赖）。
 *
 * 只做「后端 ConflictPreviewResult → 展示摘要」的纯函数装配；
 * 变更分类/reasons/churn 全部来自后端，前端不重判业务语义。
 */
import type { SchedulingConflict, ConflictPreviewResult } from '@shared/api.interface';

export interface PreviewSummary {
  hasDiff: boolean;
  baselineLabel: string | null;
  candidateLabel: string | null;
  churn: number;
  changeCount: number;
  added: number;
  removed: number;
  /** 按类型计数（键 = 后端 changeType）。 */
  changeTypeCounts: Array<{ type: string; count: number }>;
  /** 变更任务条目（taskId + changeTypes + reasons + before/after 摘要行）。 */
  entries: Array<{
    taskId: string;
    changeTypes: string[];
    reasons: string[];
    beforeLine: string | null;
    afterLine: string | null;
  }>;
}

function snapshotLine(snap: { personId: string | null; deviceId: string | null; stationId: string | null; etaSeconds?: number | null } | undefined): string | null {
  if (!snap) return null;
  const parts = [snap.personId ?? '—', snap.stationId ?? '—'];
  const line = `${parts[0]} → ${parts[1]}`;
  return snap.etaSeconds != null ? `${line} · ${snap.etaSeconds}s` : line;
}

/** 纯函数：ConflictPreviewResult → 展示摘要（不重判；无 diff 时返回空摘要）。 */
export function previewSummary(preview: ConflictPreviewResult | null): PreviewSummary {
  if (!preview || !preview.diff) {
    return {
      hasDiff: false,
      baselineLabel: preview?.baselinePlanId ?? null,
      candidateLabel: preview?.candidatePlanId ?? null,
      churn: 0,
      changeCount: 0,
      added: 0,
      removed: 0,
      changeTypeCounts: [],
      entries: [],
    };
  }
  const diff = preview.diff;
  const counts = new Map<string, number>();
  const entries = diff.diffByTask.map((d) => {
    for (const ct of d.changeTypes) counts.set(ct, (counts.get(ct) ?? 0) + 1);
    return {
      taskId: d.taskId,
      changeTypes: d.changeTypes,
      reasons: d.reasons ?? [],
      beforeLine: snapshotLine(d.before),
      afterLine: snapshotLine(d.after),
    };
  });
  return {
    hasDiff: true,
    baselineLabel: diff.baselinePlanId,
    candidateLabel: diff.candidatePlanId,
    churn: diff.churn,
    changeCount: diff.diffByTask.length,
    added: diff.added.length,
    removed: diff.removed.length,
    changeTypeCounts: [...counts.entries()].map(([type, count]) => ({ type, count })),
    entries,
  };
}

/** Preview 请求动作：优先后端 resolution（建议处置），无则 undefined（后端自判）。 */
export function resolvePreviewAction(conflict: SchedulingConflict): string | undefined {
  return conflict.resolution ?? undefined;
}
