import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidUuid } from '@server/common/uuid';
import type { FileRecord, StorageDriver } from './storage-driver';

/**
 * LocalStorageDriver（NEST-306/339/340，2026-08-17 审计整改）。
 *
 * - 布局：新写入按 org 分桶 `{root}/{orgId}/{id}` + `{id}.meta.json`；
 *   list(orgId) 只扫该 org 子目录（不再把全部租户 meta 读进内存）。
 *   根目录下的旧布局（`{root}/{id}`）保持可读（readMeta 双路径回退），
 *   全量 list（global admin）同时扫根目录遗留与全部 org 子目录。
 * - 原子写（NEST-339）：先写 `*.tmp` 再 rename；meta 最后落盘——
 *   content 落盘而 meta 缺失=可容忍孤儿，meta 存在必有意为其 content。
 * - 驱动层 UUID 校验（NEST-340）：所有按 id 寻址的入口显式拒绝非 UUID。
 */
export class LocalStorageDriver implements StorageDriver {
  constructor(private readonly rootDir: string) {}

  private assertValidId(id: string): void {
    if (!isValidUuid(id)) {
      throw new BadRequestException('invalid file id (uuid required)');
    }
  }

  private orgDir(orgId: string): string {
    return join(this.rootDir, orgId);
  }

  private orgPath(orgId: string, id: string): string {
    return join(this.orgDir(orgId), id);
  }

  private orgMetaPath(orgId: string, id: string): string {
    return join(this.orgDir(orgId), `${id}.meta.json`);
  }

  /** 旧布局（根目录平铺）路径。 */
  private legacyPath(id: string): string {
    return join(this.rootDir, id);
  }

  private legacyMetaPath(id: string): string {
    return join(this.rootDir, `${id}.meta.json`);
  }

  async save(id: string, buffer: Buffer, record: FileRecord): Promise<void> {
    this.assertValidId(id);
    const orgId = record.orgId;
    await mkdir(this.orgDir(orgId), { recursive: true });
    const contentPath = this.orgPath(orgId, id);
    const metaPath = this.orgMetaPath(orgId, id);
    // NEST-339：tmp + rename 原子化；meta 最后提交。
    await writeFile(`${contentPath}.tmp`, buffer);
    await writeFile(`${metaPath}.tmp`, JSON.stringify(record, null, 2));
    await rename(`${contentPath}.tmp`, contentPath);
    await rename(`${metaPath}.tmp`, metaPath);
  }

  /** 定位 id 所属 org 桶（新布局优先，回退旧根目录布局）。 */
  private async locateOrg(id: string): Promise<string | null> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(this.orgMetaPath(entry.name, id), 'utf8');
        return entry.name;
      } catch {
        // 该 org 桶无此 id，继续。
      }
    }
    try {
      await readFile(this.legacyMetaPath(id), 'utf8');
      return '';
    } catch {
      return null;
    }
  }

  async readMeta(id: string): Promise<FileRecord> {
    this.assertValidId(id);
    // 快路径：旧布局（历史对象平铺于根目录）。
    try {
      return JSON.parse(await readFile(this.legacyMetaPath(id), 'utf8')) as FileRecord;
    } catch {
      // 继续定位 org 桶。
    }
    const orgId = await this.locateOrg(id);
    if (orgId === null) {
      throw new NotFoundException(`File ${id} not found`);
    }
    try {
      const raw =
        orgId === ''
          ? await readFile(this.legacyMetaPath(id), 'utf8')
          : await readFile(this.orgMetaPath(orgId, id), 'utf8');
      return JSON.parse(raw) as FileRecord;
    } catch {
      throw new NotFoundException(`File ${id} not found`);
    }
  }

  private async resolveContentPath(id: string): Promise<string> {
    const orgId = await this.locateOrg(id);
    if (orgId === null) {
      throw new NotFoundException(`File ${id} not found`);
    }
    return orgId === '' ? this.legacyPath(id) : this.orgPath(orgId, id);
  }

  async readContent(id: string): Promise<Buffer> {
    this.assertValidId(id);
    try {
      return await readFile(await this.resolveContentPath(id));
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException(`File ${id} not found`);
    }
  }

  async openReadStream(id: string): Promise<NodeJS.ReadableStream> {
    this.assertValidId(id);
    const path = await this.resolveContentPath(id);
    return createReadStream(path);
  }

  async list(orgId?: string): Promise<FileRecord[]> {
    const readMetaQuietly = async (metaPath: string): Promise<FileRecord | null> => {
      try {
        return JSON.parse(await readFile(metaPath, 'utf8')) as FileRecord;
      } catch {
        return null; // Ignore corrupt metadata.
      }
    };
    const collectFrom = async (dir: string): Promise<FileRecord[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const records: FileRecord[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
        const record = await readMetaQuietly(join(dir, entry.name));
        if (record) records.push(record);
      }
      return records;
    };
    if (orgId) {
      // NEST-306：org 作用域只扫本 org 桶。
      const records = await collectFrom(this.orgDir(orgId));
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    // 全量（global admin）：根目录遗留 + 全部 org 桶。
    const records = await collectFrom(this.rootDir);
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        records.push(...(await collectFrom(join(this.rootDir, entry.name))));
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<void> {
    this.assertValidId(id);
    const orgId = await this.locateOrg(id);
    if (orgId === null) {
      throw new NotFoundException(`File ${id} not found`);
    }
    const base = orgId === '' ? this.legacyPath(id) : this.orgPath(orgId, id);
    await rm(base, { force: true });
    await rm(`${base}.meta.json`, { force: true });
  }

  async updateMeta(id: string, record: FileRecord): Promise<void> {
    this.assertValidId(id);
    const orgId = await this.locateOrg(id);
    if (orgId === null) {
      throw new NotFoundException(`File ${id} not found`);
    }
    const metaPath = orgId === '' ? this.legacyMetaPath(id) : this.orgMetaPath(orgId, id);
    await writeFile(`${metaPath}.tmp`, JSON.stringify(record, null, 2));
    await rename(`${metaPath}.tmp`, metaPath);
  }

  async findByIdempotencyKey(key: string, orgId: string): Promise<FileRecord | null> {
    if (!key) return null;
    const records = await this.list(orgId);
    return (
      records.find(
        (record) => record.idempotencyKey === key && record.orgId === orgId,
      ) ?? null
    );
  }
}
