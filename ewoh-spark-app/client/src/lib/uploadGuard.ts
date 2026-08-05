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

// ---- 流式 magic bytes 校验（不把大文件整读进内存） ----

/** 嗅探文件头所需的最大字节数：仅读取前 32 字节即可判定常见类型。 */
export const MAGIC_SNIFF_BYTES = 32;

/** 可流式嗅探的文件形状（Blob/File 的子集）。 */
export interface SniffableFile {
  type?: string;
  size?: number;
  slice(start: number, end: number): Blob;
}

/** 无可靠指纹、跳过 magic 校验的类型（文本 / CSV / JSON / 二进制流）。 */
const MAGIC_OPTIONAL = new Set([
  'text/plain',
  'text/csv',
  'application/json',
  'application/octet-stream',
  'model/gltf+json',
]);

/** 声明 MIME → 期望的 magic 类型（仅对可指纹类型生效）。 */
function expectedMagicKind(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'image/jpeg';
    case 'image/png':
      return 'image/png';
    case 'image/webp':
      return 'image/webp';
    case 'application/pdf':
      return 'application/pdf';
    case 'application/zip':
      return 'application/zip';
    case 'model/gltf-binary':
      return 'model/gltf-binary';
    default:
      return null;
  }
}

function bytesStartWith(head: Uint8Array, magic: number[]): boolean {
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (head[i] !== magic[i]) return false;
  }
  return true;
}

function latin1(head: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...head.slice(start, end));
}

/** 根据文件头字节识别真实类型；无法可靠指纹时返回 null。 */
export function detectFileMagic(head: Uint8Array): string | null {
  if (!head || head.length === 0) return null;
  if (bytesStartWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytesStartWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (head.length >= 12 && latin1(head, 0, 4) === 'RIFF' && latin1(head, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (head.length >= 5 && latin1(head, 0, 5) === '%PDF-') return 'application/pdf';
  if (
    bytesStartWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    bytesStartWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
    bytesStartWith(head, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip';
  }
  if (head.length >= 4 && latin1(head, 0, 4) === 'glTF') return 'model/gltf-binary';
  return null;
}

/**
 * 流式读取文件前 MAGIC_SNIFF_BYTES 字节做 magic bytes 校验，绝不把整个大文件
 * 读入内存。对声明的可指纹类型（图片/PDF/ZIP/glTF）校验头部与声明一致；对
 * 无指纹类型跳过。返回 ok 表示通过。
 */
export async function checkUploadMagic(file: SniffableFile): Promise<UploadCheckResult> {
  const declared = (file?.type ?? '').trim().toLowerCase();
  if (MAGIC_OPTIONAL.has(declared)) return { ok: true };
  const expected = expectedMagicKind(declared);
  if (!expected) return { ok: true }; // 未知/不可指纹声明：交由组合校验与后端处理。
  const head = await sniffHead(file, MAGIC_SNIFF_BYTES);
  const detected = detectFileMagic(head);
  if (!detected || detected !== expected) {
    return {
      ok: false,
      reason: `content type mismatch: declared ${declared}, detected ${detected ?? 'unknown'}`,
    };
  }
  return { ok: true };
}

async function sniffHead(file: SniffableFile, bytes: number): Promise<Uint8Array> {
  const slice = file.slice(0, bytes);
  const buf = await slice.arrayBuffer();
  return new Uint8Array(buf);
}

/** 组合流式校验：基础校验（MIME/扩展名/大小）+ magic bytes。 */
export async function guardUploadStreaming(
  file: SniffableFile & { name?: string; size?: number },
): Promise<UploadCheckResult> {
  const basic = guardUpload({ name: file.name, type: file.type, size: file.size });
  if (!basic.ok) return basic;
  return checkUploadMagic(file);
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