/* M05：DecisionTrace 解释纯选择器（Task Intelligence / RejectedCandidateExplain）。
 *
 * 消费服务端 DecisionTrace（heuristic 已产出 rejectedHard/hardConstraints/
 * softCosts/weightsSnapshot），前端只渲染不重算 hard constraints。
 * 纯函数、无 React 依赖、可 node 单测。禁止 import 任何 hard 判定逻辑。
 */
import type { DecisionTrace } from '@shared/api.interface';

export interface RejectedHardItem {
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  rejectReasons: string[];
  /** 可读文案（仅映射已知原因；未知原样透传）。 */
  reasonLabels: string[];
}

export interface DecisionExplainVM {
  taskId: string;
  priorityLevel: string;
  priorityScore: number | null;
  priorityFactors: Array<{ key: string; label: string; value: number }>;
  selected: { personId: string | null; deviceId: string | null; stationId: string | null };
  selectedReason: string[];
  rejectedHard: RejectedHardItem[];
  hardConstraints: string[];
  softCosts: Record<string, number>;
  weightsSnapshot: Record<string, number>;
  stationContribution: { stationId: string | null; queueLength: number; changeover: boolean } | null;
}

/** 纯函数：DecisionTrace → 展示模型（rejectedHard 结构化，前端不重算）。 */
export function decisionExplainVM(trace: DecisionTrace | null | undefined): DecisionExplainVM | null {
  if (!trace) return null;
  const rejectedHard = (trace.rejectedHard ?? []).map((r) => ({
    ...r,
    reasonLabels: (r.rejectReasons ?? []).map(decisionReasonLabel),
  }));
  return {
    taskId: trace.taskId,
    priorityLevel: trace.priority.level,
    priorityScore: trace.priority.score ?? null,
    priorityFactors: (trace.priority.factors ?? []).map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      value: f.value,
    })),
    selected: {
      personId: trace.selected?.personId ?? null,
      deviceId: trace.selected?.deviceId ?? null,
      stationId: trace.selected?.stationId ?? null,
    },
    selectedReason: trace.selectedReason ?? [],
    rejectedHard,
    hardConstraints: trace.hardConstraints ?? [],
    softCosts: trace.softCosts ?? {},
    weightsSnapshot: trace.weightsSnapshot ?? {},
    stationContribution: trace.stationContribution ?? null,
  };
}

/** 拒绝原因可读文案（仅映射已知原因；未知原样透传，禁止前端判定）。 */
export function decisionReasonLabel(reason: string): string {
  const LABELS: Record<string, string> = {
    REQUIRED_SKILL: '缺少技能',
    REQUIRED_CERTIFICATION: '缺少证书',
    PERSON_AVAILABLE: '人员不可用',
    DEVICE_AVAILABLE: '设备不可用',
    RESOURCE_TIME_WINDOW: '时间窗冲突',
    NO_DOUBLE_BOOKING: '重复占用',
    PREDECESSOR: '前置未完成',
    FORBIDDEN_ZONE: '禁入区',
    MIN_BATTERY: '电量不足',
    MAX_WORKLOAD: '负荷超限',
    SAFETY_BLOCK: '安全封锁',
    LOCKED_PERSON: '人员锁定',
    LOCKED_DEVICE: '设备锁定',
    LOCKED_STATION: '工位锁定',
    LOCKED_TIME: '时间锁定',
    LOCKED_ASSIGNMENT: '分配锁定',
    STATION_CAPABILITY: '工位能力不足',
    STATION_CAPACITY: '工位容量已满',
    EXCLUDED_RESOURCE: '资源已排除',
    ROUTE_BLOCKED: '路线阻断',
    ROUTE_CONGESTED: '路线拥塞',
    route_infeasible: '路径不可行',
    missing_skill: '缺少技能',
    missing_certification: '缺少证书',
    device_offline: '设备离线',
    low_battery: '电量不足',
    safety_blocked: '安全封锁',
    forbidden_zone: '禁入区',
    time_conflict: '时间冲突',
    station_capacity_exceeded: '工位容量超限',
    must_finish_by_violation: '违反硬截止',
  };
  return LABELS[reason] ?? reason;
}
