import { NotFoundException } from '@nestjs/common';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileRecord, StorageDriver } from './storage-driver';

export class LocalStorageDriver implements StorageDriver {
  constructor(private readonly rootDir: string) {}

  async save(id: string, buffer: Buffer, record: FileRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.path(id), buffer);
    await writeFile(this.metaPath(id), JSON.stringify(record, null, 2));
  }

  async readMeta(id: string): Promise<FileRecord> {
    try {
      return JSON.parse(await readFile(this.metaPath(id), 'utf8')) as FileRecord;
    } catch {
      throw new NotFoundException(`File ${id} not found`);
    }
  }

  async readContent(id: string): Promise<Buffer> {
    try {
      return await readFile(this.path(id));
    } catch {
      throw new NotFoundException(`File ${id} not found`);
    }
  }

  async list(): Promise<FileRecord[]> {
    try {
      const entries = await readdir(this.rootDir);
      const ids = entries.filter((entry) => entry.endsWith('.meta.json')).map((entry) => entry.replace('.meta.json', ''));
      const records: FileRecord[] = [];
      for (const id of ids) {
        try {
          records.push(JSON.parse(await readFile(this.metaPath(id), 'utf8')) as FileRecord);
        } catch {
          // Ignore corrupt metadata.
        }
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<void> {
    await this.readMeta(id);
    await rm(this.path(id), { force: true });
    await rm(this.metaPath(id), { force: true });
  }

  async findByIdempotencyKey(key: string, orgId: string): Promise<FileRecord | null> {
    if (!key) return null;
    const records = await this.list();
    return (
      records.find(
        (record) => record.idempotencyKey === key && record.orgId === orgId,
      ) ?? null
    );
  }

  private path(id: string): string {
    return join(this.rootDir, id);
  }

  private metaPath(id: string): string {
    return join(this.rootDir, `${id}.meta.json`);
  }
}
