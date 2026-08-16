import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';

/**
 * Identity 模块（ADR-006 / NO-02b）：Canonical Industrial Identity 的
 * 注册/解析/列表 API + ewoh_identity_mapping 持久化 + EntityIdentityMapped 事件。
 */
@Module({
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
