import {
  checkUploadExtension,
  checkUploadMime,
  checkUploadSize,
  guardUpload,
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
});