import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ewohEvent } from '@server/database/schema';
import { buildGucSettings, type OrgContext } from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { DeviceResponsibilityService } from '../responsibility/device-responsibility.service';
import { AuditService } from '../shared/audit.service';
import {
  insertDeterministicNotifications,
  type NotificationInsertExecutor,
} from '../notification/deterministic-notifications';
import {
  DATA_QUALITY_AGING_THRESHOLD_MS,
  dataQualityAlertText,
  dataQualityNotificationPrefix,
  dataQualityRoleRecipients,
  requiresHumanVerification,
} from '@shared/data-quality-notification';

/**
 * 数据质量"待核实"提醒（NO-53a）。
 *
 * 补的缺口：摄入侧自动分级并开 `DataQualityAlert`，人工也能确认/质疑，
 * 但**没有人被主动叫到**——告警只是躺在事件表里，直到有人恰好打开工作台。
 * 本服务周期性扫描 **open 的 DataQualityAlert** 并把"该核实这批数据"叫到：
 *   责任人（复用 NO-49a 的班次路由：本班优先/全天兜底/他班报缺口）+ 角色兜底。
 *
 * 边界（与其它提醒源同一纪律）：
 *   · **只读业务事实**：不改告警状态、不写 evidence；核实判定只能由人通过
 *     `DataQualityService.confirm` 做出（闭环另一端在那里的处置终态）；
 *   · **缺失不下结论**：告警码/设备/严重度缺失时如实写进正文，不猜；
 *   · **幂等**：通知号确定性（告警号 + 桶 + 收件人 + 渠道），重复扫描只累加 duplicates；
 *   · 跨租户扫描先取"有未处置告警的租户"（受控 SECURITY DEFINER 函数），
 *     再逐租户开 GUC 事务读明细（否则 RLS 挡行 → 静默 0 条，NO-37a/NO-48a 教训）。
 */
export interface DataQualitySweepResult {
  orgId: string;
  scanned: number;
  /** 需要人核实的告警数（低风险计数类不计入打扰）。 */
  notifyRequired: number;
  created: number;
  duplicates: number;
  /** 超过 24h 仍未了结、已补发"再催一次"的告警数（NO-56b）。 */
  agingNudged: number;
  /** 责任人账号缺口（有责任关系但没绑定账号）。 */
  unresolvedResponsiblePersons: string[];
  /** 只登记了别的班次责任人（本班没人负责）。 */
  outOfShiftResponsiblePersons: string[];
  notifications: Array<{ alertEventId: string; bucket: string; recipients: string[] }>;
  generatedAt: string;
}

