import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  ewohDataQualityConfirmation,
  ewohEvent,
} from '@server/database/schema';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';
import { resolveNotificationsFor } from '../notification/notification-resolution.link';
import { dataQualityNotificationPrefix } from '@shared/data-quality-notification';
import {
  validateDataQualityConfirmation,
  type DataQualityConfirmation,
  type DataQualityVerdict,
} from '@shared/data-quality-confirmation';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';
import { AlertService } from '../alert/alert.service';

export interface ConfirmInput {
  eventId: string;
  verdict: DataQualityVerdict;
  note?: string | null;
}

/**
 * 数据质量人工确认服务（standalone_076，DR-4 闭环第②步）。
 *
 * - 登记人对单一事件数据质量的最终判定：confirmed=可信可用于决策 /
 *   contested=不可信相关决策需复核；判定人取服务端会话（不信任客户端自报）；
 * - 幂等：同一事件至多一条最终判定（UNIQUE）；改判=UPDATE 覆盖 + 审计留痕；
 * - verdict=confirmed 时自动 resolve 关联的 open DataQualityAlert（同一
 *   evidence.evidenceJson.sourceEventId 链），resolve 失败不影响确认主事实
 *   （告警处理是衍生动作，主事实已落账）；contested 保持告警 open（不可信
 *   数据必须持续可见，直到被处置）；
 * - 事件：DataQualityConfirmed（Canonical 信封）。
 */
