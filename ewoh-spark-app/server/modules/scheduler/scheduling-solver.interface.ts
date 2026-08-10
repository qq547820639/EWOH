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
  /**
   * P0 大规模性能：可行候选 top-K 上限（默认 12；可经 SchedulingPolicyConfig
   * 的扩展字段 candidateTopK 配置）。只影响决策轨迹的候选明细（保持 top-K），
   * 绝不改变贪心 argmin 选择（稳定 top-K 与原全量排序逐位一致）。
   */
  candidateTopK?: number;
  /**
   * P0 增量重排 fast-path（flag-gated，DEFAULT OFF）：Map<taskId, {personId,
   * deviceId, stationId}>。提供时，对"当前运行状态下仍有效"的基线分配直接复用
   * （免枚举，trace 标记 reused:true）；任一硬校验失败回退完整枚举。
   * 该 fast-path 只在调用方显式传入时改变结果；未传时行为与全量重排完全一致。
   */
  reuseBaseline?: Map<
    string,
    { personId: string; deviceId: string | null; stationId: string | null }
  >;
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