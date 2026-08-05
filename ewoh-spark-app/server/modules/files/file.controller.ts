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
        fileSize: maxUploadBytes(),
        files: 1,
        fields: 4,
        fieldSize: 4096,
      },
      fileFilter: (_request, file, callback) => {
        if (!allowedMimeTypes().has(file.mimetype.toLowerCase())) {
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
    const { record, buffer } = await this.fileService.download(id, this.access(request));
    res.setHeader('Content-Type', record.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.filename)}"`);
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
