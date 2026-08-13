/* 统一约束 IR 编译器（Phase 1 / P1-1）。
 *
 * 纯函数模块（非 NestJS Service、无副作用）：把 SchedulingConstraint[] 归一化为
 * SchedulingConstraintIR[]，作为双求解器语义的单一事实源。仅用于审计/解释，
 * 绝不参与启发式/CP-SAT 的任何决策逻辑（求解器仍用现有实现）。
 *
 * reasonCode 与 eligibility.service.ts 实际返回的 reason key 对齐；无对应 key 的
 * 硬约束以求解器真实语义命名（见下方 HARD_META 注释）。
 */
import type {
  ConstraintScope,
  SchedulingConstraint,
  SchedulingConstraintIR,
  SchedulingHardConstraintType,
  SchedulingSoftConstraintType,
} from '@shared/scheduler';
import {
  SUPPORTED_HARD_CONSTRAINTS,
  SUPPORTED_SOFT_CONSTRAINTS,
} from './constraints';

/** 硬约束集合（O(1) 判定）。 */
const HARD_SET = new Set<SchedulingHardConstraintType>(
  SUPPORTED_HARD_CONSTRAINTS,
);
/** 软约束集合（O(1) 判定）。 */
const SOFT_SET = new Set<SchedulingSoftConstraintType>(
  SUPPORTED_SOFT_CONSTRAINTS,
);

/** 编译上下文中的任务描述（字段与 solver 输入一致：WorldStateSnapshot.tasks / SolverRequest.tasks）。 */
export interface ConstraintCompileTask {
  requiredSkills?: string[];
  skillMatchMode?: 'ALL' | 'ANY';
  requiredCertifications?: string[];
  mustFinishByMs?: number | null;
  dueMs?: number | null;
  predIds?: string[];
}

/** 编译上下文：任务/世界状态（供 params 归一化与派生截止约束）。 */
export interface ConstraintCompileContext {
  tasksById?: Map<string, ConstraintCompileTask>;
  /** lateness 权重（due 软约束 penalty 取值来源；缺省不设 penalty）。 */
  weights?: { lateness?: number };
}

/**
 * 硬约束 → { scope, reasonCode } 映射（与 eligibility 的 reason key 对齐）。
 * 无对应 eligibility key 的硬约束以求解器真实语义命名：
 *   - LOCKED_ASSIGNMENT：锁定整个人/设备/工位三元组，求解器语义为锁死分配 → locked_assignment。
 *   - EXCLUDED_RESOURCE：求解器以 isExcludedResource 硬过滤实现 → excluded_resource。
 */
const HARD_META: Record<
  SchedulingHardConstraintType,
  { scope: ConstraintScope; reasonCode: string }
> = {
  REQUIRED_SKILL: { scope: 'person', reasonCode: 'missing_skill' },
  // 过期变体对应 eligibility 的 cert_expired；存在性缺失对应 missing_certification。
  REQUIRED_CERTIFICATION: { scope: 'person', reasonCode: 'missing_certification' },
  PERSON_AVAILABLE: { scope: 'person', reasonCode: 'person_unavailable' },
  DEVICE_AVAILABLE: { scope: 'device', reasonCode: 'device_unavailable' },
  RESOURCE_TIME_WINDOW: { scope: 'person', reasonCode: 'time_conflict' },
  NO_DOUBLE_BOOKING: { scope: 'person', reasonCode: 'time_conflict' },
  PREDECESSOR: { scope: 'task', reasonCode: 'predecessor_pending' },
  FORBIDDEN_ZONE: { scope: 'zone', reasonCode: 'zone_forbidden' },
  MIN_BATTERY: { scope: 'device', reasonCode: 'battery_low' },
  MAX_WORKLOAD: { scope: 'person', reasonCode: 'continuous_work_exceeded' },
  SAFETY_BLOCK: { scope: 'person', reasonCode: 'safety_blocked' },
  LOCKED_PERSON: { scope: 'person', reasonCode: 'person_unavailable' },
  LOCKED_DEVICE: { scope: 'device', reasonCode: 'device_unavailable' },
  LOCKED_STATION: { scope: 'station', reasonCode: 'station_reserved' },
  LOCKED_TIME: { scope: 'task', reasonCode: 'time_conflict' },
  LOCKED_ASSIGNMENT: { scope: 'task', reasonCode: 'locked_assignment' },
  STATION_CAPABILITY: {
    scope: 'station',
    reasonCode: 'station_capability_mismatch',
  },
  STATION_CAPACITY: {
    scope: 'station',
    reasonCode: 'station_capacity_exceeded',
  },
  EXCLUDED_RESOURCE: { scope: 'global', reasonCode: 'excluded_resource' },
};

