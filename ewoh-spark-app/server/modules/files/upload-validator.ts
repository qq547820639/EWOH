/**
 * Server-side upload validation — genuine content inspection, independent of
 * the client-declared MIME type.
 *
 * Wave W8 / Task 8 "上传安全链路". The multer layer only trusts the
 * content-type the client sends; this module re-derives the real type from
 * magic bytes and rejects:
 *   - forged MIME (declared type disagrees with magic bytes)
 *   - path traversal in the filename
 *   - double extensions (e.g. `report.pdf.exe`)
 *   - oversized / non-decodable image dimensions
 *   - compressed archive bombs (imploded zip ratio / total expanded size)
 *   - abnormal metadata (overlong filename / note / content-type)
 *
 * All functions are pure and operate on in-memory buffers, so they are trivially
 * unit-testable without external services.
 */

export const MAX_FILENAME_LENGTH = 255;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_CONTENT_TYPE_LENGTH = 128;

/** Maximum total uncompressed bytes we accept for a single archive. */
export const DEFAULT_MAX_ZIP_EXPANDED_BYTES = 100 * 1024 * 1024;
/** Maximum expansion ratio (uncompressed / compressed) we tolerate. */
export const DEFAULT_MAX_ZIP_RATIO = 1000;
/** Maximum number of entries inside a single archive. */
export const DEFAULT_MAX_ZIP_ENTRIES = 1000;
/** Maximum uncompressed size of a single entry inside an archive. */
export const DEFAULT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
/** Maximum nesting depth (path segments) of an archive entry. */
export const DEFAULT_MAX_ZIP_NESTING_DEPTH = 10;
/** Upper bound on estimated extraction time (ms) for an archive. */
export const DEFAULT_MAX_ZIP_PROCESSING_MS = 5000;
/** Maximum image dimension (either edge) in pixels. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 12000;

export interface UploadValidationLimits {
  maxFilenameLength?: number;
  maxNoteLength?: number;
  maxContentTypeLength?: number;
  maxZipExpandedBytes?: number;
  maxZipRatio?: number;
  maxZipEntries?: number;
  maxZipEntryUncompressedBytes?: number;
  maxZipNestingDepth?: number;
  maxZipProcessingMs?: number;
  maxImageDimension?: number;
}

export interface UploadValidationInput {
  buffer: Buffer;
  filename: string;
  declaredMime: string;
  note?: string;
  limits?: UploadValidationLimits;
}

export type ValidatedMimeKind =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/pdf'
  | 'application/zip'
  | 'model/gltf-binary'
  | 'text/*'
  | 'application/json'
  | 'application/octet-stream';

export interface UploadValidationResult {
  ok: boolean;
  reason?: string;
  detectedMime?: string;
  normalizedFilename?: string;
}

/**
 * Derives the real content type from leading bytes. Returns `null` for types we
 * cannot fingerprint reliably (plain text / CSV / octet-stream / JSON), because
 * for those we intentionally do not enforce magic bytes.
 */
export function detectMagicType(buffer: Buffer): ValidatedMimeKind | null {
  if (!buffer || buffer.length === 0) return null;
  // JPEG: FF D8 FF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  // PDF: %PDF-
  if (buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  // ZIP: PK\x03\x04 (local) / PK\x05\x06 (empty) / PK\x07\x08 (span)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return 'application/zip';
  }
  // glTF binary: "glTF"
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === 'glTF') {
    return 'model/gltf-binary';
  }
  // JSON: first non-whitespace char is { or [
  const firstNs = byteIndexOfNonWhitespace(buffer);
  if (firstNs >= 0 && (buffer[firstNs] === 0x7b || buffer[firstNs] === 0x5b)) {
    return 'application/json';
  }
  return null;
}

function byteIndexOfNonWhitespace(buffer: Buffer): number {
  for (let i = 0; i < buffer.length; i += 1) {
    const b = buffer[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return i;
  }
  return -1;
}

/**
 * Content types for which the declared MIME must match magic bytes. Text, CSV,
 * JSON and octet-stream are deliberately exempt (no reliable fingerprint).
 */
const MAGIC_ENFORCED = new Set<ValidatedMimeKind>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/zip',
  'model/gltf-binary',
]);

