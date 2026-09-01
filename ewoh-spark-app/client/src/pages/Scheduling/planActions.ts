import type { PlanStatus } from '@shared/api.interface';

/**
 * 方案动作单一事实源（OD-5 终态行动条 / OD-3 工作台动作区共用）。
 *
 * 背景：`Scheduling.tsx:291-304` 中方案进入 dispatched / completed / rejected /
 * superseded 后，卡片只剩一行静态文本，无任何后继入口——派工成为"黑洞动作"。
 *
 * 设计原则：
 *   - **状态机驱动**：每个状态只声明其合法动作，未声明即不渲染。
 *   - **单一事实源**：排产调度页与对象工作台引用同一份定义，
 *     避免出现第二套动作实现（这正是本 PRD 要治理的"同一跃迁双入口"问题）。
 *   - **终态必有出口**：任何终态至少提供 1 个后继入口（PRD §5.3）。
 */

export type PlanActionKind =
  | 'approve'
  | 'reject'
  | 'dispatch'
  | 'replan'
  | 'viewExecution'
  | 'viewHistory'
  | 'viewReport';

export type PlanActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface PlanAction {
  kind: PlanActionKind;
  label: string;
  variant: PlanActionVariant;
  /** 导航型动作的目标路由；写操作型动作为 undefined（由调用方执行 mutation）。 */
  route?: string;
}

/** 写操作型动作（需调用 mutation），用于调用方分流。 */
export const WRITE_ACTIONS: ReadonlySet<PlanActionKind> = new Set<PlanActionKind>([
  'approve',
  'reject',
  'dispatch',
  'replan',
]);

/**
 * 按方案状态返回可用动作。
 *
 * 状态枚举见 `shared/scheduler.ts:77-85`（8 态）。
 * 注意：**没有 `stale` 态**——「已过期」来自 409 `PLAN_STALE` 响应
 * （`Scheduling.tsx:117-123`），属于 mutation 错误分支，不在此处声明。
 */
export function planActions(status: PlanStatus, planId: string): PlanAction[] {
  const execution = `/work-orchestration?plan=${encodeURIComponent(planId)}`;
  const history = `/decision-history?plan=${encodeURIComponent(planId)}`;

  switch (status) {
    case 'draft':
    case 'shadow':
      return [
        { kind: 'approve', label: '审批通过', variant: 'primary' },
        { kind: 'reject', label: '驳回', variant: 'danger' },
      ];
    case 'approved':
      return [
        { kind: 'dispatch', label: '下发执行', variant: 'primary' },
        { kind: 'replan', label: '重新排程', variant: 'secondary' },
      ];
    case 'dispatched':
    case 'executing':
      return [
        { kind: 'viewExecution', label: '查看执行态势', variant: 'primary', route: execution },
        { kind: 'replan', label: '触发重排', variant: 'secondary' },
        { kind: 'viewHistory', label: '查看决策历史', variant: 'ghost', route: history },
      ];
    case 'completed':
      return [
        { kind: 'viewReport', label: '查看执行报告', variant: 'primary', route: execution },
        { kind: 'viewHistory', label: '结案复盘', variant: 'secondary', route: history },
      ];
    case 'rejected':
      return [
        { kind: 'replan', label: '重新排程', variant: 'primary' },
        { kind: 'viewHistory', label: '查看驳回理由', variant: 'secondary', route: history },
      ];
    case 'superseded':
      return [
        { kind: 'viewHistory', label: '查看替代方案', variant: 'primary', route: history },
      ];
    default:
      return [];
  }
}

/** 状态 → 语义徽章样式（横切 X-3：一律走风险语义 Token，不用 Tailwind 默认色族）。 */
export const PLAN_STATUS_BADGE: Record<
  PlanStatus,
  { label: string; className: string }
> = {
  draft: {
    label: '待审批',
    className: 'border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground',
  },
  shadow: {
    label: '影子方案',
    className: 'border-risk-unknown-border bg-risk-unknown-soft text-risk-unknown-foreground',
  },
  approved: {
    label: '已审批',
    className: 'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground',
  },
  dispatched: {
    label: '已下发',
    className: 'border-risk-offline-border bg-risk-offline-soft text-risk-offline-foreground',
  },
  executing: {
    label: '执行中',
    className: 'border-risk-offline-border bg-risk-offline-soft text-risk-offline-foreground',
  },
  completed: {
    label: '已完成',
    className: 'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground',
  },
  rejected: {
    label: '已驳回',
    className: 'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground',
  },
  superseded: {
    label: '已替代',
    className: 'border-risk-unknown-border bg-risk-unknown-soft text-risk-unknown-foreground',
  },
};

