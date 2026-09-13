/* Phase 3 / P3-T3 前端：任务候选解释展示 VM（纯函数）。
 *
 * 输入 = 后端 GET /api/scheduler/tasks/:taskId/candidates 的 TaskCandidatesResponse
 * （资格判定 + 路径可行性均由后端完成），输出 = 前端展示模型：
 * - eligible 按评分排序（越小越优）+ 每候选展示 score breakdown / route ETA/距离 / 技能/负荷；
 * - rejected 展示排除原因（missing_skill / route_infeasible 等，来自后端 reasons）。
 * 前端不判资格、不重算优先级，只透传后端字段。
 */
import type { TaskCandidatesResponse, TaskCandidateResource } from '@shared/api.interface';
import { rejectReasonLabel } from '@shared/reject-reason';

export interface CandidateExplainItem {
  personId: string;
  personName: string;
  deviceId: string | null;
  stationId: string | null;
  eligible: boolean;
  rank: number | null;
  /** 展示评分（越小越优；不可行为 Infinity 不展示数字）。 */
  score: number;
  skillMatch: boolean;
  workload: number;
  batteryPct: number | null;
  reservationConflict: boolean;
  etaSeconds: number;
  distanceMeters: number;
  /** 排除原因（后端 reasons）。 */
  reasons: string[];
  /** 结构化拒绝原因（后端 rejectReasons，透传不重算；eligible=false 时非空）。 */
  rejectReasons: string[];
  /** 能力相关拒绝的可读细节（可空；后端生成的解释，前端不重算）。 */
  capabilityNotes: string[];
  /** NO-38b：会话相关的前向说明（人机同体配对；后端生成，前端只透传）。 */
  sessionNotes: string[];
  /** 评分分解（后端 scoreBreakdown，透传不重算；不可行候选为 null）。 */
  scoreBreakdown: TaskCandidateResource['scoreBreakdown'];
  /** 工位维度候选明细（后端 stationOptions，透传不重算）。 */
  stationOptions: TaskCandidateResource['stationOptions'];
  /** 是否当前锁定受让人（后端 lockedAssigneeId）。 */
  isLockedAssignee: boolean;
}

export interface CandidateExplainVM {
  taskId: string;
  taskTitle: string | null;
  taskStatus: string | null;
  assigned: boolean;
  lockedAssigneeId: string | null;
  lockedDeviceId: string | null;
  solverVersion: string;
  generatedAt: string;
  eligible: CandidateExplainItem[];
  rejected: CandidateExplainItem[];
  /** 是否候选为空（无任何可派资源）。 */
  noCandidate: boolean;
  eligibleCount: number;
  rejectedCount: number;
}

/** 纯函数：后端候选响应 → 展示模型（按评分排序，不透传不可行项）。 */
export function candidateExplainVM(res: TaskCandidatesResponse): CandidateExplainVM {
  const items: CandidateExplainItem[] = (res.candidates ?? []).map((c) => ({
    personId: c.personId,
    personName: c.personName,
    deviceId: c.deviceId ?? null,
    stationId: c.stationId ?? null,
    eligible: Boolean(c.eligible),
    rank: null, // 排序后按名次赋值
    score: c.score,
    skillMatch: Boolean(c.skillMatch),
    workload: c.workload ?? 0,
    batteryPct: c.batteryPct ?? null,
    reservationConflict: Boolean(c.reservationConflict),
    etaSeconds: c.etaSeconds ?? 0,
    distanceMeters: c.distanceMeters ?? 0,
    reasons: Array.isArray(c.reasons) ? c.reasons : [],
    rejectReasons: Array.isArray(c.rejectReasons) ? c.rejectReasons : [],
    // NO-15b：能力拒绝的可读细节（哪个能力、谁/何时/为何停用）——后端生成，前端只透传
    capabilityNotes: Array.isArray(c.capabilityNotes) ? c.capabilityNotes : [],
    // NO-38b：会话相关的正向说明（该设备正由本候选人员佩戴 = 人机同体）
    sessionNotes: Array.isArray(c.sessionNotes) ? c.sessionNotes : [],
    scoreBreakdown: c.scoreBreakdown ?? null,
    stationOptions: Array.isArray(c.stationOptions) ? c.stationOptions : [],
    isLockedAssignee: Boolean(res.lockedAssigneeId) && c.personId === res.lockedAssigneeId,
  }));

  const eligible = items
    .filter((c) => c.eligible)
    .sort((a, b) => {
      if (!Number.isFinite(a.score) && !Number.isFinite(b.score)) return 0;
      if (!Number.isFinite(a.score)) return 1;
      if (!Number.isFinite(b.score)) return -1;
      return a.score - b.score;
    })
    .map((c, i) => ({ ...c, rank: i + 1 }));
  const rejected = items.filter((c) => !c.eligible);

  return {
    taskId: res.taskId,
    taskTitle: res.taskTitle ?? null,
    taskStatus: res.taskStatus ?? null,
    assigned: Boolean(res.assigned),
    lockedAssigneeId: res.lockedAssigneeId ?? null,
    lockedDeviceId: res.lockedDeviceId ?? null,
    solverVersion: res.solverVersion,
    generatedAt: res.generatedAt,
    eligible,
    rejected,
    noCandidate: eligible.length === 0,
    eligibleCount: eligible.length,
    rejectedCount: rejected.length,
  };
}

/**
 * 候选行的可读 reason 文案。
 *
 * 文案唯一来源 = `shared/reject-reason.ts`（穷尽词表 + 未登记键显式标记）。
 * 此前本文件自建 11 条映射，既与其它面板不一致，也漏掉维护/质量/连续负荷等键。
 */
export function candidateReasonLabel(reason: string): string {
  return rejectReasonLabel(reason);
}
