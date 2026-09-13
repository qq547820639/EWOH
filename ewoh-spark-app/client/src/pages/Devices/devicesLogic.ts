/**
 * devicesLogic.ts — Devices 数据页纯逻辑层（ADR-083，§17/§33）。
 *
 * 从 Devices.tsx 提取，不含 React/Query/DOM 依赖，node 测试成立。
 */
import type { DeviceCapabilityLifecycleInfo, DeviceInfo, DeviceSearchQuery } from '@shared/api.interface';
import {
  capabilityRiskLevel,
  type DeviceCapabilityRiskLevel,
} from '@shared/device-capability';
import {
  DEVICE_CATEGORIES,
  DEVICE_CATEGORY_LABELS,
  DEVICE_CATEGORY_UNKNOWN,
  normalizeDeviceCategory,
} from '@shared/device-category';

// ── 类型 ─────────────────────────────────────────────────────────────────

export type OnlineFilter = 'all' | 'online' | 'offline';
export type SourceFilter =
  | 'all'
  | 'real'
  | 'simulated'
  | 'controlled_test'
  | 'replayed'
  | 'stale'
  | 'offline';
export type OrderBy =
  | 'batteryDesc'
  | 'battery'
  | 'lastTelemetryAtDesc'
  | 'deviceId'
  | 'deviceIdDesc';

/** 设备类别过滤选项（'all' + 词表内类别 + 显式未知）。 */
export type CategoryFilter = 'all' | string;

export const CATEGORY_FILTER_OPTIONS: ReadonlyArray<{ value: CategoryFilter; label: string }> = [
  { value: 'all', label: '全部类别' },
  ...DEVICE_CATEGORIES.map((category) => ({
    value: category as CategoryFilter,
    label: DEVICE_CATEGORY_LABELS[category] ?? category,
  })),
  { value: DEVICE_CATEGORY_UNKNOWN, label: DEVICE_CATEGORY_LABELS[DEVICE_CATEGORY_UNKNOWN] },
];

/**
 * 类别展示名（未知/历史行 → "未知类别"，绝不猜一个相近类别）。
 * 服务端已把读取路径归一为词表或 'unknown'，这里再兜一层是为了兼容旧快照。
 */
export function formatDeviceCategory(value: unknown): string {
  const normalized = normalizeDeviceCategory(value);
  return DEVICE_CATEGORY_LABELS[normalized] ?? normalized;
}

/** 是否有电量语义：没有电池的设备（传感器/摄像头/定位标签）电量列是 NULL。 */
export function hasBatteryReading(batteryPct: number | null | undefined): boolean {
  return typeof batteryPct === 'number' && Number.isFinite(batteryPct);
}

/** 能力条目（与 DeviceInfo.capabilities 同形，便于单测）。 */
export interface DeviceCapabilityView {
  /** 能力名（权威契约 name）。 */
  name: string;
  /** 兼容字段：= name。 */
  key: string;
  /** 权威 kind：device_capability / exo_capability。 */
  kind: string;
  kindLabel: string;
  /** 观测 / 交互（权威契约无此维度，显式保留）。 */
  mode: string;
  modeLabel: string;
  label: string;
  status: string;
  fields: string[];
  grantedAt: string | null;
  registered: boolean;
  /** 未登记能力名的显式提示（不隐藏，也不猜含义）。 */
  note: string | null;
  /** 是否参与调度（只有 active 才计入 `capabilities`；停用保留台账但不派工）。 */
  effective: boolean;
  statusLabel: string;
  /** 人工停用/恢复留痕的可读摘要（没有人工操作过 = null，不冒充人工确认）。 */
  lifecycleNote: string | null;
  /** 该能力是否在词表内（词表外不允许恢复生效——与后端 fail-closed 同口径）。 */
  restorable: boolean;
  /** 已停用天数（仅停用且留痕时间有效时给出；用于"是否该复核"的提示）。 */
  disabledDays: number | null;
  /** 长期停用（超过复核阈值）→ UI 提示复核，避免设备被悄悄永久排除在派工之外。 */
  needsReview: boolean;
  /** NO-19a：安全相关等级（未登记能力名 → null，不假装低风险）。 */
  risk: DeviceCapabilityRiskLevel | null;
  /** 风险的可读标签（含"放宽需安全确认"的行动含义）。 */
  riskLabel: string;
}

/** 长期停用复核阈值（天）。超过则提示复核：停用是有意决定，但不应被遗忘。 */
export const DISABLED_REVIEW_THRESHOLD_DAYS = 7;

/** 权威 kind 的中文名（未登记 kind 原样展示）。 */
const CAPABILITY_KIND_LABELS: Readonly<Record<string, string>> = {
  device_capability: '设备能力',
  exo_capability: '外骨骼能力',
  station_capability: '工位能力',
  skill: '技能',
  certification: '资质',
};

