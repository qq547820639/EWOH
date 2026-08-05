import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IdempotencyService } from '../shared/idempotency.service';
import { AuditService } from '../shared/audit.service';
import {
  buildCompensation,
  dangerousIdempotencyKey,
  previewDangerousImpact,
  type DangerousActionKind,
  type DangerousActionSpec,
  type DangerousImpact,
} from './dangerous-action';

/**
 * Executes the guarded confirmation flow for dangerous workbench actions.
 *
 * A dangerous action is a two-phase operation:
 *   1. `preview` — returns the impact summary (UI shows it before proceeding);
 *   2. `confirm` — idempotently applies the action. The same (action, target,
 *      payload) is executed exactly once; a replay with a changed payload is
 *      rejected (409) instead of double-applying.
 *
 * Each confirmed action records a compensation (undo) plan and an audit entry.
 */

export interface DangerousActor {
  userId: string;
  primaryOrgId: string;
  roles?: string[];
}

export interface DangerousConfirmInput extends DangerousActionSpec {
  /** Client-supplied idempotency key; falls back to a deterministic key. */
  idempotencyKey?: string;
}

@Injectable()
export class DangerousActionService {
  constructor(
    private readonly idempotencyService: IdempotencyService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /** Impact preview — no side effects. */
  preview(spec: DangerousActionSpec): DangerousImpact {
    return previewDangerousImpact(spec);
  }

  /**
   * Idempotently confirms and applies a dangerous action. Returns the impact
   * plus the compensation plan and a stable `actionId`.
   */
  async confirm(
    actor: DangerousActor,
    input: DangerousConfirmInput,
  ): Promise<{
    actionId: string;
    impact: DangerousImpact;
    compensation: ReturnType<typeof buildCompensation>;
  }> {
    const impact = previewDangerousImpact(input);
    const key =
      input.idempotencyKey ??
      dangerousIdempotencyKey(input.action, input.targetType, input.targetId);
    const payload = {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason ?? null,
    };

    const actualActionId = await this.idempotencyService.executeWithPayload<
      { actionId: string }
    >(key, payload, async () => {
      const actionId = randomUUID();
      await this.auditService?.appendAuditLog({
        actorId: actor.userId,
        orgId: actor.primaryOrgId,
        action: 'workbench.dangerous.confirm',
        entityType: input.targetType,
        entityId: input.targetId,
        metadata: {
          dangerousAction: input.action,
          affectedCount: impact.affectedCount,
          actionId,
        },
        risk: true,
      });
      return { actionId };
    });

    return {
      actionId: actualActionId.actionId,
      impact,
      compensation: buildCompensation(input.action),
    };
  }

  /** Records a compensation / undo action for a previously confirmed action. */
  async undo(
    actor: DangerousActor,
    actionId: string,
    targetType: string,
    targetId: string,
    reason = 'operator undo',
  ): Promise<{ actionId: string; undo: boolean; targetType: string; targetId: string }> {
    await this.auditService?.appendAuditLog({
      actorId: actor.userId,
      orgId: actor.primaryOrgId,
      action: 'workbench.dangerous.undo',
      entityType: targetType,
      entityId: targetId,
      metadata: { originalActionId: actionId, reason },
      risk: true,
    });
    return { actionId, undo: true, targetType, targetId };
  }
}

export type { DangerousActionKind };