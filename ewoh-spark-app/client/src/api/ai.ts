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
