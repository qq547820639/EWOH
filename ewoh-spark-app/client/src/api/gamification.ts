import { axiosForBackend } from '../lib/http';
import type {
  PlayerRoleInfo,
  ResourceAllocationRequest,
  ResourceAllocationResult,
  TaskOrchestrationRequest,
  TaskOrchestrationResult,
  ExoFeedbackRequest,
  ExoFeedbackResult,
  BrainSuggestion,
  ApplyBrainSuggestionRequest,
  ApplyBrainSuggestionResult,
} from '@shared/api.interface';

export async function getRole(): Promise<PlayerRoleInfo> {
  const res = await axiosForBackend({ url: '/api/gamification/role', method: 'GET' });
  return res.data;
}

export async function allocateResources(
  body: ResourceAllocationRequest,
): Promise<ResourceAllocationResult> {
  const res = await axiosForBackend({
    url: '/api/gamification/resources/allocate',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function orchestrateTask(
  body: TaskOrchestrationRequest,
): Promise<TaskOrchestrationResult> {
  const res = await axiosForBackend({
    url: '/api/gamification/tasks/orchestrate',
    method: 'POST',
    data: body,
  });
  return res.data;
}

// T4 前置清理（2026-08-28 审计）：原 dispatchPlan 封装（指向
// /api/gamification/schedule/:planId/dispatch 旁路端点）为死代码——
// 全前端零组件调用（所有派工 UI 均走 api/scheduler.ts 的 dispatchPlanV2
// 正统路径），随 EWOH-待拍板决策单.md 的 T4 收敛决策一并下线。
// 后端端点与 OpenAPI 契约的处置见决策单（待拍板，本轮不动）。

export async function sendExoFeedback(
  deviceId: string,
  body: ExoFeedbackRequest,
): Promise<ExoFeedbackResult> {
  const res = await axiosForBackend({
    url: `/api/gamification/exo/${deviceId}/feedback`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function getBrainSuggestions(): Promise<BrainSuggestion[]> {
  const res = await axiosForBackend({
    url: '/api/gamification/brain/suggestions',
    method: 'GET',
  });
  return res.data;
}

export async function applyBrainSuggestion(
  body: ApplyBrainSuggestionRequest,
): Promise<ApplyBrainSuggestionResult> {
  const res = await axiosForBackend({
    url: '/api/gamification/brain/apply',
    method: 'POST',
    data: body,
  });
  return res.data;
}
