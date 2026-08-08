/* P1-5 Production Demo 隔离：演示方案识别纯逻辑。
 *
 * Demo/演示方案一律禁止审批/驳回/派工（不产生真实业务副作用）。
 * 独立成纯模块便于 jest（CommonJS）直接单测，避免 import 组件引入
 * `import.meta.env` 导致的 SyntaxError。
 */
import type { SchedulingPlanV2 } from '@shared/api.interface';

/** 判定方案是否为「非权威」演示方案（Demo 兜底）。 */
export function isNonAuthoritativePlan(
  plan: Pick<SchedulingPlanV2, 'planId' | 'snapshotVersion'> | null,
): boolean {
  return Boolean(
    plan && (plan.planId.startsWith('DEMO') || plan.snapshotVersion === 'demo-snapshot'),
  );
}
