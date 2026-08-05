import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';
import { WorkbenchExportService } from './workbench-export.service';
import { WorkbenchViewService } from './workbench-view.service';
import { DangerousActionService } from './dangerous-action.service';

@Module({
  controllers: [OperationsController],
  providers: [
    OperationsService,
    RoleWorkbenchService,
    WorkbenchExportService,
    WorkbenchViewService,
    DangerousActionService,
  ],
  exports: [
    OperationsService,
    RoleWorkbenchService,
    WorkbenchExportService,
    WorkbenchViewService,
    DangerousActionService,
  ],
})
export class OperationsModule {}
