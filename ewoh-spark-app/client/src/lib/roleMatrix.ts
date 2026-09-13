/* FE-2 角色矩阵契约：把「页面路径 → 前端允许角色」与「页面主数据源 API → 后端实际要求角色」
 * 接到一起，供 roleMatrix.test.ts 做机器比对。
 *
 * 为什么需要它：角色事实是**双源**的——前端只看 navigation.ts 的 navGroups[].roles，
 * 后端权威在 route-role.policy.ts / 各 controller 的 @Roles。此前两边没有任何比对，
 * 于是出现两类线上事故：
 *   1) 前端把入口给了一个后端拒绝的角色 → 点进去 403（或页面主查询报错、被渲染成"暂无可看内容"）；
 *   2) 后端已经放行、前端却没有入口 → 角色面板/管理员的承诺落空。
 *
 * 本文件里的 PAGE_API_CONTRACT 是**唯一新增的事实**（页面 → 主数据源 API），
 * 每一条都在 roleMatrix.test.ts 里被断言：
 *   · 该路由必须真实存在于 server/modules/**\/*.controller.ts 解析出的路由表
 *     （后端改名/改前缀/删路由 → 测试失败）；
 *   · 前端 navGroups 的角色集必须与后端放行集一致
 *     （后端收窄角色 → 测试失败；前端越权加角色 → 测试失败）。
 * 后端角色集本身不在此硬编码，全部由 server 源码现算，避免出现第三份会漂移的清单。
 */
import { EWOH_ROLES, type EwohRole } from '@client/src/types/ewoh';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRef {
  method: HttpMethod;
  /** 后端真实路由（与 @Controller 前缀 + @Get/@Post 子路径拼接后的字面量一致）。 */
  path: string;
}

/** hasRoleAccess 对 global_admin 无条件放行（见 navigation.ts），因此所有页面对它恒可见。 */
export const IMPLICIT_ADMIN_ROLE: EwohRole = 'global_admin';

/**
 * 页面 → 页面主数据源 API（决定"这个角色能不能真正用这个页面"）。
 *
 * 选取口径：只登记**页面首屏渲染所依赖的主查询**（KPI / 列表 / 地图实体）。
 * 次要查询（弹窗里的下拉、按需加载的详情、动作类写接口）不进契约——
 * 它们对应用户主动触发时的局部失败，而不是"打开页面就是 403"。
 * 例外情况写在 residualRisk 里，不在此处放宽。
 */
export const PAGE_API_CONTRACT: Record<string, ApiRef[]> = {
  // 工厂运行台：首屏 KPI 全部来自 dashboard/overview（事件/方案是次要数据源）。
  '/factory-operations': [{ method: 'GET', path: '/api/dashboard/overview' }],
  // 指挥地图：地图底图 = 空间实体图层 + 世界状态，两者角色集一致。
  '/command-map': [
    { method: 'GET', path: '/api/spatial/entities' },
    { method: 'GET', path: '/api/world/state' },
  ],
  // 班次工作台：当班上下文（shifts/current 为 ANY_AUTHENTICATED 开放读）。
  '/shift-workbench': [{ method: 'GET', path: '/api/shifts/current' }],
  // 指挥中心：单查询页，全部内容来自 dashboard/overview。
  '/command-center': [{ method: 'GET', path: '/api/dashboard/overview' }],
  // 数字世界：世界状态快照。
  '/digital-world': [{ method: 'GET', path: '/api/world/state' }],
  // 排产调度：活跃方案列表。
  '/scheduling': [{ method: 'GET', path: '/api/scheduler/active-plans' }],
  // 审批控制台：待审批列表（授权清单同角色集）。
  '/approval-console': [{ method: 'GET', path: '/api/approvals/pending' }],
  // 外骨骼作业：会话列表（ANY_AUTHENTICATED 开放读）。
  '/exo': [{ method: 'GET', path: '/api/exo/sessions' }],
  // 物料与库存：库存投影。
  '/materials': [{ method: 'GET', path: '/api/materials/inventory' }],
  // 实时风险：只读事实投影（ANY_AUTHENTICATED 开放读）→ 也是 viewer 的只读落点。
  '/reasoning': [{ method: 'GET', path: '/api/reasoning/live-facts' }],
  // 执行控制台：工作编排总览，仅 global_admin。
  '/work-orchestration': [{ method: 'GET', path: '/api/work/overview' }],
  // 移动工作台：一线工作台聚包。
  '/mobile-workbench': [{ method: 'GET', path: '/api/mobile/workbench' }],
  // 现场作业台：我的现场工单。
  '/field-operations': [{ method: 'GET', path: '/api/scheduler/field/my-work' }],
  // 角色工作台：按角色裁剪的工作台列表。
  '/role-workbench': [{ method: 'GET', path: '/api/operations/role-workbench' }],
  // 风险告警：告警列表。
  '/alerts': [{ method: 'GET', path: '/api/alerts' }],
  // 设备中心：设备列表（详情/绑定为按需查询）。
  '/devices': [{ method: 'GET', path: '/api/dashboard/devices' }],
  // 人员与外骨骼：人员列表。
  '/personnel': [{ method: 'GET', path: '/api/personnel' }],
  // 组织与空间：组织树。
  '/organization': [{ method: 'GET', path: '/api/organization/tree' }],
  // 学习控制台：提案列表（ANY_AUTHENTICATED 开放读）。
  '/learning-console': [{ method: 'GET', path: '/api/learning/proposals' }],
  // 模型管理：模型清单。
  '/model-management': [{ method: 'GET', path: '/api/models' }],
  // 数据资产：AAS 资产清单。
  '/data-assets': [{ method: 'GET', path: '/api/aas/assets' }],
  // AI 决策：快照版本是首屏版本边界的权威来源（chat 为按需）。
  '/ai-decision': [{ method: 'GET', path: '/api/ai/snapshot-version' }],
  // 仿真推演：推演运行列表（ANY_AUTHENTICATED 开放读）。
  '/simulation': [{ method: 'GET', path: '/api/simulation/runs' }],
  // 决策历史：调度决策历史。
  '/decision-history': [{ method: 'GET', path: '/api/scheduler/decision-history' }],
  // 规模化运营：多厂队列状态。
  '/scale': [{ method: 'GET', path: '/api/scale/fleet/status' }],
  // 运维中心：运维总览。
  '/operations': [{ method: 'GET', path: '/api/operations/summary' }],
  // 系统管理：系统配置（含功能开关/参数）。
  '/system': [{ method: 'GET', path: '/api/system/config' }],
};

/** 前端角色全集（与 types/ewoh.ts 的 EWOH_ROLES 同源，防两处漂移）。 */
export const CONTRACT_ROLE_UNIVERSE: readonly string[] = EWOH_ROLES;
