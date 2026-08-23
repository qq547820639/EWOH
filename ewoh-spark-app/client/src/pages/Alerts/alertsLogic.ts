/**
 * alertsLogic.ts — Alerts 数据页纯逻辑层（ADR-086，§17/§33）。
 *
 * 从 Alerts.tsx 提取，不含 React/Query/DOM 依赖，node 测试成立。
 */

// ── 常量 ─────────────────────────────────────────────────────────────────

export const ALERT_STATUS_LABEL: Record<string, string> = {
  open: '待确认',
  acknowledged: '已确认',
  processing: '处置中',
  closed: '已关闭',
  reopened: '已重开',
};

/** 告警状态枚举（封闭注册表）。 */
export const ALERT_STATUSES = ['open', 'acknowledged', 'processing', 'closed', 'reopened'] as const;

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 告警状态中文标签（未知回退原始值）。 */
export function alertStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return ALERT_STATUS_LABEL[status] ?? status;
}

/** 根据当前状态计算下一步操作（标签 + 动作名）。 */
export function nextAlertAction(status: string | null | undefined): { label: string; action: string } {
  switch (status) {
    case 'open':
      return { label: '确认', action: 'acknowledge' };
    case 'acknowledged':
      return { label: '处置', action: 'process' };
    case 'processing':
      return { label: '关闭', action: 'close' };
    case 'closed':
      return { label: '重开', action: 'reopen' };
    default:
      return { label: '确认', action: 'acknowledge' };
  }
}

/** 告警是否处于活跃状态（需要关注）。 */
export function isAlertActive(status: string | null | undefined): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'processing' || status === 'reopened';
}
