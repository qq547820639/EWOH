import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
  ewohImprovementAction,
  ewohRetrospective,
  ewohSchedulingExecution,
} from '@server/database/schema';
import {
  deriveActionSubject,
  executionSubjectKey,
  deriveImprovementActions,
  improvementTransitionAllowed,
  validateAcceptanceInput,
  validateImprovementAction,
  type ImprovementActionRecord,
  type ImprovementMemoryInput,
} from '@shared/improvement-action';
import {
  IMPROVEMENT_ACTION_REMINDER_ROLES,
  improvementActionNotificationPrefix,
  improvementActionOverdueText,
} from '@shared/improvement-action-notification';
import { isCanonicalIdentity, normalizePersonRef } from '@shared/identity';
import {
  insertDeterministicNotifications,
  type NotificationInsertExecutor,
} from '../notification/deterministic-notifications';
import { resolveNotificationsFor } from '../notification/notification-resolution.link';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';
import { Optional } from '@nestjs/common';
import { KnowledgeService } from '../knowledge/knowledge.service';

/**
 * 改进行动项服务（NO-55a，学习回路接线第二轮）。
 *
 * 补的缺口：复盘能产出结构化经验条目与缺口清单，但条目落进复盘记录后就
 * **没有人负责、没有期限、没有完成证据**——"运行记忆 → 经验"有，"经验 → 行动"断着。
 *
 * 三条边界（与 `shared/improvement-action.ts` 一致，服务层不得放宽）：
 *   1. **扫描只读运行记忆**：不改复盘记录，只写行动项与审计；
 *   2. **接受/完成必须由人给足事实**：owner + 期限 + 验收判据（接受），
 *      完成人 + 结果说明（完成）——平台不替现场承诺期限，也不替现场宣布做完；
 *   3. **人的决定不被覆盖**：重复扫描只刷新标题/详情/证据这些**来源事实**，
 *      `status` 与责任/期限/完成痕迹原样保留（行动项号确定性 → 幂等）。
 */
export interface ImprovementScanResult {
  orgId: string;
  generatedAt: string;
  scannedRetrospectives: number;
  derived: number;
  created: number;
  refreshed: number;
  decisionsPreserved: number;
  rejected: Array<{ actionId: string; errors: string[] }>;
  actions: ImprovementActionRecord[];
  memory: { publishedRetrospectives: number; lessons: number; gaps: number };
}

export interface AcceptActionInput {
  owner?: string;
  dueAt?: string;
  acceptanceCriteria?: string;
  kind?: string;
}

const ACTION_LIMIT = 200;

@Injectable()
export class ImprovementActionService {
  private readonly logger = new Logger(ImprovementActionService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    /**
     * NO-57c：完成时把结果回流成知识条目（可复用运行记忆）。
     * 可选装配：知识模块缺失时如实降级为"未回流"（`outcomeRef=null`），不阻断"已完成"这一事实。
     */
    @Optional() private readonly knowledgeService?: KnowledgeService,
  ) {}

  private requireActor(actor?: OrgContext): OrgContext {
    if (!actor?.primaryOrgId?.trim() || !actor.userId?.trim()) {
      throw new BadRequestException('org/用户上下文缺失：改进行动项必须带认证租户上下文');
    }
    return actor;
  }

  /**
   * 扫复盘运行记忆 → 派生/刷新行动项候选（幂等；不覆盖人的决定）。
   *
   * `retrospectiveIds`：**聚焦扫描**——只扫指定的几篇复盘（页面「从这篇复盘生成行动项」
   * 与场景验证用）。不传则扫本租户最近 100 篇已发布复盘。
   */
  async scan(
    actor?: OrgContext,
    options: { now?: Date; retrospectiveIds?: string[] } = {},
  ): Promise<ImprovementScanResult> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const now = options.now ?? new Date();
    const focus = (options.retrospectiveIds ?? [])
      .map((id) => String(id ?? '').trim())
      .filter((id) => id !== '')
      .slice(0, 20);

    const conditions = [
      eq(ewohRetrospective.orgId, orgId),
      eq(ewohRetrospective.status, 'published'),
    ];
    if (focus.length > 0) conditions.push(inArray(ewohRetrospective.retrospectiveId, focus));

    const rows = await this.db
      .select({
        retrospectiveId: ewohRetrospective.retrospectiveId,
        scope: ewohRetrospective.scope,
        targetId: ewohRetrospective.targetId,
        title: ewohRetrospective.title,
        publishedAt: ewohRetrospective.publishedAt,
        lessonsJson: ewohRetrospective.lessonsJson,
        assembledJson: ewohRetrospective.assembledJson,
      })
      .from(ewohRetrospective)
      .where(and(...conditions))
      .orderBy(desc(ewohRetrospective.publishedAt))
      .limit(100);

