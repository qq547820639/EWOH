import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isValidUuid } from '@server/common/uuid';
import { STORAGE_DRIVER } from './storage/storage-driver.factory';
import type { FileRecord, StorageDriver } from './storage/storage-driver';

export type { FileRecord } from './storage/storage-driver';

export interface FileAccessContext {
  orgId: string;
  userId: string;
  isGlobalAdmin?: boolean;
}

@Injectable()
export class FileService {
  constructor(@Inject(STORAGE_DRIVER) private readonly driver: StorageDriver) {}

  async save(
    buffer: Buffer,
    filename: string,
    contentType: string,
    access: FileAccessContext,
    note?: string,
  ): Promise<FileRecord> {
    const id = randomUUID();
    const record: FileRecord = {
      id,
      orgId: access.orgId,
      uploadedBy: access.userId,
      filename: filename || 'file',
      contentType: contentType || 'application/octet-stream',
      size: buffer.length,
      note,
      createdAt: new Date().toISOString(),
    };
    await this.driver.save(id, buffer, record);
    return record;
  }

  async list(access: FileAccessContext): Promise<FileRecord[]> {
    const records = await this.driver.list();
    return access.isGlobalAdmin
      ? records
      : records.filter((record) => record.orgId === access.orgId);
  }

  async get(id: string, access: FileAccessContext): Promise<FileRecord> {
    this.assertValidId(id);
    const record = await this.driver.readMeta(id);
    this.assertAccessible(record, access);
    return record;
  }

  async download(
    id: string,
    access: FileAccessContext,
  ): Promise<{ record: FileRecord; buffer: Buffer }> {
    const record = await this.get(id, access);
    const buffer = await this.driver.readContent(id);
    return { record, buffer };
  }

  async remove(id: string, access: FileAccessContext): Promise<void> {
    await this.get(id, access);
    await this.driver.remove(id);
  }

  private assertValidId(id: string): void {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`File ${id} not found`);
    }
  }

  private assertAccessible(record: FileRecord, access: FileAccessContext): void {
    if (!access.isGlobalAdmin && record.orgId !== access.orgId) {
      throw new NotFoundException(`File ${record.id} not found`);
    }
  }
}
