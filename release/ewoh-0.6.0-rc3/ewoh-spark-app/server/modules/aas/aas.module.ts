import { Module } from '@nestjs/common';
import { AasController } from './aas.controller';
import { AasService } from './aas.service';

@Module({
  controllers: [AasController],
  providers: [AasService],
  exports: [AasService],
})
export class AasModule {}
