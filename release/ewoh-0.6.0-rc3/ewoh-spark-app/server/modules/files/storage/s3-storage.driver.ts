import { NotFoundException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { FileRecord, StorageDriver } from './storage-driver';

export interface S3StorageOptions {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3StorageOptions, client?: S3Client) {
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
  }

  async save(id: string, buffer: Buffer, record: FileRecord): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.contentKey(id),
      Body: buffer,
      ContentType: record.contentType,
    }));
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.metaKey(id),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  }

  async readMeta(id: string): Promise<FileRecord> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.metaKey(id),
      }));
      const raw = await response.Body?.transformToString();
      if (!raw) {
        throw new NotFoundException(`File ${id} not found`);
      }
      return JSON.parse(raw) as FileRecord;
    } catch (error) {
      if (this.isMissingKey(error)) {
        throw new NotFoundException(`File ${id} not found`);
      }
      throw error;
    }
  }

  async readContent(id: string): Promise<Buffer> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.contentKey(id),
      }));
      const bytes = await response.Body?.transformToByteArray();
      return Buffer.from(bytes ?? []);
    } catch (error) {
      if (this.isMissingKey(error)) {
        throw new NotFoundException(`File ${id} not found`);
      }
      throw error;
    }
  }

  async list(): Promise<FileRecord[]> {
    const records: FileRecord[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.prefix}/`,
        ContinuationToken: continuationToken,
      }));
      for (const item of response.Contents ?? []) {
        const key = item.Key ?? '';
        if (!key.endsWith('.meta.json')) {
          continue;
        }
        const id = key.slice(this.prefix.length + 1, -'.meta.json'.length);
        try {
          records.push(await this.readMeta(id));
        } catch {
          // Ignore orphaned metadata.
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<void> {
    await this.readMeta(id);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.contentKey(id) }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.metaKey(id) }));
  }

  private contentKey(id: string): string {
    return `${this.prefix}/${id}`;
  }

  private metaKey(id: string): string {
    return `${this.prefix}/${id}.meta.json`;
  }

  private isMissingKey(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NoSuchKey';
  }
}
