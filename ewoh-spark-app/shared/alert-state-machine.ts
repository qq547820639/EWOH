/* 前后端共享契约 - Alert/Andon 处置状态机（ADR-031 / §6 Andon Loop）。
 *
 * 权威契约：contracts/state-machines/alert.yaml（单一事实源）。
 * 本文件为锁定转换表，由 scripts/audit-domain-contracts.js
 * alert_state_machine_ts_vs_yaml 门禁强制与 YAML 逐条一致
 * （agent-task 同纪律）。alert 与 andon 复用同一状态机（ADR-031 决策 1）。
 */

export const ALERT_STATES = ['open', 'acknowledged', 'processing', 'closed', 'reopened'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

/** 转移表（from → {to, roles}）：与 alert.yaml transitions 逐条一致。 */
export const ALERT_TRANSITIONS: Readonly<Record<string, Array<{ to: AlertState; roles: readonly string[] }>>> = {
  open: [
    { to: 'acknowledged', roles: ['handler'] },
  ],
  acknowledged: [
    { to: 'processing', roles: ['handler'] },
  ],
  processing: [
    { to: 'closed', roles: ['handler'] },
  ],
  closed: [
    { to: 'reopened', roles: ['safety_admin'] },
  ],
  reopened: [
    { to: 'acknowledged', roles: ['handler'] },
    { to: 'processing', roles: ['handler'] },
  ],
};

const HANDLER_ROLES: ReadonlySet<string> = new Set([
  'dispatcher', 'workshop_lead', 'device_ops',
]);

function roleSatisfies(required: string, actorRole: string | undefined): boolean {
  if (required === 'handler') {
    return actorRole == null || HANDLER_ROLES.has(actorRole);
  }
  return actorRole === required;
}

/**
 * 状态转移判定（角色条件机器执行，ADR-031 决策 3）：
 * - reopen 仅 safety_admin；
 * - handler 条件映射 dispatcher/workshop_lead/device_ops（缺省放行——
 *   与既有 authenticated 处置语义兼容）；
 * - 非法转移返回 null。
 */
export function alertStateTransitionAllowed(
  from: string,
  to: string,
  actorRole?: string,
): boolean {
  const candidates = (ALERT_TRANSITIONS as Record<string, Array<{ to: string; roles: readonly string[] }>>)[from];
  if (!candidates) return false;
  const match = candidates.find((t) => t.to === to);
  if (!match) return false;
  return match.roles.every((role) => roleSatisfies(role, actorRole));
}

/** 按 action 语义映射（alert.service / oee.service 统一复用，消除双份 switch）。 */
export function alertActionToState(action: string): { to: AlertState } | null {
  switch (action) {
    case 'acknowledge':
      return { to: 'acknowledged' };
    case 'process':
      return { to: 'processing' };
    case 'close':
      return { to: 'closed' };
    case 'reopen':
      return { to: 'reopened' };
    default:
      return null;
  }
}
