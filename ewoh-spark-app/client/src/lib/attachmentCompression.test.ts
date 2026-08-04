import {
  compressionForQuota,
  computeTargetDimensions,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  estimateAttachmentUsage,
  wouldExceedQuota,
} from './attachmentCompression';
import type { OfflineAttachment } from './offlineDb';

describe('attachmentCompression (pure logic)', () => {
  it('preserves aspect ratio when downscaling', () => {
    expect(computeTargetDimensions(4000, 3000, 1280, 1280)).toEqual({
      width: 1280,
      height: 960,
    });
  });

  it('does not upscale smaller images', () => {
    expect(computeTargetDimensions(800, 600, 1280, 1280)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('handles zero dimensions defensively', () => {
    expect(computeTargetDimensions(0, 0, 1280, 1280)).toEqual({
      width: 1,
      height: 1,
    });
  });

  it('estimates total attachment usage', () => {
    const attachments: OfflineAttachment[] = [
      { key: 'a', id: 'a', name: 'a.jpg', contentType: 'image/jpeg', blob: new Blob(['x']), size: 100, createdAt: '' },
      { key: 'b', id: 'b', name: 'b.jpg', contentType: 'image/jpeg', blob: new Blob(['xx']), size: 200, createdAt: '' },
    ];
    expect(estimateAttachmentUsage(attachments)).toBe(300);
  });

  it('detects when a new attachment would exceed the quota', () => {
    const quota = DEFAULT_ATTACHMENT_QUOTA_BYTES;
    expect(wouldExceedQuota(quota - 100, 1000, quota)).toBe(true);
    expect(wouldExceedQuota(0, 1000, quota)).toBe(false);
  });

  it('returns progressively more aggressive compression near the quota', () => {
    expect(compressionForQuota(0, DEFAULT_ATTACHMENT_QUOTA_BYTES)).toEqual({});
    expect(
      compressionForQuota(DEFAULT_ATTACHMENT_QUOTA_BYTES * 0.9, DEFAULT_ATTACHMENT_QUOTA_BYTES),
    ).toEqual({ maxWidth: 800, maxHeight: 800, quality: 0.6 });
  });
});