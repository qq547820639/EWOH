/**
 * Client-side resumable, chunked upload helper.
 *
 * Wave W6 "PWA 与离线队列生产化". The backend upload endpoint
 * (`POST /api/files`) is unchanged — this layer is purely client-side. It
 * slices a large blob into chunks, uploads each chunk idempotently (resuming by
 * skipping chunks already persisted as completed), exposes progress, and
 * finalizes when all chunks are done. Because the server is single-POST, each
 * chunk is uploaded as an independent file part and the "resume" is at whole
 * chunk granularity: a chunk is re-uploaded only if it was never recorded as
 * completed.
 *
 * The upload id is derived from the caller's idempotency key + a file
 * identifier, so a retry after an interruption resumes the same logical upload
 * and dedupes already-uploaded chunks.
 */

export interface Chunk {
  index: number;
  blob: Blob;
}

export interface UploadMeta {
  uploadId: string;
  chunkId: string;
  idempotencyKey: string;
}

export type UploadChunkResult = { ok: true; chunkId: string } | { ok: false };

export interface ResumableUploadOptions<T = UploadChunkResult> {
  idempotencyKey: string;
  fileIdentifier: string;
  chunkSizeBytes?: number;
  uploadChunk: (
    chunk: Chunk,
    meta: UploadMeta,
  ) => Promise<T>;
  /** Records which chunk indexes completed for this uploadId. */
  saveProgress?: (uploadId: string, completedIndexes: number[]) => Promise<void>;
  /** Reads previously-completed chunk indexes (null/undefined = fresh upload). */
  resumeState?: (uploadId: string) => Promise<number[] | null>;
  /** Runs once after every chunk is uploaded. Receives results for chunks
   *  uploaded in THIS run (previously-completed chunks are not re-uploaded). */
  finalize?: (results: T[], meta: UploadMeta) => Promise<void>;
  /** When provided, the whole-file checksum is computed and returned in the
   *  result for integrity verification after upload. */
  checksumFile?: (blob: Blob) => Promise<string>;
}

export interface ResumableUploadResult {
  uploadId: string;
  totalChunks: number;
  uploadedChunks: number;
  resumed: boolean;
  bytesUploaded: number;
  /** Whole-file SHA-256 checksum when `options.checksumFile` was provided. */
  fileChecksum?: string;
}

export const DEFAULT_CHUNK_SIZE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Computes a SHA-256 hex checksum of a Blob for integrity verification. Uses
 * Web Crypto when available; otherwise falls back to a deterministic FNV-style
 * hash so the API still works in constrained environments. Pure.
 */
export async function computeBlobChecksum(blob: Blob): Promise<string> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const g = globalThis as { crypto?: { subtle?: SubtleCrypto } };
  if (g.crypto?.subtle?.digest) {
    const digest = await g.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Deterministic fallback hash (FNV-1a) — not cryptographic, but catch
  // corruption when the platform lacks Web Crypto.
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv-${hash.toString(16)}`;
}

/** Slices a blob into fixed-size chunks. Pure. */
export function createChunks(
  blob: Blob,
  chunkSizeBytes: number = DEFAULT_CHUNK_SIZE_BYTES,
): Chunk[] {
  const size = blob.size;
  const chunks: Chunk[] = [];
  for (let start = 0; start < size; start += chunkSizeBytes) {
    chunks.push({ index: chunks.length, blob: blob.slice(start, start + chunkSizeBytes) });
  }
  if (chunks.length === 0) {
    // Empty blob still yields one (empty) chunk so upload/finalize semantics hold.
    chunks.push({ index: 0, blob: blob.slice(0, 0) });
  }
  return chunks;
}

/**
 * Stable upload identifier derived from the idempotency key and file identity,
 * so a resumed upload finds the same persisted progress.
 */
export function createUploadId(idempotencyKey: string, fileIdentifier: string): string {
  return `${idempotencyKey}::${fileIdentifier}`;
}

/**
 * Uploads `file` in chunks, resuming from `resumeState`. Returns a summary; the
 * per-chunk results are handed to `finalize`.
 */
export async function runResumableUpload<T = UploadChunkResult>(
  file: Blob,
  options: ResumableUploadOptions<T>,
): Promise<ResumableUploadResult> {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const chunks = createChunks(file, chunkSizeBytes);
  const uploadId = createUploadId(options.idempotencyKey, options.fileIdentifier);

  const prior = options.resumeState
    ? await options.resumeState(uploadId)
    : [];
  const completed = new Set<number>(prior ?? []);
  const resumed = completed.size > 0;

  const meta: UploadMeta = {
    uploadId,
    idempotencyKey: options.idempotencyKey,
    chunkId: '',
  };

  const results: T[] = [];
  let bytesUploaded = 0;

  for (const chunk of chunks) {
    if (completed.has(chunk.index)) {
      // Already uploaded in a prior attempt — skip the network call (dedupe).
      bytesUploaded += chunk.blob.size;
      continue;
    }
    meta.chunkId = `${uploadId}:chunk-${chunk.index}`;
    // Re-check in case a prior chunk in this loop was already recorded.
    if (completed.has(chunk.index)) {
      bytesUploaded += chunk.blob.size;
      continue;
    }
    const result = await options.uploadChunk(chunk, meta);
    results.push(result);
    completed.add(chunk.index);
    bytesUploaded += chunk.blob.size;
    if (options.saveProgress) {
      await options.saveProgress(uploadId, Array.from(completed));
    }
  }

  if (options.finalize) {
    await options.finalize(results, meta);
  }

  const fileChecksum = options.checksumFile
    ? await options.checksumFile(file)
    : undefined;

  return {
    uploadId,
    totalChunks: chunks.length,
    uploadedChunks: completed.size,
    resumed,
    bytesUploaded,
    ...(fileChecksum ? { fileChecksum } : {}),
  };
}