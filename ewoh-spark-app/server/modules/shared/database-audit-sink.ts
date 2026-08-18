import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type { AuditLogEntry, AuditLogSink } from './audit.service';

@Injectable()
export class DatabaseAuditSink implements AuditLogSink {
  private readonly logger = new Logger(DatabaseAuditSink.name);

  // NEST-525 修复（2026-08-17）：db 类型 any → PostgresJsDatabase（保留
  // @Optional 以兼容无数据库装配的测试环境）。
  constructor(@Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: PostgresJsDatabase) {}

  /** B8（2026-08-19 审计）：ewoh_audit_log.org_id / 函数参数均为 uuid——
   * 非 UUID orgId（legacy/测试 varchar 值）经 ::uuid 强制 cast 触发 22P02，
   * 使业务写路径 500+回滚。写入前校验：非法值记 error 并跳过持久化。 */
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  async append(entry: AuditLogEntry): Promise<void> {
    if (!this.db) {
      this.logger.warn('Database audit sink has no database; entry not persisted');
      return;
    }

    const orgId = entry.orgId?.trim() || null;
    if (orgId && !DatabaseAuditSink.UUID_RE.test(orgId)) {
      this.logger.error(
        `audit orgId 非 UUID，跳过 DB 持久化（orgId=${orgId}, action=${entry.action}, entity=${entry.entityType}:${entry.entityId}）`,
      );
      return;
    }

    await this.db.execute(sql`
      select ewoh_append_audit_log(
        ${orgId}::uuid,
        ${entry.actorId},
        ${entry.action},
        ${entry.entityType},
        ${entry.entityId || ''},
        ${entry.before === undefined ? null : JSON.stringify(entry.before)}::jsonb,
        ${entry.after === undefined ? null : JSON.stringify(entry.after)}::jsonb,
        ${entry.reason || null},
        ${entry.ip || null},
        ${entry.requestId || null},
        ${entry.risk === true},
        ${entry.risk === true ? 'high' : 'normal'}
      )
    `);
  }
}