@Injectable()
export class DataQualityNotificationService {
  private readonly logger = new Logger(DataQualityNotificationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly responsibilities: DeviceResponsibilityService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：数据质量提醒扫描必须带租户上下文');
    }
    return orgId;
  }

  /** 单个租户的扫描（幂等；可重复调用）。 */
  async sweep(actor: OrgContext | undefined, options: { now?: Date; limit?: number } = {}): Promise<DataQualitySweepResult> {
    const orgId = this.requireOrgId(actor);
    const now = options.now ?? new Date();
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 200;
    const rows = await this.db
      .select()
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.orgId, orgId),
        eq(ewohEvent.eventType, 'DataQualityAlert'),
        eq(ewohEvent.status, 'open'),
      ))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(Math.max(1, limit));

    const result: DataQualitySweepResult = {
      orgId,
      scanned: rows.length,
      notifyRequired: 0,
      created: 0,
      duplicates: 0,
      agingNudged: 0,
      unresolvedResponsiblePersons: [],
      outOfShiftResponsiblePersons: [],
      notifications: [],
      generatedAt: now.toISOString(),
    };

    for (const row of rows) {
      const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
      const nested = (evidence.evidence ?? {}) as Record<string, unknown>;
      const code =
        typeof evidence.eventCode === 'string'
          ? evidence.eventCode
          : typeof row.eventCode === 'string'
            ? row.eventCode
            : null;
      if (!requiresHumanVerification(code)) continue;
      result.notifyRequired += 1;

      const deviceId =
        String(evidence.device_id ?? nested.device_id ?? row.deviceId ?? '').trim();
      // 责任人（班次感知）+ 角色兜底；责任人缺口如实汇总，不阻塞叫角色。
      const plan = await this.responsibilities.resolveAlertRecipients(orgId, deviceId);
      if (plan.unresolved.length > 0) {
        result.unresolvedResponsiblePersons.push(...plan.unresolved.map((entry) => entry.personId));
      }
      if (plan.outOfShift.length > 0) {
        result.outOfShiftResponsiblePersons.push(...plan.outOfShift.map((entry) => entry.personId));
      }
      const roleRecipients = dataQualityRoleRecipients(row.severity);
      const recipients = [
        ...plan.users.map((user) => ({ recipientType: 'user' as const, recipientId: user.recipientId })),
        ...roleRecipients.map((role) => ({ recipientType: 'role' as const, recipientId: role })),
      ];

      const text = dataQualityAlertText({
        code,
        deviceId: deviceId === '' ? null : deviceId,
        title: typeof row.title === 'string' ? row.title : null,
        severity: typeof row.severity === 'string' ? row.severity : null,
        firedAt: typeof evidence.fired_at === 'string' ? evidence.fired_at : null,
      });
      /**
       * NO-56b：长时间没人核实的告警**再催一次**（`quality_aging` 桶）。
       *
       * 与 `quality_alert` 用同一个告警号前缀与收件人，只有桶不同 →
       * 通知号确定性地分成两条：一条"刚发生"、一条"还没人处理"。
       * 人工判定（confirm/contested）按前缀一次性把两条都落到终态。
       */
      const agingMs = now.getTime() - new Date(row.createdAt ?? now).getTime();
      if (agingMs >= DATA_QUALITY_AGING_THRESHOLD_MS) {
        result.agingNudged += 1;
        const agingText = dataQualityAlertText({
          code,
          deviceId: deviceId === '' ? null : deviceId,
          title: `仍未核实 ${Math.floor(agingMs / 3_600_000)} 小时：${typeof row.title === 'string' ? row.title : ''}`,
          severity: typeof row.severity === 'string' ? row.severity : null,
          firedAt: typeof evidence.fired_at === 'string' ? evidence.fired_at : null,
        });
        const agingEmitted = await insertDeterministicNotifications(this.db as NotificationInsertExecutor, {
          orgId,
          externalRef: row.eventId,
          prefix: dataQualityNotificationPrefix(row.eventId),
          bucket: 'quality_aging',
          recipients,
          title: agingText.title,
          body: `${agingText.body}（已超过 ${Math.round(DATA_QUALITY_AGING_THRESHOLD_MS / 3_600_000)} 小时仍无人核实，再催一次）`,
          severity: row.severity === 'critical' || row.severity === 'high' ? 'high' : 'medium',
        });
        result.created += agingEmitted.created;
        result.duplicates += agingEmitted.duplicates;
      }

      const emitted = await insertDeterministicNotifications(this.db as NotificationInsertExecutor, {
        orgId,
        externalRef: row.eventId,
        prefix: dataQualityNotificationPrefix(row.eventId),
        bucket: 'quality_alert',
        recipients,
        title: text.title,
        body: text.body,
        severity: row.severity === 'critical' || row.severity === 'high' ? 'high' : 'medium',
      });
      result.created += emitted.created;
      result.duplicates += emitted.duplicates;
      result.notifications.push({
        alertEventId: row.eventId,
        bucket: 'quality_alert',
        recipients: recipients.map((r) => `${r.recipientType}:${r.recipientId}`),
      });
    }

    // 审计留痕：扫描给人发了什么（扫描本身不改业务事实）。
    if (result.notifyRequired > 0) {
      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'system:data-quality-sweep',
        orgId,
        action: 'data_quality.notify_sweep',
        entityType: 'data_quality_alert',
        entityId: orgId,
        before: { scanned: result.scanned },
        after: {
          notifyRequired: result.notifyRequired,
          created: result.created,
          duplicates: result.duplicates,
        },
      });
    }
    return result;
  }

  /** 跨租户扫描（供定时 worker）：受控函数取租户清单 → 逐租户 GUC 事务读明细。 */
  async sweepAllActiveOrgs(options: { now?: Date; lookbackDays?: number } = {}): Promise<{
    orgs: number;
    scanned: number;
    created: number;
    duplicates: number;
    failures: Array<{ orgId: string; error: string }>;
  }> {
    const lookbackDays = options.lookbackDays ?? 7;
    let orgRows: Array<{ org_id?: string | null }> = [];
    try {
      orgRows = (await this.db.execute(sql`
        SELECT org_id FROM "ewoh_open_quality_alert_orgs"((${lookbackDays} || ' days')::interval)
      `)) as unknown as Array<{ org_id?: string | null }>;
    } catch (error) {
      this.logger.error(`数据质量租户清单读取失败：${String(error)}`);
      return { orgs: 0, scanned: 0, created: 0, duplicates: 0, failures: [{ orgId: '', error: String(error).slice(0, 200) }] };
    }
    let scanned = 0;
    let created = 0;
    let duplicates = 0;
    const failures: Array<{ orgId: string; error: string }> = [];
    for (const row of orgRows) {
      const orgId = String(row.org_id ?? '').trim();
      if (!orgId) continue;
      const systemCtx = {
        userId: 'system',
        primaryOrgId: orgId,
        roles: ['global_admin'],
      } as OrgContext;
      try {
        const result = await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(systemCtx),
          () => this.sweep(systemCtx, options),
        );
        scanned += result.scanned;
        created += result.created;
        duplicates += result.duplicates;
      } catch (error) {
        failures.push({ orgId, error: String(error).slice(0, 200) });
        this.logger.error(`数据质量提醒扫描失败 org=${orgId}: ${String(error)}`);
      }
    }
    return { orgs: orgRows.length, scanned, created, duplicates, failures };
  }
}
