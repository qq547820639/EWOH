/* Task 5 / P1：Solver 状态链展示 VM（纯函数）。
 *
 * 消费服务端 SchedulingPlanV2.solverStatus / solverVersion（shared/scheduler.ts：
 * solverStatus 为求解器实际产出状态，solverVersion 为求解器版本）。
 * 映射规则（仅展示服务端已知信息，未知/缺失不伪造链）：
 * - OPTIMAL/FEASIBLE         → CP-SAT 求解器产出（最优/可行解）；
 * - HEURISTIC                → 启发式求解器（生产规范路径）；
 * - FALLBACK/TIMEOUT/UNAVAILABLE → CP-SAT 请求 → 失败 → 启发式回退（三态链）；
 * - INFEASIBLE               → CP-SAT 无可行解；
 * - 缺失/未知                → 不输出链（只保留版本等已知字段）。
 */
import type { SolverStatus } from '@shared/api.interface';

export type SolverChainStepKind = 'primary' | 'failed' | 'fallback' | 'result';

export interface SolverChainStep {
  key: string;
  label: string;
  kind: SolverChainStepKind;
}

/** 状态 → 单行展示标签（SYSTEM_DECISION 段用）。 */
export const SOLVER_STATUS_LABELS: Record<string, string> = {
  OPTIMAL: 'CP-SAT 最优解',
  FEASIBLE: 'CP-SAT 可行解',
  HEURISTIC: '启发式求解器（生产规范）',
  FALLBACK: 'CP-SAT 不可用 → 启发式回退',
  TIMEOUT: 'CP-SAT 超时 → 启发式回退',
  UNAVAILABLE: 'CP-SAT 不可用 → 启发式回退',
  INFEASIBLE: 'CP-SAT 无可行解',
};

/** 状态 → 状态链（null = 无/未知状态，不伪造链）。 */
export function solverStatusChain(status: SolverStatus | null | undefined): SolverChainStep[] | null {
  if (!status) return null;
  switch (status) {
    case 'OPTIMAL':
      return [
        { key: 'cp-sat', label: 'CP-SAT 求解器', kind: 'primary' },
        { key: 'optimal', label: '最优解 OPTIMAL', kind: 'result' },
      ];
    case 'FEASIBLE':
      return [
        { key: 'cp-sat', label: 'CP-SAT 求解器', kind: 'primary' },
        { key: 'feasible', label: '可行解 FEASIBLE', kind: 'result' },
      ];
    case 'HEURISTIC':
      return [{ key: 'heuristic', label: '启发式求解器（生产规范）', kind: 'primary' }];
    case 'FALLBACK':
      return [
        { key: 'requested', label: 'CP-SAT 请求', kind: 'primary' },
        { key: 'fallback', label: '回退 FALLBACK', kind: 'failed' },
        { key: 'heuristic-fallback', label: '启发式兜底', kind: 'fallback' },
      ];
    case 'TIMEOUT':
      return [
        { key: 'requested', label: 'CP-SAT 请求', kind: 'primary' },
        { key: 'timeout', label: '超时 TIMEOUT', kind: 'failed' },
        { key: 'heuristic-fallback', label: '启发式兜底', kind: 'fallback' },
      ];
    case 'UNAVAILABLE':
      return [
        { key: 'requested', label: 'CP-SAT 请求', kind: 'primary' },
        { key: 'unavailable', label: '不可用 UNAVAILABLE', kind: 'failed' },
        { key: 'heuristic-fallback', label: '启发式兜底', kind: 'fallback' },
      ];
    case 'INFEASIBLE':
      return [
        { key: 'cp-sat', label: 'CP-SAT 求解器', kind: 'primary' },
        { key: 'infeasible', label: '无可行解 INFEASIBLE', kind: 'failed' },
      ];
    default:
      return null;
  }
}
