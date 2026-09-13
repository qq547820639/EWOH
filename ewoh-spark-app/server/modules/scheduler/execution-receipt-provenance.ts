import type { ExecutionReceiptProvenance } from '@shared/execution-receipt';

export const RECEIPT_PROVENANCE_POLICY = 'receipt-provenance-v1' as const;
/** Reserved for independently ingested device receipts. Neither HTTP adapter writes this source. */
export const DEVICE_RECEIPT_SOURCE = 'device_receipt';
export const RECEIPT_EVIDENCE_POLICY = 'persisted-device-receipt-v1';
export interface ReceiptFact {
  id?: string;
  orgId?: string | null;
  planId?: string | null;
  taskId?: string | null;
  assignmentId?: string | null;
  executionId?: string | null;
  deviceId?: string | null;
  source?: string | null;
  sourceType?: string | null;
  status?: string | null;
  isShadow?: boolean | null;
  createdBy?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: Date | string | null;
  actualStartAt?: Date | string | null;
  actualEndAt?: Date | string | null;
  metricsJson?: unknown;
  triggerType?: string | null;
  snapshotVersion?: string | null;
}
export const receiptObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const receiptIso = (value: unknown): string | null => {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const nonProduction = (value: unknown) => typeof value === 'string' && /simulat|replay|controlled.?test|(^|[_-])(test|demo|seed|synthetic)([_-]|$)/i.test(value);
export function hasIndependentApproval(plan: ReceiptFact): boolean {
  return Boolean(plan.createdBy?.trim() && plan.confirmedBy?.trim() && plan.createdBy !== plan.confirmedBy && receiptIso(plan.confirmedAt));
}

/** Capture BEFORE applying HTTP actuals. A registry label or a timestamp supplied in
 * the current request is not a measurement. An incomplete device row cannot be
 * completed by HTTP and retain the device source. */
export function independentReceiptEvidence(row: ReceiptFact, execution: ReceiptFact): Record<string, unknown> | null {
  const start = receiptIso(row.actualStartAt);
  const end = receiptIso(row.actualEndAt);
  if (row.source !== DEVICE_RECEIPT_SOURCE || row.status !== 'COMPLETED' || !start || !end || end < start ||
      start !== receiptIso(execution.actualStartAt) || end !== receiptIso(execution.actualEndAt) ||
      !row.deviceId || !row.executionId ||
      ['orgId', 'executionId', 'assignmentId', 'planId', 'taskId', 'deviceId'].some(key =>
        row[key as keyof ReceiptFact] !== execution[key as keyof ReceiptFact])) return null;
  return { policy: RECEIPT_EVIDENCE_POLICY, source: DEVICE_RECEIPT_SOURCE,
    orgId: row.orgId, executionId: row.executionId, assignmentId: row.assignmentId,
    planId: row.planId, taskId: row.taskId, deviceId: row.deviceId, actualStartAt: start, actualEndAt: end };
}

export function receiptProvenance(input: {
  orgId: string; plan: ReceiptFact; task: ReceiptFact; device?: ReceiptFact;
  execution: ReceiptFact; persistedExecution: ReceiptFact; prior?: unknown;
  reportedSource?: 'manual_report' | 'simulated';
}): ExecutionReceiptProvenance {
  const { orgId, plan, task, device, execution } = input;
  const prior = receiptObject(input.prior);
  const metrics = receiptObject(plan.metricsJson);
  // A historical downgrade is sticky even when a previous policy version was used.
  const priorReported = receiptObject(prior.evidence).reportedSource;
  const reportedSource = input.reportedSource === 'simulated' || priorReported === 'simulated' ? 'simulated'
    : input.reportedSource === 'manual_report' || priorReported === 'manual_report' ? 'manual_report' : null;
  const simulated = reportedSource === 'simulated' || plan.isShadow === true || metrics.isSimulation === true || metrics.isSimulated === true ||
    [task.source, device?.sourceType, execution.source, plan.triggerType, metrics.source, metrics.sourceType, metrics.mode].some(nonProduction) || prior.source === 'simulated';
  const evidence = independentReceiptEvidence(input.persistedExecution, execution);
  const sameOrg = [plan, task, execution, device].every(fact => fact?.orgId === orgId);
  const linked = execution.planId === plan.planId && execution.taskId === task.id &&
    Boolean(execution.assignmentId) && execution.deviceId === device?.id;
  const real = !reportedSource && sameOrg && linked && task.source === 'real' && device?.sourceType === 'real' &&
    plan.isShadow === false && ['approved', 'dispatched', 'executing', 'completed'].includes(String(plan.status)) &&
    hasIndependentApproval(plan) && prior.source !== 'unknown' && evidence != null &&
    receiptIso(plan.confirmedAt)! <= receiptIso(execution.actualStartAt)!;
  const source = simulated ? 'simulated' : real ? 'real' : 'unknown';
  return {
    policy: RECEIPT_PROVENANCE_POLICY, source, productionTrainingEligible: source === 'real',
    reason: simulated ? 'non_production_persisted_source' : real ? 'verified_independent_device_receipt' : reportedSource === 'manual_report' ? 'manual_report_not_measured' : 'independent_real_receipt_required',
    evidence: {
      orgId, planId: plan.planId, assignmentId: execution.assignmentId, taskId: task.id,
      executionId: execution.executionId, deviceId: execution.deviceId ?? null,
      taskSource: task.source ?? null, deviceSource: device?.sourceType ?? null,
      planShadow: plan.isShadow ?? null, planCreatedBy: plan.createdBy ?? null, planConfirmedBy: plan.confirmedBy ?? null,
      planConfirmedAt: receiptIso(plan.confirmedAt), snapshotVersion: execution.snapshotVersion ?? null,
      actualStartAt: receiptIso(execution.actualStartAt), actualEndAt: receiptIso(execution.actualEndAt),
      reportedSource, independentReceipt: evidence,
    },
  };
}
