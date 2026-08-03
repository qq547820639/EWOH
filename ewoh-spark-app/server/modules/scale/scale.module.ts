import { Module } from '@nestjs/common';
import { ScaleController } from './scale.controller';
import { ScaleService } from './scale.service';

@Module({
  controllers: [ScaleController],
  providers: [ScaleService],
  exports: [ScaleService],
})
export class ScaleModule {}
