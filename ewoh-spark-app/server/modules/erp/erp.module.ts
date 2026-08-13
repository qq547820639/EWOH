import { Module } from '@nestjs/common';
import { ErpController } from './erp.controller';
import { ErpService } from './erp.service';
import { MesModule } from '../mes/mes.module';

@Module({
  imports: [MesModule],
  controllers: [ErpController],
  providers: [ErpService],
  exports: [ErpService],
})
export class ErpModule {}
