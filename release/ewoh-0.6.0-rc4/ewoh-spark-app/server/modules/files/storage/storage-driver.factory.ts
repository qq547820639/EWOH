import { join } from 'node:path';
import { LocalStorageDriver } from './local-storage.driver';
import { S3StorageDriver } from './s3-storage.driver';
import type { StorageDriver } from './storage-driver';

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

export function resolveStorageDriver(): StorageDriver {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim();
  const bucket = process.env.OBJECT_STORAGE_BUCKET?.trim();
  if (process.env.REQUIRE_OBJECT_STORAGE === 'true' && (!endpoint || !bucket)) {
    throw new Error(
      'OBJECT_STORAGE_ENDPOINT and OBJECT_STORAGE_BUCKET are required for this deployment',
    );
  }
  if (endpoint && bucket) {
    return new S3StorageDriver({
      endpoint,
      bucket,
      region: process.env.OBJECT_STORAGE_REGION?.trim() || 'auto',
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY?.trim(),
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY?.trim(),
      forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false',
      prefix: process.env.OBJECT_STORAGE_PREFIX?.trim() || 'files',
    });
  }
  return new LocalStorageDriver(process.env.UPLOAD_DIR || join(process.cwd(), 'data/uploads'));
}
