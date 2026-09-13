import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, sql } from 'drizzle-orm';
import { ewohExoSession, ewohNotification } from '@server/database/schema';
import { classifyExoSessionReminder, type ExoReminderBucket } from '@shared/exo-session';
import { ExoSessionService } from './exo-session.service';
import { normalizePersonRef } from '@shared/identity';
import { buildGucSettings, type OrgContext } from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { isLarkPushEnabled } from '../notification/channel-dispatcher.service';
import { isEmailPushEnabled } from '../notification/email-transport';

/**
 * NO-37a：外骨骼会话的**平台侧主动提醒**。
 *
 * 为什么需要它：NO-36b 让"超过预计结束/长时间佩戴"在 `/exo` 页面上可见——但那是
 * **被动**的：班组长不打开页面就不会知道有人戴着外骨骼没收工，而忘记收工会同时造成
 * 两个真实后果：① 设备被占住，后续派工按"佩戴中"被硬约束拒绝；② 世界模型里的
 * 物理事实与现实脱节（人已经走了，系统还以为他在用）。这与"授权到期提醒"是同一类
 * 问题：**凭证/占用会失效，人必须被主动叫醒**（原则 1/5/7）。
 *
 * 语义：
 *   · 扫描**只读**会话台账，绝不改状态、不代替人收工；
 *   · 桶（封闭词表，`shared/exo-session.ts`）：`overdue`（超过预计结束 + 宽限）
 *     优先于 `long_running`（连续佩戴 ≥ 4 小时）；
 *   · 收件人：角色 `workshop_lead`（班组长，现场负责人）+ **佩戴者本人绑定账号**
 *     （如果存在绑定；查不到绑定就如实记进 `unresolvedWearers`，不静默丢弃）；
 *   · **幂等**：通知 id 由 (会话号, 桶, 收件人, 渠道) 确定性推导
 *     （`NTF-EXO-<session>-<bucket>[-user-<who>]-<channel>`）+ `notification_id`
 *     唯一约束 + `ON CONFLICT DO NOTHING`——重复扫描只累加 duplicates，
 *     不是"先查后写"（没有竞态窗口）；
 *   · 渠道：app 恒发；lark/email 仅在已配置时发（未配置 = 渠道禁用，不写 doomed 行）；
 *   · 租户作用域：查询与写入都按 `org_id`，他租户会话绝不可见（原则 8）。
 */

/**
 * 提醒标签（封闭词表）：
 *   · 时间维度（`shared/exo-session.ts` 的分类结果）：`overdue` / `long_running`；
 *   · 证据维度（NO-41a 的双源校验，NO-42a 接入提醒）：`telemetry_wearer_mismatch`
 *     （会话与遥测的佩戴人不一致——硬冲突）/ `telemetry_inactive_suspect`（遥测疑似无人佩戴）。
 * 每个标签各自一条确定性通知 id，互不覆盖。
 */
export const EXO_REMINDER_TAGS = [
  'overdue',
  'long_running',
  'telemetry_wearer_mismatch',
  'telemetry_inactive_suspect',
] as const;
export type ExoReminderTag = (typeof EXO_REMINDER_TAGS)[number];

export interface ExoSessionReminderSweepResult {
  orgId: string;
  /** 扫描到的活跃会话数。 */
  scanned: number;
  overdue: number;
  longRunning: number;
  created: number;
  duplicates: number;
  /** NO-42a：证据维度（双源校验）的统计与判定分布。 */
  telemetry: {
    /** 参与校验的活跃会话数（= scanned）。 */
    scanned: number;
    wearerMismatch: number;
    inactiveSuspect: number;
    /** 每种判定的计数（consistent / no_telemetry / ... 全量透出，便于对账）。 */
    verdicts: Record<string, number>;
  };
  /** 佩戴者没有绑定登录账号的人员 id（提醒发不到人身上，必须如实列出）。 */
  unresolvedWearers: string[];
  notifications: Array<{
    sessionId: string;
    bucket: ExoReminderTag;
    recipientType: 'role' | 'user';
    recipientId: string;
    channel: string;
    notificationId: string;
    created: boolean;
  }>;
  generatedAt: string;
}

