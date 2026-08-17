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

  async append(entry: AuditLogEntry): Promise<void> {
    if (!this.db) {
      this.logger.warn('Database audit sink has no database; entry not persisted');
      return;
    }

    await this.db.execute(sql`
      select ewoh_append_audit_log(
        ${entry.orgId || null}::uuid,
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
