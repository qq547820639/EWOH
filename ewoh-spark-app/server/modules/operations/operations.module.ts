import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { RoleWorkbenchService } from './role-workbench.service';

@Module({
  controllers: [OperationsController],
  providers: [OperationsService, RoleWorkbenchService],
  exports: [OperationsService, RoleWorkbenchService],
})
export class OperationsModule {}
