// panels/intelligence-layers-logic.ts — 指挥地图"冲突层"聚合纯逻辑（可测试、无渲染依赖）
//
// 为什么抽出来（2026-09-11）：原先聚合写在 `IntelligenceLayers.tsx` 组件里，且直接拼
// 后端码（`违反约束 · UNASSIGNED_RULE_BASED：no_eligible_candidate`），并且**完全忽略**
// 求解器给的 `rejectReasons`——现场只看到英文码，看不到"为什么没有候选资源"。
//
// 本模块把三件事做成可测纯函数：
//   1. 违反项 → 可读文案（类型/原因都走唯一词表 `shared/reject-reason.ts`）；
//   2. 未派工任务的候选拒绝原因 → **按原因聚合计数**（"3 台设备电量未知"比 12 条
//      重复英文码有用得多）；
//   3. 分配失败/阻断 + 决策轨迹被排除候选 → 事实条目（不推导因果）。

import type { SchedulingPlanV2 } from '@shared/scheduler';
import { rejectReasonLabel } from '@shared/reject-reason';

export type PlanIssueSeverity = 'error' | 'warn' | 'info';

export interface PlanIssueItem {
  severity: PlanIssueSeverity;
  /** 面向现场的完整句子（已本地化；未知码显式标注"未登记原因"）。 */
  text: string;
}

/** 候选拒绝原因聚合：原因 → 次数（按次数降序，同次数按原因码稳定排序）。 */
export function aggregateRejectReasons(
  reasons: readonly string[],
): Array<{ reason: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of reasons) {
    const key = String(raw ?? '').trim();
    if (key.length === 0) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, label: rejectReasonLabel(reason), count }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
}

/** 聚合结果的单行文案：`电量未知（未上报，不派工）×3、缺少设备能力×1`。 */
export function formatRejectReasonCounts(reasons: readonly string[]): string {
  return aggregateRejectReasons(reasons)
    .map((item) => (item.count > 1 ? `${item.label}×${item.count}` : item.label))
    .join('、');
}

/** 任务短标识（后端 taskId 可能很长，展示取尾部可辨识片段）。 */
function shortTaskRef(taskId: unknown): string {
  const id = String(taskId ?? '').trim();
  if (id.length === 0) return '';
  return id.length > 12 ? `…${id.slice(-12)}` : id;
}

/**
 * 方案问题清单（冲突层数据源）。
 *
 * 顺序 = 严重度优先，且**同类内保持后端顺序**（不重排、不推导因果）：
 *   1. violations（求解器明确上报的违反项，含未派工任务的候选拒绝原因聚合）；
 *   2. assignments 里 blocked/failed 的分配；
 *   3. decisionTrace.rejectedAlternatives（被排除的候选及其原因）。
 */
export function buildPlanIssueItems(plan: SchedulingPlanV2): PlanIssueItem[] {
  const items: PlanIssueItem[] = [];

  for (const violation of plan.violations ?? []) {
    const rec = violation as Record<string, unknown>;
    const typeCode = String(rec.kind ?? rec.type ?? 'violation');
    const reasonCode = String(rec.detail ?? rec.reason ?? rec.message ?? '').trim();
    const taskRef = shortTaskRef(rec.taskId);
    // 拒绝原因：优先平铺 `rejectReasons`；历史方案（早期启发式求解器）只有嵌套
    // `alternatives[].reasons`，此处回退展开——旧数据同样要能讲清原因，不因升级失读。
    const flatReasons = Array.isArray(rec.rejectReasons)
      ? (rec.rejectReasons as unknown[]).map((r) => String(r))
      : [];
    const legacyReasons = Array.isArray(rec.alternatives)
      ? (rec.alternatives as Array<Record<string, unknown>>).flatMap((alt) =>
          Array.isArray(alt?.reasons) ? (alt.reasons as unknown[]).map((r) => String(r)) : [],
        )
      : [];
    const rejectReasons = flatReasons.length > 0 ? flatReasons : legacyReasons;
    // NO-15c：能力细节（哪个能力、谁/何时/为何停用）——后端聚合好的可读句子，原样透传
    const capabilityNotes = Array.isArray(rec.capabilityNotes)
      ? (rec.capabilityNotes as unknown[]).map((n) => String(n)).filter((n) => n.trim().length > 0)
      : [];

    const parts = [rejectReasonLabel(typeCode)];
    if (reasonCode.length > 0 && reasonCode !== typeCode) parts.push(rejectReasonLabel(reasonCode));
    if (taskRef) parts.push(`任务 ${taskRef}`);
    let text = parts.join(' · ');
    const details: string[] = [];
    if (rejectReasons.length > 0) {
      // 候选拒绝原因是本层最有用的信息：直接回答"为什么没有可用资源"。
      details.push(`候选拒绝：${formatRejectReasonCounts(rejectReasons)}`);
    }
    if (capabilityNotes.length > 0) {
      // 能力停用细节（含"谁在何时因何停用"）：现场据此决定复核停用还是换设备
      details.push(`能力：${capabilityNotes.join('；')}`);
    }
    if (details.length > 0) text += `（${details.join(' | ')}）`;
    items.push({ severity: 'error', text });
  }

  for (const assignment of plan.assignments) {
    if (assignment.status !== 'blocked' && assignment.status !== 'failed') continue;
    const statusLabel = assignment.status === 'blocked' ? '被阻断' : '失败';
    const reason = assignment.reasons?.[0];
    const reasonText =
      reason && String(reason).trim().length > 0 ? `：${rejectReasonLabel(String(reason))}` : '';
    items.push({
      severity: 'error',
      text: `任务 ${shortTaskRef(assignment.taskId) || assignment.taskId} 分配${statusLabel}${reasonText}`,
    });
  }

  for (const assignment of plan.assignments) {
    for (const rejected of assignment.decisionTrace?.rejectedAlternatives ?? []) {
      const reasons = (Array.isArray(rejected.reason) ? rejected.reason : [])
        .map((r) => String(r))
        .filter((r) => r.trim().length > 0);
      if (reasons.length === 0) continue;
      const who = rejected.personId ?? rejected.deviceId ?? '候选资源';
      const labels = reasons.map((r) => rejectReasonLabel(r)).join('；');
      items.push({ severity: 'info', text: `候选 ${who} 被排除：${labels}` });
    }
  }

  return items;
}

/**
 * 是否含未登记码（UI 据此提示"存在未登记原因"，便于运维把新码补进词表）。
 * 未登记的自由文本不会带标记——它本身就是给人读的说明，不算缺口。
 */
export function hasUnregisteredCode(items: readonly PlanIssueItem[]): boolean {
  return items.some((item) => item.text.includes('未登记原因'));
}
