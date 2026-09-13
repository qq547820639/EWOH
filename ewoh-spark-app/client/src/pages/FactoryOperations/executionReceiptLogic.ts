import type { ExecutionUpdateRequest, SchedulingExecution } from '@shared/scheduler';
import type { ExecutionReceiptResult } from '@shared/execution-receipt';

export type ReceiptAction = 'STARTED' | 'COMPLETED' | 'FAILED';
export type ReceiptSource = 'manual_report' | 'simulated';
export type ReceiptRequest = ExecutionUpdateRequest & { reportedSource: ReceiptSource };
export type ReceiptExecution = SchedulingExecution & {
  source?: string | null;
  receipt?: ExecutionReceiptResult['receipt'];
};

/**
 * 可提交执行回执的角色。
 *
 * 含 `worker`：现场人员必须能报告自己的开工/完工，否则"执行—反馈"对真正的
 * 执行者是断的。放宽的只是前端可进入性；**归属由服务端强制**
 * （assignment.personId === ctx.personId，未绑定/他人任务 403）。
 */
export const RECEIPT_ROLES = ['worker', 'device_ops', 'global_admin', 'dispatcher', 'workshop_lead'];

export function receiptActions(execution: SchedulingExecution): ReceiptAction[] {
  if (execution.status === 'PLANNED' || execution.status === 'DISPATCHED') return ['STARTED', 'FAILED'];
  if (execution.status === 'STARTED' || execution.status === 'PAUSED') {
    return execution.actualStartAt && Number.isFinite(Date.parse(execution.actualStartAt))
      ? ['COMPLETED', 'FAILED'] : ['FAILED'];
  }
  return [];
}

export function buildExecutionReceiptRequest(
  status: ReceiptAction,
  source: ReceiptSource,
  occurredAt: string,
  failureReason?: string,
): ReceiptRequest {
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('回执时间无效');
  if (status === 'FAILED' && !failureReason?.trim()) throw new Error('请填写失败说明');
  return {
    status,
    reportedSource: source,
    triggerReplan: false,
    ...(status === 'STARTED' ? { actualStartAt: occurredAt } : { actualEndAt: occurredAt }),
    ...(status === 'FAILED' ? { deviationType: 'MANUAL_OVERRIDE' as const, deviationReason: failureReason?.trim() } : {}),
  };
}

export async function submitExecutionReceipt(
  execution: SchedulingExecution,
  request: ReceiptRequest,
  roles: string[],
  current: boolean,
  send: (assignmentId: string, request: ExecutionUpdateRequest) => Promise<SchedulingExecution>,
): Promise<ReceiptExecution> {
  if (!roles.some((role) => RECEIPT_ROLES.includes(role))) throw new Error('当前角色没有提交执行回执的权限');
  if (!current) throw new Error('执行状态已过期，请先刷新');
  if (!receiptActions(execution).includes(request.status as ReceiptAction)) throw new Error('该执行状态不允许此回执');
  if (request.actualEndAt && execution.actualStartAt && Date.parse(request.actualEndAt) < Date.parse(execution.actualStartAt)) {
    throw new Error('结束时间早于已记录开始时间，请核对本机时钟');
  }
  return send(execution.assignmentId, request);
}

export function receiptSourceLabel(source: string | null | undefined): string {
  const labels: Record<string, string> = {
    manual_report: '人工报告，非设备实测',
    simulated: '模拟来源',
    real: '服务端标记真实来源，人工报告仍需核验',
    dispatch: '派工记录，尚无回执来源',
    unknown: '来源未核验',
  };
  return source ? labels[source] ?? `来源未核验（${source}）` : '来源未返回，待核验';
}
