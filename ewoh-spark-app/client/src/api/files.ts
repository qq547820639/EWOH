import type { FileRecord } from '@shared/api.interface';
import { axiosForBackend } from '../lib/http';
import {
  createUploadRequestId,
  guardUploadStreaming,
  UploadGuardError,
} from '../lib/uploadGuard';

export interface UploadFileResult extends FileRecord {
  requestId: string;
}

/**
 * Real frontend upload entry. Runs the client-side guard (MIME / extension /
 * size / magic bytes / idempotent retry diagnostics) BEFORE any network call,
 * so obviously invalid files are rejected locally instead of consuming a
 * round-trip. A per-upload `requestId` is generated for diagnostics and echoed
 * on error. Magic-bytes validation streams only the first few bytes (never the
 * whole file into memory).
 */
export async function uploadFile(file: File, note?: string): Promise<UploadFileResult> {
  const requestId = createUploadRequestId();

  const guarded = await guardUploadStreaming({
    name: file.name,
    type: file.type,
    size: file.size,
    slice: (start, end) => file.slice(start, end),
  });
  if (!guarded.ok) {
    throw buildGuardError(guarded.reason ?? 'invalid file', requestId);
  }

  const form = new FormData();
  form.append('file', file);
  if (note) {
    form.append('note', note);
  }
  try {
    const res = await axiosForBackend<FileRecord & { requestId?: string }>({
      url: '/api/files',
      method: 'POST',
      data: form,
      headers: { 'X-Request-Id': requestId },
    });
    return { ...res.data, requestId: res.data.requestId ?? requestId };
  } catch (error) {
    throw enrich(error, requestId);
  }
}

/**
 * Batch upload entry that also enforces the per-request file-count limit.
 * CLI-713：串行上传——某文件失败即中止批次，但失败之前已上传的文件会
 * 保留在服务端（客户端无批量回滚），调用方提示用户处理；串行也避免
 * 并发上传抢占连接。注释原先声称「no partial server writes」与实际
 * 行为不符，已更正。
 */
export async function uploadFiles(
  files: File[],
  note?: string,
): Promise<UploadFileResult[]> {
  const requestId = createUploadRequestId();
  const results: UploadFileResult[] = [];
  for (const file of files) {
    const guarded = await guardUploadStreaming({
      name: file.name,
      type: file.type,
      size: file.size,
      slice: (start, end) => file.slice(start, end),
    });
    if (!guarded.ok) {
      throw buildGuardError(guarded.reason ?? 'invalid file', requestId);
    }
    results.push(await uploadFile(file, note));
  }
  return results;
}

function buildGuardError(reason: string, requestId: string): UploadGuardError {
  return new UploadGuardError(reason, requestId);
}

function enrich(error: unknown, requestId: string): unknown {
  if (error instanceof Error) {
    const enriched = error as Error & { requestId?: string };
    if (!enriched.requestId) {
      enriched.requestId = requestId;
    }
    return enriched;
  }
  return error;
}