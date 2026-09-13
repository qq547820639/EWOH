import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpRight,
  Boxes,
  BrainCircuit,
  Building2,
  CalendarClock,
  Sunrise,
  ClipboardList,
  Cpu,
  Database,
  Factory,
  FlaskConical,
  HardHat,
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
  Activity,
  Accessibility,
} from 'lucide-react';
import { EWOH_ROLES, type EwohRole } from '@client/src/types/ewoh';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: EwohRole[];
};

/**
 * 全部已注册角色（含只读访客 viewer）。
 *
 * FE-2：此前这里是手写的 6 项、漏了 viewer，名字叫 ALL_ROLES 却并非全集，
 * 于是 `hasRoleAccess` 注释里"显式公开的入口应声明 ALL_ROLES"形同虚设——
 * 任何用 ALL_ROLES 的入口都会把 viewer 挡在门外。改为直接投影角色注册表，
 * 语义与命名对齐；具体入口是否真的对所有角色开放，由后端 @Roles 决定，
 * 见 roleMatrix.test.ts 的门禁。
 */
export const ALL_ROLES: EwohRole[] = [...EWOH_ROLES];

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
 * 组内同名项已改名「运维中心」）。
 *
 * FE-2（2026-09-13）：权限矩阵不再"保持重构前不变"，而是与后端 @Roles 对齐。
 * 每组条目的 roles 必须等于后端主数据源的放行角色集（角色矩阵门禁：
 * roleMatrix.test.ts）。漂移的具体后果与整改见各条目注释。
 */
