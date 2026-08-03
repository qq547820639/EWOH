import { Module } from '@nestjs/common';
import { WorldCursorController } from './world-cursor.controller';
import { WorldCursorService } from './world-cursor.service';

@Module({
  controllers: [WorldCursorController],
  providers: [WorldCursorService],
  exports: [WorldCursorService],
})
export class WorldCursorModule {}
