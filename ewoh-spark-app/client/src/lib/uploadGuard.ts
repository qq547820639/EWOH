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