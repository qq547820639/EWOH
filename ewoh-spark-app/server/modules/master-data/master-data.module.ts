import { Module } from '@nestjs/common';
import { MasterDataController } from './master-data.controller';
import { MasterDataImportService } from './master-data-import.service';
import { SharedModule } from '../shared/shared.module';

/**
 * 主数据导入模块（NO-26a）：ERP/MES/WMS 的设备能力清单 → 受控批量入口。
 * 只写既有能力台账（零新表），人工停用优先、词表 fail-closed、全过程审计。
 */
@Module({
  imports: [SharedModule],
  controllers: [MasterDataController],
  providers: [MasterDataImportService],
  exports: [MasterDataImportService],
})
export class MasterDataModule {}
