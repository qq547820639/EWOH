export interface FileRecord {
  id: string;
  orgId: string;
  uploadedBy: string;
  filename: string;
  contentType: string;
  size: number;
  note?: string;
  createdAt: string;
}

export interface StorageDriver {
  save(id: string, buffer: Buffer, record: FileRecord): Promise<void>;
  readMeta(id: string): Promise<FileRecord>;
  readContent(id: string): Promise<Buffer>;
  list(): Promise<FileRecord[]>;
  remove(id: string): Promise<void>;
}
