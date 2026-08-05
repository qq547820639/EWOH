import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../../../server/modules/files/file.service';
import { LocalStorageDriver } from '../../../server/modules/files/storage/local-storage.driver';

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('file service local storage', () => {
  const orgA = { orgId: 'org-a', userId: 'user-a' };
  const admin = { orgId: 'org-a', userId: 'admin', isGlobalAdmin: true };

  it('saves, lists, downloads, and removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(Buffer.from('hello'), 'a.txt', 'text/plain', orgA, 'demo');
    expect(record.size).toBe(5);
    expect(record).toMatchObject({ orgId: 'org-a', uploadedBy: 'user-a', scanStatus: 'pending' });
    expect((await service.list(orgA))[0].id).toBe(record.id);
    // A freshly uploaded file is quarantined until scanned.
    await expect(service.download(record.id, orgA)).rejects.toThrow();
    await service.markScanned(record.id, admin, 'clean');
    const downloaded = await service.download(record.id, orgA);
    expect(downloaded.buffer.toString()).toBe('hello');
    await service.remove(record.id, orgA);
    await expect(service.get(record.id, orgA)).rejects.toThrow();
  });

  it('keeps files unreadable until scanned and quarantines infected ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-scan-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA);

    await expect(service.get(record.id, orgA)).rejects.toThrow(/awaiting malware scan/);
    await expect(service.download(record.id, orgA)).rejects.toThrow(/awaiting malware scan/);

    // Mark infected -> still unreadable by business user, but admin can see it.
    await service.markScanned(record.id, admin, 'infected');
    await expect(service.get(record.id, orgA)).rejects.toThrow(/quarantined/);
    await expect(service.get(record.id, admin)).resolves.toMatchObject({ scanStatus: 'infected' });

    // Clean -> now readable.
    await service.markScanned(record.id, admin, 'clean');
    await expect(service.get(record.id, orgA)).resolves.toMatchObject({ scanStatus: 'clean' });
  });

  it('only a global administrator may update scan status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-scanadmin-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA);
    await expect(service.markScanned(record.id, orgA, 'clean')).rejects.toThrow();
  });

  it('hides another organization files while allowing a global administrator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-org-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(Buffer.from('private'), 'a.txt', 'text/plain', orgA);
    await service.markScanned(record.id, admin, 'clean');
    const orgB = { orgId: 'org-b', userId: 'user-b' };

    expect(await service.list(orgB)).toEqual([]);
    await expect(service.get(record.id, orgB)).rejects.toThrow();
    await expect(service.remove(record.id, orgB)).rejects.toThrow();
    await expect(
      service.get(record.id, { ...orgB, isGlobalAdmin: true }),
    ).resolves.toMatchObject({ id: record.id });
  });

  it('rejects non-uuid ids before touching storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-invalid-'));
    const service = new FileService(new LocalStorageDriver(dir));
    await expect(service.get('../secret', orgA)).rejects.toThrow();
    await expect(service.download('../secret', orgA)).rejects.toThrow();
    await expect(service.remove('../secret', orgA)).rejects.toThrow();
  });

  it('rejects forged MIME and path traversal at the service boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-forge-'));
    const service = new FileService(new LocalStorageDriver(dir));
    // Declared PNG but actual JPEG bytes.
    await expect(
      service.save(Buffer.from('%PDF-1.7'), 'photo.png', 'image/png', orgA),
    ).rejects.toThrow(/content type mismatch/);
    await expect(
      service.save(pngBuffer(10, 10), '../../evil.png', 'image/png', orgA),
    ).rejects.toThrow(/filename/);
  });

  it('dedupes duplicate submissions under the same idempotency key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-idem-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const first = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA, undefined, 'ik-1');
    const second = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA, undefined, 'ik-1');
    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe('ik-1');
    expect(await service.list(orgA)).toHaveLength(1);
  });

  it('different idempotency keys create distinct records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-idem2-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const first = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA, undefined, 'ik-a');
    const second = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA, undefined, 'ik-b');
    expect(second.id).not.toBe(first.id);
    expect(await service.list(orgA)).toHaveLength(2);
  });

  it('rejects presigned URL requests on a backend without signing support', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-presign-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(pngBuffer(10, 10), 'photo.png', 'image/png', orgA);
    await service.markScanned(record.id, admin, 'clean');
    await expect(service.createPresignedUrl(record.id, orgA, {})).rejects.toThrow(/not supported/);
  });
});