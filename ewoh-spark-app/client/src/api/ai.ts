import { axiosForBackend } from '../lib/http';
import { getAccessToken } from '../lib/auth';

/*
 * CLI-721（裁决确认）：visionUnderstand / saveAiConfig 接受可选 api_key 并
 * 经前端转发至后端。脱敏核查结论：
 *  1. 本文件不记录任何请求体日志，不在 URL/query 中携带 api_key（仅 POST body）；
 *  2. lib/http.ts 的拦截器只写 Authorization 头，不落日志；
 *  3. lib/observability.ts 的指标只含 url 路径与状态码，不含请求体。
 * 密钥经 HTTPS body 直达后端，前端不持久化。维持现状，不额外改动。
 */

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

export interface SuggestionStreamEvent {
  phase: 'basis' | 'delta' | 'done';
  suggestion?: AiSuggestion;
  delta?: string;
  error?: string;
}

/** AI 接入优化（2026-08-18）：建议生成流式版（SSE）——骨架先出 → LLM 打字机 → done。
 * 返回最终建议；出错返回 null（错误经 onEvent 透传）。 */
export async function createSuggestionStream(
  input: {
    triggeredBy: string;
    problem: string;
    snapshot: { version: number; from: string; to: string; records: number };
  },
  onEvent: (evt: SuggestionStreamEvent) => void,
  signal?: AbortSignal,
): Promise<AiSuggestion | null> {
  const res = await fetch('/api/ai/suggestions/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAccessToken() ?? ''}`,
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    onEvent({ phase: 'done', error: `HTTP ${res.status}: ${text.slice(0, 200)}` });
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: AiSuggestion | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        let evt: SuggestionStreamEvent;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        onEvent(evt);
        if (evt.phase === 'done' && evt.suggestion) final = evt.suggestion;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return final;
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

/** GET /api/ai/snapshot-version — 本租户当前推理快照版本号（真实数据源，CLI-001）。 */
export async function getAiSnapshotVersion(): Promise<{ version: number }> {
  const res = await axiosForBackend({ url: '/api/ai/snapshot-version', method: 'GET' });
  return res.data;
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

export interface AiChatStreamEvent {
  delta?: string;
  done?: boolean;
  ok?: boolean;
  model?: string;
  answer?: string;
  error?: string;
}

/**
 * POST /api/ai/chat（SSE 流式）— 自然语言问答，逐增量回调渲染（打字机效果）。
 * 后端输出 `data: {delta}` → `data: {done, ok, model, answer}`；出错输出 `data: {error}`。
 */
export async function aiChatStream(
  question: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AiChatResult> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAccessToken() ?? ''}`,
    },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    return { ok: false, answer: '', model: '', error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let model = '';
  let error: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        let evt: AiChatStreamEvent;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.delta) {
          answer += evt.delta;
          onDelta(evt.delta);
        }
        if (evt.error) error = evt.error;
        if (evt.done) {
          if (evt.answer) answer = evt.answer;
          if (evt.model) model = evt.model;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: !error, answer, model, error };
}
