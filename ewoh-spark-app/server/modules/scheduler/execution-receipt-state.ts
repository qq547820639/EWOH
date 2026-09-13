import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ExecutionUpdateRequest, SchedulingExecution } from '@shared/api.interface';

const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const allowed: Record<string, string[]> = {
  PLANNED: ['PLANNED', 'DISPATCHED', 'STARTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['DISPATCHED', 'STARTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  STARTED: ['STARTED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PAUSED: ['PAUSED', 'STARTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['COMPLETED'], FAILED: ['FAILED'], CANCELLED: ['CANCELLED'],
};

/**
 * 已记录事实的字段中文名（用于**可执行**的错误说明）。
 *
 * 为什么需要：原错误体只有 `IMMUTABLE_EXECUTION_FACT:deviationReason` 这样的
 * 机器码。现场人员看到的是一句无法处理的英文标识，不知道自己踩了什么规则、
 * 下一步该做什么。事实不可改写是**有意设计**（见下方说明），所以这里不是
 * 放宽校验，而是把"为什么拒绝 + 怎么办"讲清楚。
 */
const FIELD_LABELS: Record<string, string> = {
  actualStartAt: '实际开始时间',
  actualEndAt: '实际结束时间',
  actualTravelMs: '实际行走耗时',
  actualWaitingMs: '实际等待耗时',
  actualDistanceM: '实际行走距离',
  deviationType: '偏差类型',
  deviationReason: '偏差原因',
};

/**
 * 为什么时间/度量不可改写：它们是物理事实，也是偏差计算与时长模型训练的
 * 输入；允许覆盖等于允许事后美化数据。
 *
 * 为什么偏差原因同样不可改写：`deviationType`/`deviationReason` 在未显式提供时
 * 由服务端按计划/实际时间**推导**（见 ExecutionService.update 的 deriveDeviation）。
 * 若允许客户端覆写，任何人都能把系统推导的偏差结论替换成自由文本，偏差统计
 * 与学习样本随之失真。
 *
 * 纠正路径：终态记录不再接受修改；需要更正时应由具备权限的角色发起新的
 * 执行/工单流程，而不是改写既有事实。
 */
function immutableFact(field: string, current: unknown, attempted: unknown): ConflictException {
  const label = FIELD_LABELS[field] ?? field;
  return new ConflictException(
    `IMMUTABLE_EXECUTION_FACT:${field}：${label}已记录为 ${JSON.stringify(current)}，`
      + `不能改写为 ${JSON.stringify(attempted)}。`
      + '执行事实与偏差结论一经记录即不可覆盖（偏差原因在未提供时由服务端按计划/实际时间推导）。'
      + '如需更正，请由具备权限的角色发起新的执行记录或工单，而不是修改既有事实。',
  );
}

/** Validate before any write. Omitted/null facts are preserved, recorded facts cannot be rewritten. */
export function executionReceiptPatch(current: SchedulingExecution, body: ExecutionUpdateRequest): Record<string, unknown> {
  const target = body.status ?? (body.actualEndAt != null ? 'COMPLETED' : body.actualStartAt != null ? 'STARTED' : current.status);
  if (!allowed[target]) throw new BadRequestException('INVALID_EXECUTION_STATUS');
  if (!allowed[current.status]?.includes(target)) {
    throw new ConflictException(
      `ILLEGAL_EXECUTION_TRANSITION: ${current.status} -> ${target}。`
        + (terminal.has(current.status)
          ? '该执行记录已进入终态，只能查看；如需继续作业请新建执行记录。'
          : `当前状态只允许转向 ${allowed[current.status].join(' / ')}。`),
    );
  }
  const patch: Record<string, unknown> = {};
  if (target !== current.status) patch.status = target;
  for (const field of ['actualStartAt', 'actualEndAt'] as const) {
    const value = body[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) throw new BadRequestException(`INVALID_RECEIPT_TIME:${field}`);
    const date = new Date(value);
    if (current[field] && Date.parse(current[field]) !== date.getTime()) throw immutableFact(field, current[field], value);
    if (!current[field]) patch[field] = date;
  }
  for (const field of ['actualTravelMs', 'actualWaitingMs', 'actualDistanceM'] as const) {
    const value = body[field];
    if (value == null) continue;
    if (!Number.isFinite(value) || value < 0 || (field !== 'actualDistanceM' && !Number.isSafeInteger(value))) throw new BadRequestException(`INVALID_RECEIPT_METRIC:${field}`);
    if (current[field] != null && current[field] !== value) throw immutableFact(field, current[field], value);
    if (current[field] == null) patch[field] = value;
  }
  for (const field of ['deviationType', 'deviationReason'] as const) {
    const value = body[field];
    if (value == null || value === current[field]) continue;
    if (typeof value !== 'string' || value.length > 4000) throw new BadRequestException(`INVALID_RECEIPT_FIELD:${field}`);
    if (current[field] != null) throw immutableFact(field, current[field], value);
    patch[field] = value;
  }
  if (terminal.has(current.status) && Object.keys(patch).length) {
    throw new ConflictException(
      `TERMINAL_RECEIPT_IMMUTABLE: 执行记录已是终态 ${current.status}，不接受新的回执字段。`
        + '终态记录只读；如需继续作业请新建执行记录。',
    );
  }
  const start = body.actualStartAt ?? current.actualStartAt;
  const end = body.actualEndAt ?? current.actualEndAt;
  if (['STARTED', 'PAUSED', 'COMPLETED'].includes(target) && !start) throw new BadRequestException('RECEIPT_START_REQUIRED: 报告开始/暂停/完成必须先有实际开始时间');
  if (target === 'COMPLETED' && !end) throw new BadRequestException('RECEIPT_END_REQUIRED: 报告完成必须提供实际结束时间');
  if (end && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(target)) throw new BadRequestException('END_REQUIRES_TERMINAL_RECEIPT: 只有完成/失败/取消回执才能带结束时间');
  if (start && end && Date.parse(end) < Date.parse(start)) throw new BadRequestException('RECEIPT_END_BEFORE_START: 结束时间早于开始时间，请核对现场时钟');
  return patch;
}