/**
 * 判定约束硬度（唯一事实源）。EXCLUDED_RESOURCE 同时出现在 hard/soft 两个集合，
 * 按 HARD 优先（与 SUPPORTED_HARD_CONSTRAINTS 一致）。
 */
export function classifyHardness(
  type: SchedulingConstraint['type'],
): 'HARD' | 'SOFT' {
  if (HARD_SET.has(type as SchedulingHardConstraintType)) return 'HARD';
  if (SOFT_SET.has(type as SchedulingSoftConstraintType)) return 'SOFT';
  // 未知类型：非已支持约束，hardness 无权威定义；保守占位 HARD（此类约束会由
  // compileConstraints 标记 reasonCode='UNSUPPORTED_CONSTRAINT'，绝不参与执行）。
  return 'HARD';
}

/**
 * 将 SchedulingConstraint[] 归一化为 SchedulingConstraintIR[]。
 * 覆盖 8 条 parity 关键约束（REQUIRED_SKILL ALL/ANY、REQUIRED_CERTIFICATION、
 * SAFETY_BLOCK、PREDECESSOR、STATION_CAPACITY、mustFinishBy 硬、due 软、
 * EXCLUDED_RESOURCE 重分类）与其余硬/软约束的通用归一化；不支持的约束标记
 * reasonCode='UNSUPPORTED_CONSTRAINT'（复用 determineUnsupported 语义，绝不伪造为已执行）。
 */
export function compileConstraints(
  constraints: SchedulingConstraint[],
  ctx: ConstraintCompileContext = {},
): SchedulingConstraintIR[] {
  const result = constraints.map((c) => compileOne(c, ctx));

  // 派生截止约束（来自任务/世界状态，非用户显式约束）。
  const tasksById = ctx.tasksById;
  if (tasksById) {
    for (const [taskId, task] of tasksById) {
      if (task.mustFinishByMs != null) {
        result.push({
          type: 'MUST_FINISH_BY',
          hardness: 'HARD',
          scope: 'task',
          params: { taskId, mustFinishByMs: task.mustFinishByMs },
          source: 'derived',
          reasonCode: 'must_finish_by_violation',
        });
      }
      if (task.dueMs != null) {
        const dueIR: SchedulingConstraintIR = {
          type: 'DUE',
          hardness: 'SOFT',
          scope: 'task',
          params: { taskId, dueMs: task.dueMs },
          source: 'derived',
          reasonCode: 'due',
        };
        const lateness = ctx.weights?.lateness;
        if (lateness != null) dueIR.penalty = lateness;
        result.push(dueIR);
      }
    }
  }
  return result;
}

