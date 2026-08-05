import {
  checkUploadCount,
  checkUploadExtension,
  checkUploadMime,
  checkUploadSize,
  createUploadRequestId,
  guardUpload,
  guardUploadBatch,
  MAX_FILES_PER_UPLOAD,
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
});