@Injectable()
export class ExoSessionReminderService {
  private readonly logger = new Logger(ExoSessionReminderService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    /**
     * NO-42a：双源校验（会话 × 遥测）复用 NO-41a 的同一实现——
     * 提醒不能自己再算一套"佩戴人是否一致"（口径分叉必然导致"页面说不一致、通知说正常"）。
     */
    private readonly exoSessions: ExoSessionService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：会话提醒扫描必须带租户上下文');
    }
    return orgId;
  }

  /** 单个租户的提醒扫描（幂等；可重复调用）。 */
  async sweep(
    actor: OrgContext | undefined,
    options: { now?: Date } = {},
  ): Promise<ExoSessionReminderSweepResult> {
    const orgId = this.requireOrgId(actor);
    const now = options.now ?? new Date();
    const sessions = await this.db
      .select({
        sessionId: ewohExoSession.sessionId,
        exoId: ewohExoSession.exoId,
        personId: ewohExoSession.personId,
        status: ewohExoSession.status,
        startedAt: ewohExoSession.startedAt,
        expectedEndAt: ewohExoSession.expectedEndAt,
      })
      .from(ewohExoSession)
      .where(and(eq(ewohExoSession.orgId, orgId), eq(ewohExoSession.status, 'active')));

    const decisions = sessions
      .map((session) => ({
        session,
        decision: classifyExoSessionReminder(
          {
            status: session.status,
            startedAt: session.startedAt?.toISOString() ?? null,
            expectedEndAt: session.expectedEndAt?.toISOString() ?? null,
            actualEndAt: null,
          },
          { nowMs: now.getTime() },
        ),
      }))
      .filter((row): row is { session: typeof row.session; decision: NonNullable<typeof row.decision> } =>
        row.decision !== null,
      );

    // 账号↔人员解析必须覆盖**扫描到的全部活跃会话**（而不是只覆盖"时间桶命中"的那些）：
    // 遥测冲突（NO-42a）常常发生在"刚开始佩戴、还没超时"的会话上——只解析时间桶的佩戴者，
    // 会导致这类冲突提醒发不到佩戴者本人（实测踩过：role=true、wearer=false）。
    const wearerUserIds = await this.resolveWearerUserIds(
      orgId,
      sessions.map((row) => row.personId),
    );

    const notifications: ExoSessionReminderSweepResult['notifications'] = [];
    const unresolvedWearers = new Set<string>();
    let created = 0;
    let duplicates = 0;
    let overdue = 0;
    let longRunning = 0;

    for (const { session, decision } of decisions) {
      if (decision.bucket === 'overdue') overdue += 1;
      else longRunning += 1;
      const deviceLabel = session.exoId?.startsWith('device:')
        ? session.exoId.slice('device:'.length)
        : session.exoId;
      const wearerRef = normalizePersonRef(session.personId) ?? session.personId;
      const facts = [
        `设备 ${deviceLabel}`,
        `佩戴者 ${wearerRef}`,
        `开始 ${formatLocal(session.startedAt)}`,
        `已佩戴 ${formatDuration(decision.durationMs)}`,
      ];
      if (session.expectedEndAt) {
        facts.push(`预计结束 ${formatLocal(session.expectedEndAt)}`);
      }
      if (decision.bucket === 'overdue') {
        facts.push(`已超时 ${formatDuration(decision.overdueMs)}`);
      } else if (!session.expectedEndAt) {
        facts.push('未记录预计结束时间');
      }
      const title =
        decision.bucket === 'overdue'
          ? `外骨骼会话已超过预计结束：${deviceLabel}`
          : `外骨骼会话长时间未收工：${deviceLabel}`;
      const body =
        `${facts.join('｜')}｜会话 ${session.sessionId}｜` +
        (decision.bucket === 'overdue'
          ? '请核实是否忘记收工：占用中的设备会让后续派工被"佩戴中"硬约束拒绝'
          : '连续佩戴已达阈值，请核实是否需要收工或延长计划') +
        '｜平台只管理会话绑定，不下发任何设备指令';

      const recipients: Array<{ recipientType: 'role' | 'user'; recipientId: string; userScoped: boolean }> = [
        { recipientType: 'role', recipientId: 'workshop_lead', userScoped: false },
      ];
      const wearerUserId = wearerUserIds.get(String(session.personId));
      if (wearerUserId) {
        recipients.push({ recipientType: 'user', recipientId: wearerUserId, userScoped: true });
      } else {
        unresolvedWearers.add(String(session.personId));
      }

      const emitted = await this.emitReminders({
        orgId,
        sessionId: session.sessionId,
        tag: decision.bucket,
        title,
        body,
        severity: decision.bucket === 'overdue' ? 'high' : 'medium',
        userScopedSuffix: '（你本人佩戴中）',
        recipients,
      });
      created += emitted.created;
      duplicates += emitted.duplicates;
      notifications.push(...emitted.notifications);
    }

    // NO-42a：证据维度——"会话声明的佩戴人"与"遥测上报的佩戴人"不一致、
    // 或遥测疑似无人佩戴时，主动提醒班组长与佩戴者本人（与时间维度同一套幂等通道）。
    const consistency = (await this.exoSessions.listTelemetryConsistency(orgId)) as {
      verdicts?: Record<string, number>;
      summary?: Record<string, number>;
      sessions?: Array<{
        sessionId: string;
        exoId: string;
        personId: string | null;
        verdict: string;
        reason: string;
        needsHumanCheck: boolean;
      }>;
    };
    const verdictCounts: Record<string, number> = { ...(consistency.summary ?? consistency.verdicts ?? {}) };
    let wearerMismatch = 0;
    let inactiveSuspect = 0;
    for (const item of consistency.sessions ?? []) {
      const conflictTag: ExoReminderTag | null =
        item.verdict === 'wearer_mismatch'
          ? 'telemetry_wearer_mismatch'
          : item.verdict === 'inactive_suspect'
            ? 'telemetry_inactive_suspect'
            : null;
      if (!conflictTag) continue;
      if (conflictTag === 'telemetry_wearer_mismatch') wearerMismatch += 1;
      else inactiveSuspect += 1;
      const deviceLabel = item.exoId?.startsWith('device:') ? item.exoId.slice('device:'.length) : item.exoId;
      const title =
        conflictTag === 'telemetry_wearer_mismatch'
          ? `外骨骼会话与遥测的佩戴人不一致：${deviceLabel}`
          : `外骨骼遥测疑似无人佩戴：${deviceLabel}`;
      const body =
        `${item.reason}｜会话 ${item.sessionId}` +
        (item.personId ? `｜会话佩戴者 ${item.personId}` : '｜会话佩戴者未记录') +
        '｜建议动作：现场核实后结束会话，或按实际佩戴人重新开始会话' +
        '｜平台只管理会话绑定，不下发任何设备指令';
      const recipients: Array<{ recipientType: 'role' | 'user'; recipientId: string; userScoped: boolean }> = [
        { recipientType: 'role', recipientId: 'workshop_lead', userScoped: false },
      ];
      const wearerUserId = wearerUserIds.get(String(item.personId));
      if (wearerUserId) {
        recipients.push({ recipientType: 'user', recipientId: wearerUserId, userScoped: true });
      } else if (item.personId) {
        unresolvedWearers.add(String(item.personId));
      }
      const emitted = await this.emitReminders({
        orgId,
        sessionId: item.sessionId,
        tag: conflictTag,
        title,
        body,
        severity: conflictTag === 'telemetry_wearer_mismatch' ? 'high' : 'medium',
        userScopedSuffix: '（与你有关）',
        recipients,
      });
      created += emitted.created;
      duplicates += emitted.duplicates;
      notifications.push(...emitted.notifications);
    }

    return {
      orgId,
      scanned: sessions.length,
      overdue,
      longRunning,
      created,
      duplicates,
      telemetry: {
        scanned: sessions.length,
        wearerMismatch,
        inactiveSuspect,
        verdicts: verdictCounts,
      },
      unresolvedWearers: [...unresolvedWearers],
      notifications,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * 写一批幂等提醒（时间桶与遥测冲突桶共用同一实现）。
   *
   * 幂等键：`NTF-EXO-<会话号清洗>-<标签>[-user-<收件人>]-<渠道>` + `notification_id` 唯一约束
   * + `ON CONFLICT DO NOTHING`：重复扫描只累加 duplicates；用户级通知必须带收件人后缀
   * （同一标签对不同人要各发一条）。
   */
  private async emitReminders(params: {
    orgId: string;
    sessionId: string;
    tag: ExoReminderTag;
    title: string;
    body: string;
    severity: 'high' | 'medium';
    /** 用户级通知标题后缀（时间桶用"你本人佩戴中"、证据桶用"与你有关"——措辞要贴合各自事实）。 */
    userScopedSuffix: string;
    recipients: Array<{ recipientType: 'role' | 'user'; recipientId: string; userScoped: boolean }>;
  }): Promise<{ created: number; duplicates: number; notifications: ExoSessionReminderSweepResult['notifications'] }> {
    const notifications: ExoSessionReminderSweepResult['notifications'] = [];
    let created = 0;
    let duplicates = 0;
    for (const recipient of params.recipients) {
      for (const channel of this.channels()) {
        const sessionTag = String(params.sessionId).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
        const recipientTag = recipient.userScoped
          ? `-user-${recipient.recipientId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}`
          : '';
        const notificationId = `NTF-EXO-${sessionTag}-${params.tag}${recipientTag}-${channel}`.slice(0, 250);
        const [row] = await this.db
          .insert(ewohNotification)
          .values({
            orgId: params.orgId,
            notificationId,
            recipientType: recipient.recipientType,
            recipientId: recipient.recipientId,
            channel,
            title: (params.title + (recipient.userScoped ? params.userScopedSuffix : '')).slice(0, 255),
            body: params.body,
            severity: params.severity,
            status: 'pending',
            externalRef: params.sessionId,
          })
          .onConflictDoNothing({
        // standalone_100：唯一性收敛为 (org_id, notification_id)——target 必须与
        // 仲裁索引逐列一致（与 deterministic-notifications 同步修改，实测事故）。
        target: [ewohNotification.orgId, ewohNotification.notificationId],
      })
          .returning({ notificationId: ewohNotification.notificationId });
        const wasCreated = Array.isArray(row) ? row.length > 0 : Boolean(row);
        if (wasCreated) created += 1;
        else duplicates += 1;
        notifications.push({
          sessionId: params.sessionId,
          bucket: params.tag,
          recipientType: recipient.recipientType,
          recipientId: recipient.recipientId,
          channel,
          notificationId,
          created: wasCreated,
        });
      }
    }
    return { created, duplicates, notifications };
  }

  /** 渠道：app 恒发；lark/email 仅在配置存在时发（未配置 = 显式禁用）。 */
  private channels(): string[] {
    const list = ['app'];
    if (isLarkPushEnabled()) list.push('lark');
    if (isEmailPushEnabled()) list.push('email');
    return list;
  }

  /**
   * 佩戴者 → 登录账号（`ewoh_user.person_id` ↔ 会话 `person_id`，NO-36 的账号↔人员绑定）。
   *
   * 为什么经 `ewoh_find_active_users_by_person`（standalone_078 的 SECURITY DEFINER 函数）
   * 而不是直接查 `ewoh_user`：运行角色对身份表**没有任何直接授权**（RLS + 无 policy +
   * REVOKE ALL），直查实测得到 `permission denied for table ewoh_user` → 接口 500。
   * 身份面读取必须走受控函数（与 `ewoh_find_active_user` 同一收口方式），
   * 而不是为了图省事给业务角色开一张身份表的 SELECT（那会暴露口令哈希与角色）。
   *
   * 为什么按 personId 归一化后再查：会话存的是规范身份 `person:<uuid>`，
   * `ewoh_user.person_id` 存裸 uuid；不归一化就永远查不到（现场收不到提醒）。
   * 查不到绑定不是错误（有人可能确实没有账号）——返回缺失，由调用方如实列出。
   */
  private async resolveWearerUserIds(
    orgId: string,
    personRefs: readonly string[],
  ): Promise<Map<string, string>> {
    const refs = [...new Set(personRefs.map((ref) => normalizePersonRef(ref)).filter((ref): ref is string => !!ref))];
    const resolved = new Map<string, string>();
    if (refs.length === 0) return resolved;
    // 数组参数走仓库既有口径（resource-projection/world 同款）：drizzle 的
    // `sql` 模板把 JS 数组绑定成**单个**参数（实测 `($2)::text[]` → 类型错误），
    // 因此显式构造转义后的数组字面量 + `sql.raw`，与既有代码保持一致。
    const idLiteral = refs.map((ref) => `'${String(ref).replace(/'/g, "''")}'`).join(', ');
    const rows = (await this.db.execute(sql`
      SELECT username, person_id
      FROM ewoh_find_active_users_by_person(${orgId}::uuid, ARRAY[${sql.raw(idLiteral)}]::text[])
    `)) as unknown as Array<{ username?: string | null; person_id?: string | null }>;
    for (const row of rows) {
      const username = String(row.username ?? '').trim();
      const personId = String(row.person_id ?? '').trim();
      if (!username || !personId) continue;
      resolved.set(personId, username);
    }
    // 会话里是 `person:<uuid>`，调用方用原样 personId 取；两种形态都放进索引。
    for (const [personId, username] of [...resolved.entries()]) {
      resolved.set(`person:${personId}`, username);
    }
    return resolved;
  }

  /**
   * 全部活跃租户扫描（供定时 worker 用）。
   *
   * 数据源直接是**有活跃会话的租户**（比"最近有事件的租户"更精确、更省），
   * 逐租户调用 `sweep`（幂等），单租户失败只留痕不影响其它租户。
   */
  async sweepAllActiveOrgs(options: { now?: Date } = {}): Promise<{
    orgs: number;
    created: number;
    duplicates: number;
    failures: Array<{ orgId: string; error: string }>;
  }> {
    // 租户清单经**受控函数**读取（SECURITY DEFINER，只返回 org_id）：
    // 后台 worker 没有请求上下文 → 根句柄没有 `app.current_org_id` GUC →
    // `ewoh_exo_session` 的 RLS 会把行全部挡住（实测：端点上提醒正常，定时 worker
    // 静默 0 提醒）。拿到租户后，**每个租户都开一个系统事务并设置 GUC** 再读明细/写通知，
    // 租户隔离在真正读写数据的那一步照旧生效。
    const rows = (await this.db.execute(sql`
      SELECT org_id FROM ewoh_active_exo_session_orgs()
    `)) as unknown as Array<{ org_id?: string | null }>;
    let created = 0;
    let duplicates = 0;
    const failures: Array<{ orgId: string; error: string }> = [];
    for (const row of rows) {
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
        created += result.created;
        duplicates += result.duplicates;
      } catch (error) {
        failures.push({ orgId, error: String(error).slice(0, 200) });
        this.logger.error(`会话提醒扫描失败 org=${orgId}: ${String(error)}`);
      }
    }
    return { orgs: rows.length, created, duplicates, failures };
  }
}

/** 本地时间文案（通知正文用；与页面展示口径一致，缺值显式说明）。 */
function formatLocal(value: Date | null | undefined): string {
  if (!value) return '未记录';
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return '未记录';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 时长文案（不足 1 分钟如实说，未知说未知——不显示 0）。 */
function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return '时长未知';
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 1) return '不足 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}