    let lessonCount = 0;
    let gapCount = 0;
    const retrospectives: ImprovementMemoryInput['retrospectives'] = rows.map((row) => {
      const lessons = Array.isArray(row.lessonsJson)
        ? (row.lessonsJson as Array<Record<string, unknown>>).map((lesson) => ({
            title: String(lesson?.title ?? ''),
            detail: String(lesson?.detail ?? ''),
            severity: String(lesson?.severity ?? 'info'),
            evidenceIds: Array.isArray(lesson?.evidenceIds)
              ? (lesson.evidenceIds as unknown[]).filter((id): id is string => typeof id === 'string')
              : [],
          }))
        : [];
      const assembled = (row.assembledJson ?? {}) as { gaps?: unknown };
      const gaps = Array.isArray(assembled.gaps)
        ? (assembled.gaps as unknown[]).map((gap) => String(gap ?? '')).filter((gap) => gap.trim() !== '')
        : [];
      lessonCount += lessons.length;
      gapCount += gaps.length;
      return {
        retrospectiveId: row.retrospectiveId,
        scope: row.scope,
        targetId: row.targetId,
        title: row.title,
        publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        lessons,
        gaps,
        // NO-58a：对象归属（复发度量的前置条件）——纯函数派生，不猜
        subject: deriveActionSubject(row.scope, row.targetId),
      };
    });

    const derived = deriveImprovementActions({
      orgId,
      detectedAt: now.toISOString(),
      retrospectives,
    });

    const result: ImprovementScanResult = {
      orgId,
      generatedAt: now.toISOString(),
      scannedRetrospectives: rows.length,
      derived: derived.length,
      created: 0,
      refreshed: 0,
      decisionsPreserved: 0,
      rejected: [],
      actions: [],
      memory: { publishedRetrospectives: rows.length, lessons: lessonCount, gaps: gapCount },
    };

