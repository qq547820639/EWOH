export type ScanStatus = 'pending' | 'clean' | 'infected';

export interface FileRecord {
  id: string;
  orgId: string;
  uploadedBy: string;
  filename: string;
  contentType: string;
  size: number;
  note?: string;
  createdAt: string;
  /** Malware-scan status. Files are quarantined until 'clean'. */
  scanStatus?: ScanStatus;
  /** Client-supplied idempotency key used to dedupe duplicate submissions. */
  idempotencyKey?: string;
}

export interface PresignedUrlRequest {
  contentType?: string;
  expiresInSeconds?: number;
}

export interface PresignedUrlResult {
  url: string;
  expiresAt: string;
  key: string;
}

export interface StorageDriver {
  save(id: string, buffer: Buffer, record: FileRecord): Promise<void>;
  readMeta(id: string): Promise<FileRecord>;
  readContent(id: string): Promise<Buffer>;
  /**
   * List stored file records.
   * NEST-306（2026-08-17 审计整改）：驱动层接受 orgId 过滤——org 作用域
   * 调用只读取该 org 的对象键/元数据（global admin 传 undefined 读全量），
   * 不再把全部租户的 meta 加载进内存后再过滤。
   */
  list(orgId?: string): Promise<FileRecord[]>;
  remove(id: string): Promise<void>;
  /** Locate a record previously saved under the same idempotency key + org. */
  findByIdempotencyKey?(key: string, orgId: string): Promise<FileRecord | null>;
  /** Generate an S3 presigned GET URL for an object. */
  createPresignedUrl?(id: string, orgId: string, request: PresignedUrlRequest): Promise<PresignedUrlResult>;
  /**
   * NEST-337：仅更新 meta（不重写 content）——markScanned 原先为改一个
   * scanStatus 字段读 20MB 写 20MB。驱动不支持时服务层回退整对象重写。
   */
  updateMeta?(id: string, record: FileRecord): Promise<void>;
  /**
   * NEST-338：流式读内容（下载端点原先 res.send(buffer) 全内存，
   * 20MB×并发可 OOM）。驱动不支持时服务层回退 readContent 缓冲。
   */
  openReadStream?(id: string): Promise<NodeJS.ReadableStream>;
}
