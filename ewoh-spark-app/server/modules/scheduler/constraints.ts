/* 调度约束类型系统
 *
 * 核心目标：API 接受的任何约束要么被求解器真实执行，要么被显式报告为
 * UNSUPPORTED_CONSTRAINT，绝不静默忽略。
 *
 * 本模块为纯常量 + 纯函数模块（非 NestJS Service），供约束检查与
 * 启发式求解器共同使用。
 */

import {
  SchedulingConstraint,
  SchedulingHardConstraintType,
  SchedulingSoftConstraintType,
} from '@shared/api.interface';

/** 启发式求解器真实执行的硬约束集合（当前全部 15 个，倾向从严）。 */
export const SUPPORTED_HARD_CONSTRAINTS: readonly SchedulingHardConstraintType[] = [
  'REQUIRED_SKILL',
  'REQUIRED_CERTIFICATION',
  'PERSON_AVAILABLE',
  'DEVICE_AVAILABLE',
  'RESOURCE_TIME_WINDOW',
  'NO_DOUBLE_BOOKING',
  'PREDECESSOR',
  'FORBIDDEN_ZONE',
  'MIN_BATTERY',
  'MAX_WORKLOAD',
  'SAFETY_BLOCK',
  'LOCKED_PERSON',
  'LOCKED_DEVICE',
  'LOCKED_STATION',
  'LOCKED_TIME',
  'LOCKED_ASSIGNMENT',
];

/** 求解器应用的软约束集合（全部 9 个，贡献到目标评分）。 */
export const SUPPORTED_SOFT_CONSTRAINTS: readonly SchedulingSoftConstraintType[] = [
  'MIN_TRAVEL_TIME',
  'BALANCE_WORKLOAD',
  'MIN_CHANGE',
  'MIN_WAIT',
  'PREFER_SAME_TEAM',
  'PREFER_NEARBY_RESOURCE',
  'EXCLUDED_RESOURCE',
  'PREFERRED_RESOURCE',
  'MANUAL_BOOST',
];

/** 启发式求解器暂未实现的硬约束（当前为空，为未来约束预留）。 */
export const HEURISTIC_SOLVER_UNSUPPORTED: readonly SchedulingHardConstraintType[] = [];

/** 约束支持性检查结果。 */
export interface ConstraintSupportResult {
  constraint: SchedulingConstraint;
  supported: boolean;
  reason?: 'UNSUPPORTED_CONSTRAINT' | 'OK';
}

/** 硬约束类型集合（用于 O(1) 判定）。 */
const SUPPORTED_HARD_SET: ReadonlySet<SchedulingHardConstraintType> = new Set(
  SUPPORTED_HARD_CONSTRAINTS,
);

/** 软约束类型集合（用于 O(1) 判定）。 */
const SUPPORTED_SOFT_SET: ReadonlySet<SchedulingSoftConstraintType> = new Set(
  SUPPORTED_SOFT_CONSTRAINTS,
);

/**
 * 检查单个约束是否被求解器支持。
 * 硬约束命中 SUPPORTED_HARD_CONSTRAINTS、软约束命中 SUPPORTED_SOFT_CONSTRAINTS
 * 即视为支持；否则返回 supported=false 且 reason='UNSUPPORTED_CONSTRAINT'。
 */
export function checkConstraintSupported(
  constraint: SchedulingConstraint,
): ConstraintSupportResult {
  const { type } = constraint;
  const supported =
    SUPPORTED_HARD_SET.has(type as SchedulingHardConstraintType) ||
    SUPPORTED_SOFT_SET.has(type as SchedulingSoftConstraintType);

  return {
    constraint,
    supported,
    reason: supported ? 'OK' : 'UNSUPPORTED_CONSTRAINT',
  };
}

/**
 * 将每个约束映射到其支持性检查结果，仅返回不支持的约束。
 * 用于在求解前一次性识别所有无法被执行、必须显式拒绝的约束。
 */
export function determineUnsupported(
  constraints: SchedulingConstraint[],
): ConstraintSupportResult[] {
  return constraints
    .map((constraint) => checkConstraintSupported(constraint))
    .filter((result) => !result.supported);
}

/**
 * 在给定任务集合上，利用 predecessorOf 探测前置依赖环。
 * 使用 DFS + visiting 集合（灰/黑两态）找环。
 * 若存在环，返回环路径（任务 ID 数组，首尾相同）；否则返回 null。
 */
export function detectDependencyCycle(
  taskIds: string[],
  predecessorOf: (taskId: string) => string[],
): string[] | null {
  // 白=未访问，灰=访问中（当前 DFS 栈）、黑=已完成。
  const white = new Set(taskIds);
  const gray = new Set<string>();
  const black = new Set<string>();

  const dfs = (node: string, path: string[]): string[] | null => {
    gray.add(node);
    white.delete(node);
    path.push(node);

    for (const pred of predecessorOf(node)) {
      if (!white.has(pred) && !gray.has(pred) && !black.has(pred)) {
        // 前置任务不在给定集合内，忽略（仅检测集合内部环）。
        continue;
      }
      if (gray.has(pred)) {
        // 找到环：从 pred 到 node 的路径段即环。
        const start = path.indexOf(pred);
        return [...path.slice(start), pred];
      }
      if (white.has(pred)) {
        const cycle = dfs(pred, path);
        if (cycle) {
          return cycle;
        }
      }
    }

    path.pop();
    gray.delete(node);
    black.add(node);
    return null;
  };

  for (const taskId of taskIds) {
    if (white.has(taskId)) {
      const cycle = dfs(taskId, []);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}