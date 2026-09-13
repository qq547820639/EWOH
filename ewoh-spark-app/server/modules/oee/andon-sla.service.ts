import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ewohEvent } from '@server/database/schema';
import {
  andonBreachRecipients,
  andonBreachText,
  evaluateAndonSla,
  type AndonBreachBucket,
} from '@shared/andon-sla';
import { buildGucSettings, type OrgContext } from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { insertAndonNotifications } from '../notification/andon-notifications';
import { DeviceResponsibilityService } from '../responsibility/device-responsibility.service';

/**
 * 安灯"超时未接手"升级（NO-48a）。
 *
 * 补的缺口：现有 SLA 升级只在**有人接手但接晚了**时触发
 * （`OeeService.transitionAndon` 的 acknowledge 分支）。真实且危险的场景是
 * **红灯亮了、没人接手**——事件停在 `open`，既不升级也不叫第二个人，
 * 直到有人偶然打开看板。本服务周期性扫描并升级这一种安灯。
 *
 * 边界（原则 4/6/7）：
 *   · **只升级"没人接手"的安灯**（`open`）：`acknowledged`/`processing` 表示有人在处理，
 *     不做重复升级（那是噪音，不是安全）；
 *   · **只读业务事实**：不修改安灯状态、不写 evidence（升级是提醒与审计留痕，
 *     不代替人处置）；判定依赖 `evidence.openedAt` / `evidence.slaSeconds`；
 *   · **缺失即不下结论**：开启时间无法解析 → 跳过并计数（`undecidable`），
 *     不用"现在"当开启时间；
 *   · **幂等**：通知号确定性（安灯 + 档位 + 收件人 + 渠道），重复扫描只累加 duplicates。
 *
 * 后台 worker 与手动触发共用同一实现；跨租户扫描必须先取"有未关闭安灯的租户清单"
 * （受控 SECURITY DEFINER 函数），再逐租户开 GUC 事务读明细——否则 RLS 会把行全挡住
 * （NO-37a 实测教训，见 production-runbook「后台 Worker」）。
 */
/**
 * 受控函数调用语句（**必须显式 ::interval**）。
 *
 * 实测教训（2026-09-12）：`ewoh_open_andon_orgs(p_lookback interval)` 传
 * `($1 || ' days')`（text）时 PostgreSQL 不会隐式转 interval → 报
 * `function ewoh_open_andon_orgs(text) does not exist`，worker 每 tick 都失败、
 * 日志里只有"失败 1 个"（不会有人主动去看）。因此把构造抽成可测函数，
 * 由单测钉死"参数带 ::interval 转型"。
 */
export function buildOpenAndonOrgsQuery(lookbackDays: number) {
  return sql`SELECT org_id FROM "ewoh_open_andon_orgs"((${lookbackDays} || ' days')::interval)`;
}

export interface AndonSlaSweepResult {
  orgId: string;
  scanned: number;
  openAndons: number;
  breached: number;
  /** 因开启时间缺失/非法而无法判定（如实计数，不当成"没超期"）。 */
  undecidable: number;
  created: number;
  duplicates: number;
  escalations: Array<{
    eventId: string;
    level: 1 | 2;
    bucket: AndonBreachBucket;
    ageSeconds: number;
    /** 本次真实投递的收件人（账号 + 角色），顺序稳定。 */
    recipients: string[];
    /** 点名到人的责任人（已绑定账号）。 */
    responsiblePersons: string[];
    /** 有责任关系但**没有绑定账号**的责任人（缺口，如实报出）。 */
    unresolvedResponsiblePersons: string[];
    /** NO-51a：本次判定使用的班次（null = 当前班次未知）。 */
    shiftId: string | null;
    /** NO-51a：**只覆盖别的班次**的责任人（本班不在岗，不算收件人）。 */
    outOfShiftPersons: string[];
  }>;
  /** 本次扫描遇到的责任人账号缺口汇总（去重；非空说明"提醒发不到责任人"）。 */
  unresolvedResponsiblePersons: string[];
  /** NO-51a：本次扫描遇到"只登记了别的班次责任人"的设备责任人汇总（本班没人负责）。 */
  outOfShiftResponsiblePersons: string[];
  generatedAt: string;
}

