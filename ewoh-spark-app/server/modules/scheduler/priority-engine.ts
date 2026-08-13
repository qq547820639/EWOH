import type {
  SchedulingConstraint,
  SchedulingEventImpact,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { computeBlockingReach } from './task-dag';

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
  /** T03 / P1-1（G4）：本次计算所用策略版本（可审计）。 */
  policyVersion: number;
  /** P0-2：同快照内排序（1-based，越小越靠前）。由 computeEffectivePriorityResults 统一填充；直接 compute 时为 undefined。 */
  rank?: number;
  /** P0-2：触发原因码（base_priority/deadline_risk/waiting_age/production_impact/event_severity/downstream_blocking/manual_boost）。 */
  reasonCodes?: string[];
}

/** 计算优先级所需的输入。 */
export interface PriorityInput {
  task: {
    id: string;
    priority: string;
    planStart?: string | null;
    planEnd?: string | null;
    /** 生产影响度 0..1（越高越影响产线节拍，越小 score 越紧急）。缺省 0。 */
    productionImpact?: number;
  };
  config: SchedulingPolicyConfig;
  now: number;
  horizonEndMs: number;
  downstreamCount: Map<string, number>;
  manualBoostIds: Set<string>;
  /** T03 / P1-1（G4）：开放事件（open 且 severity L2/L3 或 DEADLINE_AT_RISK → deadlineAtRisk=true）。eventId 可选（P0-2 scope 匹配保留）。 */
  events?: Array<{ eventType: string | null; severity: string; eventId?: string }>;
  /** 显式截止风险标记（事件驱动推导结果；缺省由 events 推导）。 */
  deadlineAtRisk?: boolean;
}

const SCALE = 100;

