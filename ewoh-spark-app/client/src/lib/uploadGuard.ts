/**
 * Wave W8「安全」— 客户端上传前校验（MIME / 扩展名 / 大小）。
 *
 * 后端 `POST /api/files` 已做严格校验（MIME 白名单 + 文件大小上限，见
 * file.controller.ts），但客户端 `api/files.ts` uploadFile 原样提交任意文件，
 * 会在服务端才被拒绝。本模块在客户端上传前拦截明显不合规的文件，减少无效流量
 * 与误报。白名单与后端保持一致，避免"客户端放行、服务端拒绝"的落差。
 */

export const ALLOWED_MIME_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'image/jpeg',
  'image/png',
  'image/webp',
  'model/gltf+json',
  'model/gltf-binary',
  'text/csv',
  'text/plain',
]);

export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 与后端默认一致

/** 单次上传允许的最大文件数量（数量预校验）。 */
export const MAX_FILES_PER_UPLOAD = 20;

const ALLOWED_EXTENSIONS = new Set([
  '.json',
  '.bin',
  '.pdf',
  '.zip',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gltf',
  '.glb',
  '.csv',
  '.txt',
]);

export interface UploadCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkUploadMime(type: string): UploadCheckResult {
  const normalized = (type || '').trim().toLowerCase();
  if (!normalized) {
    return { ok: false, reason: 'missing MIME type' };
  }
  return ALLOWED_MIME_TYPES.has(normalized)
    ? { ok: true }
    : { ok: false, reason: `unsupported MIME type: ${type}` };
}

export function checkUploadExtension(filename: string): UploadCheckResult {
  const name = (filename || '').trim();
  if (!name) return { ok: false, reason: 'missing filename' };
  const dot = name.lastIndexOf('.');
  if (dot < 0) return { ok: false, reason: 'filename has no extension' };
  const ext = name.slice(dot).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext)
    ? { ok: true }
    : { ok: false, reason: `unsupported extension: ${ext}` };
}

export function checkUploadSize(
  size: number,
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): UploadCheckResult {
  if (!Number.isFinite(size) || size < 0) {
    return { ok: false, reason: 'invalid file size' };
  }
  return size <= maxBytes
    ? { ok: true }
    : { ok: false, reason: `file exceeds ${maxBytes} byte limit` };
}

/** 组合校验：MIME + 扩展名 + 大小，任一失败即拒绝。 */
export function guardUpload(file: {
  name?: string;
  type?: string;
  size?: number;
  maxBytes?: number;
}): UploadCheckResult {
  const mime = checkUploadMime(file.type ?? '');
  if (!mime.ok) return mime;
  const ext = checkUploadExtension(file.name ?? '');
  if (!ext.ok) return ext;
  return checkUploadSize(
    file.size ?? 0,
    file.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
  );
}

/** 数量预校验：单次上传不能超过上限。 */
export function checkUploadCount(count: number): UploadCheckResult {
  if (!Number.isFinite(count) || count < 0) {
    return { ok: false, reason: 'invalid file count' };
  }
  return count <= MAX_FILES_PER_UPLOAD
    ? { ok: true }
    : { ok: false, reason: `too many files (max ${MAX_FILES_PER_UPLOAD})` };
}

/** 批量预校验：先查数量，再按序对每个文件做组合校验，返回第一个失败。 */
export function guardUploadBatch(
  files: Array<{ name?: string; type?: string; size?: number }>,
): UploadCheckResult {
  const count = checkUploadCount(files.length);
  if (!count.ok) return count;
  for (const file of files) {
    const result = guardUpload(file);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** 生成上传诊断用的客户端 requestId（用于 X-Request-Id 头与错误关联）。 */
export function createUploadRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 把客户端预校验结果包装成带 requestId 的上传错误，便于前端诊断。 */
export class UploadGuardError extends Error {
  readonly requestId: string;
  readonly reason: string;

  constructor(reason: string, requestId: string) {
    super(reason);
    this.name = 'UploadGuardError';
    this.requestId = requestId;
    this.reason = reason;
  }
}