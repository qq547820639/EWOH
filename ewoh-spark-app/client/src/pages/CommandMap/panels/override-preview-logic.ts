// panels/override-preview-logic.ts — OverridePanel「预览后确认」纯逻辑（可测试、无渲染依赖）
//
// Task 10 / 10.2：人工覆盖执行前先调后端 previewOverrides（POST /plans/:id/overrides/preview，
// 纯计算不落库不重排），本模块把 OverridePreviewResponse 映射为确认对话框展示摘要：
// 受影响分配数 / planChurn / 迟到·路程·负荷·工位等待增量 / 预览引入冲突。
// 只透传后端字段，前端不重算影响（同 OverridePreviewService 语义）。

import type { OverridePreviewResponse } from '@shared/api.interface';

export interface OverridePreviewSummary {
  planId: string;
  affectedCount: number;
  planChurn: number;
  latenessDeltaMinutes: number;
  travelDeltaMinutes: number;
  workloadDelta: number;
  stationWaitDeltaMinutes: number;
  conflictsIntroduced: Array<{ conflictId?: string; type?: string; message?: string }>;
}

/** 纯函数：OverridePreviewResponse → 确认对话框摘要。 */
export function overridePreviewSummary(
  preview: OverridePreviewResponse,
): OverridePreviewSummary {
  return {
    planId: preview.planId,
    affectedCount: preview.affectedAssignments.length,
    planChurn: preview.planChurn,
    latenessDeltaMinutes: preview.latenessDeltaMinutes,
    travelDeltaMinutes: preview.travelDeltaMinutes,
    workloadDelta: preview.workloadDelta,
    stationWaitDeltaMinutes: preview.stationWaitDeltaMinutes,
    conflictsIntroduced: preview.conflictsIntroduced ?? [],
  };
}

/** 预览 delta 行（含「负值利好」色调提示所需符号）。 */
export function overridePreviewDeltaRows(
  preview: OverridePreviewResponse,
): Array<{ key: string; label: string; value: number; unit: string }> {
  return [
    { key: 'lateness', label: '迟到', value: preview.latenessDeltaMinutes, unit: 'min' },
    { key: 'travel', label: '路程', value: preview.travelDeltaMinutes, unit: 'min' },
    { key: 'workload', label: '负荷', value: preview.workloadDelta, unit: '' },
    { key: 'stationWait', label: '工位等待', value: preview.stationWaitDeltaMinutes, unit: 'min' },
  ];
}
