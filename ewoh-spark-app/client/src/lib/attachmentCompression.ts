import type { OfflineAttachment } from './offlineDb';

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  mimeType?: string;
}

export const DEFAULT_COMPRESSION: Required<CompressionOptions> = {
  maxWidth: 1280,
  maxHeight: 1280,
  quality: 0.8,
  mimeType: 'image/jpeg',
};

/** Default total attachment budget for the offline vault (bytes). */
export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 25 * 1024 * 1024;

/**
 * Computes the target dimensions that keep the image within the given bounds
 * while preserving aspect ratio. Pure and unit-testable.
 */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/**
 * Compresses an image file on a canvas, downscaling to `maxWidth`/`maxHeight`
 * and re-encoding as JPEG at `quality`. Falls back to the raw file when the
 * browser cannot decode the image (non-image file or unsupported format).
 */
export async function compressImageFile(
  file: File,
  options?: CompressionOptions,
): Promise<Blob> {
  const opts = { ...DEFAULT_COMPRESSION, ...options };
  if (!file.type.startsWith('image/')) {
    return file;
  }
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
    } else {
      bitmap = await loadHtmlImage(file);
    }
  } catch {
    return file;
  }

  const { width, height } = computeTargetDimensions(
    bitmap.width,
    bitmap.height,
    opts.maxWidth,
    opts.maxHeight,
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return file;
  }
  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, opts.mimeType, opts.quality);
  });
  if (blob) {
    return blob;
  }
  return file;
}

function loadHtmlImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    image.src = url;
  });
}

/** Total bytes currently used by stored attachments. */
export function estimateAttachmentUsage(
  attachments: OfflineAttachment[],
): number {
  return attachments.reduce((sum, attachment) => {
    const size = attachment.size ?? attachment.blob?.size ?? 0;
    return sum + Number(size);
  }, 0);
}

/** Whether adding `newSizeBytes` would push total usage over the quota. */
export function wouldExceedQuota(
  usageBytes: number,
  newSizeBytes: number,
  quotaBytes: number = DEFAULT_ATTACHMENT_QUOTA_BYTES,
): boolean {
  return usageBytes + newSizeBytes > quotaBytes;
}

/**
 * Returns the compression options to use given the current usage and quota.
 * When near the quota, compresses more aggressively (smaller cap, lower quality)
 * so the attachment still fits; otherwise returns the default.
 */
export function compressionForQuota(
  usageBytes: number,
  quotaBytes: number = DEFAULT_ATTACHMENT_QUOTA_BYTES,
): CompressionOptions {
  const ratio = usageBytes / quotaBytes;
  if (ratio < 0.5) {
    return {};
  }
  if (ratio < 0.8) {
    return { maxWidth: 1024, maxHeight: 1024, quality: 0.7 };
  }
  return { maxWidth: 800, maxHeight: 800, quality: 0.6 };
}