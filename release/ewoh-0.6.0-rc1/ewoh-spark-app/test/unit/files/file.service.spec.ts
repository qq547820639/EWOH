import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../../../server/modules/files/file.service';
import { LocalStorageDriver } from '../../../server/modules/files/storage/local-storage.driver';

describe('file service local storage', () => {
  const orgA = { orgId: 'org-a', userId: 'user-a' };

  it('saves, lists, downloads, and removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-'));
    process.env.UPLOAD_DIR = dir;
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(Buffer.from('hello'), 'a.txt', 'text/plain', orgA, 'demo');
    expect(record.size).toBe(5);
    expect(record).toMatchObject({ orgId: 'org-a', uploadedBy: 'user-a' });
    expect((await service.list(orgA))[0].id).toBe(record.id);
    const downloaded = await service.download(record.id, orgA);
    expect(downloaded.buffer.toString()).toBe('hello');
    await service.remove(record.id, orgA);
    await expect(service.get(record.id, orgA)).rejects.toThrow();
  });

  it('hides another organization files while allowing a global administrator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ewoh-files-org-'));
    const service = new FileService(new LocalStorageDriver(dir));
    const record = await service.save(Buffer.from('private'), 'a.txt', 'text/plain', orgA);
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
});
