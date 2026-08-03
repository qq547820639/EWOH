import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq, inArray } from 'drizzle-orm';
import { ewohScheduleTaskStep } from '@server/database/schema';
import { MesService } from '../mes/mes.service';
import type { OrgContext } from '../shared/org-context.interceptor';

@Injectable()
export class MobileService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly mesService: MesService,
  ) {}

  async listWorkbench(personId: string) {
    if (!personId?.trim()) {
      return [];
    }
    return this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(
        inArray(ewohScheduleTaskStep.status, [
          'pending',
          'in_progress',
          'paused',
        ]),
      )
      .orderBy(desc(ewohScheduleTaskStep.actualStart));
  }

  async scanOrder(orderId: string) {
    return this.mesService.getWorkOrder(orderId);
  }

  async getOrder(orderId: string) {
    return this.mesService.getWorkOrder(orderId);
  }

  async transitionStep(
    orderId: string,
    stepId: string,
    action: string,
    body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    return this.mesService.transitionStep(orderId, stepId, action, body, actor);
  }
}
