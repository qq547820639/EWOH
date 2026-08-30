import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpRight,
  Boxes,
  BrainCircuit,
  Building2,
  CalendarClock,
  ClipboardList,
  Cpu,
  Database,
  Factory,
  FlaskConical,
  History,
  LayoutDashboard,
  Map,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { type EwohRole } from '@client/src/types/ewoh';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: EwohRole[];
};

export const ALL_ROLES: EwohRole[] = [
  'global_admin',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
  'worker',
];

/**
 * 导航信息架构（UX-IA-2026-08 重构）：
 *
 * 按「用户任务域」而非系统模块分组，组内按角色-任务频率排序：
 *   驾驶舱      —— 看（高频态势感知）
 *   调度与执行  —— 决策（排产/审批/派工写路径）
 *   作业现场    —— 做（一线作业与风险处置）
 *   资源与资产  —— 管（中频台账管理）
 *   仿真与治理  —— 改（低频探索/审计/配置）
 *
 * 约束：单组 ≤6 项（Miller 7±2）；组名与组内项不得重名（原「运营管理」
 * 组内同名项已改名「运维中心」）；权限矩阵（roles）保持重构前不变，
 * 仅调整分组与顺序。
 */
export const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '驾驶舱',
    items: [
      {
        to: '/command-map',
        label: '指挥地图',
        icon: Map,
        roles: ALL_ROLES,
      },
      {
        to: '/command-center',
        label: '指挥中心',
        icon: LayoutDashboard,
        roles: ['global_admin', 'dispatcher', 'safety_admin'],
      },
      {
        to: '/digital-world',
        label: '数字世界',
        icon: Boxes,
        roles: ['dispatcher', 'workshop_lead'],
      },
    ],
  },
  {
    label: '调度与执行',
    items: [
      {
        to: '/scheduling',
        label: '排产调度',
        icon: CalendarClock,
        roles: ['dispatcher', 'workshop_lead'],
      },
      {
        to: '/approval-console',
        label: '审批控制台',
        icon: ShieldCheck,
        roles: ['dispatcher', 'workshop_lead', 'global_admin'],
      },
      {
        to: '/work-orchestration',
        label: '执行控制台',
        icon: Workflow,
        roles: ['global_admin'],
      },
    ],
  },
  {
    label: '作业现场',
    items: [
      {
        to: '/mobile-workbench',
        label: '移动工作台',
        icon: Smartphone,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'worker'],
      },
      {
        to: '/role-workbench',
        label: '角色工作台',
        icon: ClipboardList,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'worker', 'device_ops'],
      },
      {
        to: '/alerts',
        label: '风险告警',
        icon: ShieldAlert,
        roles: ['safety_admin', 'dispatcher'],
      },
    ],
  },
  {
    label: '资源与资产',
    items: [
      {
        to: '/devices',
        label: '设备中心',
        icon: Cpu,
        roles: ['device_ops', 'dispatcher'],
      },
      {
        to: '/personnel',
        label: '人员与外骨骼',
        icon: Users,
        roles: ['workshop_lead', 'safety_admin'],
      },
      {
        to: '/organization',
        label: '组织与空间',
        icon: Building2,
        roles: ['global_admin'],
      },
      {
        to: '/model-management',
        label: '模型管理',
        icon: Boxes,
        roles: ['global_admin', 'device_ops'],
      },
      {
        to: '/data-assets',
        label: '数据资产',
        icon: Database,
        roles: ['global_admin'],
      },
    ],
  },
  {
    label: '仿真与治理',
    items: [
      {
        to: '/ai-decision',
        label: 'AI 决策',
        icon: BrainCircuit,
        roles: ['dispatcher', 'global_admin'],
      },
      {
        to: '/simulation',
        label: '仿真推演',
        icon: FlaskConical,
        roles: ['dispatcher', 'workshop_lead', 'global_admin'],
      },
      {
        to: '/decision-history',
        label: '决策历史',
        icon: History,
        roles: ['dispatcher', 'workshop_lead', 'global_admin'],
      },
      {
        to: '/scale',
        label: '规模化运营',
        icon: Factory,
        roles: ['global_admin', 'dispatcher', 'workshop_lead'],
      },
      {
        to: '/operations',
        label: '运维中心',
        icon: Wrench,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'safety_admin', 'device_ops'],
      },
      {
        to: '/system',
        label: '系统管理',
        icon: Settings,
        roles: ['global_admin', 'safety_admin'],
      },
    ],
  },
];

