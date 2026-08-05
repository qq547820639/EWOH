/**
 * 引导/首个任务处理的匿名产品事件。
 *
 * 目的：衡量「跑通首个闭环任务」的完成率、放弃步骤、失败原因，用于产品迭代。
 * 隐私安全：只上报结构化的枚举/计数，绝不采集业务内容（任务正文、订单号、
 * 工厂名、用户身份等敏感或业务数据）。事件走既有可观测链路
 * （client/src/lib/observability.ts 的 recordMetric），由后端脱敏后入库。
 */

import { recordMetric } from './observability';

/** 引导相关且允许匿名上报的结构化事件名。 */
export type OnboardingEventName =
  | 'onboarding.shown'
  | 'onboarding.dismissed'
  | 'onboarding.completed'
  | 'onboarding.abandoned'
  | 'onboarding.step_completed'
  | 'first_task.completed'
  | 'first_task.abandoned'
  | 'first_task.failed';

export interface OnboardingEventData {
  flow?: 'onboarding' | 'fiveMinute';
  /** 步骤 id（枚举，非业务内容）。 */
  step?: string;
  /** 角色（枚举，用于分角色漏斗）。 */
  role?: string;
  /** 放弃/失败原因（枚举，非业务内容）。 */
  reason?: string;
  /** 是否已完成全部步骤（用于完成率）。 */
  completed?: boolean;
}

/** 可选注入以采集当前角色；默认不带上敏感信息。 */
export function reportOnboardingEvent(
  name: OnboardingEventName,
  data: OnboardingEventData = {},
): void {
  // value 固定为 1，表示「发生一次」；tags 只含枚举，不含业务内容。
  const tags: Record<string, string | number | boolean> = {
    ...(data.flow ? { flow: data.flow } : {}),
    ...(data.step ? { step: data.step } : {}),
    ...(data.role ? { role: data.role } : {}),
    ...(data.reason ? { reason: data.reason } : {}),
    ...(typeof data.completed === 'boolean'
      ? { completed: data.completed }
      : {}),
  };
  // 无可选字段时不携带任何 tag，避免下发空标签对象
  recordMetric(
    `uwax.onboarding.${name}`,
    1,
    Object.keys(tags).length > 0 ? tags : undefined,
  );
}

/** 便捷事件：首个任务完成。 */
export function trackFirstTaskCompleted(opts: {
  flow?: 'onboarding' | 'fiveMinute';
  role?: string;
}): void {
  reportOnboardingEvent('first_task.completed', {
    flow: opts.flow,
    role: opts.role,
    completed: true,
  });
}

/** 便捷事件：首个任务放弃（含放弃步骤）。 */
export function trackFirstTaskAbandoned(opts: {
  flow?: 'onboarding' | 'fiveMinute';
  step?: string;
  reason?: string;
}): void {
  reportOnboardingEvent('first_task.abandoned', {
    flow: opts.flow,
    step: opts.step,
    reason: opts.reason,
  });
}