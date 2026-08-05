import {
  detectMagicType,
  hasDoubleExtension,
  isOversizedImage,
  isZipBomb,
  normalizeFilename,
  readImageDimensions,
  sumZipUncompressedBytes,
  validateUpload,
} from '../../../server/modules/files/upload-validator';

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // IHDR chunk length
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(11);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0; // SOF0
  buffer.writeUInt16BE(8, 4); // segment length
  buffer[6] = 8; // precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webpBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(26, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  buffer.writeUInt32LE(0, 16);
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

function zipBuffer(uncompressedSize: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer[0] = 0x50;
  buffer[1] = 0x4b;
  buffer[2] = 0x03;
  buffer[3] = 0x04;
  buffer.writeUInt32LE(uncompressedSize, 22);
  return buffer;
}

describe('upload-validator magic bytes', () => {
  it('detects common content types from leading bytes', () => {
    expect(detectMagicType(pngBuffer(10, 10))).toBe('image/png');
    expect(detectMagicType(jpegBuffer(10, 10))).toBe('image/jpeg');
    expect(detectMagicType(webpBuffer(10, 10))).toBe('image/webp');
    expect(detectMagicType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectMagicType(zipBuffer(0))).toBe('application/zip');
    expect(detectMagicType(Buffer.from('glTF'))).toBe('model/gltf-binary');
    expect(detectMagicType(Buffer.from('{"a":1}'))).toBe('application/json');
    expect(detectMagicType(Buffer.from('plain text'))).toBeNull();
  });

  it('accepts a genuinely typed PNG', () => {
    const result = validateUpload({
      buffer: pngBuffer(100, 100),
      filename: 'photo.png',
      declaredMime: 'image/png',
    });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ normalizedFilename: 'photo.png', detectedMime: 'image/png' });
  });

  it('rejects forged MIME where declared type disagrees with magic bytes', () => {
    // Declared PNG but actually JPEG.
    const forged = validateUpload({
      buffer: jpegBuffer(100, 100),
      filename: 'photo.png',
      declaredMime: 'image/png',
    });
    expect(forged.ok).toBe(false);
    expect(forged.reason).toContain('content type mismatch');

    // Declared PDF but actually PNG.
    const fakePdf = validateUpload({
      buffer: pngBuffer(10, 10),
      filename: 'doc.pdf',
      declaredMime: 'application/pdf',
    });
    expect(fakePdf.ok).toBe(false);
  });
});

describe('upload-validator filename safety', () => {
  it('rejects path traversal and absolute paths', () => {
    expect(normalizeFilename('../evil.png')).toBeNull();
    expect(normalizeFilename('a/b.png')).toBeNull();
    expect(normalizeFilename('a\\b.png')).toBeNull();
    expect(normalizeFilename('.hidden.png')).toBeNull();
    expect(normalizeFilename('')).toBeNull();
  });

  it('normalizes a safe filename', () => {
    expect(normalizeFilename('  report.pdf  ')).toBe('report.pdf');
  });

  it('rejects double extensions with a scriptable inner extension', () => {
    expect(hasDoubleExtension('report.pdf.exe')).toBe(true);
    expect(hasDoubleExtension('photo.png.php')).toBe(true);
    expect(hasDoubleExtension('archive.tar.gz')).toBe(false);
    expect(hasDoubleExtension('report.pdf')).toBe(false);
  });

  it('rejects a traversing filename through validateUpload', () => {
    const result = validateUpload({
      buffer: pngBuffer(10, 10),
      filename: '../../etc/passwd.png',
      declaredMime: 'image/png',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('filename');
  });
});

describe('upload-validator archive bombs', () => {
  it('detects an archive with an over-large total uncompressed size', () => {
    const bomb = zipBuffer(200 * 1024 * 1024); // 200 MB expanded
    expect(isZipBomb(bomb)).toBe(true);
    expect(sumZipUncompressedBytes(bomb)).toBe(200 * 1024 * 1024);
  });

  it('detects an archive with an extreme expansion ratio', () => {
    // 1000-byte file claiming 10 MB uncompressed => ratio 10000 > 1000.
    const tight = Buffer.concat([zipBuffer(10 * 1024 * 1024), Buffer.alloc(1000)]);
    expect(isZipBomb(tight)).toBe(true);
  });

  it('accepts a benign archive within limits', () => {
    const benign = Buffer.concat([zipBuffer(1024), Buffer.alloc(1024)]);
    expect(isZipBomb(benign)).toBe(false);
  });

  it('rejects a zip bomb through validateUpload', () => {
    const result = validateUpload({
      buffer: zipBuffer(200 * 1024 * 1024),
      filename: 'archive.zip',
      declaredMime: 'application/zip',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('archive rejected');
  });
});

describe('upload-validator oversized images & metadata', () => {
  it('rejects an image whose pixel dimensions exceed the limit', () => {
    expect(isOversizedImage(pngBuffer(20000, 10), 'image/png')).toBe(true);
    expect(isOversizedImage(pngBuffer(100, 100), 'image/png')).toBe(false);
  });

  it('rejects an image that cannot be decoded (abnormal metadata)', () => {
    // Declared image/png but the buffer is not a structurally valid PNG.
    const result = validateUpload({
      buffer: Buffer.from('%PDF-1.7'),
      filename: 'fake.png',
      declaredMime: 'image/png',
    });
    expect(result.ok).toBe(false);
  });

  it('reads dimensions for supported formats', () => {
    expect(readImageDimensions(pngBuffer(800, 600), 'image/png')).toEqual({ width: 800, height: 600 });
    expect(readImageDimensions(jpegBuffer(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(webpBuffer(320, 240), 'image/webp')).toEqual({ width: 320, height: 240 });
  });

  it('rejects overlong metadata fields', () => {
    const result = validateUpload({
      buffer: pngBuffer(10, 10),
      filename: 'a.png',
      declaredMime: 'image/png',
      note: 'x'.repeat(2001),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('note');
  });
});