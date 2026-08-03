import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type { AuditLogEntry, AuditLogSink } from './audit.service';

@Injectable()
export class DatabaseAuditSink implements AuditLogSink {
  private readonly logger = new Logger(DatabaseAuditSink.name);

  constructor(@Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: any) {}

  async append(entry: AuditLogEntry): Promise<void> {
    if (!this.db) {
      this.logger.warn('Database audit sink has no database; entry not persisted');
      return;
    }

    await this.db.execute(sql`
      select public.ewoh_append_audit_log(
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
