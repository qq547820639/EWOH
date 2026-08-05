import type { RoleWorkbenchRole } from '../../api/operations';

/**
 * UX-001 角色任务驱动首页 —— 待处理事项优先级分诊。
 *
 * 供给 role-workbench 的「当前最需要处理的事项」排序/摘要逻辑：
 * 对某角色收到的一组事项，按 紧急 > 高 > 中 > 低 排序，同优先级内按截止时间升序，
 * 并补充面向用户的中文「优先级标签」与「是否已逾期」提示。
 *
 * 纯函数模块：不依赖 React / 网络，便于单测与复用。
 */

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

export interface TriageItem {
  id: string;
  title: string;
  /** 为什么需要优先处理（如「已逾期待办」「设备故障影响产能」）。 */
  reason: string;
  priority: PriorityLevel;
  /** ISO 截止时间，可选。 */
  deadline?: string;
  /** 影响面说明（产量/质量/交付…），可选。 */
  impact?: string;
  /** 当前负责人，可选。 */
  owner?: string;
  /** 建议的下一步动作，可选。 */
  nextStep?: string;
  /** 跨实体跳转实体类型，可选。 */
  entityType?: string;
  /** 跨实体跳转实体 id，可选。 */
  entityId?: string;
}

export interface TriageResult extends TriageItem {
  /** 中文优先级标签（紧急/高/中/低）。 */
  priorityLabel: string;
  /** 是否有明确截止时间且已逾期。 */
  hasDeadline: boolean;
  /** 是否已逾期（即便没有截止时间也是 false）。 */
  overdue: boolean;
}

const PRIORITY_ORDER: Record<PriorityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  critical: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

/** 返回优先级数值（越小越高），用于排序。 */
export function priorityOrder(priority: PriorityLevel): number {
  return PRIORITY_ORDER[priority];
}

/** 比较两个优先级：a 更高则为负。 */
export function comparePriority(a: PriorityLevel, b: PriorityLevel): number {
  return priorityOrder(a) - priorityOrder(b);
}

/** 中文优先级标签。 */
export function priorityLabel(priority: PriorityLevel): string {
  return PRIORITY_LABELS[priority];
}

/** 截止时间是否已逾期（无截止时间视为未逾期）。 */
export function isOverdue(deadline: string | undefined, now = Date.now()): boolean {
  if (!deadline) return false;
  const t = new Date(deadline).getTime();
  if (!Number.isFinite(t)) return false;
  return t < now;
}

/**
 * 对一组事项做优先级分诊排序并补充中文标签。
 * 排序规则：优先级降序（紧急在前），同优先级内按截止时间升序（越早越靠前）。
 */
export function triageRoleItems(
  _role: RoleWorkbenchRole,
  items: TriageItem[],
  now = Date.now(),
): TriageResult[] {
  return [...items]
    .sort((a, b) => {
      const byPriority = comparePriority(a.priority, b.priority);
      if (byPriority !== 0) return byPriority;
      const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
      const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
      return aDeadline - bDeadline;
    })
    .map((item) => ({
      ...item,
      priorityLabel: priorityLabel(item.priority),
      hasDeadline: typeof item.deadline === 'string' && item.deadline.length > 0,
      overdue: isOverdue(item.deadline, now),
    }));
}

/** 常见优先级字段名（用于从通用表格行中识别「优先级」列）。 */
const PRIORITY_KEYS = ['priority', 'urgency', 'level', 'severity'];

/**
 * 人事/任务摘要（spec item 11）：把「为什么现在处理、截止时间、影响、
 * 责任人、推荐下一步」收敛为一段面向一线用户的纯文本，可在列表行 / 详情
 * 中统一展示。纯函数，便于单测与复用。
 */
export interface ItemSummary {
  /** 为什么现在处理（原因 + 逾期提示）。 */
  reason: string;
  /** 截止时间（无则填空）。 */
  deadline: string;
  /** 影响面。 */
  impact: string;
  /** 责任人。 */
  owner: string;
  /** 推荐的下一步动作。 */
  nextStep: string;
}

export function summarizeItem(
  item: TriageResult,
  now = Date.now(),
): ItemSummary {
  const overdue = isOverdue(item.deadline, now);
  const reason = [
    item.reason,
    overdue && item.deadline ? '（已逾期）' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    reason: reason || '待处理事项',
    deadline: item.deadline
      ? new Date(item.deadline).toLocaleString('zh-CN', { hour12: false })
      : '',
    impact: item.impact ?? '',
    owner: item.owner ?? '',
    nextStep: item.nextStep ?? '',
  };
}

/** 在列定义中查找优先级列；找不到返回 null。 */
export function priorityColumnKey(
  columns: Array<{ key: string }>,
): string | null {
  return columns.find((column) => PRIORITY_KEYS.includes(column.key.toLowerCase()))?.key ?? null;
}

/**
 * 通用表格行按优先级排序（用于「待处理事项优先」的默认排序）。
 * 若存在优先级列则以优先级数值排序；无优先级列则原样返回。
 */
export function prioritySortRows(
  rows: Array<Record<string, unknown>>,
  columns: Array<{ key: string }>,
): Array<Record<string, unknown>> {
  const key = priorityColumnKey(columns);
  if (!key) return rows;
  const copy = [...rows];
  const order = (value: unknown): number => {
    const text = String(value ?? '').toLowerCase();
    return text in PRIORITY_ORDER
      ? PRIORITY_ORDER[text as PriorityLevel]
      : Number.POSITIVE_INFINITY;
  };
  copy.sort((a, b) => order(a[key]) - order(b[key]));
  return copy;
}