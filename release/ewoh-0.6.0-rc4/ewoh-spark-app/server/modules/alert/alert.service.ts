import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohEvent } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export function nextAlertStatus(
  current: string,
  action: string,
): string | null {
  switch (action) {
    case 'acknowledge':
      return current === 'open' || current === 'reopened'
        ? 'acknowledged'
        : null;
    case 'process':
      return current === 'acknowledged' || current === 'reopened'
        ? 'processing'
        : null;
    case 'close':
      return current === 'processing' ? 'closed' : null;
    case 'reopen':
      return current === 'closed' ? 'reopened' : null;
    default:
      return null;
  }
}

@Injectable()
export class AlertService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async listAlerts() {
    return this.db.select().from(ewohEvent).orderBy(desc(ewohEvent.createdAt));
  }

  async getAlert(eventId: string) {
    const [row] = await this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventId, eventId));
    if (!row) {
      throw new NotFoundException(`Alert ${eventId} not found`);
    }
    return row;
  }

  async transitionAlert(eventId: string, action: string, actor?: OrgContext) {
    const alert = await this.getAlert(eventId);
    const currentStatus = alert.status ?? 'open';
    const status = nextAlertStatus(currentStatus, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${alert.status}`,
      );
    }
    const [row] = await this.db
      .update(ewohEvent)
      .set({ status })
      .where(
        and(
          eq(ewohEvent.eventId, eventId),
          eq(ewohEvent.status, currentStatus),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `alert.${action}`,
      entityType: 'alert',
      entityId: row.eventId,
      before: { status: currentStatus },
      after: { status: row.status },
    });
    return row;
  }
}
