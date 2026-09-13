import { Module } from '@nestjs/common';
import { RetrospectiveService } from './retrospective.service';
import { RetrospectiveController } from './retrospective.controller';
import { SharedModule } from '../shared/shared.module';
import { AiModule } from '../ai/ai.module';

/**
 * Retrospective 模块（standalone_075，DR-3）：复盘/运行记忆——闭环六段组装
 * + AI 总结（LLM 事务外调用、规则模板兜底、narrationSource 双路留痕）。
 * 依赖 SharedModule（审计）；AiModule 提供 ArkService（Optional 装配，
 * 未配置时降级 rule_fallback，绝不冒充 LLM 产出）。
 */
@Module({
  imports: [SharedModule, AiModule],
  controllers: [RetrospectiveController],
  providers: [RetrospectiveService],
  exports: [RetrospectiveService],
})
export class RetrospectiveModule {}
