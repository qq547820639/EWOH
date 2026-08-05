/**
 * 引导内容目录：基于角色的首次使用 Quick Start + 「5 分钟跑通首个闭环任务」清单。
 *
 * 内容均为展示文案与目标路由，不含任何业务/敏感数据。步骤 id 与
 * onboardingState.ts 中的 ONBOARDING_STEP_IDS / FIVE_MINUTE_STEP_IDS 对应，
 * 以便进度可在各角色/各次登录间续做。
 */

import type { OnboardingStepId, FiveMinuteStepId } from './onboardingState';

/** 引导角色键（用于分角色的 Quick Start 内容与分漏斗统计）。 */
export type OnboardingRoleKey = keyof typeof ROLE_QUICKSTART;

export interface QuickStartStep {
  id: OnboardingStepId;
  /** 当前状态说明：用户现在处于什么状态。 */
  state: string;
  /** 目前缺什么（gap）。 */
  missing: string;
  /** 下一步可执行动作。 */
  nextAction: string;
  /** 目标路由（跳转到对应页面）。 */
  href?: string;
}

/** 各角色的首次使用 Quick Start 步骤。 */
export const ROLE_QUICKSTART = {
  admin: [
    {
      id: 'connect_device',
      state: '还没有接入任何现场设备/数据源。',
      missing: '需要先接入至少一个数据源。',
      nextAction: '进入「设备接入」添加首个数据源。',
      href: '/devices',
    },
    {
      id: 'publish_template',
      state: '尚无已发布的工厂模板。',
      missing: '需要一份已发布（certified→published）的模板。',
      nextAction: '在「工厂模板」中注册并发布模板。',
      href: '/scale/templates',
    },
    {
      id: 'install_scenario',
      state: '尚未安装任何场景包。',
      missing: '需要安装通过一致性校验的场景包。',
      nextAction: '在「场景包」中安装一个场景。',
      href: '/scale/scenarios',
    },
    {
      id: 'run_first_task',
      state: '还没有跑通一个闭环任务。',
      missing: '需要从派单到完工的完整闭环。',
      nextAction: '创建并执行首个任务，验证闭环。',
      href: '/workbench',
    },
  ],
  dispatcher: [
    {
      id: 'connect_device',
      state: '还没有可调度的现场设备。',
      missing: '需要至少一台已接入设备。',
      nextAction: '查看「设备接入」，确认数据源已连接。',
      href: '/devices',
    },
    {
      id: 'publish_template',
      state: '还没有可用的已发布模板。',
      missing: '需要已发布模板才能派单。',
      nextAction: '确认「工厂模板」已发布。',
      href: '/scale/templates',
    },
    {
      id: 'install_scenario',
      state: '还没有可执行的场景。',
      missing: '需要已安装的场景包。',
      nextAction: '确认「场景包」已安装。',
      href: '/scale/scenarios',
    },
    {
      id: 'run_first_task',
      state: '还没有派发过任务。',
      missing: '需要发起一次任务派单。',
      nextAction: '在「工作台」创建并派发首个任务。',
      href: '/workbench',
    },
  ],
  engineer: [
    {
      id: 'connect_device',
      state: '还没有校验过的设备连接。',
      missing: '需要确认设备/数据源连通性。',
      nextAction: '查看「设备接入」并校验连接。',
      href: '/devices',
    },
    {
      id: 'publish_template',
      state: '还没有发布模板。',
      missing: '需要工程师完成模板发布。',
      nextAction: '在「工厂模板」走完发布流程。',
      href: '/scale/templates',
    },
    {
      id: 'install_scenario',
      state: '还没有安装场景。',
      missing: '需要安装并验证场景包。',
      nextAction: '在「场景包」安装一个场景。',
      href: '/scale/scenarios',
    },
    {
      id: 'run_first_task',
      state: '还没有执行过任务。',
      missing: '需要执行一次任务闭环。',
      nextAction: '在「工作台」执行首个任务。',
      href: '/workbench',
    },
  ],
  field_worker: [
    {
      id: 'connect_device',
      state: '还没有可操作的现场工位。',
      missing: '需要确认工位/设备已上线。',
      nextAction: '查看「设备接入」确认现场设备在线。',
      href: '/devices',
    },
    {
      id: 'publish_template',
      state: '还没有可用的作业模板。',
      missing: '需要已发布的作业模板。',
      nextAction: '确认「工厂模板」可用。',
      href: '/scale/templates',
    },
    {
      id: 'install_scenario',
      state: '还没有可执行的作业场景。',
      missing: '需要已安装的场景。',
      nextAction: '确认「场景包」已安装。',
      href: '/scale/scenarios',
    },
    {
      id: 'run_first_task',
      state: '还没有执行过现场作业任务。',
      missing: '需要接单并完成一次作业。',
      nextAction: '在「工作台」领取并完成首个任务。',
      href: '/workbench',
    },
  ],
} as const satisfies Record<string, readonly QuickStartStep[]>;

