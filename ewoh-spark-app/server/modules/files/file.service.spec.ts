import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileService, type FileAccessContext } from './file.service';
import type { FileRecord, StorageDriver } from './storage/storage-driver';

/** 内存版 StorageDriver 假实现，用于纯逻辑单测。 */
class FakeDriver implements StorageDriver {
  private content = new Map<string, Buffer>();
  private meta = new Map<string, FileRecord>();
  createPresignedUrl?: StorageDriver['createPresignedUrl'];

  constructor(private readonly seed: Array<[FileRecord, Buffer]>) {
    for (const [record, buffer] of seed) {
      this.meta.set(record.id, record);
      this.content.set(record.id, buffer);
    }
  }

  async save(id: string, buffer: Buffer, record: FileRecord): Promise<void> {
    this.meta.set(id, record);
    this.content.set(id, buffer);
  }

  async readMeta(id: string): Promise<FileRecord> {
    const record = this.meta.get(id);
    if (!record) throw new NotFoundException(`File ${id} not found`);
    return record;
  }

  async readContent(id: string): Promise<Buffer> {
    const buffer = this.content.get(id);
    if (!buffer) throw new NotFoundException(`File ${id} not found`);
    return buffer;
  }

  async list(orgId?: string): Promise<FileRecord[]> {
    const all = Array.from(this.meta.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // NEST-306：驱动层 org 过滤语义（fake 与真实驱动对齐）。
    return orgId ? all.filter((record) => record.orgId === orgId) : all;
  }

  async remove(id: string): Promise<void> {
    this.meta.delete(id);
    this.content.delete(id);
  }

  findByIdempotencyKey(key: string, orgId: string): Promise<FileRecord | null> {
    const found = Array.from(this.meta.values()).find(
      (record) => record.idempotencyKey === key && record.orgId === orgId,
    );
    return Promise.resolve(found ?? null);
  }
}

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const userA: FileAccessContext = { orgId: orgA, userId: 'user-1' };
const admin: FileAccessContext = { orgId: orgA, userId: 'admin', isGlobalAdmin: true };
const UUID_1 = '00000000-0000-4000-8000-000000000001';

function recordOf(id: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id,
    orgId: orgA,
    uploadedBy: 'user-1',
    filename: 'a.pdf',
    contentType: 'application/pdf',
    size: 10,
    createdAt: new Date().toISOString(),
    scanStatus: 'clean',
    ...overrides,
  };
}

describe('FileService (quarantine / org isolation / scan gate)', () => {
  it('blocks cross-organization read (NotFoundException, not a leak)', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1), Buffer.from('pdf')]]);
    const service = new FileService(driver);
    await expect(
      service.get(UUID_1, { orgId: orgB, userId: 'user-2' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('blocks download of a pending (quarantined) file before reading content', async () => {
    let contentRead = 0;
    const driver = new FakeDriver([[recordOf(UUID_1, { scanStatus: 'pending' }), Buffer.from('pdf')]]);
    const original = driver.readContent.bind(driver);
    driver.readContent = async (id) => {
      contentRead += 1;
      return original(id);
    };
    const service = new FileService(driver);
    await expect(service.download(UUID_1, userA)).rejects.toBeInstanceOf(ForbiddenException);
    // 隔离文件不得被读取内容。
    expect(contentRead).toBe(0);
  });

  it('blocks download of an infected (quarantined) file', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1, { scanStatus: 'infected' }), Buffer.from('pdf')]]);
    const service = new FileService(driver);
    await expect(service.download(UUID_1, userA)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('NEST-334: missing scanStatus (legacy record) is treated as pending quarantine', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1, { scanStatus: undefined }), Buffer.from('pdf')]]);
    const service = new FileService(driver);
    await expect(service.download(UUID_1, userA)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows download of a clean file within the owning org', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1), Buffer.from('pdfbody')]]);
    const service = new FileService(driver);
    const { record, buffer } = await service.download(UUID_1, userA);
    expect(record.id).toBe(UUID_1);
    expect(buffer.toString()).toBe('pdfbody');
  });

  it('allows a global admin to read before scan completes (scanner identity)', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1, { scanStatus: 'pending' }), Buffer.from('pdf')]]);
    const service = new FileService(driver);
    const record = await service.get(UUID_1, admin);
    expect(record.scanStatus).toBe('pending');
  });

  it('only a global admin may update scan status', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1), Buffer.from('pdf')]]);
    const service = new FileService(driver);
    await expect(service.markScanned(UUID_1, userA, 'infected')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const updated = await service.markScanned(UUID_1, admin, 'infected');
    expect(updated.scanStatus).toBe('infected');
  });

  it('blocks presigned URL cross-org and for quarantined files', async () => {
    const driver = new FakeDriver([[recordOf(UUID_1, { scanStatus: 'pending' }), Buffer.from('pdf')]]);
    driver.createPresignedUrl = async () => ({ url: 'https://example/x', expiresAt: '', key: 'k' });
    const service = new FileService(driver);
    // 跨组织：get() 抛 NotFound。
    await expect(
      service.createPresignedUrl(UUID_1, { orgId: orgB, userId: 'user-2' }, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    // 隔离中：get() 抛 Forbidden，不产生 URL。
    await expect(
      service.createPresignedUrl(UUID_1, userA, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('same-org duplicate idempotency key returns the existing record without a second write', async () => {
    const driver = new FakeDriver([
      [recordOf(UUID_1, { idempotencyKey: 'ik-1' }), Buffer.from('pdf')],
    ]);
    const service = new FileService(driver);
    // 同 org 命中幂等 → 返回既有记录，不重复写。
    const dup = await service.save(
      Buffer.from('%PDF-1.7 new body'),
      'a.pdf',
      'application/pdf',
      userA,
      undefined,
      'ik-1',
    );
    expect(dup.id).toBe(UUID_1);
    expect(await driver.list()).toHaveLength(1);
  });

  it('NEST-354: another org reusing the same idempotency key gets a NEW record (no cross-org dedupe collision)', async () => {
    const driver = new FakeDriver([
      [recordOf(UUID_1, { idempotencyKey: 'ik-1' }), Buffer.from('pdf')],
    ]);
    const service = new FileService(driver);
    const userB: FileAccessContext = { orgId: orgB, userId: 'user-2' };
    const forged = await service.save(
      Buffer.from('%PDF-1.7 forged body'),
      'a.pdf',
      'application/pdf',
      userB,
      undefined,
      'ik-1',
    );
    // 跨 org 幂等键不碰撞：org B 产生自己的新记录，而不是读到 org A 的文件。
    expect(forged.id).not.toBe(UUID_1);
    expect(forged.orgId).toBe(orgB);
    expect(await driver.list()).toHaveLength(2);
    // org 作用域列表互不可见（驱动层 orgId 过滤，NEST-306）。
    expect((await driver.list(orgA)).map((r) => r.id)).toEqual([UUID_1]);
    expect((await driver.list(orgB)).map((r) => r.id)).toEqual([forged.id]);
  });

  it('save rejects a malicious upload (bad magic) with BadRequest', async () => {
    const driver = new FakeDriver([]);
    const service = new FileService(driver);
    const mz = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from('rest')]);
    await expect(
      service.save(mz, 'app.png', 'image/png', userA),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});