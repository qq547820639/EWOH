/* 训练样本资格判定（单一事实源）。
 *
 * 为什么单独成模块：训练加载（duration-model-training.service）与资格统计
 * （训练样本摘要 API / 学习控制台）必须给出**同一个口径**。若两处各写一份，
 * 就会出现"界面显示有 N 条可训练样本、训练却报样本不足"的矛盾——这正是
 * 本项目明令禁止的"同一事实两套口径 / 把缺失说成存在"。
 *
 * 资格是**两级**的，两级都必须满足：
 *   1) 行级标记：receipt_source='real'、production_training_eligible=true、
 *      且带 provenance_json。这些是派生的元数据，可能过期或被旧写入方伪造。
 *   2) 独立设备回执证据：provenance.policy='receipt-provenance-v1'、
 *      provenance.source='real'，且其中的 independentReceipt 满足
 *      policy='persisted-device-receipt-v1'、source='device_receipt'，
 *      时间戳与执行事实一致、执行/分配/方案/任务/设备 ID 齐备。
 *
 * 因此**人工上报与模拟回执永远无法训练生产模型**，即使行级标记被写成 true。
 * 这是有意的：时长模型会影响排程预测，只能由独立设备证据驱动。
 */

/** 拒绝原因（可枚举，便于界面按原因分组说明"为什么不能训练"）。 */
export type TrainingRejectionReason =
  | 'not_real_source'
  | 'flags_not_eligible'
  | 'missing_provenance'
  | 'provenance_policy_mismatch'
  | 'missing_independent_device_receipt'
  | 'receipt_evidence_mismatch'
  | 'missing_actual_times'
  | 'invalid_duration';

export interface TrainabilityVerdict {
  trainable: boolean;
  /** trainable=false 时的首个拒绝原因（稳定枚举，不是自由文本）。 */
  reason?: TrainingRejectionReason;
  /** 时长（毫秒）；仅 trainable=true 时给出。 */
  durationMs?: number;
}

/** 判定所需的最小行形状（避免与 drizzle 行类型耦合，便于单测）。 */
export interface TrainabilityInput {
  receiptSource?: string | null;
  productionTrainingEligible?: boolean | null;
  provenanceJson?: unknown;
  actualStart?: Date | null;
  actualEnd?: Date | null;
}

const PROVENANCE_POLICY = 'receipt-provenance-v1';
const DEVICE_RECEIPT_POLICY = 'persisted-device-receipt-v1';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 评估单行反馈能否作为生产训练样本。纯函数、无副作用、可单测。 */
export function evaluateTrainingSample(row: TrainabilityInput): TrainabilityVerdict {
  if (row.receiptSource !== 'real') {
    return { trainable: false, reason: 'not_real_source' };
  }
  if (row.productionTrainingEligible !== true) {
    return { trainable: false, reason: 'flags_not_eligible' };
  }
  const provenance = asRecord(row.provenanceJson);
  if (!provenance) {
    return { trainable: false, reason: 'missing_provenance' };
  }
  if (provenance.policy !== PROVENANCE_POLICY || provenance.source !== 'real') {
    return { trainable: false, reason: 'provenance_policy_mismatch' };
  }
  const evidence = asRecord(provenance.independentReceipt);
  if (!evidence || evidence.policy !== DEVICE_RECEIPT_POLICY || evidence.source !== 'device_receipt') {
    return { trainable: false, reason: 'missing_independent_device_receipt' };
  }
  const start = row.actualStart instanceof Date ? row.actualStart.getTime() : null;
  const end = row.actualEnd instanceof Date ? row.actualEnd.getTime() : null;
  if (start == null || end == null) {
    return { trainable: false, reason: 'missing_actual_times' };
  }
  if (
    evidence.actualStartAt !== row.actualStart?.toISOString()
    || evidence.actualEndAt !== row.actualEnd?.toISOString()
    || !evidence.executionId
    || !evidence.assignmentId
    || !evidence.planId
    || !evidence.taskId
    || !evidence.deviceId
  ) {
    return { trainable: false, reason: 'receipt_evidence_mismatch' };
  }
  const duration = end - start;
  if (!Number.isFinite(duration) || duration < 0) {
    return { trainable: false, reason: 'invalid_duration' };
  }
  return { trainable: true, durationMs: duration };
}

/** 拒绝原因的中文说明（界面直接展示，避免各处自造措辞）。 */
export const TRAINING_REJECTION_LABELS: Record<TrainingRejectionReason, string> = {
  not_real_source: '非真实来源（人工上报或模拟回执）',
  flags_not_eligible: '来源资格标记未通过',
  missing_provenance: '缺少可追溯证明 JSON',
  provenance_policy_mismatch: '证明策略不符（非 receipt-provenance-v1 / 非真实来源）',
  missing_independent_device_receipt: '缺少独立设备回执证据（人工上报不满足）',
  receipt_evidence_mismatch: '设备回执证据与执行事实不一致',
  missing_actual_times: '缺少实际开始/结束时间',
  invalid_duration: '时长无效（负值或非有限数）',
};
