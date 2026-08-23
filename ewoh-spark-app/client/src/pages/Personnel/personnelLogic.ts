/**
 * personnelLogic.ts — Personnel 数据页纯逻辑层（ADR-085，§17/§33）。
 *
 * 从 Personnel.tsx 提取，不含 React/Query/DOM 依赖，node 测试成立。
 */

// ── 类型 ─────────────────────────────────────────────────────────────────

export interface PersonnelNode {
  id: string;
  name: string;
  employeeNo?: string | null;
  status?: string;
  riskLevel?: string | null;
  orgId?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface DeviceNode {
  deviceId: string;
  boundPersonId?: string | null;
  online?: boolean;
  batteryPct?: number;
  model?: string | null;
}

export interface OrgOption {
  id: string;
  name: string;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

export const RISK_LABEL: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

export const PERSONNEL_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'available', label: '在岗可调配' },
  { value: 'busy', label: '任务中' },
  { value: 'high_load', label: '高负荷' },
];

export const PERSONNEL_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  PERSONNEL_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 风险等级中文标签（未知回退原始值）。 */
export function riskLevelLabel(level: string | null | undefined): string {
  if (!level) return '—';
  return RISK_LABEL[level] ?? level;
}

/** 人员状态中文标签（未知回退原始值）。 */
export function personStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return PERSONNEL_STATUS_LABEL[status] ?? status;
}

/** personId → 当前绑定设备查找表（一人一设备：boundPersonId 反查）。 */
export function buildDeviceByPersonMap(
  devices: DeviceNode[],
): Map<string, DeviceNode> {
  const m = new Map<string, DeviceNode>();
  for (const d of devices) {
    if (d.boundPersonId) m.set(d.boundPersonId, d);
  }
  return m;
}

/** 创建人员表单提交前置校验。 */
export function canSubmitPersonnel(
  name: string,
  isPending: boolean,
): boolean {
  return name.trim().length > 0 && !isPending;
}

/** 绑定/解绑操作消息构建。 */
export function buildBindMessage(
  personName: string,
  deviceId: string | null,
): string {
  return deviceId
    ? `已为 ${personName} 绑定外骨骼 ${deviceId}`
    : `已解绑 ${personName} 的外骨骼`;
}
