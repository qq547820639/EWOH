import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

/**
 * Knowledge 模块（ADR-018 Amendment 1 / NO-07b）：Factory Knowledge System
 * 运行时——知识条目唯一权威写路径（register/retrieve 五层 scope 阶梯/
 * transition 人工 verifiedBy 审计）+ ewoh_knowledge_entry 持久化
 * （standalone_039 TENANT_SCOPED + 共享层哨兵 org）+
 * KnowledgeEntryCreated 目录事件。
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
