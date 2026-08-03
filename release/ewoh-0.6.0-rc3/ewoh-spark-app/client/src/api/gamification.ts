import { axiosForBackend } from '../lib/http';
import type {
  PlayerRoleInfo,
  ResourceAllocationRequest,
  ResourceAllocationResult,
  TaskOrchestrationRequest,
  TaskOrchestrationResult,
  DispatchRequest,
  DispatchResult,
  ExoFeedbackRequest,
  ExoFeedbackResult,
  BrainSuggestion,
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

export async function dispatchPlan(
  planId: string,
  body: DispatchRequest,
): Promise<DispatchResult> {
  const res = await axiosForBackend({
    url: `/api/gamification/schedule/${planId}/dispatch`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

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
