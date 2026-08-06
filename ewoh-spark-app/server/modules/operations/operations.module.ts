import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';
import { WorkbenchExportService } from './workbench-export.service';
import { WorkbenchViewService } from './workbench-view.service';
import { DangerousActionService } from './dangerous-action.service';
import { PostgresWorkbenchViewStore } from './workbench-view.store';
import { PostgresWorkbenchExportStore } from './workbench-export.store';
import {
  WORKBENCH_VIEW_STORE,
} from './workbench-view.service';
import {
  WORKBENCH_EXPORT_STORE,
} from './workbench-export.service';

@Module({
  controllers: [OperationsController],
  providers: [
    OperationsService,
    RoleWorkbenchService,
    WorkbenchExportService,
    WorkbenchViewService,
    DangerousActionService,
    PostgresWorkbenchViewStore,
    PostgresWorkbenchExportStore,
    { provide: WORKBENCH_VIEW_STORE, useClass: PostgresWorkbenchViewStore },
    { provide: WORKBENCH_EXPORT_STORE, useClass: PostgresWorkbenchExportStore },
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
