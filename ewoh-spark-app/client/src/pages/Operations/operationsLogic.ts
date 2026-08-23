/**
 * operationsLogic.ts — Operations 数据页纯逻辑层（ADR-087，§17/§33）。
 *
 * 从 Operations.tsx（1143 行）提取，不含 React/Query/DOM 依赖，node 测试成立。
 */

// ── 类型 ─────────────────────────────────────────────────────────────────

export type Tab =
  | '总览'
  | '维保资产'
  | '维保任务'
  | '工装校验'
  | '工作中心'
  | '标准工时'
  | '人员效率';

export interface WorkCenterFlags {
  firstInspectionRequired: boolean;
  materialConsumptionRequired: boolean;
  reportReviewRequired: boolean;
  handoverRequired: boolean;
  scanRequired: boolean;
  exoskeletonRequired: boolean;
  riskConfirmationRequired: boolean;
  toolingCheckRequired: boolean;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

export const TABS: ReadonlyArray<Tab> = [
  '总览', '维保资产', '维保任务', '工装校验', '工作中心', '标准工时', '人员效率',
];

export const EMPTY_FLAGS: WorkCenterFlags = {
  firstInspectionRequired: false,
  materialConsumptionRequired: false,
  reportReviewRequired: false,
  handoverRequired: false,
  scanRequired: false,
  exoskeletonRequired: false,
  riskConfirmationRequired: false,
  toolingCheckRequired: false,
};

export const FLAG_LABELS: ReadonlyArray<{ key: keyof WorkCenterFlags; label: string }> = [
  { key: 'firstInspectionRequired', label: '首检必需' },
  { key: 'materialConsumptionRequired', label: '投料记录' },
  { key: 'reportReviewRequired', label: '报工审核' },
  { key: 'handoverRequired', label: '工序交收' },
  { key: 'scanRequired', label: '扫码作业' },
  { key: 'exoskeletonRequired', label: '外骨骼要求' },
  { key: 'riskConfirmationRequired', label: '风险确认' },
  { key: 'toolingCheckRequired', label: '工装点检' },
];

/** 维保资产类别选项。 */
export const ASSET_CATEGORY_OPTIONS = [
  { value: 'device', label: '设备' },
  { value: 'tooling', label: '工装' },
] as const;

/** 维保任务类型选项。 */
export const TASK_TYPE_OPTIONS = [
  { value: 'preventive', label: '预防性' },
  { value: 'corrective', label: '纠正性' },
  { value: 'predictive', label: '预测性' },
] as const;

/** 维保任务优先级选项。 */
export const TASK_PRIORITY_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'critical', label: '紧急' },
] as const;

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 时间格式化（zh-CN，null/undefined → '—'）。 */
export function formatOpsTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/** 活跃工作中心标志数量。 */
export function countActiveFlags(flags: WorkCenterFlags): number {
  return Object.values(flags).filter(Boolean).length;
}

/** 工作中心标志摘要（活跃标志的中文标签列表）。 */
export function activeFlagLabels(flags: WorkCenterFlags): string[] {
  return FLAG_LABELS
    .filter((f) => flags[f.key])
    .map((f) => f.label);
}

/** 维保资产类别中文标签（未知回退原始值）。 */
export function assetCategoryLabel(value: string): string {
  const opt = ASSET_CATEGORY_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? value;
}

/** 维保任务类型中文标签（未知回退原始值）。 */
export function taskTypeLabel(value: string): string {
  const opt = TASK_TYPE_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? value;
}

/** 维保任务优先级中文标签（未知回退原始值）。 */
export function taskPriorityLabel(value: string): string {
  const opt = TASK_PRIORITY_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? value;
}

/** 人员效率百分比计算（实际/标准 × 100，除零保护）。 */
export function calcEfficiencyPercent(actual: number, standard: number): number {
  if (standard <= 0) return 0;
  return Math.round((actual / standard) * 100);
}

/** 效率等级判定（≥100% 优秀、≥85% 良好、≥70% 一般、<70% 需改进）。 */
export function efficiencyGrade(pct: number): '优秀' | '良好' | '一般' | '需改进' {
  if (pct >= 100) return '优秀';
  if (pct >= 85) return '良好';
  if (pct >= 70) return '一般';
  return '需改进';
}