export const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '驾驶舱',
    items: [
      {
        // FE-2：后端 GET /api/dashboard/overview 仅放行 global_admin/dispatcher/
        // safety_admin/device_ops。此前多给了 workshop_lead（班组长默认落地页！
        // → 首屏 KPI 与异常两条主查询恒 403，页面看起来只是"没有数据"），
        // 又漏了 device_ops（设备运维在驾驶舱本应有入口）。现与后端逐项对齐。
        to: '/factory-operations',
        label: '工厂运行台',
        icon: LayoutDashboard,
        roles: ['global_admin', 'dispatcher', 'safety_admin', 'device_ops'],
      },
      {
        // FE-2：地图实体图层（GET /api/spatial/entities）与世界状态
        // （GET /api/world/state）都只放行 global_admin/dispatcher/workshop_lead。
        // 此前写成 ALL_ROLES，等于把 safety_admin/device_ops/worker 引到一个
        // 画不出任何实体的空地图上。按后端收窄。
        to: '/command-map',
        label: '指挥地图',
        icon: Map,
        roles: ['global_admin', 'dispatcher', 'workshop_lead'],
      },
      {
        // DR-2 班次工作台（standalone_074）：当班异常/待审批/偏差/交接班的第一视角。
        to: '/shift-workbench',
        label: '班次工作台',
        icon: Sunrise,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'safety_admin'],
      },
      {
        // FE-2：指挥中心唯一数据源 GET /api/dashboard/overview 放行 device_ops，
        // 此前前端漏了它（后端放行但无入口）。
        to: '/command-center',
        label: '指挥中心',
        icon: LayoutDashboard,
        roles: ['global_admin', 'dispatcher', 'safety_admin', 'device_ops'],
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
        // FE-2：后端审批主查询（GET /api/approvals/pending、
        // GET /api/approvals/authorizations）只放行 global_admin/workshop_lead/
        // safety_admin。此前给了 dispatcher——调度点进审批控制台必然 403；
        // 又漏了 safety_admin（安全管理员才是审批链上的常客）。按后端对齐。
        to: '/approval-console',
        label: '审批控制台',
        icon: ShieldCheck,
        roles: ['global_admin', 'workshop_lead', 'safety_admin'],
      },
      {
        // NO-33a：外骨骼作业台（会话绑定的开始/结束/中止；不下发任何设备控制指令）
        to: '/exo',
        label: '外骨骼作业',
        icon: Accessibility,
        roles: ['worker', 'workshop_lead', 'dispatcher', 'device_ops', 'global_admin'],
      },
      {
        // NO-27a/28a：物料与库存（ERP 出入库投影 + 订单 BOM 需求缺口）
        to: '/materials',
        label: '物料与库存',
        icon: Boxes,
        roles: ['dispatcher', 'workshop_lead', 'device_ops', 'global_admin'],
      },
      {
        // NO-25a：观测推导的实时风险（确定性规则 + 依据 + 未采用数据）。
        // FE-2：两条接口（live-facts / evaluate-live）都是 ANY_AUTHENTICATED_ROLES，
        // 即任何已登录账号都可读——这里如实声明 ALL_ROLES（含 viewer）。
        // 这也是 viewer（只读访客）的落地页：只读投影、无写路径承担，
        // 不再出现"登录后侧栏为空、点什么都 403"。
        to: '/reasoning',
        label: '实时风险',
        icon: Activity,
        roles: ALL_ROLES,
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
        // 现场作业台：外骨骼绑定 + 现场提醒 + 现场回执（区别于 MES 工序视角的移动工作台）。
        to: '/field-operations',
        label: '现场作业台',
        icon: HardHat,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'worker'],
      },
      {
        // FE-2：工作台列表接口放行 safety_admin，此前前端漏登记。
        to: '/role-workbench',
        label: '角色工作台',
        icon: ClipboardList,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'worker', 'device_ops', 'safety_admin'],
      },
      {
        // FE-2：GET /api/alerts 放行 workshop_lead（班组长要处置当班风险），
        // 此前前端漏登记 → 班长只能靠 403 页面猜。
        to: '/alerts',
        label: '风险告警',
        icon: ShieldAlert,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'safety_admin'],
      },
    ],
  },
  {
    label: '资源与资产',
    items: [
      {
        // FE-2：GET /api/dashboard/devices 放行 safety_admin（安全巡检要看设备面），
        // 此前前端漏登记，安全管理员在设备中心没有入口。
        to: '/devices',
        label: '设备中心',
        icon: Cpu,
        roles: ['global_admin', 'dispatcher', 'safety_admin', 'device_ops'],
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
        // 学习控制台：评估 → 提案 → 影子 → 人审 → 回滚 / 时长模型重训。
        // 提案可见性面向班组长与调度（他们要对建议负责），激活仅限前两者中的
        // workshop_lead/global_admin（服务端强制）。
        to: '/learning-console',
        label: '学习控制台',
        icon: BrainCircuit,
        roles: ['global_admin', 'workshop_lead', 'dispatcher', 'device_ops', 'safety_admin'],
      },
      {
        to: '/model-management',
        label: '模型管理',
        icon: Boxes,
        roles: ['global_admin', 'device_ops'],
      },
      {
        // FE-2：GET /api/aas/assets 放行 dispatcher/workshop_lead/device_ops/
        // safety_admin，此前前端只给了 global_admin——后端放行但四个角色无入口。
        to: '/data-assets',
        label: '数据资产',
        icon: Database,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin'],
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
        // FE-2：GET /api/operations/summary 放行 worker（一线也要看本班运维态），
        // 此前前端漏登记。
        to: '/operations',
        label: '运维中心',
        icon: Wrench,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'safety_admin', 'device_ops', 'worker'],
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
 *  （CLI-507），本函数仅决定「无 from 时的默认值」。
 *
 *  FE-2：落地页必须是该角色**真的进得去**的页面（否则登录即 403，
 *  用户只看到"没有数据"）。两条修正：
 *   · viewer 此前落到 /factory-operations（后端不放行，且侧栏为空）→ 改到
 *     /reasoning（只读风险投影，接口 ANY_AUTHENTICATED，见其 nav 注释）；
 *   · workshop_lead 此前落到 /factory-operations，但 GET /api/dashboard/overview
 *     不放行班组长 → 首屏两条主查询恒 403；改到 /shift-workbench
 *     （当班异常/待审批/偏差/交接班，正是班组长的第一视角）。 */
export function defaultLandingPath(userRoles: string[] | null | undefined): string {
  const roleSet = new Set(userRoles ?? []);
  if (roleSet.has('worker') || roleSet.has('device_ops')) {
    return '/mobile-workbench';
  }
  if (roleSet.has('workshop_lead')) {
    return '/shift-workbench';
  }
  if (roleSet.has('global_admin') || roleSet.has('dispatcher') || roleSet.has('safety_admin')) {
    return '/factory-operations';
  }
  // 只读访客（或未来新增的只读角色）：落到只读风险投影，而不是撞 403 的驾驶舱。
  if (roleSet.has('viewer')) {
    return '/reasoning';
  }
  return '/factory-operations';
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
