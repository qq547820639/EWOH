import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { isValidUuid } from '@server/common/uuid';
import type {
  FileRecord,
  PresignedUrlRequest,
  PresignedUrlResult,
  StorageDriver,
} from './storage-driver';

export interface S3StorageOptions {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

/** Max allowed presigned URL lifetime (24h). */
export const MAX_PRESIGN_EXPIRY_SECONDS = 24 * 60 * 60;
/** Default presigned URL lifetime (1h). */
export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 60 * 60;

export type S3CommandSigner = (
  command: GetObjectCommand,
  options: { expiresIn?: number },
) => Promise<string>;

/**
 * Production signer backed by @aws-sdk/s3-request-presigner. It is resolved
 * lazily so the rest of the module can be imported and unit-tested without the
 * optional runtime dependency installed.
 */
function defaultSigner(client: S3Client): S3CommandSigner {
  return async (command, options) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner') as {
      getSignedUrl: (
        c: S3Client,
        command: GetObjectCommand,
        opts?: { expiresIn?: number },
      ) => Promise<string>;
    };
    return getSignedUrl(client, command, { expiresIn: options.expiresIn });
  };
}

/**
 * S3StorageDriver（NEST-306/307/337/338/340，2026-08-17 审计整改）。
 *
 * - 布局：新写入按 org 前缀分桶 `{prefix}/{orgId}/{id}` + `.meta.json`；
 *   list(orgId) 用 ListObjectsV2 以该 org 前缀列举（NEST-307：org 作用域
 *   只对命中键做 GetObject，不再全量 meta 逐键拉取进内存）。
 * - 旧布局（`{prefix}/{id}`，无 org 段）保持可读：readMeta 先试旧键，
 *   未命中再用一次 ListObjectsV2 定位「任意 org 段 + /{id}.meta.json」。
 * - updateMeta（NEST-337）：仅 PutObject meta 键。
 * - openReadStream（NEST-338）：GetObject Body 直接返回流。
 * - assertValidId（NEST-340）：驱动层 UUID 校验。
 */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly signer: S3CommandSigner;

  constructor(options: S3StorageOptions, client?: S3Client, signer?: S3CommandSigner) {
    this.bucket = options.bucket;
    this.prefix = options.prefix?.replace(/^\/+|\/+$/g, '') || 'files';
    this.client = client ?? new S3Client({
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      region: options.region || 'auto',
      forcePathStyle: options.forcePathStyle !== false,
      ...(options.accessKeyId && options.secretAccessKey
        ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }
        : {}),
    });
    this.signer = signer ?? defaultSigner(this.client);
  }

  private assertValidId(id: string): void {
    if (!isValidUuid(id)) {
      throw new BadRequestException('invalid file id (uuid required)');
    }
  }

  private orgContentKey(orgId: string, id: string): string {
    return `${this.prefix}/${orgId}/${id}`;
  }

  private orgMetaKey(orgId: string, id: string): string {
    return `${this.prefix}/${orgId}/${id}.meta.json`;
  }

  /** 旧布局键（无 org 段）。 */
  private legacyContentKey(id: string): string {
    return `${this.prefix}/${id}`;
  }

  private legacyMetaKey(id: string): string {
    return `${this.prefix}/${id}.meta.json`;
  }

  async save(id: string, buffer: Buffer, record: FileRecord): Promise<void> {
    this.assertValidId(id);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.orgContentKey(record.orgId, id),
      Body: buffer,
      ContentType: record.contentType,
    }));
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.orgMetaKey(record.orgId, id),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  }

  private async getMetaObject(key: string): Promise<FileRecord | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      const raw = await response.Body?.transformToString();
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as FileRecord;
    } catch (error) {
      if (this.isMissingKey(error)) {
        return null;
      }
      throw error;
    }
  }

  /** 定位 id 的 meta 键（新 org 前缀优先，回退旧平铺键）。 */
  private async locateMetaKey(id: string): Promise<string | null> {
    // 旧布局快路径。
    const legacy = await this.getMetaObject(this.legacyMetaKey(id));
    if (legacy) return this.legacyMetaKey(id);
    // 单次列举定位 `*/{id}.meta.json`。
    let continuationToken: string | undefined;
    const suffix = `/${id}.meta.json`;
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.prefix}/`,
        ContinuationToken: continuationToken,
      }));
      for (const item of response.Contents ?? []) {
        const key = item.Key ?? '';
        if (key.endsWith(suffix) && key !== this.legacyMetaKey(id)) {
          return key;
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return null;
  }

  async readMeta(id: string): Promise<FileRecord> {
    this.assertValidId(id);
    const direct = await this.getMetaObject(this.legacyMetaKey(id));
    if (direct) return direct;
    const key = await this.locateMetaKey(id);
    if (!key) {
      throw new NotFoundException(`File ${id} not found`);
    }
    const record = await this.getMetaObject(key);
    if (!record) {
      throw new NotFoundException(`File ${id} not found`);
    }
    return record;
  }

  private async resolveContentKey(id: string): Promise<string> {
    const metaKey = await this.locateMetaKey(id);
    if (!metaKey) {
      throw new NotFoundException(`File ${id} not found`);
    }
    return metaKey.slice(0, -'.meta.json'.length);
  }

  async readContent(id: string): Promise<Buffer> {
    this.assertValidId(id);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: await this.resolveContentKey(id),
      }));
      const bytes = await response.Body?.transformToByteArray();
      return Buffer.from(bytes ?? []);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (this.isMissingKey(error)) {
        throw new NotFoundException(`File ${id} not found`);
      }
      throw error;
    }
  }

  async openReadStream(id: string): Promise<NodeJS.ReadableStream> {
    this.assertValidId(id);
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: await this.resolveContentKey(id),
    }));
    const body = response.Body as Readable | undefined;
    if (!body) {
      throw new NotFoundException(`File ${id} not found`);
    }
    return body;
  }

  async list(orgId?: string): Promise<FileRecord[]> {
    const records: FileRecord[] = [];
    let continuationToken: string | undefined;
    // NEST-306/307：org 作用域仅列举 `{prefix}/{orgId}/` 前缀；全量
    // （global admin）列举 `{prefix}/`（兼容旧平铺键 + org 布局键）。
    const scopePrefix = orgId ? `${this.prefix}/${orgId}/` : `${this.prefix}/`;
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: scopePrefix,
        ContinuationToken: continuationToken,
      }));
      for (const item of response.Contents ?? []) {
        const key = item.Key ?? '';
        if (!key.endsWith('.meta.json')) {
          continue;
        }
        if (orgId) {
          const id = key.slice(scopePrefix.length, -'.meta.json'.length);
          if (!isValidUuid(id)) continue;
        } else {
          // 全量模式：仅接受 `{prefix}/{uuid}.meta.json`（旧平铺）与
          // `{prefix}/{orgId}/{uuid}.meta.json`（org 布局）两种形状。
          const rest = key.slice(this.prefix.length + 1, -'.meta.json'.length);
          if (!isValidUuid(rest) && !rest.split('/').every((part, idx) => idx === 0 || isValidUuid(part))) {
            continue;
          }
        }
        const record = await this.getMetaObject(key);
        if (record) records.push(record);
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<void> {
    this.assertValidId(id);
    const metaKey = await this.locateMetaKey(id);
    if (!metaKey) {
      throw new NotFoundException(`File ${id} not found`);
    }
    const contentKey = metaKey.slice(0, -'.meta.json'.length);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: contentKey }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: metaKey }));
    // 旧布局残留键幂等清理（不存在时 DeleteObject 是 no-op）。
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.legacyContentKey(id) }));
  }

  async updateMeta(id: string, record: FileRecord): Promise<void> {
    this.assertValidId(id);
    const metaKey = await this.locateMetaKey(id);
    if (!metaKey) {
      throw new NotFoundException(`File ${id} not found`);
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: metaKey,
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
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

  async createPresignedUrl(
    id: string,
    _orgId: string,
    request: PresignedUrlRequest,
  ): Promise<PresignedUrlResult> {
    const expiresIn = clampLifetime(request.expiresInSeconds);
    const key = await this.resolveContentKey(id);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(request.contentType
        ? { ResponseContentType: request.contentType }
        : {}),
    });
    const url = await this.signer(command, { expiresIn });
    return {
      url,
      key,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  private isMissingKey(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NoSuchKey';
  }
}

/** Clamps the requested lifetime into [1s, MAX_PRESIGN_EXPIRY_SECONDS]. */
function clampLifetime(requested?: number): number {
  const value = Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_PRESIGN_EXPIRY_SECONDS;
  if (value < 1) return 1;
  if (value > MAX_PRESIGN_EXPIRY_SECONDS) return MAX_PRESIGN_EXPIRY_SECONDS;
  return value;
}
