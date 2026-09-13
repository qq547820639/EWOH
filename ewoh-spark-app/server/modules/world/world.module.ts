import { Module } from '@nestjs/common';
import { MaterialsModule } from '../materials/materials.module';
import { WorldController } from './world.controller';
import { WorldService } from './world.service';
import { OrderChainService } from './order-chain.service';
import { OrderChainController } from './order-chain.controller';

/**
 * 世界模型模块（§6）。
 *
 * `WorldService`：快照/版本/回放读面；
 * `OrderChainService`（NO-57a）：订单 → 任务/工序 → 物料的链路消费面（含断链缺口）。
 */
@Module({
  imports: [MaterialsModule],
  controllers: [WorldController, OrderChainController],
  providers: [WorldService, OrderChainService],
  exports: [WorldService, OrderChainService],
})
export class WorldModule {}
