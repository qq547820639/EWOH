import type { SchedulingPlanV2 } from '@shared/api.interface';

/**
 * AI 方案解读的呈现状态（OD-6）。
 *
 * ⚠️ 实现裁决：采用**派生**而非后端新增字段。
 *
 * 背景：`shared/scheduler.ts:1192-1194` 只有 `aiNarration` 与 `narrationSource`，
 * 没有生成状态字段；narrator 是 fire-and-forget（`scheduling-narrator.service.ts:9`），
 * 仅在完成后 `persist()`（`:153`），无中间态。因此前端拿到 `aiNarration === null` 时
 * 无法区分「生成中 / 失败 / 未启用」——`Scheduling.tsx:184` 此前只能整块不渲染，
 * 用户看到的是永久空白。
 *
 * 为什么不新增 `narrationStatus` 落库字段：
 *   - 需要改 shared 契约 + plan 落库 + narrator 三处状态流转，且要处理存量行默认值；
 *   - 状态一旦落库就与主流程产生同步问题（失败重试、方案重算时的状态重置）。
 * 派生方案零后端依赖、无状态同步风险，且已能覆盖真实体验缺口。
 * 若后续需要精确的「生成失败」原因，再升级为落库字段（不阻塞本次交付）。
 */

export type NarrationStatus = 'pending' | 'done' | 'unavailable';

/**
 * 生成中判定窗口。narrator 实测 30–90s（含 LLM 调用与规则兜底），
 * 取 3 分钟为上限：既不会过早把「慢」误判为「不可用」，
 * 也不会让用户在明确失败后长时间面对转圈。
 */
export const NARRATION_PENDING_WINDOW_MS = 3 * 60_000;

/** 由方案快照派生 AI 解读状态；`nowMs` 由调用方注入以保证可测试、可确定性重放。 */
export function deriveNarrationStatus(
  plan: Pick<SchedulingPlanV2, 'aiNarration' | 'createdAt'> | null | undefined,
  nowMs: number,
): NarrationStatus {
  if (!plan) return 'unavailable';
  if (typeof plan.aiNarration === 'string' && plan.aiNarration.trim().length > 0) {
    return 'done';
  }
  const created = Date.parse(plan.createdAt);
  if (Number.isFinite(created) && nowMs - created < NARRATION_PENDING_WINDOW_MS) {
    return 'pending';
  }
  return 'unavailable';
}