export function getAllowedRoles(path: string): EwohRole[] {
  const item = navGroups.flatMap((group) => group.items).find((nav) => nav.to === path);
  return item?.roles ?? [];
}

export function hasRoleAccess(
  userRoles: string[] | null | undefined,
  allowedRoles: EwohRole[] | string[],
): boolean {
  // CLI-521：allowedRoles 为空（配置漏写 roles）时拒绝访问（fail-closed），
  // 不再默认放行；显式公开的入口应声明 ALL_ROLES。
  if (!allowedRoles || allowedRoles.length === 0) return false;
  if (!userRoles || userRoles.length === 0) return false;
  const roleSet = new Set(userRoles);
  if (roleSet.has('global_admin')) return true;
  return allowedRoles.some((role) => roleSet.has(role));
}

export function getVisibleNavGroups(userRoles: string[] | null | undefined) {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => hasRoleAccess(userRoles, item.roles)),
    }))
    .filter((group) => group.items.length > 0);
}

/** 登录后的默认落地页（按角色任务域分流，UX-IA-2026-08 §3.2）。
 *  一线作业角色直达作业现场，管理角色直达驾驶舱；redirect 参数优先级更高
 *  （CLI-507），本函数仅决定「无 from 时的默认值」。 */
export function defaultLandingPath(userRoles: string[] | null | undefined): string {
  const roleSet = new Set(userRoles ?? []);
  if (roleSet.has('worker') || roleSet.has('device_ops')) {
    return '/mobile-workbench';
  }
  if (roleSet.has('workshop_lead') || roleSet.has('global_admin')) {
    return '/command-map';
  }
  return '/command-center';
}

/** 页面内功能直达条目（UX-IA-2026-08 §3.5 横切层）：
 *  聚合页内部的能力通过 ⌘K 命令面板直达（锚点/tab 参数），不占导航视觉空间。
 *  仅登记真实存在的页内目标；页面删除/改名时需同步。 */
export interface PageFunctionEntry {
  label: string;
  /** 页面路由（可含 ?tab= 查询参数） */
  to: string;
  /** 页面内锚点 id（可选，目标页需支持 hash 滚动） */
  anchor?: string;
  /** 搜索匹配关键词 */
  keywords: string;
}

export const pageFunctionEntries: PageFunctionEntry[] = [
  { label: '功能开关评估', to: '/system', anchor: 'system-flags', keywords: '开关 flag 灰度 评估' },
  { label: '参数注册中心', to: '/system', anchor: 'system-params', keywords: '参数 注册 配置' },
  { label: 'AI 能力接入', to: '/system', anchor: 'system-ai', keywords: 'AI 模型 接入 vision' },
  { label: '请求追踪', to: '/system', anchor: 'system-tracing', keywords: '追踪 tracing 请求 排查' },
  { label: '维保资产', to: '/operations?tab=维保资产', keywords: '维保 资产 登记' },
  { label: '维保任务', to: '/operations?tab=维保任务', keywords: '维保 任务 工单' },
  { label: '工装校验', to: '/operations?tab=工装校验', keywords: '工装 校验 点检 校准' },
  { label: '工作中心', to: '/operations?tab=工作中心', keywords: '工作中心 产线 配置' },
  { label: '标准工时', to: '/operations?tab=标准工时', keywords: '标准 工时 定额' },
  { label: '人员效率', to: '/operations?tab=人员效率', keywords: '效率 人员 绩效' },
];
