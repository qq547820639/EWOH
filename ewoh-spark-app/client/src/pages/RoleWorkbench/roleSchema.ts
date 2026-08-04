import type { RoleWorkbenchRole } from '../../api/operations';

/**
 * UX-001 角色工作台 Schema 定义。
 * 将后端 role-workbench 返回的原始字段名/JSON 映射为产品化的中文业务视图。
 */

export type ValueFormat = 'number' | 'percent' | 'time' | 'duration';

/** 语义链接：跳转到已存在的路由（如 /alerts、/devices…）。 */
export interface ColumnLink {
  to: string;
  /** 若提供，则将取该字段的值作为链接末尾路径段；否则链接到静态 `to`。 */
  valueKey?: string;
}

export interface ColumnDefinition {
  key: string;
  label: string;
  format?: ValueFormat;
  /** 原始枚举值 → 中文标签（如 pending → 待处理）。 */
  enumMap?: Record<string, string>;
  link?: ColumnLink;
}

export interface KpiDefinition {
  key: string;
  label: string;
  unit?: string;
  format?: ValueFormat;
  /** 中文数据来源说明。 */
  source: string;
  /** 更新频率说明。 */
  refreshHint: string;
}

export interface ListDefinition {
  key: string;
  label: string;
  columns: ColumnDefinition[];
  emptyText: string;
  /** 对原始数据做映射（如将对象转成行）；缺省时按数组处理。 */
  transform?: (raw: unknown) => Array<Record<string, unknown>>;
  /** 行点击下钻的静态路径（跳转到已存在路由）。 */
  rowTo?: string;
}

export interface QuickAction {
  label: string;
  to: string;
}

export interface RoleSchema {
  key: RoleWorkbenchRole;
  label: string;
  description: string;
  kpis: KpiDefinition[];
  lists: ListDefinition[];
  quickActions: QuickAction[];
}

/** 通用状态枚举映射。 */
const STEP_STATUS: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  released: '已下发',
};

const DEVICE_STATUS: Record<string, string> = {
  running: '运行中',
  idle: '空闲',
  fault: '故障',
  offline: '离线',
  unknown: '未知',
};

/** object → 行 的转换器（用于设备状态分布等）。 */
function objectToRows(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([status, count]) => ({
    status,
    count,
  }));
}

