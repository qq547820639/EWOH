/**
 * 任务能力要求编辑器（纯逻辑）。
 *
 * 为什么需要：能力要求决定任务能被哪些资源承接，而"没有候选"最常见的原因之一就是
 * 要求写错/写多。现场（调度员）必须能在**看到候选解释的同一个面板**里改要求，
 * 而不是去找接口或改库。
 *
 * 口径与后端完全一致（复用 `shared/capability-requirements` 的规范化）：
 * 形状非法在前端就显式报错；未登记/无法匹配的名称由后端在保存后返回 warnings。
 */
import {
  buildCapabilityRelaxationApprovalSubject,
  highRiskCapabilitiesBeingRelaxed,
  normalizeCapabilityList,
} from '@shared/capability-requirements';
import { isHighRiskCapability } from '@shared/device-capability';
import type { TaskCandidatesResponse } from '@shared/scheduler';

/** 编辑器输入 → 能力名列表（支持逗号/顿号/空白/换行分隔；去重保序）。 */
export function parseCapabilityInput(input: string): { names: string[]; errors: string[] } {
  const parts = String(input ?? '')
    .split(/[,，、\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const normalized = normalizeCapabilityList(parts, '能力要求');
  return { names: normalized.names, errors: normalized.errors };
}

/** 当前要求 → 编辑器初始文本（可读、可再编辑）。 */
export function formatCapabilityInput(names: readonly string[] | null | undefined): string {
  return (names ?? []).join('、');
}

/** 是否有任何能力要求（用于"未设置要求"的显式提示，而不是空白）。 */
export function hasCapabilityRequirements(
  candidates: Pick<
    TaskCandidatesResponse,
    'requiredDeviceCapabilities' | 'requiredStationCapabilities'
  > | null,
): boolean {
  const device = candidates?.requiredDeviceCapabilities ?? [];
  const station = candidates?.requiredStationCapabilities ?? [];
  return device.length > 0 || station.length > 0;
}

/** 能力要求摘要（面板头部展示；无要求时显式写"未设置"）。 */
export function describeCapabilityRequirements(
  candidates: Pick<
    TaskCandidatesResponse,
    'requiredDeviceCapabilities' | 'requiredStationCapabilities'
  > | null,
): string {
  const device = candidates?.requiredDeviceCapabilities ?? [];
  const station = candidates?.requiredStationCapabilities ?? [];
  if (device.length === 0 && station.length === 0) return '未设置能力要求（任意资源都可承接）';
  const parts: string[] = [];
  if (device.length > 0) parts.push(`设备：${device.join('、')}`);
  if (station.length > 0) parts.push(`工位：${station.join('、')}`);
  return parts.join(' · ');
}

/**
 * 反事实放宽建议的可读行（NO-17a）。
 *
 * 语义边界必须随文案一起展示：**仅建议**、不自动放宽、需现场确认可替代性、
 * 修改要求后需重新生成方案。建议里列出的能力是"那些设备实际具备的能力"，
 * 不是"等价能力"声明——现场据此判断，平台不替现场下结论。
 */
export function describeRelaxationSuggestions(
  candidates: Pick<TaskCandidatesResponse, 'capabilityRelaxationSuggestions'> | null,
): string[] {
  const suggestions = candidates?.capabilityRelaxationSuggestions ?? [];
  return suggestions.map((s) => {
    const caps = s.sampleDeviceCapabilities.length > 0
      ? `；这些设备具备：${s.sampleDeviceCapabilities.join('、')}`
      : '';
    // 组合建议必须写明"需同时放宽"（否则现场会以为放宽一项就够）
    const prefix = s.kind === 'combination' ? '需同时放宽' : '放宽';
    const label = s.label ?? s.capability;
    // 高风险放宽必须在**行首**就能看出需要安全确认（不能埋在长文案里）
    const riskPrefix = s.requiresSafetyReview
      ? '⚠ 高风险 · 需安全负责人确认：'
      : s.risk === 'medium'
        ? '中风险 · 建议与安全/工艺确认：'
        : s.risk === null
          ? '风险未知 · 需人工确认：'
          : '';
    return `${riskPrefix}${prefix}「${label}」可多出 ${s.addedEligibleCount} 个合格候选${caps}。${s.note}`;
  });
}

// ── NO-20a：高风险放宽的审批闸门（前端） ────────────────────────────────────

/**
 * 识别"需要审批"的失败（服务端 409 且带闸门标识）。
 *
 * 只做识别与文案提取，不做任何自动重试或自动放宽——改要求仍必须由人确认。
 */
export function isCapabilityRelaxationApprovalRequired(error: unknown): boolean {
  const message = errorText(error);
  return message.includes('HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL');
}

/** 提取服务端返回的可读原因（尽量拿到 message 字段而不是整段 JSON）。 */
export function errorText(error: unknown): string {
  const response = (error as { response?: { data?: unknown } })?.response?.data;
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const rec = response as Record<string, unknown>;
    const nested = (rec.error ?? rec) as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
    if (typeof rec.message === 'string') return rec.message;
  }
  return error instanceof Error ? error.message : String(error ?? '');
}

/** 本次保存会使哪些高风险能力被放宽（用于发起审批与提示）。 */
export function relaxedHighRiskForSave(
  candidates: Pick<TaskCandidatesResponse, 'requiredDeviceCapabilities'> | null,
  nextDeviceCapabilities: readonly string[],
): string[] {
  return highRiskCapabilitiesBeingRelaxed(
    candidates?.requiredDeviceCapabilities ?? [],
    nextDeviceCapabilities,
    isHighRiskCapability,
  );
}

/** 构造审批对象描述（与后端落地校验的指纹口径完全一致——同一 shared 实现）。 */
export function buildRelaxationApprovalSubject(params: {
  taskId: string;
  taskTitle?: string | null;
  relaxedHighRisk: readonly string[];
  nextDeviceCapabilities: readonly string[];
  nextStationCapabilities?: readonly string[];
}) {
  return buildCapabilityRelaxationApprovalSubject({
    taskId: params.taskId,
    taskTitle: params.taskTitle,
    relaxedHighRisk: params.relaxedHighRisk,
    resultingDeviceCapabilities: params.nextDeviceCapabilities,
    resultingStationCapabilities: params.nextStationCapabilities ?? [],
  });
}