@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    // 告警联动为衍生动作：装配缺失时跳过（显式 warn），不阻断确认主事实。
    @Optional() private readonly alertService?: AlertService,
  ) {}

  private requireActor(actor?: OrgContext): OrgContext {
    if (!actor?.primaryOrgId?.trim() || !actor.userId?.trim()) {
      throw new ForbiddenException('数据质量确认必须带认证租户上下文');
    }
    return actor;
  }

  /** 登记确认/改判（幂等覆盖）并联动告警。 */
  async confirm(input: ConfirmInput, actor?: OrgContext) {
    const ctx = this.requireActor(actor);
    const [target] = await this.db
      .select()
      .from(ewohEvent)
      .where(and(eq(ewohEvent.eventId, input.eventId), eq(ewohEvent.orgId, ctx.primaryOrgId)))
      .limit(1);
    if (!target) {
      throw new NotFoundException(`事件 ${input.eventId} 不存在（同租户内）`);
    }

    const now = new Date();
    const record: DataQualityConfirmation = {
      eventId: input.eventId,
      verdict: input.verdict,
      note: input.note ?? null,
      confirmedBy: ctx.userId,
      confirmedAt: now.toISOString(),
      context: {
        dataQuality: (target.evidenceJson as Record<string, unknown> | null)?.dataQuality != null
          ? String((target.evidenceJson as Record<string, unknown>).dataQuality)
          : null,
        source: target.sourceType,
        observedAt: target.occurredAt ? target.occurredAt.toISOString() : null,
        receivedAt: target.receivedAt ? target.receivedAt.toISOString() : null,
      },
    };
    const errors = validateDataQualityConfirmation(record);
    if (errors.length > 0) {
      throw new BadRequestException(`数据质量确认违反契约: ${errors.join(', ')}`);
    }

    const row = {
      orgId: ctx.primaryOrgId,
      eventId: input.eventId,
      verdict: input.verdict,
      note: input.note ?? null,
      confirmedBy: ctx.userId,
      confirmedAt: now,
      contextJson: record.context as unknown as Record<string, unknown>,
    };
    /**
     * NO-53a：**判定主事实与"待核实提醒"终态同事务**。
     * 人的判定一旦落账，"请核实这批数据"这条提醒就不该再挂在待办里——
     * 两者分开提交会出现"已核实但提醒还挂着"或"提醒没了但判定没落"的半成品。
     * 幂等覆盖语义不变：同事件已有判定 → UPDATE（改判），否则 INSERT。
     */
    const { created, resolvedNotificationCount } = await this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(ewohDataQualityConfirmation)
        .where(and(
          eq(ewohDataQualityConfirmation.orgId, ctx.primaryOrgId),
          eq(ewohDataQualityConfirmation.eventId, input.eventId),
        ))
        .limit(1);
      if (existingRows.length > 0) {
        await tx
          .update(ewohDataQualityConfirmation)
          .set({ verdict: input.verdict, note: input.note ?? null, confirmedBy: ctx.userId, confirmedAt: now })
          .where(eq(ewohDataQualityConfirmation.id, existingRows[0].id));
      } else {
        await tx.insert(ewohDataQualityConfirmation).values(row);
      }
      const resolved = await this.resolveQualityNotifications(
        tx,
        ctx,
        input.eventId,
        target.eventType === 'DataQualityAlert' ? input.eventId : null,
        input.verdict,
      );
      return { created: existingRows.length === 0, resolvedNotificationCount: resolved };
    });

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'data_quality.confirm',
      entityType: 'event',
      entityId: input.eventId,
      reason: `verdict=${input.verdict}${input.note ? `; note=${input.note}` : ''}`,
      after: { verdict: input.verdict, note: input.note ?? null },
    });
    await this.recordConfirmationEvent(record, ctx.primaryOrgId);

    // confirmed → 联动 resolve 同源 open DataQualityAlert（衍生动作，失败不回滚主事实）。
    let linkedAlertsResolved = 0;
    if (input.verdict === 'confirmed' && this.alertService) {
      try {
        linkedAlertsResolved = await this.resolveLinkedQualityAlerts(
          input.eventId,
          ctx,
          // NO-53a：人**直接在告警上**判定是最短路径，必须同样把该告警了结。
          // 否则会出现"提醒已处置为 data_quality_confirmed，告警却永远 open"的半成品
          // （实测：只有"在源事件上判定"才会关告警，最短路径反而漏了）。
          target.eventType === 'DataQualityAlert' ? input.eventId : null,
        );
      } catch (err) {
        this.logger.warn(
          `数据质量确认联动告警失败（不阻断主事实）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { record, created, linkedAlertsResolved, resolvedNotificationCount };
  }

  /** 查询若干事件的确认状态（复盘/工作台批量展示）。 */
  async getConfirmations(eventIds: string[], actor?: OrgContext) {
    const ctx = this.requireActor(actor);
    if (eventIds.length === 0) return [] as DataQualityConfirmation[];
    const rows = await this.db
      .select()
      .from(ewohDataQualityConfirmation)
      .where(and(
        eq(ewohDataQualityConfirmation.orgId, ctx.primaryOrgId),
        inArray(ewohDataQualityConfirmation.eventId, eventIds.slice(0, 100)),
      ));
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * NO-53a：把"待核实提醒"落到处置终态（与判定同事务）。
   *
   * 范围：①人直接在告警事件上判定 → 只resolve该告警；
   *      ②人在**源事件**上判定 → resolve 所有引用该源事件的 open 告警提醒
   *      （与 `resolveLinkedQualityAlerts` 同一链路，避免两套关联口径）。
   * 处置码区分"数据可信"与"数据不可信"（后者意味着相关决策需复核，不是"没事"）。
   */
  private async resolveQualityNotifications(
    tx: Pick<PostgresJsDatabase, 'select' | 'update'>,
    ctx: OrgContext,
    sourceEventId: string,
    directAlertEventId: string | null,
    verdict: 'confirmed' | 'contested',
  ): Promise<number> {
    const alertIds = new Set<string>();
    if (directAlertEventId) alertIds.add(directAlertEventId);
    // 源事件 → 引用它的 open 告警（与告警联动 resolve 同一口径）
    const alerts = (await tx
      .select({ eventId: ewohEvent.eventId, evidenceJson: ewohEvent.evidenceJson })
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.orgId, ctx.primaryOrgId),
        eq(ewohEvent.eventType, 'DataQualityAlert'),
        eq(ewohEvent.status, 'open'),
      ))
      .limit(200)) as Array<{ eventId: string; evidenceJson: unknown }>;
    for (const alert of alerts) {
      const ev = alert.evidenceJson as Record<string, unknown> | null;
      const nested = ev?.evidence as Record<string, unknown> | null | undefined;
      if (ev?.sourceEventId === sourceEventId || nested?.sourceEventId === sourceEventId) {
        alertIds.add(alert.eventId);
      }
    }
    let resolved = 0;
    for (const alertEventId of alertIds) {
      const outcome = await resolveNotificationsFor(tx as never, {
        orgId: ctx.primaryOrgId,
        externalRef: alertEventId,
        notificationIdPrefix: dataQualityNotificationPrefix(alertEventId),
        resolution: verdict === 'confirmed' ? 'data_quality_confirmed' : 'data_quality_contested',
        resolvedBy: ctx.userId,
        resolutionRef: sourceEventId,
      });
      resolved += outcome.closed + outcome.annotated;
    }
    return resolved;
  }

  /**
   * 把 `confirmed` 判定联动到告警事件状态：
   *   · `directAlertEventId` —— 人直接判定的就是这条告警（最短路径）；
   *   · 以及 evidence 里 `sourceEventId` 指向本次判定事件的其它 open 告警。
   * 只处理未 `closed` 的行（已 `closed` 的重复判定是幂等 no-op，不报错、不覆盖终态）。
   */
  private async resolveLinkedQualityAlerts(
    sourceEventId: string,
    ctx: OrgContext,
    directAlertEventId: string | null = null,
  ): Promise<number> {
    const linked: string[] = [];
    if (directAlertEventId) {
      const [direct] = await this.db
        .select({ eventType: ewohEvent.eventType, status: ewohEvent.status })
        .from(ewohEvent)
        .where(and(
          eq(ewohEvent.orgId, ctx.primaryOrgId),
          eq(ewohEvent.eventId, directAlertEventId),
        ))
        .limit(1);
      if (direct?.eventType === 'DataQualityAlert' && String(direct.status ?? '') !== 'closed') {
        linked.push(directAlertEventId);
      }
    }
    const alerts = (await this.db
      .select({ eventId: ewohEvent.eventId })
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.orgId, ctx.primaryOrgId),
        eq(ewohEvent.eventType, 'DataQualityAlert'),
        // 未了结即可（open / acknowledged / processing / reopened 都要能走到 closed）
        ne(ewohEvent.status, 'closed'),
      ))
      .limit(200)) as Array<{ eventId: string }>;
    if (linked.length > 0) {
      // 已登记的直判告警不必在下面的扫描里重复 resolve（避免重复审计与重复 transition）。
      for (let i = alerts.length - 1; i >= 0; i -= 1) {
        if (alerts[i].eventId === directAlertEventId) alerts.splice(i, 1);
      }
    }
    for (const a of alerts) {
      const [row] = await this.db
        .select({ evidenceJson: ewohEvent.evidenceJson })
        .from(ewohEvent)
        .where(eq(ewohEvent.eventId, a.eventId))
        .limit(1);
      const ev = row?.evidenceJson as Record<string, unknown> | null;
      const nested = ev?.evidence as Record<string, unknown> | null | undefined;
      if (ev?.sourceEventId === sourceEventId || nested?.sourceEventId === sourceEventId) {
        linked.push(a.eventId);
      }
    }
    for (const eventId of linked) {
      try {
        await this.closeAlertThroughLegalChain(eventId, ctx);
      } catch (err) {
        this.logger.warn(
          `联动了结 DataQualityAlert ${eventId} 失败（判定主事实已落账，告警需人工按告警流程处理）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return linked.length;
  }

  /**
   * 按 ADR-031 告警状态机**合法链**了结告警：open → acknowledged → processing → closed。
   *
   * 为什么不能一步 `resolve`：状态机（`contracts/state-machines/alert.yaml`）刻意不提供
   * `open → closed`，SH-004 门禁还把"跳过确认直接关闭"钉成非法——这是安全属性，不能为了
   * 顺手而放宽。实测：旧实现直接调 `transitionAlert(id,'resolve')` 在 open 告警上**永远失败**
   * （`Transition resolve not allowed from open`），而调用处只 warn 不报错，于是
   * "confirmed 联动关闭告警"成了死代码（DR-4 的 e2e 只打印数字、不断言，没人发现）。
   *
   * 每一步都由**做出判定的人**作为 actor 记录审计；状态不在链上（未知态）时立即停手，
   * 不猜、不硬改（宁可不关，也不伪造处置事实）。
   */
  private async closeAlertThroughLegalChain(eventId: string, ctx: OrgContext): Promise<void> {
    const nextAction: Record<string, 'acknowledge' | 'process' | 'close'> = {
      open: 'acknowledge',
      reopened: 'acknowledge',
      acknowledged: 'process',
      processing: 'close',
    };
    for (let step = 0; step < 4; step += 1) {
      const [row] = await this.db
        .select({ status: ewohEvent.status })
        .from(ewohEvent)
        .where(and(eq(ewohEvent.orgId, ctx.primaryOrgId), eq(ewohEvent.eventId, eventId)))
        .limit(1);
      const status = String(row?.status ?? '');
      if (status === 'closed') return;
      const action = nextAction[status];
      if (!action) {
        this.logger.warn(
          `DataQualityAlert ${eventId} 当前状态 ${status || '未知'} 不在合法链上，停手（不伪造处置）`,
        );
        return;
      }
      await this.alertService!.transitionAlert(eventId, action, ctx);
    }
  }

  private toRecord(r: typeof ewohDataQualityConfirmation.$inferSelect): DataQualityConfirmation {
    return {
      eventId: r.eventId,
      verdict: r.verdict === 'contested' ? 'contested' : 'confirmed',
      note: r.note,
      confirmedBy: r.confirmedBy,
      confirmedAt: r.confirmedAt.toISOString(),
      context: (r.contextJson as DataQualityConfirmation['context']) ?? null,
    };
  }

  /** DataQualityConfirmed 目录事件（Canonical 信封）。 */
  private async recordConfirmationEvent(record: DataQualityConfirmation, orgId: string) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'DataQualityConfirmed',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:data-quality',
      subject: record.eventId,
      correlationId: currentTraceId() ?? null,
    });
    const evidence = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'DataQualityConfirmed',
      eventCode: 'DATA_QUALITY_CONFIRMED',
      severity: 'low',
      title: `DataQualityConfirmed: ${record.eventId} → ${record.verdict}`,
      status: 'closed',
      sourceType: 'data_quality',
      orgId,
      createdAt: now,
      occurredAt: now,
      receivedAt: now,
      schemaVersion: '1.0.0',
      evidenceJson: {
        envelope: evidence.envelope,
        envelopeSemantics: evidence.envelopeSemantics,
        confirmedEventId: record.eventId,
        verdict: record.verdict,
        confirmedBy: record.confirmedBy,
        note: record.note,
      } as unknown as Record<string, unknown>,
    });
  }
}