/**
 * J1 排产主线的流程环节（OD-8 Journey Rail）。
 *
 * 由 `PlanStatus` + AI 解读状态**派生**，不引入新的持久状态——
 * 环节位置始终是方案状态的投影，因此不存在"流程带与真实状态不一致"的可能。
 */
export type JourneyStepState = 'done' | 'current' | 'todo';

export interface JourneyStep {
  key: string;
  label: string;
  state: JourneyStepState;
  /** 该环节可回溯到的路由；`todo` 环节尚未到达，故不提供。 */
  route?: string;
}

/** 终态：流程不再前进，后续环节一律 todo。 */
const TERMINAL_STATUSES: ReadonlySet<PlanStatus> = new Set<PlanStatus>([
  'rejected',
  'superseded',
]);

export function planJourney(
  status: PlanStatus,
  narrationStatus: 'pending' | 'done' | 'unavailable',
  planId: string,
): JourneyStep[] {
  const planRoute = `/o/scheduling_plan/${encodeURIComponent(planId)}`;
  const executionRoute = `/work-orchestration?plan=${encodeURIComponent(planId)}`;

  // 是否已跨过评审：draft / shadow 之外均视为已通过评审。
  const reviewed = status !== 'draft' && status !== 'shadow';
  const dispatched =
    status === 'dispatched' || status === 'executing' || status === 'completed';
  const terminated = TERMINAL_STATUSES.has(status);

  const reviewState: JourneyStepState = terminated || reviewed ? 'done' : 'current';
  const dispatchState: JourneyStepState = dispatched
    ? 'done'
    : terminated
      ? 'todo'
      : reviewed
        ? 'current'
        : 'todo';
  const executeState: JourneyStepState =
    status === 'completed'
      ? 'done'
      : status === 'dispatched' || status === 'executing'
        ? 'current'
        : 'todo';

  return [
    { key: 'generate', label: '生成方案', state: 'done', route: planRoute },
    {
      key: 'narration',
      label: 'AI 解读',
      // 解读是并行发生的旁路环节：生成中显示为进行中，不可用时视为跳过。
      state: narrationStatus === 'pending' ? 'current' : 'done',
      route: planRoute,
    },
    { key: 'review', label: '评审会签', state: reviewState, route: planRoute },
    {
      key: 'dispatch',
      label: '下发执行',
      state: dispatchState,
      route: dispatchState === 'todo' ? undefined : planRoute,
    },
    {
      key: 'execute',
      label: '执行跟踪',
      state: executeState,
      route: executeState === 'todo' ? undefined : executionRoute,
    },
  ];
}

/**
 * 关联对象的下钻路由（OD-9）。
 *
 * 沿用既有页面能力、不新建页面：调度方案走对象工作台（可看全部上下文），
 * 设备/人员走既有台账页，工位暂无独立页面故不可下钻。
 * 未知类型返回 undefined，调用方渲染为纯文本（不产生死链）。
 */
export function resolveObjectRoute(objectType: string, objectId: string): string | undefined {
  switch (objectType) {
    case 'scheduling_plan':
      return `/o/scheduling_plan/${encodeURIComponent(objectId)}`;
    case 'device':
      return '/devices';
    case 'person':
      return '/personnel';
    default:
      return undefined;
  }
}

/** 触发类型中文标签（与 Scheduling 页保持一致，避免术语漂移）。 */
export const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: '手动',
  TASK_CREATED: '任务创建',
  TASK_UPDATED: '任务更新',
  PERSON_UNAVAILABLE: '人员不可用',
  DEVICE_OFFLINE: '设备离线',
  DEVICE_LOW_BATTERY: '设备低电量',
  BOTTLENECK_DETECTED: '瓶颈检测',
  DEADLINE_AT_RISK: '交期风险',
  SAFETY_EVENT: '安全事件',
  ZONE_RESTRICTED: '区域受限',
};
