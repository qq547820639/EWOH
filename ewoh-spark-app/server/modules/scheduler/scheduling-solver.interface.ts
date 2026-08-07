import type {
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  WorldStateSnapshot,
} from '@shared/api.interface';

/** 求解器入参选项。 */
export interface SolveOptions {
  planId: string;
  planName?: string;
  triggerType: string;
  triggerEntityId: string | null;
  snapshotVersion: string;
  horizonMinutes: number;
  baselineAssignee?: Map<string, string | null>;
  /** 可选显式策略覆盖（缺失时由求解器从 SchedulingPolicyService 加载）。 */
  policy?: SchedulingPolicy;
}

/**
 * 调度求解器接口：任何实现都须在给定世界状态快照 + 约束 + 选项下，
 * 产出一个完整、可解释、可确定性重放的 SchedulingPlanV2。
 */
export interface SchedulingSolver {
  solve(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2>;
}