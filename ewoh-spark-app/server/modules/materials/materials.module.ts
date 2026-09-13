import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

/**
 * 物料模块（NO-27a）：从 ERP 出站事件投影库存（零新表），供读面与推理事实用。
 */
@Module({
  controllers: [MaterialsController],
  providers: [MaterialsService],
  exports: [MaterialsService],
})
export class MaterialsModule {}