/** Maps a declared MIME to the magic kind we expect for it (when enforceable). */
function expectedKind(declaredMime: string): ValidatedMimeKind | null {
  const m = (declaredMime || '').trim().toLowerCase();
  switch (m) {
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
    case 'application/json':
      return 'application/json';
    case 'text/plain':
    case 'text/csv':
      return 'text/*';
    case 'application/octet-stream':
      return 'application/octet-stream';
    default:
      return null;
  }
}

/**
 * Normalizes a client filename: strips surrounding whitespace and any path
 * prefix, so the stored name can never escape the upload directory through
 * traversal. Returns null when the name is empty or contains a traversal
 * segment (`..`, absolute path, embedded path separators).
 */
export function normalizeFilename(raw: string): string | null {
  const name = (raw || '').trim();
  if (!name) return null;
  if (name.length > MAX_FILENAME_LENGTH) return null;
  // Reject absolute paths and any path separator.
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    return null;
  }
  // Reject any path segment equal to ".." (belt-and-braces given separators are
  // already rejected above).
  if (name === '..' || name.endsWith('..')) return null;
  // Reject control characters that could corrupt stored metadata.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/**
 * Rejects names that smuggle a dangerous (scriptable / executable) extension
 * behind an allowed-looking one, e.g. `report.pdf.exe` or `evil.php.png`. A
 * filename with multiple dots is only rejected when any of its extension
 * segments is a scriptable one; benign compound extensions like `.tar.gz`
 * remain allowed.
 */
export function hasDoubleExtension(filename: string): boolean {
  const name = (filename || '').trim();
  const extensions = name.split('.').slice(1);
  if (extensions.length < 2) return false;
  return extensions.some((ext) => SCRIPTABLE_EXTENSIONS.has(ext.toLowerCase()));
}

const SCRIPTABLE_EXTENSIONS = new Set([
  'exe',
  'bat',
  'cmd',
  'com',
  'sh',
  'ps1',
  'vbs',
  'js',
  'jsp',
  'php',
  'asp',
  'aspx',
  'html',
  'htm',
  'svg',
  'jar',
  'msi',
  'scr',
  'phtml',
  'cgi',
  'pl',
  'py',
  'rb',
]);

/**
 * Sums the declared uncompressed sizes of the local file headers in a ZIP
 * stream. Used to reject archive bombs before any extraction happens.
 */
export function sumZipUncompressedBytes(buffer: Buffer): number {
  if (!buffer) return 0;
  let total = 0;
  let offset = 0;
  const maxIterations = 100000;
  // Local file header signature PK\x03\x04.
  const sig = [0x50, 0x4b, 0x03, 0x04];
  for (let i = 0; i < maxIterations; i += 1) {
    const idx = buffer.indexOf(Buffer.from(sig), offset);
    if (idx < 0 || idx + 30 > buffer.length) break;
    // At header + 26 is the uncompressed size (4 bytes, LE).
    const uncomp = buffer.readUInt32LE(idx + 22);
    total += uncomp;
    // Advance past this header (30-byte fixed part) to the next entry.
    offset = idx + 30;
    if (offset >= buffer.length) break;
  }
  return total;
}

export function isZipBomb(
  buffer: Buffer,
  limits?: UploadValidationLimits,
): boolean {
  const maxExpanded = limits?.maxZipExpandedBytes ?? DEFAULT_MAX_ZIP_EXPANDED_BYTES;
  const maxRatio = limits?.maxZipRatio ?? DEFAULT_MAX_ZIP_RATIO;
  const uncompressed = sumZipUncompressedBytes(buffer);
  if (uncompressed > maxExpanded) return true;
  const ratio = buffer.length > 0 ? uncompressed / buffer.length : 0;
  return ratio > maxRatio;
}

/** 单个 ZIP 本地文件头的固定长度（签名 + 26 字节固定字段）。 */
const ZIP_LOCAL_HEADER_FIXED = 30;
/** ZIP 本地文件头签名 PK\x03\x04。 */
const ZIP_LOCAL_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface ZipEntryInfo {
  /** 条目名（路径分隔符统一为 '/'，去掉尾部 '/'）。 */
  name: string;
  /** 声明解压后大小（字节）。 */
  uncompressedSize: number;
}

