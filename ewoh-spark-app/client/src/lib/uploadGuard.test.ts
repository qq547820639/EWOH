import {
  checkUploadCount,
  checkUploadExtension,
  checkUploadMagic,
  checkUploadMime,
  checkUploadSize,
  createUploadRequestId,
  detectFileMagic,
  guardUpload,
  guardUploadBatch,
  guardUploadStreaming,
  MAX_FILES_PER_UPLOAD,
  MAGIC_SNIFF_BYTES,
} from './uploadGuard';

describe('uploadGuard', () => {
  it('accepts allowed MIME types', () => {
    expect(checkUploadMime('image/png').ok).toBe(true);
    expect(checkUploadMime('application/pdf').ok).toBe(true);
    expect(checkUploadMime('text/csv').ok).toBe(true);
  });

  it('rejects unsupported MIME types', () => {
    expect(checkUploadMime('application/x-msdownload').ok).toBe(false);
    expect(checkUploadMime('').ok).toBe(false);
  });

  it('accepts allowed extensions and rejects others', () => {
    expect(checkUploadExtension('photo.png').ok).toBe(true);
    expect(checkUploadExtension('report.pdf').ok).toBe(true);
    expect(checkUploadExtension('evil.exe').ok).toBe(false);
    expect(checkUploadExtension('noext').ok).toBe(false);
  });

  it('enforces the file size limit', () => {
    expect(checkUploadSize(1000).ok).toBe(true);
    expect(checkUploadSize(21 * 1024 * 1024).ok).toBe(false);
    expect(checkUploadSize(-1).ok).toBe(false);
  });

  it('guardUpload combines all checks and returns the first failure', () => {
    expect(guardUpload({ name: 'a.png', type: 'image/png', size: 100 }).ok).toBe(true);
    expect(guardUpload({ name: 'a.png', type: 'text/html', size: 100 }).ok).toBe(false);
    expect(guardUpload({ name: 'a.exe', type: 'application/octet-stream', size: 100 }).ok).toBe(false);
    expect(guardUpload({ name: 'big.bin', type: 'application/octet-stream', size: 999999999 }).ok).toBe(false);
  });

  it('enforces the per-request file count limit', () => {
    expect(checkUploadCount(0).ok).toBe(true);
    expect(checkUploadCount(MAX_FILES_PER_UPLOAD).ok).toBe(true);
    expect(checkUploadCount(MAX_FILES_PER_UPLOAD + 1).ok).toBe(false);
  });

  it('guardUploadBatch checks count then each file in order', () => {
    const ok = { name: 'a.png', type: 'image/png', size: 100 };
    expect(guardUploadBatch([ok, ok]).ok).toBe(true);
    expect(guardUploadBatch(Array(MAX_FILES_PER_UPLOAD + 1).fill(ok)).ok).toBe(false);
    expect(guardUploadBatch([ok, { name: 'b.exe', type: 'application/octet-stream', size: 10 }]).ok).toBe(false);
  });

  it('createUploadRequestId returns a stable-format diagnostic id', () => {
    const a = createUploadRequestId();
    const b = createUploadRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('detectFileMagic fingerprints common binary types from the head bytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectFileMagic(png)).toBe('image/png');
    expect(detectFileMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectFileMagic(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(detectFileMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe('application/zip');
    expect(detectFileMagic(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('checkUploadMagic accepts a file whose head matches its declared type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await checkUploadMagic({ type: 'image/png', size: 100, slice: () => new Blob([png]) });
    expect(res.ok).toBe(true);
  });

  it('checkUploadMagic rejects a forged declared type (real bytes disagree)', async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ header
    const res = await checkUploadMagic({ type: 'image/png', size: 100, slice: () => new Blob([exe]) });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('content type mismatch');
  });

  it('sniffs only the first MAGIC_SNIFF_BYTES, never reading the whole large file', async () => {
    const sliced: Array<[number, number]> = [];
    const pngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await checkUploadMagic({
      type: 'image/png',
      size: 100 * 1024 * 1024, // 100 MB 大文件
      slice: (start: number, end: number) => {
        sliced.push([start, end]);
        return new Blob([pngHead]);
      },
    });
    expect(res.ok).toBe(true);
    // 只 slice 了一次，且只读取前 N 字节，绝不是整个 100MB 文件。
    expect(sliced).toHaveLength(1);
    expect(sliced[0][0]).toBe(0);
    expect(sliced[0][1]).toBeLessThanOrEqual(MAGIC_SNIFF_BYTES);
  });

  it('checkUploadMagic skips types without a reliable fingerprint', async () => {
    const res = await checkUploadMagic({ type: 'text/csv', size: 10, slice: () => new Blob([]) });
    expect(res.ok).toBe(true);
  });

  it('guardUploadStreaming runs basic guard then magic check', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = await guardUploadStreaming({ name: 'a.png', type: 'image/png', size: 100, slice: () => new Blob([png]) });
    expect(ok.ok).toBe(true);
    const bad = await guardUploadStreaming({ name: 'a.exe', type: 'image/png', size: 100, slice: () => new Blob([png]) });
    expect(bad.ok).toBe(false);
  });
});