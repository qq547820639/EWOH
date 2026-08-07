import { axiosForBackend } from '../lib/http';

export interface AiSuggestion {
  id: string;
  problem: string;
  snapshotVersion: number;
  basis: string[];
  suggestion: string;
  risk: string[];
  uncertainty: string[];
  confirmItems: string[];
}

export interface AiPlan {
  id: string;
  suggestionId: string;
  isSimulation: boolean;
  status: string;
  content: Record<string, unknown>;
}

export async function createSuggestion(input: {
  triggeredBy: string;
  problem: string;
  snapshot: { version: number; from: string; to: string; records: number };
}): Promise<AiSuggestion> {
  const res = await axiosForBackend({ url: '/api/ai/suggestions', method: 'POST', data: input });
  return res.data;
}

export async function createPlan(suggestionId: string, content: Record<string, unknown>): Promise<AiPlan> {
  const res = await axiosForBackend({
    url: '/api/ai/plans',
    method: 'POST',
    data: { suggestionId, content },
  });
  return res.data;
}

export interface VisionUnderstandResult {
  status: number;
  ok: boolean;
  backend?: string;
  model?: string;
  answer?: string;
  error?: string;
  now?: string;
}

export async function visionUnderstand(input: {
  image_url?: string;
  question?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
}): Promise<VisionUnderstandResult> {
  const res = await axiosForBackend({
    url: '/api/ai/vision/understand',
    method: 'POST',
    data: input,
    timeout: 65000,
  });
  return res.data;
}

export interface AiConfigStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}

/** GET /api/ai/config/status — 查询全局 AI 配置状态。 */
export async function getAiConfigStatus(): Promise<AiConfigStatus> {
  const res = await axiosForBackend({ url: '/api/ai/config/status', method: 'GET' });
  return res.data;
}

/** PUT /api/ai/config — 保存全局 AI 配置（供整个系统共享）。 */
export async function saveAiConfig(input: {
  api_key?: string;
  base_url?: string;
  model?: string;
}): Promise<AiConfigStatus> {
  const res = await axiosForBackend({ url: '/api/ai/config', method: 'PUT', data: input });
  return res.data;
}

export interface AiChatResult {
  ok: boolean;
  answer: string;
  model: string;
  error?: string;
  context?: string;
}

/** POST /api/ai/chat — 自然语言问答（采集系统实时上下文调用 Ark）。 */
export async function aiChat(question: string): Promise<AiChatResult> {
  const res = await axiosForBackend({
    url: '/api/ai/chat',
    method: 'POST',
    data: { question },
    timeout: 180000,
  });
  return res.data;
}
