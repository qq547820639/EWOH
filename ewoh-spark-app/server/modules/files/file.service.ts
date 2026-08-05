import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isValidUuid } from '@server/common/uuid';
import { STORAGE_DRIVER } from './storage/storage-driver.factory';
import { validateUpload, type UploadValidationLimits } from './upload-validator';
import type {
  FileRecord,
  PresignedUrlRequest,
  PresignedUrlResult,
  ScanStatus,
  StorageDriver,
} from './storage/storage-driver';

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
    idempotencyKey?: string,
    limits?: UploadValidationLimits,
  ): Promise<FileRecord> {
    const validation = validateUpload({
      buffer,
      filename,
      declaredMime: contentType,
      note,
      limits,
    });
    if (!validation.ok || !validation.normalizedFilename) {
      throw new BadRequestException(validation.reason ?? 'invalid upload');
    }

    // Duplicate submission: return the previously stored record for the same
    // idempotency key + organization instead of writing a second object.
    if (idempotencyKey && this.driver.findByIdempotencyKey) {
      const existing = await this.driver.findByIdempotencyKey(idempotencyKey, access.orgId);
      if (existing) {
        return existing;
      }
    }

    const id = randomUUID();
    const record: FileRecord = {
      id,
      orgId: access.orgId,
      uploadedBy: access.userId,
      filename: validation.normalizedFilename,
      contentType: validation.detectedMime ?? contentType,
      size: buffer.length,
      note,
      createdAt: new Date().toISOString(),
      scanStatus: 'pending',
      ...(idempotencyKey ? { idempotencyKey } : {}),
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
    this.assertScanned(record, access);
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

  /** Records the outcome of a malware scan. Only a global admin (the scanner
   *  identity) may transition a file out of quarantine. */
  async markScanned(id: string, access: FileAccessContext, status: ScanStatus): Promise<FileRecord> {
    if (!access.isGlobalAdmin) {
      throw new ForbiddenException('Only an administrator may update scan status');
    }
    this.assertValidId(id);
    const record = await this.driver.readMeta(id);
    if (record.orgId !== access.orgId && !access.isGlobalAdmin) {
      throw new NotFoundException(`File ${record.id} not found`);
    }
    const updated: FileRecord = { ...record, scanStatus: status };
    await this.driver.save(id, await this.driver.readContent(id), updated);
    return updated;
  }

  /** Generates a short-lived S3 presigned GET URL, enforcing the organization
   *  boundary: only the owning org (or a global admin) may obtain one. */
  async createPresignedUrl(
    id: string,
    access: FileAccessContext,
    request: PresignedUrlRequest,
  ): Promise<PresignedUrlResult> {
    if (!this.driver.createPresignedUrl) {
      throw new BadRequestException('Presigned URLs are not supported by this storage backend');
    }
    const record = await this.get(id, access); // enforces org boundary + scan gate
    const result = await this.driver.createPresignedUrl(record.id, access.orgId, request);
    return result;
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

  /** Files in quarantine (pending scan) or flagged infected must not be
   *  readable by business users. */
  private assertScanned(record: FileRecord, access: FileAccessContext): void {
    if (access.isGlobalAdmin) return;
    if (record.scanStatus === 'pending') {
      throw new ForbiddenException('File is awaiting malware scan and cannot be read');
    }
    if (record.scanStatus === 'infected') {
      throw new ForbiddenException('File failed malware scan and is quarantined');
    }
  }
}