function compileOne(
  c: SchedulingConstraint,
  ctx: ConstraintCompileContext,
): SchedulingConstraintIR {
  const base = {
    id: c.id,
    type: c.type,
    hardness: classifyHardness(c.type),
    source: normalizeSource(c.source),
  };

  if (!isSupported(c.type)) {
    // 复用 determineUnsupported 语义：不支持约束绝不标为已执行。
    return {
      ...base,
      scope: inferScope(c),
      params: resourceParams(c),
      reasonCode: 'UNSUPPORTED_CONSTRAINT',
    };
  }

  switch (c.type) {
    case 'REQUIRED_SKILL': {
      const task = taskOf(c, ctx);
      return {
        ...base,
        hardness: 'HARD',
        scope: 'person',
        params: {
          ...resourceParams(c),
          skillMatchMode: task?.skillMatchMode ?? 'ALL',
          requiredSkills: task?.requiredSkills ?? [],
        },
        reasonCode: 'missing_skill',
      };
    }
    case 'REQUIRED_CERTIFICATION': {
      const task = taskOf(c, ctx);
      return {
        ...base,
        hardness: 'HARD',
        scope: 'person',
        params: {
          ...resourceParams(c),
          requiredCertifications: task?.requiredCertifications ?? [],
        },
        reasonCode: 'missing_certification',
      };
    }
    case 'SAFETY_BLOCK':
      return {
        ...base,
        hardness: 'HARD',
        scope: 'person',
        params: resourceParams(c),
        reasonCode: 'safety_blocked',
      };
    case 'PREDECESSOR': {
      const task = taskOf(c, ctx);
      return {
        ...base,
        hardness: 'HARD',
        scope: 'task',
        params: {
          ...resourceParams(c),
          predIds: task?.predIds ?? [],
        },
        reasonCode: 'predecessor_pending',
      };
    }
    case 'STATION_CAPACITY':
      return {
        ...base,
        hardness: 'HARD',
        scope: 'station',
        params: {
          ...resourceParams(c),
          ...(c.value != null ? { capacity: c.value } : {}),
        },
        reasonCode: 'station_capacity_exceeded',
      };
    case 'EXCLUDED_RESOURCE':
      // T03 / P1-3：EXCLUDED_RESOURCE 由 soft 重分类为 hard（与 SUPPORTED_HARD_CONSTRAINTS 一致）。
      return {
        ...base,
        hardness: 'HARD',
        scope: inferResourceScope(c),
        params: resourceParams(c),
        reasonCode: 'excluded_resource',
      };
    default:
      break;
  }

  if (HARD_SET.has(c.type as SchedulingHardConstraintType)) {
    const meta = HARD_META[c.type as SchedulingHardConstraintType];
    return {
      ...base,
      hardness: 'HARD',
      scope: meta.scope,
      params: resourceParams(c),
      reasonCode: meta.reasonCode,
    };
  }

  // 软约束：hardness=SOFT，reasonCode=类型名小写蛇形（如 MIN_TRAVEL_TIME → min_travel_time）。
  return {
    ...base,
    hardness: 'SOFT',
    scope: inferScope(c),
    params: resourceParams(c),
    reasonCode: c.type.toLowerCase(),
  };
}

function isSupported(type: SchedulingConstraint['type']): boolean {
  return (
    HARD_SET.has(type as SchedulingHardConstraintType) ||
    SOFT_SET.has(type as SchedulingSoftConstraintType)
  );
}

function normalizeSource(
  source: SchedulingConstraint['source'],
): SchedulingConstraintIR['source'] {
  return source === 'manual' || source === 'system' || source === 'auto'
    ? source
    : 'manual';
}

/** 收集约束的资源标识/数值参数到 params（IR 无独立资源字段）。 */
function resourceParams(c: SchedulingConstraint): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (c.taskId != null) params.taskId = c.taskId;
  if (c.personId != null) params.personId = c.personId;
  if (c.deviceId != null) params.deviceId = c.deviceId;
  if (c.stationId != null) params.stationId = c.stationId;
  if (c.zoneId != null) params.zoneId = c.zoneId;
  if (c.startMs != null) params.startMs = c.startMs;
  if (c.endMs != null) params.endMs = c.endMs;
  if (c.value != null) params.value = c.value;
  return params;
}

function taskOf(
  c: SchedulingConstraint,
  ctx: ConstraintCompileContext,
): ConstraintCompileTask | undefined {
  return c.taskId ? ctx.tasksById?.get(c.taskId) : undefined;
}

/** 通用 scope 推断（按 person/device/station/zone/task 优先级）。 */
function inferScope(c: SchedulingConstraint): ConstraintScope {
  if (c.personId) return 'person';
  if (c.deviceId) return 'device';
  if (c.stationId) return 'station';
  if (c.zoneId) return 'zone';
  if (c.taskId) return 'task';
  return 'global';
}

/** 资源排除约束 scope 推断（仅资源维度，无资源时全局）。 */
function inferResourceScope(c: SchedulingConstraint): ConstraintScope {
  if (c.personId) return 'person';
  if (c.deviceId) return 'device';
  if (c.stationId) return 'station';
  return 'global';
}
