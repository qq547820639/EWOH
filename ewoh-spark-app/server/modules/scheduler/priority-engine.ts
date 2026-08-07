import type {
  SchedulingPolicy,
  SchedulingPolicyConfig,
} from '@shared/api.interface';

/** 单个优先级影响因素（用于可解释性）。 */
export interface PriorityFactor {
  name: string;
  weight: number;
  value: number;
  term: number;
}

/** 优先级计算结果（score 越小时越紧急）。 */
export interface PriorityResult {
  level: number;
  score: number;
  factors: PriorityFactor[];
  explanation: string[];
  urgent: boolean;
}

/** 计算优先级所需的输入。 */
export interface PriorityInput {
  task: { id: string; priority: string; planStart?: string | null; planEnd?: string | null };
  config: SchedulingPolicyConfig;
  now: number;
  horizonEndMs: number;
  downstreamCount: Map<string, number>;
  manualBoostIds: Set<string>;
}

const SCALE = 100;

/**
 * 纯优先级引擎（可 new 即用）。
 * 分数约定：越小越紧急。
 * - base：按 priority 等级映射到档位 × SCALE。
 * - deadline：越接近 planEnd 越紧急（修正：不再反向加分）。
 * - waiting age / event severity / downstream / manual boost：均为负项，缩小 score 提升紧急度。
 */
export class PriorityEngine {
  compute(policy: SchedulingPolicy, input: PriorityInput): PriorityResult {
    const p = input.config.priority;
    const explanation: string[] = [];
    const factors: PriorityFactor[] = [];
    const rank = this.priorityRank(input.task.priority);
    const urgent = rank === 0; // critical/urgent 硬地板

    let score = rank * SCALE;
    factors.push({
      name: 'base_priority',
      weight: SCALE,
      value: rank,
      term: rank * SCALE,
    });
    explanation.push(`base_priority=${input.task.priority}(rank=${rank})`);

    // 截止风险：越接近 deadline（ratio 越小）越紧急 → 加分越小 → score 越小。
    const deadlineMs = input.task.planEnd
      ? Date.parse(input.task.planEnd)
      : input.horizonEndMs;
    const windowMs = Math.max(input.horizonEndMs - input.now, 1);
    const deadlineRatio = Math.max(
      0,
      Math.min(1, (deadlineMs - input.now) / windowMs),
    );
    const deadlineTerm = p.deadlineRiskWeight * deadlineRatio * SCALE;
    score += deadlineTerm;
    factors.push({
      name: 'deadline_risk',
      weight: p.deadlineRiskWeight,
      value: deadlineRatio,
      term: deadlineTerm,
    });
    if (deadlineTerm !== 0)
      explanation.push(`deadline_risk=+${deadlineTerm.toFixed(2)}`);

    // 等待老化：挂起越久越紧急。
    if (input.task.planStart) {
      const startMs = Date.parse(input.task.planStart);
      if (startMs < input.now) {
        const ageRatio = Math.min(
          1,
          (input.now - startMs) / (p.agingBaseMs || 1),
        );
        const waitingTerm = -p.waitingAgeWeight * ageRatio * SCALE;
        score += waitingTerm;
        factors.push({
          name: 'waiting_age',
          weight: p.waitingAgeWeight,
          value: ageRatio,
          term: waitingTerm,
        });
        explanation.push(`waiting_age=${waitingTerm.toFixed(2)}`);
      }
    }

    // 事件严重度 / 截止风险标记。
    const taskExt = input.task as typeof input.task & {
      deadlineAtRisk?: boolean;
    };
    if (taskExt.deadlineAtRisk === true) {
      const sevTerm = -p.eventSeverityWeight * SCALE;
      score += sevTerm;
      factors.push({
        name: 'event_severity',
        weight: p.eventSeverityWeight,
        value: 1,
        term: sevTerm,
      });
      explanation.push(`event_severity=${sevTerm.toFixed(2)}`);
    }

    // 下游阻塞：被越多人依赖越紧急。
    const downstream = input.downstreamCount.get(input.task.id) ?? 0;
    if (downstream > 0) {
      const downTerm = -p.downstreamBlockingWeight * downstream * SCALE;
      score += downTerm;
      factors.push({
        name: 'downstream_blocking',
        weight: p.downstreamBlockingWeight,
        value: downstream,
        term: downTerm,
      });
      explanation.push(`downstream_blocking=${downTerm.toFixed(2)}`);
    }

    // 人工加急（MANUAL_BOOST 约束或 critical 优先级）。
    if (input.manualBoostIds.has(input.task.id)) {
      const boostTerm = -p.manualBoostWeight * SCALE;
      score += boostTerm;
      factors.push({
        name: 'manual_boost',
        weight: p.manualBoostWeight,
        value: 1,
        term: boostTerm,
      });
      explanation.push(`manual_boost=${boostTerm.toFixed(2)}`);
    }

    return {
      level: rank,
      score,
      factors,
      explanation,
      urgent,
    };
  }

  private priorityRank(priority: string): number {
    switch (priority) {
      case 'critical':
      case 'urgent':
        return 0;
      case 'high':
        return 1;
      case 'medium':
        return 2;
      default:
        return 3;
    }
  }
}