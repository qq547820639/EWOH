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
   * Task B / P0：局部重排真实影响任务集（ReplanImpact.affectedTaskIds，来自 impact-propagation）。
   * 提供时 scheduler_partial_replan_affected 取 affectedTaskIds.length（真实受影响数）；
   * 缺省（全量重排/无影响分析）时按快照任务数近似。绝不改变求解语义，仅影响观测指标。
   */
  affectedTaskIds?: string[];
  /**
   * Task A / P0：租户 org id（CANARY org allowlist 采样判定；缺省 null 时采样键退化为 planId）。
   * 仅影响 CANARY 采样决策与 solverActivation 审计，不改变求解语义。
   */
  orgId?: string | null;
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