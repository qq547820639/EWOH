import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { FileService, type FileAccessContext } from './file.service';
import { Roles } from '../shared/roles.decorator';
import type { ScanStatus } from './storage/storage-driver';

const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_ALLOWED_MIME_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'image/jpeg',
  'image/png',
  'image/webp',
  'model/gltf+json',
  'model/gltf-binary',
  'text/csv',
  'text/plain',
]);

interface AuthenticatedFileRequest {
  userContext?: {
    userId: string;
    primaryOrgId: string;
    isGlobalAdmin?: boolean;
  };
}

export function maxUploadBytes(): number {
  const configured = Number(process.env.MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * NEST-357（2026-08-17 审计整改）：上传限制统一为启动时求值一次——
 * FileInterceptor 的 limits 只在装饰器求值时读取一次 env（运行时改
 * MAX_UPLOAD_BYTES 原本就无效），allowedMimeTypes 原先却每请求读 env，
 * 两端口径不一致。现两者同为模块加载时快照；运行时调整需重启生效。
 */
const UPLOAD_FILE_SIZE_LIMIT = maxUploadBytes();
const UPLOAD_ALLOWED_MIME_TYPES = allowedMimeTypes();

function allowedMimeTypes(): Set<string> {
  const configured = process.env.UPLOAD_ALLOWED_MIME_TYPES?.split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured?.length ? new Set(configured) : DEFAULT_ALLOWED_MIME_TYPES;
}

@Controller('api/files')
@Roles('global_admin', 'device_ops')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: UPLOAD_FILE_SIZE_LIMIT,
        files: 1,
        fields: 4,
        fieldSize: 4096,
      },
      fileFilter: (_request, file, callback) => {
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
          callback(
            new UnsupportedMediaTypeException(`Unsupported file type: ${file.mimetype}`),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  async upload(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
    @Req() request: AuthenticatedFileRequest,
    @Body('note') note?: string,
    @Body('idempotencyKey') idempotencyKey?: string,
  ) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('file is required and must not be empty');
    }
    return this.fileService.save(
      file.buffer,
      file.originalname ?? 'file',
      file.mimetype ?? 'application/octet-stream',
      this.access(request),
      note,
      idempotencyKey,
    );
  }

  @Get()
  list(@Req() request: AuthenticatedFileRequest) {
    return this.fileService.list(this.access(request));
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedFileRequest) {
    return this.fileService.get(id, this.access(request));
  }

  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Req() request: AuthenticatedFileRequest,
    @Res() res: Response,
  ) {
    // NEST-338：流式下载——驱动支持 openReadStream 时走 StreamableFile
    // （不再 20MB×并发全内存 res.send(buffer)）；否则回退缓冲路径。
    const { record, stream } = await this.fileService.downloadStream(id, this.access(request));
    res.setHeader('Content-Type', record.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.filename)}"`);
    if (stream) {
      const readable = stream as import('node:stream').Readable;
      // 流式下载必须挂 error 兜底：定位与打开之间的 TOCTOU 删除 / 存储端
      // 中断会让流发出 'error'，pipe 不转发错误且无人监听 ⇒ uncaught
      // exception ⇒ 整个 API 进程退出（pipe 过程中 headers 已发出，只能
      // 掐断连接，不能再造一个 5xx 响应）。
      readable.on('error', () => {
        res.destroy();
      });
      const file = new StreamableFile(readable);
      file.getStream().pipe(res);
      return;
    }
    const { buffer } = await this.fileService.download(id, this.access(request));
    res.send(buffer);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: AuthenticatedFileRequest) {
    await this.fileService.remove(id, this.access(request));
    return { success: true };
  }

  @Post(':id/presigned-url')
  async presignedUrl(
    @Param('id') id: string,
    @Req() request: AuthenticatedFileRequest,
    @Body() body: { expiresInSeconds?: number; contentType?: string },
  ) {
    return this.fileService.createPresignedUrl(id, this.access(request), {
      expiresInSeconds: body?.expiresInSeconds,
      contentType: body?.contentType,
    });
  }

  @Post(':id/scan-result')
  async scanResult(
    @Param('id') id: string,
    @Req() request: AuthenticatedFileRequest,
    @Body() body: { status?: ScanStatus },
  ) {
    const status = body?.status;
    if (status !== 'clean' && status !== 'infected') {
      throw new BadRequestException('scan status must be "clean" or "infected"');
    }
    return this.fileService.markScanned(id, this.access(request), status);
  }

  private access(request: AuthenticatedFileRequest): FileAccessContext {
    if (!request.userContext?.userId || !request.userContext.primaryOrgId) {
      throw new BadRequestException('Authenticated organization context is required');
    }
    return {
      userId: request.userContext.userId,
      orgId: request.userContext.primaryOrgId,
      isGlobalAdmin: request.userContext.isGlobalAdmin,
    };
  }
}