/**
 * 解析 ZIP 流中的本地文件头，返回条目名与声明解压大小。不做解压，仅遍历
 * 头部以支撑文件数/嵌套深度/单文件尺寸等结构限制。
 */
export function readZipEntries(buffer: Buffer): ZipEntryInfo[] {
  if (!buffer) return [];
  const entries: ZipEntryInfo[] = [];
  let offset = 0;
  const maxIterations = 100000;
  for (let i = 0; i < maxIterations; i += 1) {
    const idx = buffer.indexOf(ZIP_LOCAL_SIG, offset);
    if (idx < 0 || idx + ZIP_LOCAL_HEADER_FIXED > buffer.length) break;
    const nameLen = buffer.readUInt16LE(idx + 26);
    const extraLen = buffer.readUInt16LE(idx + 28);
    const uncompressedSize = buffer.readUInt32LE(idx + 22);
    const nameStart = idx + ZIP_LOCAL_HEADER_FIXED;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buffer.length) break;
    const raw = buffer.toString('utf8', nameStart, nameEnd).replace(/\\/g, '/');
    const name = raw.replace(/\/+$/, '');
    entries.push({ name, uncompressedSize });
    offset = idx + ZIP_LOCAL_HEADER_FIXED + nameLen + extraLen;
    if (offset >= buffer.length) break;
  }
  return entries;
}

/** 统计 ZIP 内的条目数。 */
export function countZipEntries(buffer: Buffer): number {
  return readZipEntries(buffer).length;
}

/** 求出 ZIP 内单条目声明解压大小的最大值（无可解析条目时返回 0）。 */
export function maxZipEntryUncompressedBytes(buffer: Buffer): number {
  return readZipEntries(buffer).reduce((max, e) => Math.max(max, e.uncompressedSize), 0);
}

/** 求出 ZIP 条目目录嵌套的最大深度（按 '/' 分割的路径段数）。 */
export function maxZipNestingDepth(buffer: Buffer): number {
  return readZipEntries(buffer).reduce((max, e) => {
    const depth = e.name.split('/').filter(Boolean).length;
    return Math.max(max, depth);
  }, 0);
}

export interface ZipLimitCheckResult {
  ok: boolean;
  reason?: string;
  entries: number;
  maxEntryBytes: number;
  maxDepth: number;
  totalExpandedBytes: number;
}

/**
 * 对压缩包做全套结构限制校验：总展开尺寸、压缩率、条目数、单条目尺寸、
 * 嵌套深度、估算处理时间。任一超限即拒绝（fail-closed）。
 */
export function validateZipLimits(
  buffer: Buffer,
  limits?: UploadValidationLimits,
): ZipLimitCheckResult {
  const maxExpanded = limits?.maxZipExpandedBytes ?? DEFAULT_MAX_ZIP_EXPANDED_BYTES;
  const maxRatio = limits?.maxZipRatio ?? DEFAULT_MAX_ZIP_RATIO;
  const maxEntries = limits?.maxZipEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const maxEntryBytes = limits?.maxZipEntryUncompressedBytes ?? DEFAULT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES;
  const maxNesting = limits?.maxZipNestingDepth ?? DEFAULT_MAX_ZIP_NESTING_DEPTH;
  const maxProcessingMs = limits?.maxZipProcessingMs ?? DEFAULT_MAX_ZIP_PROCESSING_MS;

  const entries = readZipEntries(buffer);
  const totalExpandedBytes = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  const maxEntry = entries.reduce((m, e) => Math.max(m, e.uncompressedSize), 0);
  const depth = maxZipNestingDepth(buffer);
  const ratio = buffer.length > 0 ? totalExpandedBytes / buffer.length : 0;
  // 解压耗时估算：头部遍历开销 + 展开字节吞吐（约 1 字节/1µs 的保守上界）。
  const estimatedProcessingMs = totalExpandedBytes / 1000 + entries.length;

  const base = { entries: entries.length, maxEntryBytes: maxEntry, maxDepth: depth, totalExpandedBytes };

  if (totalExpandedBytes > maxExpanded) {
    return { ok: false, reason: 'archive expanded size exceeds limit', ...base };
  }
  if (ratio > maxRatio) {
    return { ok: false, reason: 'archive compression ratio exceeds limit', ...base };
  }
  if (entries.length > maxEntries) {
    return { ok: false, reason: 'archive contains too many entries', ...base };
  }
  if (maxEntry > maxEntryBytes) {
    return { ok: false, reason: 'archive entry exceeds single-file size limit', ...base };
  }
  if (depth > maxNesting) {
    return { ok: false, reason: 'archive nesting depth exceeds limit', ...base };
  }
  if (estimatedProcessingMs > maxProcessingMs) {
    return { ok: false, reason: 'archive processing time estimate exceeds limit', ...base };
  }
  return { ok: true, ...base };
}