    for (const action of derived) {
      const errors = validateImprovementAction(action);
      if (errors.length > 0) {
        this.logger.warn(`行动项 ${action.actionId} 未通过契约校验，已跳过：${errors.join(', ')}`);
        result.rejected.push({ actionId: action.actionId, errors });
        continue;
      }
      const outcome = await this.persistAction(orgId, action, ctx.userId, now);
      if (outcome === 'created') result.created += 1;
      else if (outcome === 'refreshed') result.refreshed += 1;
      else result.decisionsPreserved += 1;
      result.actions.push(await this.mustGet(orgId, action.actionId));
    }

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.action_scan',
      entityType: 'improvement_action',
      entityId: orgId,
      reason: focus.length > 0
        ? `publishedRetrospectives=${rows.length}; focus=${focus.length}`
        : `publishedRetrospectives=${rows.length}`,
      before: { lessons: lessonCount, gaps: gapCount },
      after: {
        derived: result.derived,
        created: result.created,
        refreshed: result.refreshed,
        decisionsPreserved: result.decisionsPreserved,
        rejected: result.rejected.length,
      },
    });
    return result;
  }

  async list(
    actor?: OrgContext,
    filters: { status?: string; priority?: string; owner?: string; limit?: number } = {},
  ): Promise<ImprovementActionRecord[]> {
    const ctx = this.requireActor(actor);
    const conditions = [eq(ewohImprovementAction.orgId, ctx.primaryOrgId)];
    if (filters.status?.trim()) conditions.push(eq(ewohImprovementAction.status, filters.status.trim()));
    if (filters.priority?.trim()) conditions.push(eq(ewohImprovementAction.priority, filters.priority.trim()));
    if (filters.owner?.trim()) conditions.push(eq(ewohImprovementAction.owner, filters.owner.trim()));
    const limit = Number.isFinite(filters.limit)
      ? Math.min(Math.max(Math.trunc(Number(filters.limit)), 1), ACTION_LIMIT)
      : 50;
    const rows = await this.db
      .select()
      .from(ewohImprovementAction)
      .where(and(...conditions))
      .orderBy(asc(ewohImprovementAction.dueAt), desc(ewohImprovementAction.detectedAt))
      .limit(limit);
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * 逾期待办**主动叫人**（NO-56b）：把"到期未完成"接进统一提醒契约。
   *
   * 收件人 = 负责人账号（经受控函数从 person 反查，查不到就如实进 unresolvedOwners）
   * + 班组长角色兜底；通知号确定性（行动项 + 桶 + 收件人 + 渠道）→ 重复扫描只累加 duplicates。
   * **只读行动项**：不改状态、不代替人完成，只写提醒与审计。
   */
  async sweepOverdue(
    actor?: OrgContext,
    options: { now?: Date } = {},
  ): Promise<{
    orgId: string;
    scanned: number;
    created: number;
    duplicates: number;
    notified: Array<{ actionId: string; recipients: string[] }>;
    unresolvedOwners: string[];
    generatedAt: string;
  }> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const now = options.now ?? new Date();
    const overdueActions = await this.overdue(ctx, now);
    const result = {
      orgId,
      scanned: overdueActions.length,
      created: 0,
      duplicates: 0,
      notified: [] as Array<{ actionId: string; recipients: string[] }>,
      unresolvedOwners: [] as string[],
      generatedAt: now.toISOString(),
    };
    if (overdueActions.length === 0) return result;

    // 负责人 → 登录账号（身份面只能经受控函数读；person:<uuid> 与裸 uuid 两种形态都归一化）
    const ownerRefs = [...new Set(
      overdueActions
        .map((action) => normalizePersonRef(action.owner ?? null))
        .filter((ref): ref is string => !!ref),
    )];
    const accountByOwner = new Map<string, string>();
    if (ownerRefs.length > 0) {
      const idLiteral = ownerRefs.map((ref) => `'${ref.replace(/'/g, "''")}'`).join(', ');
      const rows = (await this.db.execute(sql`
        SELECT username, person_id
        FROM ewoh_find_active_users_by_person(${orgId}::uuid, ARRAY[${sql.raw(idLiteral)}]::text[])
      `)) as unknown as Array<{ username?: string | null; person_id?: string | null }>;
      for (const row of rows) {
        const username = String(row.username ?? '').trim();
        const personId = String(row.person_id ?? '').trim();
        if (!username || !personId) continue;
        accountByOwner.set(personId, username);
        accountByOwner.set(`person:${personId}`, username);
      }
    }

    for (const action of overdueActions) {
      const ownerRef = normalizePersonRef(action.owner ?? null);
      const ownerAccount = ownerRef ? accountByOwner.get(ownerRef) ?? null : null;
      if (ownerRef && !ownerAccount) result.unresolvedOwners.push(ownerRef);
      const recipients = [
        ...(ownerAccount ? [{ recipientType: 'user' as const, recipientId: ownerAccount }] : []),
        ...IMPROVEMENT_ACTION_REMINDER_ROLES.map((role) => ({ recipientType: 'role' as const, recipientId: role })),
      ];
      const dueMs = action.dueAt ? Date.parse(action.dueAt) : Number.NaN;
      const text = improvementActionOverdueText({
        actionId: action.actionId,
        title: action.title,
        owner: action.owner ?? null,
        dueAt: action.dueAt ?? null,
        acceptanceCriteria: action.acceptanceCriteria ?? null,
        overdueMs: Number.isFinite(dueMs) ? Math.max(0, now.getTime() - dueMs) : null,
      });
      const emitted = await insertDeterministicNotifications(this.db as NotificationInsertExecutor, {
        orgId,
        externalRef: action.actionId,
        prefix: improvementActionNotificationPrefix(action.actionId),
        bucket: 'action_overdue',
        recipients,
        title: text.title,
        body: text.body,
        severity: action.priority === 'high' ? 'high' : 'medium',
      });
      result.created += emitted.created;
      result.duplicates += emitted.duplicates;
      result.notified.push({ actionId: action.actionId, recipients: recipients.map((r) => r.recipientId) });
    }

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.action_overdue_sweep',
      entityType: 'improvement_action',
      entityId: orgId,
      reason: `overdue=${overdueActions.length}`,
      before: { overdue: overdueActions.length },
      after: {
        created: result.created,
        duplicates: result.duplicates,
        unresolvedOwners: result.unresolvedOwners.length,
      },
    });
    return result;
  }

  /**
   * 有"已接受且设了期限"行动项的租户清单（后台 worker 用）。
   *
   * 只能走受控 SECURITY DEFINER 函数（`ewoh_improvement_action_orgs`，standalone_090）：
   * 后台没有 GUC → 直接查业务表被 RLS 全挡 → 表现为"worker 静默 0 条"。
   */
  async listOrgsWithOpenActions(): Promise<string[]> {
    const rows = (await this.db.execute(sql`
      SELECT org_id FROM ewoh_improvement_action_orgs()
    `)) as unknown as Array<{ org_id?: string | null }>;
    return rows
      .map((row) => String(row.org_id ?? '').trim())
      .filter((orgId) => orgId !== '');
  }

  /** 逾期待办（到期日已过且未完成）：接班的班组长最需要看的一行。 */
  async overdue(actor?: OrgContext, now = new Date()): Promise<ImprovementActionRecord[]> {
    const ctx = this.requireActor(actor);
    const rows = await this.db
      .select()
      .from(ewohImprovementAction)
      .where(and(
        eq(ewohImprovementAction.orgId, ctx.primaryOrgId),
        eq(ewohImprovementAction.status, 'accepted'),
        isNotNull(ewohImprovementAction.dueAt),
      ))
      .orderBy(asc(ewohImprovementAction.dueAt))
      .limit(ACTION_LIMIT);
    return rows
      .map((row) => this.toRecord(row))
      .filter((action) => action.dueAt != null && Date.parse(action.dueAt) < now.getTime());
  }

  /**
   * 人接受：必须给负责人 + 期限 + 验收判据（"做完了"要能被别人判断）；
   * 同时可纠正类型（平台建议的类型不强制）。
   *
   * 错误顺序统一为：**404（不存在）→ 409（状态不允许）→ 400（必填事实缺失）**——
   * 状态不对时补事实也救不了，先告诉调用方"这件事现在不能做"。
   */
  async accept(actionId: string, input: AcceptActionInput, actor?: OrgContext): Promise<ImprovementActionRecord> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    // 先判状态（状态不对时补事实也救不了），再校验必填事实。
    const current = await this.mustGet(orgId, actionId);
    if (current.status !== 'proposed') {
      throw new ConflictException(`行动项 ${actionId} 已是 ${current.status}（终态不可再改）`);
    }
    const errors = validateAcceptanceInput({
      owner: input.owner,
      dueAt: input.dueAt,
      acceptanceCriteria: input.acceptanceCriteria,
      kind: input.kind,
    });
    if (errors.length > 0) {
      throw new BadRequestException(
        `接受行动项必须给全负责人/期限/验收判据（${errors.join(', ')}）：平台不替现场承诺期限`,
      );
    }
    const acceptedAt = new Date();
    const kindChanged = Boolean(input.kind && input.kind !== current.kind);
    const next: ImprovementActionRecord = {
      ...current,
      status: 'accepted',
      owner: String(input.owner).trim(),
      dueAt: new Date(String(input.dueAt)).toISOString(),
      acceptanceCriteria: String(input.acceptanceCriteria).trim(),
      kind: (input.kind as ImprovementActionRecord['kind']) ?? current.kind,
      kindSource: kindChanged ? 'human' : current.kindSource,
      acceptedBy: ctx.userId,
      acceptedAt: acceptedAt.toISOString(),
    };
    const validationErrors = validateImprovementAction(next);
    if (validationErrors.length > 0) {
      throw new BadRequestException(`接受后的行动项违反契约：${validationErrors.join(', ')}`);
    }
    await this.writeRecord(orgId, next, ctx.userId, acceptedAt);
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.action_accepted',
      entityType: 'improvement_action',
      entityId: actionId,
      reason: `owner=${next.owner}; dueAt=${next.dueAt}`,
      before: { status: current.status, kind: current.kind },
      after: { status: 'accepted', kind: next.kind, acceptanceCriteria: next.acceptanceCriteria },
    });
    return this.mustGet(orgId, actionId);
  }

  /** 人完成：必须带结果说明（对着判据说清楚做了什么）。 */
  async complete(
    actionId: string,
    input: { outcomeNote?: string },
    actor?: OrgContext,
    // options.now 只给内部调用与用例：控制器不把请求体转成它，完成时刻因此不可被外部伪造。
    options: { now?: Date } = {},
  ): Promise<ImprovementActionRecord> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const current = await this.mustGet(orgId, actionId);
    if (current.status !== 'accepted') {
      throw new ConflictException(`只有已接受的行动项可以完成（当前 ${current.status}）`);
    }
    const outcomeNote = (input.outcomeNote ?? '').trim();
    if (outcomeNote === '') {
      throw new BadRequestException('完成必须写结果说明（对着验收判据说清楚做了什么、结果如何）');
    }
    const completedAt = options.now ?? new Date();
    const next: ImprovementActionRecord = {
      ...current,
      status: 'completed',
      completedBy: ctx.userId,
      completedAt: completedAt.toISOString(),
      outcomeNote,
    };
    const errors = validateImprovementAction(next);
    if (errors.length > 0) {
      throw new BadRequestException(`完成后的行动项违反契约：${errors.join(', ')}`);
    }
    /**
     * 主事实（完成）与提醒终态**同一事务**：分开提交会出现
     * "事已办完提醒还挂着"或"提醒没了但事没办"（与数据质量判定同纪律）。
     */
    /**
     * NO-57c：把完成结果**回流成知识条目**（在状态落库之前尝试，拿到 entryId 一起写）：
     *   · 回流失败 → `outcomeRef=null` 且**在审计里写明原因**；"已完成"这一事实照旧成立
     *     （页面上"未回流"是显式状态，不会被误读成"已归档"）；
     *   · 回流成功 → 行动项带 `outcomeRef`，知识条目里带行动项与判据作为证据。
     */
    let outcomeRef: string | null = null;
    let knowledgeNote: string | null = null;
    const canonicalEvidenceRefs = [
      ...new Set(
        (current.evidenceRefs ?? [])
          .flatMap((ref) => {
            const id = String(ref.id ?? '').trim();
            const detailEvidence = Array.isArray((ref.detail as { evidenceIds?: unknown } | undefined)?.evidenceIds)
              ? ((ref.detail as { evidenceIds: unknown[] }).evidenceIds ?? [])
                .map((value) => String(value ?? '').trim())
                .filter((value) => value !== '')
              : [];
            return [id, ...detailEvidence];
          })
          .map((id) => (isCanonicalIdentity(id) ? id : `event:${id}`))
          .filter((id) => isCanonicalIdentity(id)),
      ),
    ].slice(0, 10);
    const canonicalRelatedRefs = canonicalEvidenceRefs.slice(0, 5);
    if (canonicalEvidenceRefs.length === 0) {
      knowledgeNote = '行动项证据里没有规范身份（event:/task:/…）：未建知识条目（不造没有证据的知识）';
    }
    if (this.knowledgeService && canonicalEvidenceRefs.length > 0) {
      try {
        const registered = (await this.knowledgeService.registerEntry(
          {
            kind: 'process_knowledge',
            scope: 'factory',
            title: `改进行动项完成：${current.title}`.slice(0, 200),
            summary: outcomeNote.slice(0, 300),
            body:
              `行动项 ${actionId}\n验收判据：${current.acceptanceCriteria ?? '（未填写）'}\n`
              + `结果说明：${outcomeNote}\n负责人：${current.owner ?? '未指派'}；`
              + `由 ${ctx.userId} 于 ${completedAt.toISOString()} 标记完成。`,
            /**
             * 知识契约要求**规范身份**（`event:`/`task:`/`device:`…），复盘号/条目号/行动项号
             * 都不是规范身份——直接塞进去会被 `bad_evidence_ref` 拒（实测）。
             * 因此只回流规范证据；一条都没有时**不建知识条目**（如实记 note，
             * 而不是造一个没有证据的知识条目）。
             */
            sourceEvidenceIds: canonicalEvidenceRefs,
            relatedEntityIds: canonicalRelatedRefs,
            tags: ['improvement_action', current.kind],
          },
          orgId,
        )) as { record?: { knowledgeId?: string; entryId?: string } } | null;
        // registerEntry 返回 `{ record, created }`，记录里是 `knowledgeId`（= entry_id）。
        const knowledgeId = registered?.record?.knowledgeId ?? registered?.record?.entryId ?? null;
        outcomeRef = knowledgeId ? String(knowledgeId) : null;
        if (!outcomeRef) knowledgeNote = '知识条目注册未返回条目号';
      } catch (error) {
        knowledgeNote = `知识回流失败（不阻断完成）：${error instanceof Error ? error.message : String(error)}`;
        this.logger.warn(`行动项 ${actionId} 知识回流失败：${knowledgeNote}`);
      }
    } else {
      knowledgeNote = '知识模块未装配：结果未回流（outcomeRef 为空）';
    }
    if (outcomeRef) {
      next.outcomeRef = outcomeRef;
      next.outcomeKind = 'knowledge_entry';
    }

    const resolvedNotificationCount = await this.db.transaction(async (tx) => {
      await this.writeRecord(orgId, next, ctx.userId, completedAt, tx);
      const outcome = await resolveNotificationsFor(tx as never, {
        orgId,
        externalRef: actionId,
        notificationIdPrefix: improvementActionNotificationPrefix(actionId),
        resolution: 'action_completed',
        resolvedBy: ctx.userId,
        resolutionRef: actionId,
      });
      return outcome.closed + outcome.annotated;
    });
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.action_completed',
      entityType: 'improvement_action',
      entityId: actionId,
      reason: outcomeNote.slice(0, 180),
      before: { status: current.status },
      after: {
        status: 'completed',
        outcomeNote,
        resolvedNotificationCount,
        outcomeRef,
        ...(knowledgeNote ? { knowledgeNote } : {}),
      },
    });
    return this.mustGet(orgId, actionId);
  }

  /** 拒绝（proposed）或放弃（accepted）：理由必填（§33 不静默作废）。 */
  async decide(
    actionId: string,
    input: { decision: 'rejected' | 'dropped'; reason?: string },
    actor?: OrgContext,
  ): Promise<ImprovementActionRecord> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    if (input.decision !== 'rejected' && input.decision !== 'dropped') {
      throw new BadRequestException('decision 必须是 rejected | dropped');
    }
    const current = await this.mustGet(orgId, actionId);
    if (!improvementTransitionAllowed(current.status, input.decision)) {
      throw new ConflictException(`行动项 ${actionId} 不能从 ${current.status} 转到 ${input.decision}`);
    }
    const reason = (input.reason ?? '').trim();
    if (reason === '') {
      throw new BadRequestException('拒绝/放弃必须给理由（否则没人知道这条经验为什么被作废）');
    }
    const decidedAt = new Date();
    const next: ImprovementActionRecord = {
      ...current,
      status: input.decision,
      decidedBy: ctx.userId,
      decidedAt: decidedAt.toISOString(),
      decidedReason: reason,
    };
    const errors = validateImprovementAction(next);
    if (errors.length > 0) {
      throw new BadRequestException(`决定后的行动项违反契约：${errors.join(', ')}`);
    }
    const resolvedNotificationCount = await this.db.transaction(async (tx) => {
      await this.writeRecord(orgId, next, ctx.userId, decidedAt, tx);
      const outcome = await resolveNotificationsFor(tx as never, {
        orgId,
        externalRef: actionId,
        notificationIdPrefix: improvementActionNotificationPrefix(actionId),
        resolution: 'action_dropped',
        resolvedBy: ctx.userId,
        resolutionRef: actionId,
      });
      return outcome.closed + outcome.annotated;
    });
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: `learning.action_${input.decision}`,
      entityType: 'improvement_action',
      entityId: actionId,
      reason,
      before: { status: current.status },
      after: { status: input.decision, resolvedNotificationCount },
    });
    return this.mustGet(orgId, actionId);
  }

  /**
   * 行动的**复发度量**（NO-58a）：对象在"完成前后两个窗口"里的复发事实。
   *
   * 三条诚实边界：
   *   1. **没有对象归属 → 不可度量**（`conclusion='no_subject'`），不硬算；
   *   2. **样本不足不给结论**（两窗口合计 < 3 次复发 → `insufficient_sample`）；
   *   3. **只报事实，不给因果**：计数下降 ≠ "这条改进有效"（可能有季节/订单结构变化），
   *      结论文案里必须写明这一点，由人判断。
   */
  async effect(
    actionId: string,
    actor?: OrgContext,
    options: { now?: Date; windowDays?: number } = {},
  ): Promise<{
    actionId: string;
    subjectType: string | null;
    subjectId: string | null;
    status: string;
    completedAt: string | null;
    windowDays: number;
    before: { from: string; to: string; deviations: number };
    after: { from: string; to: string; deviations: number };
    conclusion: 'no_subject' | 'not_completed' | 'insufficient_sample' | 'recurrence_dropped' | 'recurrence_persisted';
    reason: string;
    notes: string[];
    generatedAt: string;
  }> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const now = options.now ?? new Date();
    const windowDays = Number.isFinite(options.windowDays)
      ? Math.min(Math.max(Math.trunc(Number(options.windowDays)), 1), 180)
      : 30;
    const action = await this.mustGet(orgId, actionId);
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const notes: string[] = [];
    const base = {
      actionId,
      subjectType: action.subjectType ?? null,
      subjectId: action.subjectId ?? null,
      status: action.status,
      completedAt: action.completedAt ?? null,
      windowDays,
      generatedAt: now.toISOString(),
    };
    if (!action.subjectType || !action.subjectId) {
      return {
        ...base,
        before: { from: '', to: '', deviations: 0 },
        after: { from: '', to: '', deviations: 0 },
        conclusion: 'no_subject',
        reason: '这条行动项没有对象归属（复盘 scope 不是 incident 或 target_id 缺失）→ 复发不可度量（不硬算）',
        notes,
      };
    }
    if (action.status !== 'completed' || !action.completedAt) {
      const to = now.toISOString();
      const from = new Date(now.getTime() - windowMs).toISOString();
      const count = await this.countDeviations(orgId, action, from, to);
      return {
        ...base,
        before: { from, to, deviations: count },
        after: { from: '', to: '', deviations: 0 },
        conclusion: 'not_completed',
        reason: '行动项尚未完成：只能给出"完成前"的复发计数（完成后再看才有前后对比）',
        notes,
      };
    }
    const completedMs = Date.parse(action.completedAt);
    const beforeFrom = new Date(completedMs - windowMs).toISOString();
    const beforeTo = action.completedAt;
    const afterFrom = action.completedAt;
    const afterTo = new Date(Math.min(now.getTime(), completedMs + windowMs)).toISOString();
    const [beforeCount, afterCount] = await Promise.all([
      this.countDeviations(orgId, action, beforeFrom, beforeTo),
      this.countDeviations(orgId, action, afterFrom, afterTo),
    ]);
    const total = beforeCount + afterCount;
    let conclusion: 'insufficient_sample' | 'recurrence_dropped' | 'recurrence_persisted' = 'insufficient_sample';
    let reason = `完成前后各 ${windowDays} 天内该对象复发合计 ${total} 次（< 门槛 3）→ 样本不足，不给结论`;
    if (total >= 3) {
      if (afterCount < beforeCount) {
        conclusion = 'recurrence_dropped';
        reason = `完成前 ${beforeCount} 次 / 完成后 ${afterCount} 次：复发计数下降（**只是事实，不等于"这条改进有效"**——订单结构/季节变化同样会影响）`;
      } else {
        conclusion = 'recurrence_persisted';
        reason = `完成前 ${beforeCount} 次 / 完成后 ${afterCount} 次：复发没有下降（是否需要追加措施由人判断）`;
      }
    }
    if (Date.parse(afterTo) - completedMs < windowMs) {
      notes.push(`完成后窗口尚未跑满 ${windowDays} 天（观察期未结束，数字会继续变化）`);
    }
    return {
      ...base,
      before: { from: beforeFrom, to: beforeTo, deviations: beforeCount },
      after: { from: afterFrom, to: afterTo, deviations: afterCount },
      conclusion,
      reason,
      notes,
    };
  }

  /** 该行动项对象在窗口内的偏差复发次数（执行事实口径）。 */
  private async countDeviations(
    orgId: string,
    action: ImprovementActionRecord,
    fromIso: string,
    toIso: string,
  ): Promise<number> {
    const column = action.subjectType === 'person'
      ? ewohSchedulingExecution.personId
      : action.subjectType === 'station'
        ? ewohSchedulingExecution.stationId
        : ewohSchedulingExecution.deviceId;
    // 归属是规范身份引用（`person:<uuid>` / `station:<id>`），执行事实表存裸 id：
    // 不归一就**永远查到 0 行**（"有偏差却显示 0 次"）。归一规则见 executionSubjectKey。
    const subjectKey = executionSubjectKey(action.subjectType, action.subjectId as string);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(ewohSchedulingExecution)
      .where(and(
        eq(ewohSchedulingExecution.orgId, orgId),
        eq(column, subjectKey),
        isNotNull(ewohSchedulingExecution.deviationType),
        gte(ewohSchedulingExecution.createdAt, new Date(fromIso)),
        lte(ewohSchedulingExecution.createdAt, new Date(toIso)),
      ));
    return Number(row?.count ?? 0);
  }

  /* ── 落库 ─────────────────────────────────────────────────────────────── */

  private async persistAction(
    orgId: string,
    action: ImprovementActionRecord,
    actorId: string,
    now: Date,
  ): Promise<'created' | 'refreshed' | 'preserved'> {
    const [existing] = await this.db
      .select({ id: ewohImprovementAction.id, status: ewohImprovementAction.status })
      .from(ewohImprovementAction)
      .where(and(
        eq(ewohImprovementAction.orgId, orgId),
        eq(ewohImprovementAction.actionId, action.actionId),
      ))
      .limit(1);
    const sourceSnapshot = {
      sourceType: action.sourceType,
      sourceRef: action.sourceRef,
      subjectType: action.subjectType ?? null,
      subjectId: action.subjectId ?? null,
      title: action.title,
      detail: action.detail,
      priority: action.priority,
      evidenceJson: action.evidenceRefs,
      detectedAt: new Date(action.detectedAt),
      updatedAt: now,
      updatedBy: actorId,
    };
    if (!existing) {
      await this.db.insert(ewohImprovementAction).values({
        orgId,
        actionId: action.actionId,
        kind: action.kind,
        kindSource: action.kindSource,
        status: 'proposed',
        recordJson: action as unknown as Record<string, unknown>,
        createdBy: actorId,
        ...sourceSnapshot,
      });
      return 'created';
    }
    // 已有行：只刷新**来源事实**（标题/详情/优先级/证据）；人的决定与责任痕迹原样保留。
    await this.db
      .update(ewohImprovementAction)
      .set(sourceSnapshot)
      .where(and(
        eq(ewohImprovementAction.orgId, orgId),
        eq(ewohImprovementAction.actionId, action.actionId),
      ));
    return existing.status === 'proposed' ? 'refreshed' : 'preserved';
  }

  /** 状态变更：把整条记录（含责任/期限/完成痕迹）写回，保证 DB 与契约一致。 */
  private async writeRecord(
    orgId: string,
    action: ImprovementActionRecord,
    actorId: string,
    now: Date,
    executor?: Pick<PostgresJsDatabase, 'update'>,
  ): Promise<void> {
    await (executor ?? this.db)
      .update(ewohImprovementAction)
      .set({
        status: action.status,
        kind: action.kind,
        kindSource: action.kindSource,
        owner: action.owner ?? null,
        dueAt: action.dueAt ? new Date(action.dueAt) : null,
        acceptanceCriteria: action.acceptanceCriteria ?? null,
        acceptedBy: action.acceptedBy ?? null,
        acceptedAt: action.acceptedAt ? new Date(action.acceptedAt) : null,
        completedBy: action.completedBy ?? null,
        completedAt: action.completedAt ? new Date(action.completedAt) : null,
        outcomeNote: action.outcomeNote ?? null,
        outcomeRef: action.outcomeRef ?? null,
        outcomeKind: action.outcomeKind ?? null,
        decidedBy: action.decidedBy ?? null,
        decidedAt: action.decidedAt ? new Date(action.decidedAt) : null,
        decidedReason: action.decidedReason ?? null,
        recordJson: action as unknown as Record<string, unknown>,
        updatedAt: now,
        updatedBy: actorId,
      })
      .where(and(
        eq(ewohImprovementAction.orgId, orgId),
        eq(ewohImprovementAction.actionId, action.actionId),
      ));
  }

  private async mustGet(orgId: string, actionId: string): Promise<ImprovementActionRecord> {
    const [row] = await this.db
      .select()
      .from(ewohImprovementAction)
      .where(and(
        eq(ewohImprovementAction.orgId, orgId),
        eq(ewohImprovementAction.actionId, actionId),
      ))
      .limit(1);
    if (!row) throw new NotFoundException(`改进行动项 ${actionId} 不存在（同租户内）`);
    return this.toRecord(row);
  }

  private toRecord(row: typeof ewohImprovementAction.$inferSelect): ImprovementActionRecord {
    return {
      actionId: row.actionId,
      sourceType: row.sourceType as ImprovementActionRecord['sourceType'],
      sourceRef: row.sourceRef,
      subjectType: (row.subjectType as ImprovementActionRecord['subjectType']) ?? null,
      subjectId: row.subjectId ?? null,
      title: row.title,
      detail: row.detail,
      kind: row.kind as ImprovementActionRecord['kind'],
      kindSource: row.kindSource as ImprovementActionRecord['kindSource'],
      priority: row.priority as ImprovementActionRecord['priority'],
      status: row.status as ImprovementActionRecord['status'],
      evidenceRefs: (row.evidenceJson ?? []) as ImprovementActionRecord['evidenceRefs'],
      owner: row.owner,
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      acceptanceCriteria: row.acceptanceCriteria,
      acceptedBy: row.acceptedBy,
      acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
      completedBy: row.completedBy,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      outcomeNote: row.outcomeNote,
      outcomeRef: row.outcomeRef,
      outcomeKind: (row.outcomeKind as ImprovementActionRecord['outcomeKind']) ?? null,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decidedReason: row.decidedReason,
      detectedAt: row.detectedAt.toISOString(),
    };
  }
}

/** 未完成的行动项状态（逾期看板/交接核对共用口径）。 */
export const IMPROVEMENT_OPEN_STATUSES = ['proposed', 'accepted'] as const;
