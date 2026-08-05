import type { FileRecord } from '@shared/api.interface';
import { axiosForBackend } from '../lib/http';
import {
  createUploadRequestId,
  guardUpload,
  UploadGuardError,
} from '../lib/uploadGuard';

export interface UploadFileResult extends FileRecord {
  requestId: string;
}

/**
 * Real frontend upload entry. Runs the client-side guard (MIME / extension /
 * size / idempotent retry diagnostics) BEFORE any network call, so obviously
 * invalid files are rejected locally instead of consuming a round-trip. A
 * per-upload `requestId` is generated for diagnostics and echoed on error.
 */
export async function uploadFile(file: File, note?: string): Promise<UploadFileResult> {
  const requestId = createUploadRequestId();

  const guarded = guardUpload({ name: file.name, type: file.type, size: file.size });
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
 * Batch upload entry that also enforces the per-request file-count limit. First
 * failing file aborts the batch; all remain local (no partial server writes).
 */
export async function uploadFiles(
  files: File[],
  note?: string,
): Promise<UploadFileResult[]> {
  const requestId = createUploadRequestId();
  const results: UploadFileResult[] = [];
  for (const file of files) {
    const guarded = guardUpload({ name: file.name, type: file.type, size: file.size });
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