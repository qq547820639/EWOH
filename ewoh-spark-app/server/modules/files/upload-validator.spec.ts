import {
  DEFAULT_MAX_ZIP_ENTRIES,
  DEFAULT_MAX_ZIP_NESTING_DEPTH,
  countZipEntries,
  detectMagicType,
  hasDoubleExtension,
  isZipBomb,
  maxZipEntryUncompressedBytes,
  maxZipNestingDepth,
  normalizeFilename,
  readZipEntries,
  validateUpload,
  validateZipLimits,
  type UploadValidationInput,
} from './upload-validator';

/** 构造一个仅含本地文件头（stored，无 central directory）的最小 ZIP 缓冲。 */
function makeZip(entries: Array<{ name: string; uncompressedSize?: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // compression method (stored)
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32
    const size = entry.uncompressedSize ?? 0;
    header.writeUInt32LE(size, 18); // compressed size
    header.writeUInt32LE(size, 22); // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26); // filename length
    header.writeUInt16LE(0, 28); // extra length
    parts.push(header, nameBuf);
  }
  return Buffer.concat(parts);
}

function baseInput(overrides: Partial<UploadValidationInput> = {}): UploadValidationInput {
  return {
    buffer: Buffer.from('%PDF-1.7 fake pdf body'),
    filename: 'report.pdf',
    declaredMime: 'application/pdf',
    ...overrides,
  };
}

describe('upload-validator', () => {
  it('detects magic types from leading bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectMagicType(png)).toBe('image/png');
    expect(detectMagicType(makeZip([{ name: 'a.txt' }]))).toBe('application/zip');
    expect(detectMagicType(Buffer.from('%PDF-'))).toBe('application/pdf');
    expect(detectMagicType(Buffer.from('hello plain'))).toBeNull();
  });

  it('rejects a forged declared MIME whose magic bytes disagree', () => {
    const result = validateUpload(
      baseInput({ buffer: makeZip([{ name: 'a.txt' }]), declaredMime: 'image/png' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('content type mismatch');
  });

  it('accepts a matching declared MIME + magic bytes', () => {
    const result = validateUpload(
      baseInput({ buffer: makeZip([{ name: 'a.txt' }]), declaredMime: 'application/zip' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects path traversal in the filename', () => {
    expect(normalizeFilename('../evil.png')).toBeNull();
    expect(normalizeFilename('/etc/passwd')).toBeNull();
    expect(normalizeFilename('..')).toBeNull();
    expect(normalizeFilename('folder\\evil.png')).toBeNull();
    expect(normalizeFilename('good.png')).toBe('good.png');
  });

  it('rejects a double extension smuggling a scriptable extension', () => {
    expect(hasDoubleExtension('report.pdf.exe')).toBe(true);
    expect(hasDoubleExtension('evil.php.png')).toBe(true);
    expect(hasDoubleExtension('backup.tar.gz')).toBe(false);
    expect(hasDoubleExtension('photo.png')).toBe(false);
  });

  it('rejects a malicious executable regardless of a benign declared extension', () => {
    // MZ 头 + 声明为 image/png：既走 magic 不匹配，也不允许 EXE 伪装。
    const mz = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from('rest')]);
    const result = validateUpload(baseInput({ buffer: mz, filename: 'app.png', declaredMime: 'image/png' }));
    expect(result.ok).toBe(false);
  });

  it('counts zip entries and reports nesting depth and per-entry max size', () => {
    const zip = makeZip([
      { name: 'a.txt' },
      { name: 'dir/sub/b.txt', uncompressedSize: 1024 },
      { name: 'dir/sub/deep/c.txt', uncompressedSize: 2048 },
    ]);
    expect(countZipEntries(zip)).toBe(3);
    expect(readZipEntries(zip).map((e) => e.name)).toEqual(['a.txt', 'dir/sub/b.txt', 'dir/sub/deep/c.txt']);
    // maxZipNestingDepth counts path segments (including the filename).
    expect(maxZipNestingDepth(zip)).toBe(4);
    expect(maxZipEntryUncompressedBytes(zip)).toBe(2048);
  });

  it('rejects a zip with too many entries (bomb by cardinality)', () => {
    const zip = makeZip(
      Array.from({ length: DEFAULT_MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt` })),
    );
    const check = validateZipLimits(zip);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('too many entries');
  });

  it('rejects a zip nested deeper than the depth limit', () => {
    const zip = makeZip([
      { name: `${'a/'.repeat(DEFAULT_MAX_ZIP_NESTING_DEPTH + 1)}file.txt` },
    ]);
    const check = validateZipLimits(zip);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('nesting depth');
  });

  it('rejects a zip whose single entry exceeds the per-file size limit', () => {
    const oversized = 60 * 1024 * 1024; // > 50 MB default
    const zip = makeZip([{ name: 'big.bin', uncompressedSize: oversized }]);
    // 提高压缩率上限以隔离单文件尺寸检查（否则先被压缩率拒绝）。
    const check = validateZipLimits(zip, { maxZipRatio: 1e9 });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('single-file size');
  });

  it('rejects an archive bomb (high expansion ratio)', () => {
    // 极小压缩缓冲声明极大展开大小 → 压缩率超限。
    const zip = makeZip([{ name: 'bomb.bin', uncompressedSize: 200 * 1024 * 1024 }]);
    expect(isZipBomb(zip)).toBe(true);
    const check = validateZipLimits(zip);
    expect(check.ok).toBe(false);
  });

  it('accepts a well-formed, within-limits zip', () => {
    const zip = makeZip([
      { name: 'a.txt', uncompressedSize: 10 },
      { name: 'dir/b.txt', uncompressedSize: 20 },
    ]);
    const check = validateZipLimits(zip);
    expect(check.ok).toBe(true);
    expect(check.entries).toBe(2);
  });

  it('validateUpload applies combined zip structure limits', () => {
    const zip = makeZip(
      Array.from({ length: DEFAULT_MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt` })),
    );
    const result = validateUpload(
      baseInput({ buffer: zip, declaredMime: 'application/zip', filename: 'many.zip' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('archive rejected');
  });
});