/** 默认角色（未匹配到任何已知角色时使用最通用的派单视角）。 */
export const DEFAULT_ONBOARDING_ROLE: OnboardingRoleKey = 'dispatcher';

/**
 * 从用户角色列表映射到 Quick Start 角色键。
 * 匹配不到时回退到 dispatcher（通用视角）。
 */
export function onboardingRoleKey(
  roles: readonly string[] = [],
): OnboardingRoleKey {
  const normalized = roles.map((r) => r.toLowerCase());
  if (normalized.includes('global_admin') || normalized.includes('admin')) {
    return 'admin';
  }
  if (normalized.includes('dispatcher') || normalized.includes('workshop_lead')) {
    return 'dispatcher';
  }
  if (normalized.includes('engineer')) return 'engineer';
  if (normalized.includes('field_worker') || normalized.includes('worker')) {
    return 'field_worker';
  }
  return DEFAULT_ONBOARDING_ROLE;
}

export function quickStartSteps(role: OnboardingRoleKey): readonly QuickStartStep[] {
  return ROLE_QUICKSTART[role];
}

// ---- 「5 分钟跑通首个闭环任务」清单 ----

export interface FiveMinuteStep {
  id: FiveMinuteStepId;
  title: string;
  /** 当前状态/缺什么/下一步。 */
  state: string;
  missing: string;
  nextAction: string;
  href?: string;
}

export const FIVE_MINUTE_FLOW: readonly FiveMinuteStep[] = [
  {
    id: 'understand',
    title: '了解闭环',
    state: '你已进入系统，但还不清楚首个任务闭环长什么样。',
    missing: '缺少对「派单→执行→完工」闭环的认识。',
    nextAction: '阅读向导说明，了解一次完整闭环的四个环节。',
  },
  {
    id: 'connect',
    title: '接入数据源',
    state: '还没有任何设备/数据源接入。',
    missing: '需要至少一个在线数据源。',
    nextAction: '在「设备接入」添加并连接首个数据源。',
    href: '/devices',
  },
  {
    id: 'configure',
    title: '发布模板与场景',
    state: '还没有可用的模板与场景。',
    missing: '需要一份已发布模板与已安装场景。',
    nextAction: '在「工厂模板」「场景包」完成发布与安装。',
    href: '/scale/templates',
  },
  {
    id: 'execute',
    title: '执行任务',
    state: '还没有执行过任务。',
    missing: '需要一次真实的任务执行。',
    nextAction: '在「工作台」创建并执行任务。',
    href: '/workbench',
  },
  {
    id: 'close_loop',
    title: '闭环确认',
    state: '任务数据可能尚未回传确认。',
    missing: '需要确认任务状态已流转到完工。',
    nextAction: '核对任务状态与数据回传，完成闭环。',
    href: '/workbench',
  },
];

export function fiveMinuteSteps(): readonly FiveMinuteStep[] {
  return FIVE_MINUTE_FLOW;
}