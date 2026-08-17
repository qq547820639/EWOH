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
  // NEST-358（2026-08-17 审计整改）：生产环境 REQUIRE_OBJECT_STORAGE 非
  // true 时不再静默回退本地存储（误配 = 文件落容器本地盘/丢失，且绕过
  // 对象存储的隔离与生命周期策略）；显式配置对象存储或显式声明本地运行。
  const isProduction = process.env.NODE_ENV === 'production';
  const localExplicitlyAllowed = process.env.ALLOW_LOCAL_FILE_STORAGE === 'true';
  if (isProduction && !localExplicitlyAllowed && process.env.REQUIRE_OBJECT_STORAGE !== 'true') {
    throw new Error(
      'production requires REQUIRE_OBJECT_STORAGE=true (or explicit ALLOW_LOCAL_FILE_STORAGE=true for edge deployments)',
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