/**
 * 纯优先级引擎（可 new 即用）。
 * 分数约定：越小越紧急。
 * - base：按 priority 等级映射到档位 × SCALE。
 * - deadline：越接近 planEnd 越紧急（修正：不再反向加分）。
 * - waiting age / event severity / production impact / downstream / manual boost：均为负项，缩小 score 提升紧急度。
 * 注意：安全关键（SAFETY_BLOCK）是硬约束，由求解器在校验阶段强制阻断，不参与 score，任何优先级因子均不可覆盖。 */
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

    // 生产影响度：越影响产线节拍越紧急（负项，缩小 score）。
    const productionImpact = Math.max(
      0,
      Math.min(1, input.task.productionImpact ?? 0),
    );
    if (productionImpact > 0) {
      const piTerm = -p.productionImpactWeight * productionImpact * SCALE;
      score += piTerm;
      factors.push({
        name: 'production_impact',
        weight: p.productionImpactWeight,
        value: productionImpact,
        term: piTerm,
      });
      explanation.push(`production_impact=${piTerm.toFixed(2)}`);
    }

    // 事件严重度 / 截止风险标记（T03 / P1-1 G4：死路径修复——从 events 推导 deadlineAtRisk）。
    // 开放（status=open）且 severity L2/L3 或 eventType=DEADLINE_AT_RISK 的事件触发。
    const taskExt = input.task as typeof input.task & {
      deadlineAtRisk?: boolean;
    };
    const eventRisky = (input.events ?? []).some(
      (e) =>
        (e.severity === 'L2' || e.severity === 'L3') ||
        e.eventType === 'DEADLINE_AT_RISK',
    );
    const deadlineAtRisk =
      taskExt.deadlineAtRisk === true || eventRisky;
    if (deadlineAtRisk) {
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

    // P0-2：可解释原因码——base_priority 恒在（基线），其余因子仅当 term≠0（实际生效）时计入。
    const reasonCodes = ['base_priority'].concat(
      factors
        .filter((f) => f.name !== 'base_priority' && f.term !== 0)
        .map((f) => f.name),
    );

    return {
      level: rank,
      score,
      factors,
      explanation,
      urgent,
      policyVersion: policy.version,
      reasonCodes,
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

/**
 * 统一计算快照内所有任务的有效优先级分（越小越紧急）。
 * 供 CP-SAT 与 heuristic 两条求解路径消费同一优先级规则，禁止各自实现独立规则。
 * - downstreamCount：前置依赖的反向阻塞计数（下游越多越紧急）。
 * - manualBoostIds：MANUAL_BOOST 约束指定的人工加急任务。
 */
/**
 * 统一计算快照内所有任务的完整优先级结果（含 score / factors / level / explanation）。
 * 供 CP-SAT 与 heuristic 两条求解路径消费同一优先级规则与解释，禁止各自实现独立规则
 * 或产生伪造的 0/[] 占位（P0-SCHED-002）。
 */
export function computeEffectivePriorityResults(
  policy: SchedulingPolicy,
  config: SchedulingPolicyConfig,
  snapshot: WorldStateSnapshot,
  constraints: SchedulingConstraint[],
  now: number,
  horizonEndMs: number,
): Map<string, PriorityResult> {
  const engine = new PriorityEngine();

  // P1-1：下游阻塞从「直接反向计数」升级为「传递闭包可达数」（Task DAG）。
  // 长链头部任务直接/间接阻塞更多任务，应被识别为更关键；环安全由 computeBlockingReach 保证。
  const downstreamCount = computeBlockingReach(snapshot.tasks);

  const manualBoostIds = new Set<string>();
  for (const c of constraints) {
    if (
      c.type === ('MANUAL_BOOST' as SchedulingConstraint['type']) &&
      c.taskId
    ) {
      manualBoostIds.add(c.taskId);
    }
  }

  const results = new Map<string, PriorityResult>();

  // P0-2：事件 scope——优先用 eventImpacts 做"任务 → 相关开放事件"的匹配，使事件只影响相关任务。
  // 兼容回退：eventImpacts 缺失/为空时保留旧行为（所有开放事件作用于所有任务），保证既有调用方与测试不变。
  const openEventByEventId = new Map<
    string,
    { eventType: string | null; severity: string; eventId?: string }
  >();
  for (const e of snapshot.events ?? []) {
    if (e.status !== 'open') continue;
    openEventByEventId.set(e.eventId, {
      eventType: e.eventType ?? null,
      severity: e.severity,
      eventId: e.eventId,
    });
  }
  const hasEventImpacts =
    Array.isArray(snapshot.eventImpacts) && snapshot.eventImpacts.length > 0;

  for (const t of snapshot.tasks) {
    let events: Array<{ eventType: string | null; severity: string; eventId?: string }>;
    if (hasEventImpacts) {
      // 仅收集与当前任务相关的开放事件。
      events = [];
      for (const imp of snapshot.eventImpacts ?? []) {
        if (imp.status !== 'open') continue;
        if (!isEventRelatedToTask(imp, t)) continue;
        const open = openEventByEventId.get(imp.eventId);
        if (!open) continue; // eventImpacts 引用了非开放事件 → 不参与（fail-safe）。
        events.push(open);
      }
    } else {
      // 向后兼容：全部开放事件。
      events = Array.from(openEventByEventId.values());
    }

    const result = engine.compute(policy, {
      task: {
        id: t.id,
        priority: t.priority,
        planStart: t.planStart,
        planEnd: t.planEnd,
        productionImpact: t.productionImpact,
      },
      config,
      now,
      horizonEndMs,
      downstreamCount,
      manualBoostIds,
      events,
    });
    results.set(t.id, result);
  }

  // P0-2：快照内排序 rank（1-based，score 越小越靠前）。
  const ranked = Array.from(results.values()).sort((a, b) => a.score - b.score);
  ranked.forEach((r, idx) => {
    r.rank = idx + 1;
  });

  return results;
}

/**
 * P0-2：判断事件影响 scope 是否波及给定任务。
 * 任一维度命中即视为相关：直接任务 id / 指派人员 / 设备 / 工位 / 区域。
 */
function isEventRelatedToTask(
  imp: SchedulingEventImpact,
  t: WorldStateSnapshot['tasks'][number],
): boolean {
  if (imp.affectedTaskIds.includes(t.id)) return true;
  if (t.assigneeId && imp.affectedPersonIds.includes(t.assigneeId)) return true;
  if (t.deviceId && imp.affectedDeviceIds.includes(t.deviceId)) return true;
  if (t.stationId && imp.affectedStationIds.includes(t.stationId)) return true;
  if (t.zoneId && imp.affectedZoneIds.includes(t.zoneId)) return true;
  return false;
}

/** 便捷封装：仅返回 score 映射（保持既有调用方兼容）。 */
export function computeEffectivePriorityScores(
  policy: SchedulingPolicy,
  config: SchedulingPolicyConfig,
  snapshot: WorldStateSnapshot,
  constraints: SchedulingConstraint[],
  now: number,
  horizonEndMs: number,
): Map<string, number> {
  const results = computeEffectivePriorityResults(
    policy,
    config,
    snapshot,
    constraints,
    now,
    horizonEndMs,
  );
  const scores = new Map<string, number>();
  for (const [id, r] of results) scores.set(id, r.score);
  return scores;
}