const CAPABILITY_MODE_LABELS: Readonly<Record<string, string>> = {
  observation: '观测',
  execution: '执行',
  interaction: '交互',
};

/**
 * 能力清单视图（纯函数）。
 *
 * 关键：**停用/非 active 的能力不隐藏**，只是显式标出状态；词表外的能力键
 * 原样展示并标注"未登记能力键"——世界模型不能因为"不认识"就把事实丢掉。
 */
export function buildCapabilityViews(
  capabilities: DeviceInfo['capabilities'] | null | undefined,
  /** 计算"已停用天数"的参照时间（测试注入；生产默认当前时间）。 */
  nowMs: number = Date.now(),
): DeviceCapabilityView[] {
  if (!capabilities?.length) return [];
  return capabilities
    .map((capability) => ({
      name: capability.name ?? capability.key,
      key: capability.name ?? capability.key,
      kind: capability.kind,
      kindLabel: CAPABILITY_KIND_LABELS[capability.kind] ?? capability.kind,
      mode: capability.mode,
      modeLabel: CAPABILITY_MODE_LABELS[capability.mode] ?? capability.mode,
      label: capability.label || capability.name || capability.key,
      status: capability.status,
      fields: capability.fields ?? [],
      grantedAt: capability.grantedAt ?? null,
      registered: capability.registered,
      note: capability.registered
        ? capability.status === 'active'
          ? null
          : `能力状态：${capability.status}（台账保留，当前不计入可用能力）`
        : '未登记能力名（词表外，原样展示）',
      effective: capability.status === 'active',
      statusLabel: capability.status === 'active' ? '生效中' : capability.status === 'disabled' ? '已停用' : capability.status,
      lifecycleNote: formatCapabilityLifecycle(capability.lifecycle),
      disabledDays: disabledDaysFor(capability.status, capability.lifecycle, nowMs),
      risk: capabilityRiskLevel(capability.name ?? capability.key),
      riskLabel: formatCapabilityRisk(capabilityRiskLevel(capability.name ?? capability.key)),
      needsReview: disabledDaysFor(capability.status, capability.lifecycle, nowMs) !== null
        && (disabledDaysFor(capability.status, capability.lifecycle, nowMs) as number) >= DISABLED_REVIEW_THRESHOLD_DAYS,
      // 与后端恢复口径一致：词表外的能力名无法按权威契约校验 → 不允许恢复生效
      restorable: capability.registered,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 人工停用/恢复留痕 → 可读摘要（谁、何时、为什么）。
 *
 * 形状不完整的留痕返回 null：宁可不显示，也不半截渲染成"已人工确认"。
 */
export function formatCapabilityLifecycle(
  lifecycle: DeviceCapabilityLifecycleInfo | null | undefined,
): string | null {
  if (!lifecycle) return null;
  const action = lifecycle.action === 'disable' ? '停用' : lifecycle.action === 'restore' ? '恢复' : null;
  if (!action) return null;
  const operator = (lifecycle.operator ?? '').trim();
  const reason = (lifecycle.reason ?? '').trim();
  const at = (lifecycle.at ?? '').trim();
  if (!operator || !reason || !at) return null;
  const when = Number.isNaN(new Date(at).getTime())
    ? at
    : new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return `人工${action} · ${operator} · ${when} · 理由：${reason}`;
}

/**
 * 已停用天数（仅"停用中 + 留痕时间有效"时给出，否则 null）。
 *
 * 为什么需要：停用是有意的人工决定，但**不应被遗忘**——一台设备的某个能力长期停用
 * 会让它悄悄永久失去该类派工资格。UI 据此提示复核，而不是默默接受。
 */
export function disabledDaysFor(
  status: string | null | undefined,
  lifecycle: DeviceCapabilityLifecycleInfo | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (status !== 'disabled') return null;
  const at = (lifecycle?.at ?? '').trim();
  if (!at) return null;
  const startedMs = new Date(at).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const days = Math.floor((nowMs - startedMs) / 86_400_000);
  return days >= 0 ? days : null;
}

/** 能力状态操作按钮的可读文案与语义（纯函数，UI 与测试共用）。 */
export function capabilityActionLabel(view: Pick<DeviceCapabilityView, 'effective' | 'restorable'>): {
  action: 'disable' | 'restore';
  label: string;
  /** 不可操作时的原因（按钮禁用并说明为什么——不做"点了没反应"的按钮）。 */
  blockedReason: string | null;
} {
  if (view.effective) {
    return { action: 'disable', label: '停用', blockedReason: null };
  }
  if (!view.restorable) {
    return {
      action: 'restore',
      label: '恢复',
      blockedReason: '能力名不在词表内，无法按权威契约校验，后端会拒绝恢复；请先登记该能力名',
    };
  }
  return { action: 'restore', label: '恢复', blockedReason: null };
}

/**
 * 能力风险等级 → 可读标签（NO-19a）。
 *
 * 标签必须带上**行动含义**（"放宽需安全确认"），而不是只写"高"——否则现场不知道
 * 这个等级意味着什么（原则 5：建议要能指导行动）。
 */
export function formatCapabilityRisk(risk: DeviceCapabilityRiskLevel | null): string {
  switch (risk) {
    case 'high':
      return '高风险（放宽要求需安全负责人确认）';
    case 'medium':
      return '中风险（放宽前与安全/工艺确认）';
    case 'low':
      return '低风险';
    default:
      return '未登记风险等级（无法判断，需人工确认）';
  }
}

/**
 * NO-21b：恢复高风险能力 = 让设备重新获得高风险作业资格，属执行边界变更。
 *
 * 后端闸门（`HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL`）是唯一权威；
 * 这里的纯函数只负责**提前告知**与**渲染依据**，绝不代替后端放行判定。
 */
export const RESTORE_APPROVAL_REQUIRED_CODE = 'HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL';

/** 该能力的"恢复"动作是否需要安全管理员审批（高风险 + 当前处于可恢复状态）。 */
export function restoreRequiresSafetyApproval(
  view: Pick<DeviceCapabilityView, 'risk' | 'effective' | 'restorable'>,
): boolean {
  if (view.effective || !view.restorable) return false;
  return view.risk === 'high';
}

/**
 * 从错误对象里判定"是否撞上恢复审批闸门"。
 *
 * 兼容三种形态（axios 错误 / 已抽取 message 的字符串 / 后端错误体），
 * 只认后端返回的稳定码，不做"猜测式"识别——猜错会让现场以为可以绕过审批。
 */
export function isRestoreApprovalGateError(err: unknown): boolean {
  return errorTexts(err).some((text) => text.includes(RESTORE_APPROVAL_REQUIRED_CODE));
}

/** 后端稳定码（NO-22a）：授权已过期 / 已被本设备的这次恢复用掉。 */
export const APPROVAL_ALREADY_CONSUMED_CODE = 'APPROVAL_ALREADY_CONSUMED';

/**
 * 把"恢复被拒"翻译成现场能照做的下一步。
 *
 * 三类拒绝的处置动作不同，绝不能都显示成一句"操作失败"：
 *   · 无审批号 / 未通过 → 去发起或等待审批；
 *   · 审批过期（24 小时）→ 必须**重新申请**（旧审批不能续用）；
 *   · 审批已被本设备用掉 → 也要重新申请（上次那一次现场条件已结束）。
 */
export function describeRestoreRejection(err: unknown): {
  kind: 'approval_required' | 'approval_stale' | 'approval_consumed' | 'other';
  nextStep: string | null;
} {
  const texts = errorTexts(err);
  const joined = texts.join('\n');
  if (joined.includes('超出有效期') || joined.includes('缺少通过时间')) {
    return {
      kind: 'approval_stale',
      nextStep: '该审批已过有效期（24 小时）或缺少通过时间：请重新申请安全审批，不要沿用旧审批号。',
    };
  }
  if (joined.includes(APPROVAL_ALREADY_CONSUMED_CODE)) {
    return {
      kind: 'approval_consumed',
      nextStep: '该审批号已经用于本设备的这次恢复：若设备再次停用后需要恢复，请重新申请审批。',
    };
  }
  if (joined.includes(RESTORE_APPROVAL_REQUIRED_CODE)) {
    return {
      kind: 'approval_required',
      nextStep: '高风险能力恢复必须持已获批的审批号：请先申请安全审批，获批后在有效期内执行。',
    };
  }
  return { kind: 'other', nextStep: null };
}

/** 统一的错误文本抽取（axios 错误 / 字符串 / 后端错误体）。 */
function errorTexts(err: unknown): string[] {
  const candidates: string[] = [];
  if (typeof err === 'string') candidates.push(err);
  if (err && typeof err === 'object') {
    const anyErr = err as { message?: unknown; response?: { data?: unknown } };
    if (typeof anyErr.message === 'string') candidates.push(anyErr.message);
    const data = anyErr.response?.data as
      | { message?: unknown; error?: { message?: unknown; code?: unknown } }
      | undefined;
    if (typeof data?.message === 'string') candidates.push(data.message);
    if (typeof data?.error?.message === 'string') candidates.push(data.error.message);
    if (typeof data?.error?.code === 'string') candidates.push(data.error.code);
  }
  return candidates;
}

/**
 * NO-22a：审批时效文案（现场据此判断"还能不能用"）。
 *
 * 实现已收敛到 shared（任务侧放宽审批也用同一份文案，避免两处口径漂移）；
 * 这里保持原导出名，设备抽屉与既有测试不受影响。
 */
export { describeCapabilityApprovalFreshness as describeApprovalFreshness } from '@shared/capability-requirements';

/** 审批状态 → 可读进度（现场据此判断"还要等谁"，而不是反复点恢复）。 */
export function describeRestoreApprovalStatus(
  status: string | null | undefined,
  steps?: Array<{ role?: string | null; status?: string | null }> | null,
): { approved: boolean; label: string } {
  const roleLabels: Record<string, string> = {
    safety_admin: '安全管理员',
    workshop_lead: '班组长',
    global_admin: '全局管理员',
  };
  const pendingRoles = (steps ?? [])
    .filter((step) => (step?.status ?? 'pending') === 'pending')
    .map((step) => roleLabels[String(step?.role)] ?? String(step?.role ?? '未知角色'));
  switch (status) {
    case 'approved':
      return { approved: true, label: '审批已通过，可执行恢复' };
    case 'pending':
      return {
        approved: false,
        label:
          pendingRoles.length > 0
            ? `审批进行中，等待：${pendingRoles.join('、')}`
            : '审批进行中，等待审批人处理',
      };
    case 'rejected':
      return { approved: false, label: '审批已被驳回，恢复不可执行（需重新申请）' };
    case 'cancelled':
      return { approved: false, label: '审批已撤销，恢复不可执行' };
    default:
      return { approved: false, label: '审批状态未知（不得据此放行，请刷新审批状态）' };
  }
}

/** 设备是否有已登记空间位置（无 → UI 必须显示"位置未登记"，不显示空白）。 */
export function hasRegisteredLocation(entityId?: string | null, parentId?: string | null): boolean {
  return Boolean(entityId || parentId);
}

// ── 纯函数 ───────────────────────────────────────────────────────────────

// 注：原 batteryColor(pct)（返回三档电量 hex 色值）已删除（2026-09-01）——
// 全仓零生产调用（Devices.tsx 与 ResourcePoolPanel.tsx 均为本地定义服务于 Recharts
// 图表 fill，数据可视化色与 UI 语义色分属不同体系）。如需电量等级语义色，
// 使用 risk-normal / risk-degraded / risk-blocked 语义 Token。

/** 数据过期判定：超过 60s 未成功更新即视为过期。 */
export function isDataStale(dataUpdatedAt: number, staleMs = 60000): boolean {
  return dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > staleMs;
}

/** 从搜索参数构建 DeviceSearchQuery（过滤空值）。 */
export function buildDeviceSearchQuery(params: {
  keyword?: string;
  onlineFilter?: OnlineFilter;
  batteryMin?: string;
  batteryMax?: string;
  sourceFilter?: SourceFilter;
  categoryFilter?: CategoryFilter;
  orderby: OrderBy;
}): DeviceSearchQuery {
  const q: DeviceSearchQuery = { orderby: params.orderby };
  if (params.keyword?.trim()) q.keyword = params.keyword.trim();
  if (params.onlineFilter && params.onlineFilter !== 'all') {
    q.online = params.onlineFilter === 'online';
  }
  if (params.batteryMin !== undefined && params.batteryMin !== '') {
    q.batteryMin = Number(params.batteryMin);
  }
  if (params.batteryMax !== undefined && params.batteryMax !== '') {
    q.batteryMax = Number(params.batteryMax);
  }
  if (params.sourceFilter && params.sourceFilter !== 'all') {
    q.sourceType = params.sourceFilter;
  }
  if (params.categoryFilter && params.categoryFilter !== 'all') {
    q.category = params.categoryFilter;
  }
  return q;
}

/** 设备电量图表数据转换。 */
export function buildBatteryChartData(
  devices: DeviceInfo[],
): Array<{ name: string; battery: number; online: boolean }> {
  return devices.map((d) => ({
    name: d.deviceId,
    battery: d.batteryPct,
    online: d.online,
  }));
}

/** 空间实体名称查找表构建。 */
export function buildEntityNameMap(
  entities: Array<{ entityId: string; id: string; name: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) {
    m.set(e.entityId, e.name);
    m.set(e.id, e.name);
  }
  return m;
}

/** 数据源标签中文映射。 */
export const SOURCE_LABELS: Record<string, string> = {
  real: '真实',
  simulated: '仿真',
  controlled_test: '受控测试',
  replayed: '回放',
  stale: '过期',
  offline: '离线',
};
