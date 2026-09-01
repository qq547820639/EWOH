import {
  alertActionToState,
  alertStateTransitionAllowed,
} from '@shared/alert-state-machine';
import { CircleAlert, CircleCheck, CircleHelp, Siren, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 告警动作派生（修复"按钮可点、点击必 400"的角色盲区）。
 *
 * ## 背景
 *
 * 后端告警状态机是**角色感知 + fail-closed** 的
 * （`shared/alert-state-machine.ts`，ADR-031 单一事实源）：
 *
 * | 转移 | 允许角色 |
 * |------|---------|
 * | `open → acknowledged` | `dispatcher` |
 * | `acknowledged → processing` | `workshop_lead` |
 * | `processing → closed` | `device_ops` |
 * | `closed → reopened` | 仅 `safety_admin` |
 * | `reopened → acknowledged / processing` | `handler`（= dispatcher / workshop_lead / device_ops） |
 * | 任何转移 | 无角色 → **拒绝** |
 *
 * 而原 `Alerts.tsx` 的 `actionFor(status)` **只按状态返回动作，不看角色**，
 * 于是出现：用户看得到按钮、点了被后端 400 拒绝。
 *
 * ## 修复原则
 *
 * **不在前端硬编码角色矩阵**，判定一律委托给 `@shared/alert-state-machine`
 * ——那正是后端正在执行的同一套规则，因此不会漂移。
 *
 * 本模块同时修正了原实现的第二个缺陷：`reopened` 状态有两个合法转移
 * （确认 / 处置），而 `actionFor` 只能返回其中一个。
 */

export interface AlertAction {
  action: string;
  label: string;
}

/** 动作中文标签，与 `alertActionToState` 的语义一一对应。 */
const ACTION_LABELS: Record<string, string> = {
  acknowledge: '确认',
  process: '处置',
  close: '关闭',
  reopen: '重开',
};

/**
 * 全局管理员角色。
 *
 * 注意语义差异：状态机层对 `global_admin` 判定为**不允许**
 * （见 `shared/alert-state-machine.spec.ts:30`），
 * 放行发生在服务层 `alert.service.ts:54-56` 的 `actor.isGlobalAdmin` 短路。
 * 前端 `AuthUser` 没有 `isGlobalAdmin` 标志，只能以 roles 数组近似。
 */
const GLOBAL_ADMIN_ROLE = 'global_admin';

/** 单个转移是否对给定角色集合开放。 */
export function isAlertActionAllowed(
  from: string,
  to: string,
  roles: string[] | null | undefined,
): boolean {
  // 对齐服务层 alert.service.ts:54-56 的 global_admin 短路放行。
  if (roles?.includes(GLOBAL_ADMIN_ROLE)) return true;
  // SH-004 fail-closed：无角色信息一律拒绝，不缺省放行。
  if (!roles || roles.length === 0) return false;
  // 与后端 alert.service.ts:57-62 同语义：遍历角色，任一满足即允许。
  return roles.some((role) => alertStateTransitionAllowed(from, to, role));
}

/**
 * 按「当前状态 × 用户角色」返回可执行的告警动作列表。
 *
 * @param status 告警当前状态；`null` 视为 `open`（与后端默认值一致）
 * @param roles  当前用户角色；`null`/空数组 → 返回空列表（fail-closed）
 */
export function availableAlertActions(
  status: string | null,
  roles: string[] | null | undefined,
): AlertAction[] {
  const current = status ?? 'open';
  const actions: AlertAction[] = [];
  for (const action of Object.keys(ACTION_LABELS)) {
    const target = alertActionToState(action);
    if (!target) continue;
    if (isAlertActionAllowed(current, target.to, roles)) {
      actions.push({ action, label: ACTION_LABELS[action] });
    }
  }
  return actions;
}

/**
 * 严重度徽章映射（J2 设计规格补充 §1：防御性五档 + 兜底）。
 *
 * 取值域服务端未声明枚举，故未知值自动落兜底档，不抛错、不白标。
 * `critical` 与 `high` 共用同一 token（色彩通道已饱和于 blocked 级），
 * **靠图标区分等级**（Siren vs TriangleAlert）——不依赖颜色单通道（横切 X-4）。
 */
export interface SeverityBadge {
  label: string;
  className: string;
  Icon: LucideIcon;
}

export function severityBadge(severity: string | null | undefined): SeverityBadge {
  switch (severity) {
    case 'critical':
      return {
        label: '严重',
        className:
          'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground',
        Icon: Siren,
      };
    case 'high':
      return {
        label: '高',
        className:
          'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground',
        Icon: TriangleAlert,
      };
    case 'medium':
      return {
        label: '中',
        className:
          'border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground',
        Icon: CircleAlert,
      };
    case 'low':
      return {
        label: '低',
        className:
          'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground',
        Icon: CircleCheck,
      };
    default:
      return {
        label: '未知',
        className:
          'border-risk-unknown-border bg-risk-unknown-soft text-risk-unknown-foreground',
        Icon: CircleHelp,
      };
  }
}

/**
 * 告警流程环节（J2 PRD §5.2，JourneyRail 派生；与 planJourney 同构）。
 *
 * 环节由 `status` **派生**，不引入新持久状态——流程带永远是真实状态的投影。
 * 状态机：open → acknowledged → processing → closed ⇄ reopened（reopened 回到确认环节）。
 */
export interface AlertJourneyStep {
  key: string;
  label: string;
  state: 'done' | 'current' | 'todo';
  route?: string;
}

export function alertJourney(status: string | null, eventId: string): AlertJourneyStep[] {
  const current = status ?? 'open';
  const workbenchRoute = `/o/alert/${encodeURIComponent(eventId)}`;
  const done = (label: string, key: string): AlertJourneyStep => ({
    key,
    label,
    state: 'done',
    route: workbenchRoute,
  });
  const todo = (label: string, key: string): AlertJourneyStep => ({ key, label, state: 'todo' });

  const confirmStep =
    current === 'open' || current === 'reopened'
      ? { key: 'confirm', label: '确认', state: 'current' as const, route: workbenchRoute }
      : done('确认', 'confirm');
  const processStep =
    current === 'acknowledged'
      ? { key: 'process', label: '处置', state: 'current' as const, route: workbenchRoute }
      : current === 'processing' || current === 'closed'
        ? done('处置', 'process')
        : todo('处置', 'process');
  const closeStep =
    current === 'processing'
      ? { key: 'close', label: '关闭', state: 'current' as const, route: workbenchRoute }
      : current === 'closed'
        ? done('关闭', 'close')
        : todo('关闭', 'close');

  return [
    done('发现', 'detect'),
    confirmStep,
    processStep,
    closeStep,
  ];
}