@Injectable()
export class AndonSlaService {
  private readonly logger = new Logger(AndonSlaService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly responsibilities: DeviceResponsibilityService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：安灯 SLA 扫描必须带租户上下文');
    }
    return orgId;
  }

  /** 单个租户的扫描（幂等；可重复调用）。 */
  async sweep(actor: OrgContext | undefined, options: { now?: Date } = {}): Promise<AndonSlaSweepResult> {
    const orgId = this.requireOrgId(actor);
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const rows = await this.db
      .select()
      .from(ewohEvent)
      .where(and(eq(ewohEvent.orgId, orgId), inArray(ewohEvent.eventType, ['AndonRaised', 'andon'])))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(500);

    const result: AndonSlaSweepResult = {
      orgId,
      scanned: rows.length,
      openAndons: 0,
      breached: 0,
      undecidable: 0,
      created: 0,
      duplicates: 0,
      escalations: [],
      unresolvedResponsiblePersons: [],
      outOfShiftResponsiblePersons: [],
      generatedAt: now.toISOString(),
    };

    for (const row of rows) {
      const status = String(row.status ?? 'open');
      // 只升级"没人接手"的安灯；已接手/已关闭不在这里重复升级。
      if (status !== 'open') continue;
      result.openAndons += 1;
      const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
      const openedAtRaw = String(evidence.openedAt ?? '');
      const openedAtParsed = openedAtRaw ? Date.parse(openedAtRaw) : Number.NaN;
      const openedAtMs = Number.isFinite(openedAtParsed)
        ? openedAtParsed
        : row.createdAt
          ? new Date(row.createdAt).getTime()
          : Number.NaN;
      const slaRaw = evidence.slaSeconds ?? evidence.slaMinutes;
      const slaSeconds =
        evidence.slaSeconds != null
          ? Number(evidence.slaSeconds)
          : evidence.slaMinutes != null
            ? Number(evidence.slaMinutes) * 60
            : null;
      const state = evaluateAndonSla({
        openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : null,
        slaSeconds,
        nowMs,
      });
      if (state.reason !== null) {
        result.undecidable += 1;
        continue;
      }
      if (state.breachLevel === 0 || state.bucket === null || state.ageSeconds === null) continue;
      result.breached += 1;

      // NO-49a：升级受众 = 设备责任人（点名到人）+ 分级角色兜底。
      // 责任人没有绑定账号时如实计数（unresolved），不假装通知到了。
      const roleRecipients = andonBreachRecipients(state.breachLevel);
      const deviceId = typeof evidence.deviceId === 'string' ? evidence.deviceId : '';
      const plan = await this.responsibilities.resolveAlertRecipients(orgId, deviceId);
      const recipients = [
        ...plan.users.map((user) => user.recipientId),
        ...roleRecipients,
      ];
      const text = andonBreachText({
        title: String(row.title ?? '安灯'),
        deviceId: typeof evidence.deviceId === 'string' ? evidence.deviceId : null,
        ageSeconds: state.ageSeconds,
        slaSeconds: state.slaSeconds,
        level: state.breachLevel,
        slaIsDefault: state.slaIsDefault,
      });
      const emitted = await insertAndonNotifications(this.db, orgId, {
        recipients: [
          ...plan.users.map((user) => ({ recipientType: 'user' as const, recipientId: user.recipientId })),
          ...roleRecipients.map((role) => ({ recipientType: 'role' as const, recipientId: role })),
        ],
        externalRef: String(row.eventId),
        title: text.title,
        body: text.body,
        severity: 'high',
        bucket: state.bucket,
      });
      result.created += emitted.created;
      result.duplicates += emitted.duplicates;
      result.escalations.push({
        eventId: String(row.eventId),
        level: state.breachLevel,
        bucket: state.bucket,
        ageSeconds: state.ageSeconds,
        recipients,
        responsiblePersons: plan.users.map((user) => user.personId),
        unresolvedResponsiblePersons: plan.unresolved.map((entry) => entry.personId),
        shiftId: plan.shiftId,
        outOfShiftPersons: plan.outOfShift.map((entry) => entry.personId),
      });
      if (plan.unresolved.length > 0) {
        result.unresolvedResponsiblePersons.push(
          ...plan.unresolved.map((entry) => entry.personId),
        );
      }
      if (plan.outOfShift.length > 0) {
        result.outOfShiftResponsiblePersons.push(
          ...plan.outOfShift.map((entry) => entry.personId),
        );
      }
      // 审计留痕：升级本身也要可追溯（谁在何时把哪条安灯升到哪一级）。
      // 扫描不改业务事实，但"我给谁发了升级"必须留账。
      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'system:andon-sla-sweep',
        orgId,
        action: 'oee.andon.sla_breach',
        entityType: 'event',
        entityId: String(row.eventId),
        before: { status, ageSeconds: state.ageSeconds, slaSeconds: state.slaSeconds },
        after: { breachLevel: state.breachLevel, bucket: state.bucket, recipients },
      });
    }
    return result;
  }

  /**
   * 跨租户扫描（供定时 worker）。
   *
   * 先经受控函数取"有未关闭安灯的租户"，再逐租户以 GUC 事务读明细；
   * 单租户失败只留痕不中断（与其它 worker 同纪律）。
   */
  async sweepAllActiveOrgs(options: { now?: Date; lookbackDays?: number } = {}): Promise<{
    orgs: number;
    created: number;
    duplicates: number;
    breached: number;
    undecidable: number;
    failures: Array<{ orgId: string; error: string }>;
  }> {
    const lookbackDays = options.lookbackDays ?? 7;
    let orgRows: Array<{ org_id?: string | null }> = [];
    try {
      orgRows = (await this.db.execute(
        buildOpenAndonOrgsQuery(lookbackDays),
      )) as unknown as Array<{ org_id?: string | null }>;
    } catch (error) {
      this.logger.error(`安灯租户清单读取失败：${String(error)}`);
      return { orgs: 0, created: 0, duplicates: 0, breached: 0, undecidable: 0, failures: [{ orgId: '', error: String(error).slice(0, 200) }] };
    }
    let created = 0;
    let duplicates = 0;
    let breached = 0;
    let undecidable = 0;
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
        // 后台 worker 没有请求上下文 → 根句柄没有 `app.current_org_id` GUC →
        // `ewoh_event` 的 RLS 会把行全部挡住（实测：清单能拿到租户，明细却恒 0 条，
        // 表现为 worker 静默不升级）。因此**每个租户都开一个系统事务并设置 GUC**
        // 再读明细/写通知；租户隔离在真正读写数据的那一步照旧生效。
        const result = await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(systemCtx),
          () => this.sweep(systemCtx, options),
        );
        created += result.created;
        duplicates += result.duplicates;
        breached += result.breached;
        undecidable += result.undecidable;
      } catch (error) {
        failures.push({ orgId, error: String(error).slice(0, 200) });
        this.logger.error(`安灯 SLA 扫描失败 org=${orgId}: ${String(error)}`);
      }
    }
    return { orgs: orgRows.length, created, duplicates, breached, undecidable, failures };
  }
}
