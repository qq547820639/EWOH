import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IdempotencyService } from '../shared/idempotency.service';
import { AuditService } from '../shared/audit.service';
import {
  buildCompensation,
  dangerousIdempotencyKey,
  DANGEROUS_ACTION_KINDS,
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
    this.assertKnownKind(spec?.action);
    return previewDangerousImpact(spec);
  }

  /**
   * 未知 kind 必须以 400 拒绝：previewDangerousImpact 直接查
   * ACTION_LABELS/ACTION_TEMPLATES 表，未知 kind 会 TypeError → 500。
   */
  private assertKnownKind(action: unknown): asserts action is DangerousActionKind {
    if (!DANGEROUS_ACTION_KINDS.includes(action as DangerousActionKind)) {
      throw new BadRequestException(
        `action must be one of ${DANGEROUS_ACTION_KINDS.join(', ')}`,
      );
    }
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
    this.assertKnownKind(input?.action);
    const impact = previewDangerousImpact(input);
    const key = this.scopedKey(actor, input);
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

  /**
   * 幂等键必须带租户前缀：ewoh_idempotency_keys 的隔离依赖 RLS/org 谓词，
   * 而部署形态存在以表 owner 连接（RLS 不生效）的情况；裸
   * `dangerous:{action}:{targetType}:{targetId}` 会让 A/B 租户对同形
   * (targetType, targetId) 的确认互相吞并（B 拿到 A 的 actionId，且 B 的
   * 确认审计丢失）。同租户内幂等语义不变。
   */
  private scopedKey(
    actor: DangerousActor,
    input: DangerousConfirmInput,
  ): string {
    const base =
      input.idempotencyKey ??
      dangerousIdempotencyKey(input.action, input.targetType, input.targetId);
    return `${base}::org:${actor.primaryOrgId}`;
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