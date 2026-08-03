import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { resolveStorageDriver, STORAGE_DRIVER } from './storage/storage-driver.factory';

@Module({
  controllers: [FileController],
  providers: [
    {
      provide: STORAGE_DRIVER,
      useFactory: () => resolveStorageDriver(),
    },
    FileService,
  ],
  exports: [FileService],
})
export class FilesModule {}
