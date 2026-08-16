// simulation.ts — 仿真运行控制台 API（R-57 / ADR-036，L6 生产消费面）。
//
// 消费 ADR-025 SimulationRun 体系（ewoh_simulation_run 权威台账）：
//  - POST /api/simulation/runs           创建运行（服务端契约 fail-closed + 确定性评估）
//  - GET  /api/simulation/runs           运行列表（租户作用域，created_at 倒序，
//                                        条目含完整 results/failureReason）
// 无本地状态、无静默 mock；错误由调用方（React Query）显式呈现。
import { axiosForBackend } from '../lib/http';

export interface SimulationRunRequest {
  runId?: string;
  kind: string;
  baseRef: { snapshotVersion: number; scenarioId?: string };
  parameters: Record<string, unknown>;
  engineVersion?: string;
}

export interface SimulationRun {
  runId: string;
  kind: string;
  status: string;
  isSimulation: boolean;
  baseRef: Record<string, unknown>;
  parameters: Record<string, unknown>;
  results?: Record<string, unknown>;
  failureReason?: string;
  engineVersion: string;
  auditTrail: boolean;
}

export interface SimulationRunResponse {
  run: SimulationRun;
  created: boolean;
}

export async function runSimulation(body: SimulationRunRequest): Promise<SimulationRunResponse> {
  const res = await axiosForBackend({
    url: '/api/simulation/runs',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listSimulationRuns(params?: {
  kind?: string;
  status?: string;
}): Promise<SimulationRun[]> {
  const res = await axiosForBackend({
    url: '/api/simulation/runs',
    method: 'GET',
    params,
  });
  return res.data;
}