export const ROLE_SCHEMAS: Record<RoleWorkbenchRole, RoleSchema> = {
  operator: {
    key: 'operator',
    label: '操作员',
    description:
      '聚焦你被分配的工序任务、SOP 待签与异常，帮助你在当班内高效完成作业。',
    kpis: [
      {
        key: 'sopPendingCount',
        label: 'SOP 待签',
        unit: '项',
        format: 'number',
        source: '来自分配给我的工序中尚未完成 SOP 签字的数量',
        refreshHint: '实时，随工序状态更新',
      },
      {
        key: 'exceptionCount',
        label: '异常工序',
        unit: '项',
        format: 'number',
        source: '来自分配给我的工序中记录异常的工序数量',
        refreshHint: '实时，随工序状态更新',
      },
    ],
    lists: [
      {
        key: 'mySteps',
        label: '我的工序',
        emptyText: '当前没有分配给我的进行中工序。',
        columns: [
          { key: 'name', label: '工序' },
          {
            key: 'scheduleTaskId',
            label: '工单号',
            link: { to: '/scheduling' },
          },
          { key: 'status', label: '状态', enumMap: STEP_STATUS },
          { key: 'sopPending', label: 'SOP 待签' },
          { key: 'exception', label: '异常' },
        ],
        rowTo: '/operations',
      },
    ],
    quickActions: [
      { label: '排产调度', to: '/scheduling' },
      { label: '移动工作台', to: '/mobile-workbench' },
    ],
  },

  team_lead: {
    key: 'team_lead',
    label: '班组长',
    description:
      '跟踪班组在制、物料缺口、质量阻塞与异常升级，保证当班交付。',
    kpis: [
      {
        key: 'inProgressSteps',
        label: '在制工序',
        unit: '项',
        format: 'number',
        source: '全厂当前处于进行中的工序数量',
        refreshHint: '实时更新',
      },
      {
        key: 'materialShortage',
        label: '物料缺口',
        unit: '项',
        format: 'number',
        source: '处于激活状态的物料绑定数量',
        refreshHint: '随物料绑定变更更新',
      },
      {
        key: 'qualityBlocks',
        label: '质量阻塞',
        unit: '项',
        format: 'number',
        source: '处于开放状态的质量事件数量',
        refreshHint: '随质量事件状态更新',
      },
      {
        key: 'escalatedExceptions',
        label: '升级异常',
        unit: '项',
        format: 'number',
        source: '记录了异常的工序数量',
        refreshHint: '实时更新',
      },
    ],
    lists: [
      {
        key: 'delayedOrders',
        label: '延迟工单',
        emptyText: '暂无延迟工单。',
        columns: [
          { key: 'title', label: '工单' },
          {
            key: 'scheduleTaskId',
            label: '工单号',
            link: { to: '/scheduling' },
          },
          { key: 'status', label: '状态', enumMap: STEP_STATUS },
          { key: 'planEnd', label: '计划完成', format: 'time' },
        ],
        rowTo: '/scheduling',
      },
    ],
    quickActions: [
      { label: '排产调度', to: '/scheduling' },
      { label: '人员与外骨骼', to: '/personnel' },
    ],
  },

  quality: {
    key: 'quality',
    label: '质检',
    description:
      '关注待检、复检、直通率与缺陷分布，守住质量关口。',
    kpis: [
      {
        key: 'pendingInspections',
        label: '待检',
        unit: '项',
        format: 'number',
        source: '处于开放状态的质量事件数量',
        refreshHint: '随质量事件状态更新',
      },
      {
        key: 'overdueInspections',
        label: '逾期待检',
        unit: '项',
        format: 'number',
        source: '超过规定时限仍未完成的质量检查数量',
        refreshHint: '随检查时限更新',
      },
      {
        key: 'firstPassYield',
        label: '直通率',
        format: 'percent',
        source: '一次通过的质量事件占全部质量事件的比例',
        refreshHint: '随质量事件更新',
      },
    ],
    lists: [
      {
        key: 'duplicateDefects',
        label: '重复缺陷',
        emptyText: '暂无重复缺陷。',
        columns: [
          {
            key: 'defectCode',
            label: '缺陷代码',
            link: { to: '/alerts' },
          },
          { key: 'count', label: '出现次数', format: 'number' },
        ],
        rowTo: '/alerts',
      },
      {
        key: 'defectPareto',
        label: '缺陷分布',
        emptyText: '暂无缺陷分布数据。',
        columns: [
          {
            key: 'defectCode',
            label: '缺陷代码',
            link: { to: '/alerts' },
          },
          { key: 'count', label: '数量', format: 'number' },
        ],
        rowTo: '/alerts',
      },
    ],
    quickActions: [
      { label: '风险告警', to: '/alerts' },
      { label: '运营管理', to: '/operations' },
    ],
  },

  equipment: {
    key: 'equipment',
    label: '设备',
    description:
      '监控设备异常与停工，掌握设备健康状态与分布。',
    kpis: [
      {
        key: 'currentDowntime',
        label: '当前停机设备',
        unit: '台',
        format: 'number',
        source: '故障与空闲设备数量之和',
        refreshHint: '随设备状态实时更新',
      },
    ],
    lists: [
      {
        key: 'abnormalDevices',
        label: '异常设备',
        emptyText: '暂无异常设备。',
        columns: [
          { key: 'name', label: '设备' },
          { key: 'status', label: '状态', enumMap: DEVICE_STATUS },
          {
            key: 'entityId',
            label: '设备 ID',
            link: { to: '/devices' },
          },
        ],
        rowTo: '/devices',
      },
      {
        key: 'downtimeReasons',
        label: '设备状态分布',
        emptyText: '暂无设备状态分布数据。',
        transform: objectToRows,
        columns: [
          { key: 'status', label: '状态', enumMap: DEVICE_STATUS },
          { key: 'count', label: '设备数', format: 'number' },
        ],
        rowTo: '/devices',
      },
      {
        key: 'maintenanceTasks',
        label: '维护任务',
        emptyText: '暂无维护任务。',
        columns: [
          { key: 'title', label: '任务' },
          { key: 'status', label: '状态', enumMap: STEP_STATUS },
        ],
      },
      {
        key: 'capacityDegradation',
        label: '产能衰减',
        emptyText: '暂无产能衰减数据。',
        columns: [
          { key: 'name', label: '设备' },
          { key: 'level', label: '等级' },
        ],
      },
    ],
    quickActions: [
      { label: '设备中心', to: '/devices' },
      { label: '数字世界', to: '/digital-world' },
    ],
  },

  manager: {
    key: 'manager',
    label: '管理者',
    description:
      '从交付风险、产能瓶颈、物料、质量与设备健康的全局视角把握整体运营。',
    kpis: [
      {
        key: 'orderDeliveryRisk',
        label: '交付风险',
        unit: '项',
        format: 'number',
        source: '超出计划完成时间仍未完成的工单数量',
        refreshHint: '随工单计划时间更新',
      },
      {
        key: 'capacityBottleneck',
        label: '产能瓶颈',
        unit: '项',
        format: 'number',
        source: '当前处于进行中的工序数量',
        refreshHint: '随工序状态更新',
      },
      {
        key: 'materialShortage',
        label: '物料缺口',
        unit: '项',
        format: 'number',
        source: '物料绑定缺口数量',
        refreshHint: '随物料绑定变更更新',
      },
      {
        key: 'qualityLoss',
        label: '质量损失',
        unit: '项',
        format: 'number',
        source: '未通过质量事件的数量',
        refreshHint: '随质量事件更新',
      },
      {
        key: 'oeeAnomalies',
        label: '设备异常',
        unit: '台',
        format: 'number',
        source: '处于故障状态的设备数量',
        refreshHint: '随设备状态更新',
      },
    ],
    lists: [
      {
        key: 'riskTrend',
        label: '风险趋势',
        emptyText: '暂无风险趋势数据。',
        columns: [
          { key: 'riskType', label: '风险类型' },
          { key: 'level', label: '等级' },
          { key: 'count', label: '数量', format: 'number' },
        ],
        rowTo: '/command-center',
      },
    ],
    quickActions: [
      { label: '指挥中心', to: '/command-center' },
      { label: '排产调度', to: '/scheduling' },
      { label: '风险告警', to: '/alerts' },
    ],
  },
};

export function getRoleSchema(role: RoleWorkbenchRole): RoleSchema {
  return ROLE_SCHEMAS[role];
}

/**
 * 将原始值按格式渲染为中文文本，避免把原始 JSON 暴露给普通用户。
 * 布尔值、数字、时间、百分比、时长均做业务化格式化。
 */
export function formatValue(
  format: ValueFormat | undefined,
  value: unknown,
): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';

  switch (format) {
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : String(value);
    }
    case 'time': {
      if (typeof value === 'string' || value instanceof Date) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) {
          return d.toLocaleString('zh-CN', { hour12: false });
        }
      }
      return String(value);
    }
    case 'duration': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? `${n} 分钟` : String(value);
    }
    case 'number':
    default:
      return typeof value === 'number'
        ? value.toLocaleString('zh-CN')
        : String(value);
  }
}