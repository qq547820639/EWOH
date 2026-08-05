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
  list(): Promise<FileRecord[]>;
  remove(id: string): Promise<void>;
  /** Locate a record previously saved under the same idempotency key + org. */
  findByIdempotencyKey?(key: string, orgId: string): Promise<FileRecord | null>;
  /** Generate an S3 presigned GET URL for an object. */
  createPresignedUrl?(id: string, orgId: string, request: PresignedUrlRequest): Promise<PresignedUrlResult>;
}
