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
    // NEST-306：驱动层 orgId 过滤（global admin 传 undefined 读全量）——
    // 不再把全部租户的 meta 加载进内存后再过滤。
    return this.driver.list(access.isGlobalAdmin ? undefined : access.orgId);
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

  /** NEST-338：流式下载面——驱动支持 openReadStream 时返回流（避免大文件
   *  全量进内存），否则回退缓冲路径。扫描门与 org 边界与 download 一致。 */
  async downloadStream(
    id: string,
    access: FileAccessContext,
  ): Promise<{ record: FileRecord; stream?: NodeJS.ReadableStream }> {
    const record = await this.get(id, access);
    if (this.driver.openReadStream) {
      const stream = await this.driver.openReadStream(id);
      return { record, stream };
    }
    return { record };
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
    // NEST-337：驱动支持 meta 独立更新时只写 meta（原先为改一个字段
    // 读 20MB 写 20MB 整对象重写）；不支持时回退旧路径。
    if (this.driver.updateMeta) {
      await this.driver.updateMeta(id, updated);
    } else {
      await this.driver.save(id, await this.driver.readContent(id), updated);
    }
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
   *  readable by business users.
   *  NEST-334：scanStatus 未定义（旧记录/缺省）按 pending 处理（fail-closed，
   *  原先 undefined 直接放行）。非 global_admin 一律要求显式 'clean'。 */
  private assertScanned(record: FileRecord, access: FileAccessContext): void {
    if (access.isGlobalAdmin) return;
    if (record.scanStatus !== 'clean') {
      if (record.scanStatus === 'infected') {
        throw new ForbiddenException('File failed malware scan and is quarantined');
      }
      throw new ForbiddenException('File is awaiting malware scan and cannot be read');
    }
  }
}
