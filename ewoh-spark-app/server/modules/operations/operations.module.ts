import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';
import { WorkbenchExportService } from './workbench-export.service';
import { WorkbenchExportWorkerService } from './workbench-export.worker';
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
    // R2-SOP-006：导出消费端 worker（轮询 claim → 拉列表 → CSV → complete）。
    WorkbenchExportWorkerService,
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