/** Reads pixel dimensions for common image types. Returns null when undecodable. */
export function readImageDimensions(
  buffer: Buffer,
  kind: ValidatedMimeKind,
): { width: number; height: number } | null {
  if (!buffer) return null;
  if (kind === 'image/png' && buffer.length >= 24) {
    // IHDR: PNG signature (8) + length/type (8) + width(4) + height(4).
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  if (kind === 'image/jpeg') {
    const dims = readJpegDimensions(buffer);
    if (dims) return dims;
  }
  if (kind === 'image/webp') {
    const dims = readWebpDimensions(buffer);
    if (dims) return dims;
  }
  return null;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF markers (C0..CF) excluding DHT(C4), DAC(CC), DNL(C8), restart(C8..CF not SOF).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    const segLen = buffer.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    // VP8X: 4-byte chunk header + 24-bit width/height at offset 24.
    const width = 1 + ((buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) & 0x00ffffff);
    const height = 1 + ((buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) & 0x00ffffff);
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // lossy: 3-byte frame tag then 14-bit width/height.
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (width > 0 && height > 0) return { width, height };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

export function isOversizedImage(
  buffer: Buffer,
  kind: ValidatedMimeKind,
  limits?: UploadValidationLimits,
): boolean {
  const maxDim = limits?.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION;
  const dims = readImageDimensions(buffer, kind);
  // We cannot decode dimensions yet the file claims to be an image — treat as
  // abnormal metadata and reject (fail-closed).
  if (!dims) return true;
  return dims.width > maxDim || dims.height > maxDim;
}

/**
 * Full server-side gate. Returns `{ ok:false, reason }` on the first failure,
 * otherwise the normalized filename and detected MIME.
 */
export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  const { buffer, filename, declaredMime, note } = input;
  const limits = input.limits ?? {};

  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: 'file is required and must not be empty' };
  }

  const normalized = normalizeFilename(filename);
  if (!normalized) {
    return { ok: false, reason: 'invalid or unsafe filename' };
  }
  if (hasDoubleExtension(normalized)) {
    return { ok: false, reason: `double extension not allowed: ${normalized}` };
  }

  const expected = expectedKind(declaredMime);
  if (!expected) {
    return { ok: false, reason: `unsupported content type: ${declaredMime}` };
  }

  const detected = detectMagicType(buffer);
  if (MAGIC_ENFORCED.has(expected)) {
    if (!detected || detected !== expected) {
      return {
        ok: false,
        reason: `content type mismatch: declared ${declaredMime}, detected ${detected ?? 'unknown'}`,
        detectedMime: detected ?? undefined,
      };
    }
  }

  // Archive bomb / structure limits for zip（展开尺寸/压缩率/条目数/单文件/嵌套深度/耗时）。
  if (detected === 'application/zip') {
    const zipCheck = validateZipLimits(buffer, limits);
    if (!zipCheck.ok) {
      return { ok: false, reason: `archive rejected: ${zipCheck.reason}` };
    }
  }

  // Oversized / undecodable images.
  if (detected && detected.startsWith('image/')) {
    if (isOversizedImage(buffer, detected, limits)) {
      return { ok: false, reason: 'image dimensions exceed limit or are undecodable' };
    }
  }

  // Abnormal metadata limits.
  if ((note?.length ?? 0) > (limits.maxNoteLength ?? MAX_NOTE_LENGTH)) {
    return { ok: false, reason: 'note is too long' };
  }
  if (declaredMime.length > (limits.maxContentTypeLength ?? MAX_CONTENT_TYPE_LENGTH)) {
    return { ok: false, reason: 'content type is too long' };
  }

  return { ok: true, normalizedFilename: normalized, detectedMime: detected ?? declaredMime };
}