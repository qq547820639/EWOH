import { Module } from '@nestjs/common';
import { MesController } from './mes.controller';
import { MesService } from './mes.service';

@Module({
  controllers: [MesController],
  providers: [MesService],
  exports: [MesService],
})
export class MesModule {}
