'use client';
import { getDataloom } from '@lark-apaas/client-toolkit/dataloom';
import { getDefaultBucketId } from '@lark-apaas/client-toolkit/tools/storage';

export interface UploadFileData {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
}

/**
 * CLI-316：上传前客户端校验。
 *
 * 裁决：此处是通用附件/图片上传入口（富文本编辑器），不做 MIME 白名单
 * （会拒绝合法的业务附件类型），改为「大小上限 + 可执行类型拒绝」组合，
 * 阻止明显不合规文件占用存储桶；最终约束仍由对象存储服务端执行。
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.sh', '.com', '.scr', '.vbs', '.js', '.jar',
  '.apk', '.dll', '.so', '.dylib',
]);

export function validateUploadFile(file: File): void {
  if (file.size <= 0) {
    throw new Error(`文件为空：${file.name}`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `文件超过大小上限（${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）：${file.name}`,
    );
  }
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`不允许上传可执行文件（${ext}）：${file.name}`);
  }
}

export async function uploadFile(file: File): Promise<UploadFileData> {
  validateUploadFile(file);
  const dataloom = await getDataloom();
  const bucket = dataloom.storage.from(getDefaultBucketId());

  const result = await bucket.uploadFile(file);

  if (result.error) {
    throw result.error;
  }

  return {
    id: result.data.id,
    filePath: result.data.file_path,
    bucketId: result.data.bucket_id,
    url: result.data.download_url,
  };
}
