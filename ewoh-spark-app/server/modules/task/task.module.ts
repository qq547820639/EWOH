import { Module } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { ApprovalModule } from '../approval/approval.module';
// NO-36a：任务指派写入必须能读外骨骼会话权威事实（执行边界，不因入口而异）。
import { ExoSessionModule } from '../exo/exo-session.module';

@Module({
  imports: [ApprovalModule, ExoSessionModule],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}
