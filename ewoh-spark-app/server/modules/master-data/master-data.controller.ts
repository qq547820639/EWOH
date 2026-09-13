import { Body, Controller, Post, Query, Req } from '@nestjs/common';
import {
  MasterDataImportService,
  type MasterDataImportInput,
} from './master-data-import.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 主数据（ERP/MES/WMS）导入入口（NO-26a）。
 *
 * 只有设备主数据责任人可以调用：`device_ops`（设备运维）与 `global_admin`。
 * 导入**不会**创建设备、**不会**复活人工停用的能力、**不会**接受词表外的能力名；
 * 每行结果逐条如实回报，并且默认支持 `?dryRun=1` 先看影响面再落库。
 */
@Controller('api/master-data')
@Roles('device_ops', 'global_admin')
export class MasterDataController {
  constructor(private readonly masterDataImportService: MasterDataImportService) {}

  @Post('capabilities/import')
  importCapabilities(
    @Body() body: MasterDataImportInput,
    @Query('dryRun') dryRun: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    const dryRunFlag = ['1', 'true', 'yes'].includes(String(dryRun ?? '').trim().toLowerCase());
    return this.masterDataImportService.importCapabilities(body, request.userContext, {
      dryRun: dryRunFlag,
    });
  }
}
