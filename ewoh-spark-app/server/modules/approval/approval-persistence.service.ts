import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohEvent, ewohEventChain } from '@server/database/schema';
import type {
  ApprovalInstance,
  ApprovalStep,
  ApprovalStepAction,
  ApprovalStepStatus,
  CreateApprovalRequest,
  ObjectDescriptor,
} from '@shared/api.interface';

/**
 * OD-1：从 evidenceJson 还原对象描述符快照。
 *
 * evidenceJson 是无 `$type` 约束的 jsonb（见 `server/database/schema.ts`），
 * 老数据不含 subject，故一律以 undefined 返回，由消费方回退到 entityType+entityId 渲染。
 */
function readSubject(evidence: Record<string, unknown>): ObjectDescriptor | undefined {
  const raw = evidence.subject;
  if (!raw || typeof raw !== 'object') return undefined;
  const subject = raw as Partial<ObjectDescriptor>;
  if (typeof subject.objectType !== 'string' || typeof subject.objectId !== 'string') {
    return undefined;
  }
  if (typeof subject.title !== 'string') return undefined;
  return subject as ObjectDescriptor;
}
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';
import { aggregateApprovalStatus } from './approval.service';
import { CAPABILITY_APPROVAL_VALIDITY_MS } from '@shared/capability-requirements';
import { resolveNotificationsFor } from '../notification/notification-resolution.link';

/**
 * NO-24a/NO-31a：**执行边界授权**的实体类型——凡是"批准一次即授予某项执行权力、
 * 因而必须有时效与用量"的审批都属于这里：
 *   · 设备能力恢复（device_capability_change）
 *   · 任务能力放宽（task_capability_change）
 *   · 高危物理控制指令（control_request，NO-31a 纳入：半年前的"同意"不该今天仍有效）
 * 与 `APPROVAL_ROLE_POLICY` 登记项一致；未登记的实体类型不进授权视图。
 */
const CAPABILITY_CHANGE_ENTITY_TYPES = [
  'device_capability_change',
  'task_capability_change',
  'control_request',
] as const;

/** approval.yaml role:high_privilege_admin 在系统角色表中的映射（最高权限角色）。 */
const HIGH_PRIVILEGE_ROLE = 'global_admin';

/**
 * R2-SMI-003：审批图（谁批什么）由服务端决定——entityType → 必需审批步骤
 * 角色映射。请求体 input.roles 仅作展示性输入，不再作为审批角色来源；
 * 未登记的 entityType 一律拒绝（fail-closed，防自造审批链）。
 */
export const APPROVAL_ROLE_POLICY: Readonly<Record<string, readonly string[]>> = {
  /** 生产任务相关审批：车间主管复核 + 安全管理员把关。 */
  task: ['workshop_lead', 'safety_admin'],
  /** 危险作业审批：安全管理员。 */
  dangerous_action: ['safety_admin'],
  /** R2-SMI-001/INV-005：高危物理控制指令审批；safety_admin 扮演
   * control.yaml pending_approval→approved 的 approver 角色。 */
  control_request: ['safety_admin'],
  /**
   * NO-20a：**放宽高风险能力要求**的审批（安全管理员）。
   * 去掉 crane / exo-lift / interact.assist 一类高风险要求会放宽"谁可以承接该任务"，
   * 属执行边界变更——调度员不得单独决定，必须经安全管理员审批（原则 4/6）。
   */
  task_capability_change: ['safety_admin'],
  /**
   * NO-21a：**恢复高风险设备能力**的审批（安全管理员）。
   * 把 crane / exo-lift / interact.assist 重新放回可用集 = 设备重新具备高风险作业资格
   * （重新投运是安全决定）；停用属收紧，不需要审批。审批可覆盖一批设备（一次维护授权多台）。
   */
  device_capability_change: ['safety_admin'],
};

const STEP_STATUSES = new Set<ApprovalStepStatus>([
  'pending',
  'approved',
  'rejected',
  'delegated',
  'skipped',
  'expired',
]);

const STEP_ACTIONS = new Set<ApprovalStepAction>([
  'approve',
  'reject',
  'delegate',
  'skip',
  'expire',
]);

interface EventRow {
  eventId: string;
  eventType: string | null;
  title: string | null;
  status: string | null;
  createdAt: Date | string | null;
  /** NO-22a：实例行最后写入时间（= 最后一个步骤放行时刻，作为 approvedAt）。 */
  updatedAt?: Date | string | null;
  evidenceJson: unknown;
}

interface ChainRow {
  eventId: string;
  description: string | null;
  /** NO-22a：步骤最后一次状态变更时间（时效展示与对账）。 */
  updatedAt?: Date | string | null;
}

function serializeStep(step: ApprovalStep): string {
  return JSON.stringify({
    role: step.role,
    status: step.status,
    reason: step.reason ?? null,
    delegateTo: step.delegateTo ?? null,
  });
}

function parseStep(row: ChainRow): ApprovalStep {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.description ?? '{}');
  } catch {
    throw new InternalServerErrorException(
      `Approval step ${row.eventId} has invalid description`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InternalServerErrorException(
      `Approval step ${row.eventId} has invalid description`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.role !== 'string' ||
    typeof record.status !== 'string' ||
    !STEP_STATUSES.has(record.status as ApprovalStepStatus)
  ) {
    throw new InternalServerErrorException(
      `Approval step ${row.eventId} has invalid description`,
    );
  }
  return {
    id: row.eventId,
    role: record.role,
    status: record.status as ApprovalStepStatus,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    delegateTo:
      typeof record.delegateTo === 'string' ? record.delegateTo : undefined,
    ...(row.updatedAt
      ? { decidedAt: new Date(row.updatedAt as Date | string).toISOString() }
      : {}),
  };
}

@Injectable()
export class ApprovalPersistenceService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /** NO-12f/ADR-030：待批清单（org 作用域，最近创建优先）。 */
  async listPending(orgId: string): Promise<Array<Record<string, unknown>>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：审批待批查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.orgId, orgId),
        eq(ewohEvent.eventType, 'approval_instance'),
        eq(ewohEvent.status, 'pending'),
      ))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(200);
    return rows.map((r) => {
      const evidence = (r.evidenceJson ?? {}) as Record<string, unknown>;
      const subject = readSubject(evidence);
      return {
        approvalId: r.eventId,
        entityType: evidence.entityType ?? null,
        entityId: evidence.entityId ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        // OD-1：老数据无 subject → undefined，前端回退既有渲染，不允许白屏。
        ...(subject ? { subject } : {}),
      };
    });
  }

  /**
   * NO-24a：**执行边界授权视图**（org 作用域）。
   *
   * 为什么需要它：NO-22a 之后"已授权"是有时效、且会被消耗的凭证，但审批台只列
   * **待批**清单——于是"已通过但已过期"的审批在界面上完全不可见，只有现场真去
   * 执行时才会撞到 409（原则 5/6：已授权必须能看出时效与用量）。
   *
   * 返回内容（都用已存在的事件行推导，不新增表）：
   *   · 授权本身：状态 / 通过时间 / 失效时间 / 是否过期 / 剩余毫秒；
   *   · 对象描述符快照（含指纹 metrics）——UI 才能写出"哪个能力、覆盖哪些设备"；
   *   · **消耗情况**：哪些对象已用掉这份授权（approval_usage 事件行，谁/何时/备注）。
   *
   * 排序：先"可用且最快过期"（最容易误用为仍然有效），再已过期，最后待批/终态。
   */
  async listCapabilityAuthorizations(orgId: string): Promise<
    Array<{
      approvalId: string;
      entityType: string;
      entityId: string;
      status: string;
      createdAt: string | null;
      approvedAt: string | null;
      expiresAt: string | null;
      expired: boolean;
      remainingMs: number | null;
      subject?: ObjectDescriptor;
      usage: Array<{ usageKey: string; usedBy: string; at: string | null; note: string | null }>;
      /** NO-30a：发起人（审批实例创建时写入 evidence.createdBy）——到期提醒要能找到他。 */
      createdBy: string | null;
    }>
  > {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：授权视图查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.orgId, orgId),
          eq(ewohEvent.eventType, 'approval_instance'),
          inArray(sql`${ewohEvent.evidenceJson}->>'entityType'`, [...CAPABILITY_CHANGE_ENTITY_TYPES]),
        ),
      )
      .orderBy(desc(ewohEvent.createdAt))
      .limit(200);
    if (rows.length === 0) return [];

    const approvalIds = rows.map((row) => String(row.eventId));
    // 消耗记录按 causation_id 归组（claimUsage 写入时 causationId = 审批号）
    const usageRows = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.orgId, orgId),
          eq(ewohEvent.eventType, 'approval_usage'),
          inArray(ewohEvent.causationId, approvalIds),
        ),
      )
      .orderBy(asc(ewohEvent.createdAt));
    const usageByApproval = new Map<string, Array<{ usageKey: string; usedBy: string; at: string | null; note: string | null }>>();
    for (const row of usageRows) {
      const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
      const key = String(row.causationId ?? evidence.approvalId ?? '');
      if (!key) continue;
      const entry = {
        usageKey: typeof evidence.usageKey === 'string' ? evidence.usageKey : '',
        usedBy: typeof evidence.usedBy === 'string' ? evidence.usedBy : '未知操作人',
        at: typeof evidence.at === 'string' ? evidence.at : null,
        note: typeof evidence.note === 'string' ? evidence.note : null,
      };
      const list = usageByApproval.get(key);
      if (list) list.push(entry);
      else usageByApproval.set(key, [entry]);
    }

    const nowMs = Date.now();
    const items = rows.map((row) => {
      const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
      const status = String(row.status ?? 'pending');
      const subject = readSubject(evidence);
      const updatedAtIso = row.updatedAt ? new Date(row.updatedAt as Date | string).toISOString() : null;
      // 与闸门口径一致：只有 approved 才有"通过时间"，未通过的审批没有时效可言
      const approvedAt = status === 'approved' ? updatedAtIso : null;
      const approvedMs = approvedAt ? Date.parse(approvedAt) : Number.NaN;
      const expiresAtMs = Number.isFinite(approvedMs)
        ? approvedMs + CAPABILITY_APPROVAL_VALIDITY_MS
        : Number.NaN;
      const expired = Number.isFinite(expiresAtMs) && nowMs > expiresAtMs;
      return {
        approvalId: String(row.eventId),
        entityType: String(evidence.entityType ?? ''),
        entityId: String(evidence.entityId ?? ''),
        status,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        approvedAt,
        expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
        expired,
        remainingMs: Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - nowMs) : null,
        ...(subject ? { subject } : {}),
        usage: usageByApproval.get(String(row.eventId)) ?? [],
        createdBy:
          typeof evidence.createdBy === 'string' && evidence.createdBy.trim() !== ''
            ? evidence.createdBy
            : null,
      };
    });

    // 可用（未过期、已通过）优先且最快过期在前；其次已过期；最后待批/驳回等
    const bucket = (item: (typeof items)[number]): number => {
      if (item.status === 'approved' && !item.expired) return 0;
      if (item.status === 'approved' && item.expired) return 1;
      if (item.status === 'pending') return 2;
      return 3;
    };
    return items.sort((a, b) => {
      const bucketDiff = bucket(a) - bucket(b);
      if (bucketDiff !== 0) return bucketDiff;
      if (bucket(a) === 0) return (a.remainingMs ?? 0) - (b.remainingMs ?? 0);
      return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    });
  }

  async createApproval(
    input: CreateApprovalRequest,
    actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    if (!input.entityType?.trim() || !input.entityId?.trim()) {
      throw new BadRequestException('entityType and entityId are required');
    }
    // NEST-401：HTTP 创建必须带租户上下文（org 缺失 401，绝不静默写全局行）。
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：审批创建必须带租户上下文',
      );
    }
    const entityType = input.entityType.trim();
    const entityId = input.entityId.trim();
    // R2-SMI-003：审批角色按 entityType 由服务端映射——请求体 roles 不可
    // 指定审批图；未登记 entityType 拒绝（fail-closed）。
    const requiredRoles = APPROVAL_ROLE_POLICY[entityType];
    if (!requiredRoles?.length) {
      throw new BadRequestException(
        `Unknown approval entityType '${entityType}' (allowed: ${Object.keys(APPROVAL_ROLE_POLICY).join(', ')})`,
      );
    }
    const now = new Date();
    const id = randomUUID();
    const steps: ApprovalStep[] = requiredRoles.map((role) => ({
      id: randomUUID(),
      role,
      status: 'pending',
    }));
    // OD-1：对象描述符快照（可选，向后兼容）。未登记的 entityType 已在上面 fail-closed 拒绝。
    const subject = input.subject;

    // R2-SMI-004：instance（ewoh_event）与 steps（ewoh_event_chain）同事务
    // 提交——chain 失败不再留下无 steps 的孤儿 instance 行。
    await this.db.transaction(async (tx) => {
      await tx.insert(ewohEvent).values({
        eventId: id,
        eventType: 'approval_instance',
        // OD-1：优先存人类可读标题，缺失时回退既有文案（避免 DB 里落裸 ID）。
        title: subject?.title?.trim() || `Approval for ${entityType} ${entityId}`,
        status: 'pending',
        createdAt: now,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        sourceType: 'approval',
        // NEST-401：写入显式携带 orgId。
        orgId,
        evidenceJson: {
          entityType,
          entityId,
          createdAt: now.toISOString(),
          // NEST-405：记录发起人（cancel/发起人回避的 initiator 校验依据）。
          createdBy: actor?.userId ?? 'system',
          // OD-1：对象描述符快照（jsonb 无 $type 约束，加字段无需 DB 迁移）。
          ...(subject ? { subject } : {}),
        },
      });
      await tx.insert(ewohEventChain).values(
        steps.map((step) => ({
          eventId: step.id,
          parentEventId: id,
          causalType: 'approval_step',
          description: serializeStep(step),
          createdAt: now,
        })),
      );
    });

    return {
      id,
      entityType,
      entityId,
      status: 'pending',
      steps,
      createdAt: now.toISOString(),
      ...(subject ? { subject } : {}),
    };
  }

  /** NEST-402：读取带 org 守卫（NULL legacy 行/同 org/global_admin 放行，跨租户 404）。 */
  async getApproval(id: string, actor?: OrgContext): Promise<ApprovalInstance> {
    const [event] = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventId, id),
          eq(ewohEvent.eventType, 'approval_instance'),
        ),
      );
    if (!event) {
      throw new NotFoundException(`Approval ${id} not found`);
    }
    assertTenantVisible(
      (event as EventRow & { orgId?: string | null }).orgId,
      actor,
      `Approval ${id}`,
    );
    const chainRows = await this.db
      .select()
      .from(ewohEventChain)
      .where(
        and(
          eq(ewohEventChain.parentEventId, id),
          eq(ewohEventChain.causalType, 'approval_step'),
        ),
      )
      .orderBy(asc(ewohEventChain.createdAt));
    const steps = chainRows.map((row) =>
      parseStep({
        eventId: row.eventId,
        description: row.description,
        updatedAt: row.updatedAt,
      }),
    );
    return this.toInstance(event as EventRow, steps);
  }

  /**
   * R2-SMI-001：按 (entityType, entityId) 查最近一条审批实例（control 审批
   * 闸门联动查询）。org 守卫与 getApproval 一致（跨租户 404）。
   */
  async findLatestForEntity(
    entityType: string,
    entityId: string,
    actor?: OrgContext,
  ): Promise<ApprovalInstance | null> {
    // 查询本身也按租户收敛：只在"取回后 getApproval 再判 404"是不够的——
    // 第一条查询会读到**他租户**的审批实例行（2026-09-10 org 谓词审计暴露）。
    // 有 actor 时按其 org 过滤；无 actor（系统/内部调用）= 存量路径，保持原形状。
    const viewerOrgId = actor?.primaryOrgId?.trim();
    const rows = await this.db
      .select({ eventId: ewohEvent.eventId })
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventType, 'approval_instance'),
          sql`${ewohEvent.evidenceJson}->>'entityType' = ${entityType}`,
          sql`${ewohEvent.evidenceJson}->>'entityId' = ${entityId}`,
          viewerOrgId ? eq(ewohEvent.orgId, viewerOrgId) : undefined,
        ),
      )
      .orderBy(desc(ewohEvent.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.getApproval(row.eventId, actor);
  }

  async stepAction(
    id: string,
    stepId: string,
    action: ApprovalStepAction,
    reason?: string,
    delegateTo?: string,
    actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    if (!STEP_ACTIONS.has(action)) {
      throw new BadRequestException(`Unsupported approval action ${action}`);
    }
    const instance = await this.getApproval(id, actor);
    if (instance.status !== 'pending') {
      throw new BadRequestException(`Approval ${id} is not pending`);
    }
    const step = instance.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found`);
    }
    if (step.status !== 'pending') {
      throw new BadRequestException(`Step ${stepId} is not pending`);
    }
    // NEST-403：step 角色匹配（global_admin 越权放行；角色不满足 403）。
    const actorRoles = actor?.roles ?? [];
    if (
      !actorRoles.includes(HIGH_PRIVILEGE_ROLE) &&
      !actorRoles.includes(step.role)
    ) {
      throw new ForbiddenException(
        `Step ${stepId} requires role '${step.role}' (actor roles: ${actorRoles.join(', ') || 'none'})`,
      );
    }
    // R2-SMI-003：职责分离（segregation of duties）——发起人回避。发起人
    // 不得审批/操作自己发起的实例上的任何步骤（global_admin 亦回避；
    // 紧急通道走 approval.bypass，另行 high_risk 审计）。legacy 行无
    // createdBy 时不适用（无从判定发起人）。
    if (actor) {
      const [evidenceRow] = await this.db
        .select({ evidenceJson: ewohEvent.evidenceJson })
        .from(ewohEvent)
        .where(eq(ewohEvent.eventId, id));
      const evidence =
        ((evidenceRow?.evidenceJson as Record<string, unknown> | null) ?? {});
      const createdBy =
        typeof evidence.createdBy === 'string' ? evidence.createdBy : null;
      if (createdBy && createdBy === actor.userId) {
        throw new ForbiddenException(
          'approval.stepAction 发起人回避：不得审批自己发起的实例（segregation of duties）',
        );
      }
    }

    const nextStep: ApprovalStep = { ...step };
    switch (action) {
      case 'approve':
        nextStep.status = 'approved';
        break;
      case 'reject':
        nextStep.status = 'rejected';
        break;
      case 'delegate':
        nextStep.status = 'delegated';
        nextStep.delegateTo = delegateTo;
        break;
      case 'skip':
        nextStep.status = 'skipped';
        break;
      case 'expire':
        nextStep.status = 'expired';
        break;
    }
    if (reason !== undefined) {
      nextStep.reason = reason;
    }

    const nextSteps = instance.steps.map((candidate) =>
      candidate.id === stepId ? nextStep : candidate,
    );
    const nextStatus = aggregateApprovalStatus(nextSteps);

    // R2-SMI-004：step 与 instance 双 UPDATE 同事务——instance CAS 失败时
    // step 变更一并回滚，不再留下 step/聚合状态永裂的脏审批。
    const [updatedStep, updatedInstance] = await this.db.transaction(
      async (tx) => {
        const [stepRow] = await tx
          .update(ewohEventChain)
          .set({ description: serializeStep(nextStep) })
          .where(
            and(
              eq(ewohEventChain.eventId, stepId),
              eq(ewohEventChain.parentEventId, id),
              sql`${ewohEventChain.description}::jsonb->>'status' = ${step.status}`,
            ),
          )
          .returning();
        if (!stepRow) {
          throw new ConflictException('STATE_CONFLICT');
        }
        const [instanceRow] = await tx
          .update(ewohEvent)
          .set({ status: nextStatus })
          .where(
            and(
              eq(ewohEvent.eventId, id),
              eq(ewohEvent.eventType, 'approval_instance'),
              eq(ewohEvent.status, instance.status),
            ),
          )
          .returning();
        if (!instanceRow) {
          throw new ConflictException('STATE_CONFLICT');
        }
        // NO-45a：同一对象重新申请并通过 → 旧审批的到期提醒随之了结（同事务）。
        // 现场视角：重新申请成功之后，"请尽快处理/已失效请重新申请"这些提醒的前提
        // 都已经消失；留着只会让通知中心继续堆积（原则 1/10）。
        if (nextStatus === 'approved') {
          await this.supersedeEarlierApprovalReminders(tx, {
            orgId: String((instanceRow as { orgId?: string | null }).orgId ?? ''),
            approvalId: id,
            entityType: instance.entityType,
            entityId: instance.entityId,
            resolvedBy: actor?.userId ?? 'system:approval-supersede',
          });
        }
        return [stepRow, instanceRow] as const;
      },
    );
    if (!updatedStep || !updatedInstance) {
      throw new ConflictException('STATE_CONFLICT');
    }

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `approval.${action}`,
      entityType: 'approval',
      entityId: id,
      before: {
        instanceStatus: instance.status,
        stepStatus: step.status,
        reason: step.reason ?? null,
        delegateTo: step.delegateTo ?? null,
      },
      after: {
        instanceStatus: nextStatus,
        stepStatus: nextStep.status,
        reason: nextStep.reason ?? null,
        delegateTo: nextStep.delegateTo ?? null,
      },
    });

    return { ...instance, status: nextStatus, steps: nextSteps };
  }

  async bypass(
    id: string,
    reason: string,
    actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    // NEST-404：approval.yaml 要求 high_privilege_admin（映射 global_admin）；
    // 原 fallback 仅 workshop_lead/safety_admin 即可绕过。
    const actorRoles = actor?.roles ?? [];
    if (!actorRoles.includes(HIGH_PRIVILEGE_ROLE)) {
      throw new ForbiddenException(
        'approval.bypass requires high_privilege_admin (global_admin)',
      );
    }
    const instance = await this.getApproval(id, actor);
    if (instance.status !== 'pending') {
      throw new BadRequestException(`Approval ${id} is not pending`);
    }
    const pendingSteps = instance.steps.filter(
      (step) => step.status === 'pending',
    );
    const nextSteps = instance.steps.map((step) =>
      step.status === 'pending'
        ? { ...step, status: 'skipped' as const, reason: reason || step.reason }
        : step,
    );

    // R2-SMI-004：bypass 的全部 step UPDATE 与 instance UPDATE 同事务——
    // 中途任一 CAS 失败整体回滚，不再留下「部分 skipped + instance 仍 pending」。
    await this.db.transaction(async (tx) => {
      for (const step of pendingSteps) {
        const nextStep = nextSteps.find(
          (candidate) => candidate.id === step.id,
        )!;
        const [updatedStep] = await tx
          .update(ewohEventChain)
          .set({ description: serializeStep(nextStep) })
          .where(
            and(
              eq(ewohEventChain.eventId, step.id),
              eq(ewohEventChain.parentEventId, id),
              sql`${ewohEventChain.description}::jsonb->>'status' = 'pending'`,
            ),
          )
          .returning();
        if (!updatedStep) {
          throw new ConflictException('STATE_CONFLICT');
        }
      }

      const [updatedInstance] = await tx
        .update(ewohEvent)
        .set({ status: 'bypassed' })
        .where(
          and(
            eq(ewohEvent.eventId, id),
            eq(ewohEvent.eventType, 'approval_instance'),
            eq(ewohEvent.status, instance.status),
          ),
        )
        .returning();
      if (!updatedInstance) {
        throw new ConflictException('STATE_CONFLICT');
      }
    });

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'approval.bypass',
      entityType: 'approval',
      entityId: id,
      // NEST-415：approval.yaml audit:high_risk——bypass 显式标 risk:true。
      risk: true,
      before: { instanceStatus: instance.status, steps: instance.steps },
      after: { instanceStatus: 'bypassed', steps: nextSteps },
    });

    return { ...instance, status: 'bypassed', steps: nextSteps };
  }

  async cancel(id: string, actor?: OrgContext): Promise<ApprovalInstance> {
    const instance = await this.getApproval(id, actor);
    if (
      instance.status === 'approved' ||
      instance.status === 'rejected' ||
      instance.status === 'bypassed'
    ) {
      throw new BadRequestException(`Approval ${id} is terminal`);
    }
    // NEST-405：approval.yaml 要求 role:initiator——非发起人（且非
    // global_admin）不可取消；legacy 行（无 createdBy）保持可操作不锁死。
    const actorRoles = actor?.roles ?? [];
    if (
      actor &&
      !actorRoles.includes(HIGH_PRIVILEGE_ROLE)
    ) {
      const [evidenceRow] = await this.db
        .select({ evidenceJson: ewohEvent.evidenceJson })
        .from(ewohEvent)
        .where(eq(ewohEvent.eventId, id));
      const evidence =
        ((evidenceRow?.evidenceJson as Record<string, unknown> | null) ?? {});
      const createdBy =
        typeof evidence.createdBy === 'string' ? evidence.createdBy : null;
      if (createdBy && createdBy !== actor.userId) {
        throw new ForbiddenException(
          'approval.cancel requires the initiator (or global_admin)',
        );
      }
    }
    const [updatedInstance] = await this.db
      .update(ewohEvent)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(ewohEvent.eventId, id),
          eq(ewohEvent.eventType, 'approval_instance'),
          eq(ewohEvent.status, instance.status),
        ),
      )
      .returning();
    if (!updatedInstance) {
      throw new ConflictException('STATE_CONFLICT');
    }

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'approval.cancel',
      entityType: 'approval',
      entityId: id,
      before: { instanceStatus: instance.status },
      after: { instanceStatus: 'cancelled' },
    });

    return { ...instance, status: 'cancelled' };
  }

  /**
   * NO-45a：同一 (entityType, entityId) 的**更早**已通过审批，其到期提醒随新审批通过而了结。
   *
   * 只关"提醒"，不动任何审批事实：旧审批的状态/时效/用量全部保留（审计要能回答
   * "上一张是怎么失效的、这一张是什么时候批的"）。`resolutionRef` 指向新审批号，
   * 于是从一条提醒能反查到"是哪次重新申请把它关掉的"。
   */
  private async supersedeEarlierApprovalReminders(
    tx: Pick<PostgresJsDatabase, 'select' | 'update' | 'execute'>,
    input: {
      orgId: string;
      approvalId: string;
      entityType: string;
      entityId: string;
      resolvedBy: string;
    },
  ): Promise<number> {
    const orgId = input.orgId.trim();
    const entityType = input.entityType.trim();
    const entityId = input.entityId.trim();
    // 缺组织/对象标识 → 不猜、不关（fail-closed：宁可不关，也不误关别人的提醒）。
    if (orgId === '' || entityType === '' || entityId === '') return 0;
    // 候选 = **同一对象、更早通过、且当前还挂着待处置提醒**的审批（直接从通知表反查）。
    //
    // 为什么不能"取最近 N 张旧审批"：实测 e2e 里旧审批的时间戳会被回拨（真实的授权也
    // 可能因为补录/迁移而与创建顺序不一致），按 updated_at 取"最近"会漏掉真正的上一张 →
    // 表现成"重新申请后旧提醒没关"。直接以"还有待办提醒"为准，既不漏也不做无谓的写入；
    // 上限 50 防止一次动作影响面过大。
    const candidates = (await tx.execute(sql`
      SELECT DISTINCT e.event_id AS event_id
      FROM "ewoh_event" e
      JOIN "ewoh_notification" n
        ON n.external_ref = e.event_id
       AND n.org_id = e.org_id
      WHERE e.org_id = ${orgId}
        AND e.event_type = 'approval_instance'
        AND e.status = 'approved'
        AND e.event_id <> ${input.approvalId}
        AND e.evidence_json->>'entityType' = ${entityType}
        AND e.evidence_json->>'entityId' = ${entityId}
        AND n.status = 'pending'
        AND n.resolution IS NULL
        AND n.notification_id LIKE 'NTF-EXPR-%'
      LIMIT 50
    `)) as unknown as Array<{ event_id?: string | null }>;
    let closed = 0;
    for (const row of candidates) {
      const earlierId = String(row.event_id ?? '').trim();
      if (earlierId === '') continue;
      const result = await resolveNotificationsFor(tx, {
        orgId,
        externalRef: earlierId,
        notificationIdPrefix: `NTF-EXPR-${earlierId}-`,
        resolution: 'approval_superseded',
        resolvedBy: input.resolvedBy,
        resolutionRef: input.approvalId,
      });
      closed += result.closed;
    }
    return closed;
  }

  private toInstance(event: EventRow, steps: ApprovalStep[]): ApprovalInstance {
    const evidence = (event.evidenceJson ?? {}) as Record<string, unknown>;
    const createdAt =
      event.createdAt instanceof Date
        ? event.createdAt.toISOString()
        : event.createdAt
          ? new Date(event.createdAt).toISOString()
          : typeof evidence.createdAt === 'string'
            ? evidence.createdAt
            : new Date().toISOString();
    const subject = readSubject(evidence);
    const status = event.status as ApprovalInstance['status'];
    // NO-22a：实例行最后一次写入 = 最后一个步骤放行的时刻（stepAction 会同步更新
    // 实例行状态）。只有 approved 才暴露 approvedAt——pending 实例没有"通过时间"。
    const updatedAtIso = event.updatedAt
      ? new Date(event.updatedAt as Date | string).toISOString()
      : undefined;
    return {
      id: event.eventId,
      entityType:
        typeof evidence.entityType === 'string' ? evidence.entityType : '',
      entityId: typeof evidence.entityId === 'string' ? evidence.entityId : '',
      status,
      steps,
      createdAt,
      ...(status === 'approved' && updatedAtIso ? { approvedAt: updatedAtIso } : {}),
      // OD-1：对象描述符快照；老数据缺失时为 undefined，消费方回退渲染。
      ...(subject ? { subject } : {}),
    };
  }

  /**
   * NO-22a：认领一次授权消耗（同一审批 + 同一对象只能消耗一次）。
   *
   * 实现要点：消耗记录写成一条 `ewoh_event` 行，`event_id` 由 (审批号, 消耗键) 决定，
   * 而 `ewoh_event.event_id` 有**唯一约束**——于是"只能消耗一次"由数据库保证，
   * 不依赖"先查后写"的竞态窗口。插入用 `ON CONFLICT DO NOTHING`：
   *   · 返回行 → 本次消耗成功（claimed=true）；
   *   · 无返回行 → 该审批已用于该对象，回读原消耗记录（谁/何时/备注）如实告知现场。
   *
   * 传 `tx` 时与调用方的业务写入同事务：业务写失败 → 消耗记录一并回滚，
   * 不会出现"审批被烧掉但什么都没做"的假消耗。
   */
  async claimUsage(
    input: {
      approvalId: string;
      usageKey: string;
      usedBy: string;
      note?: string | null;
      orgId?: string | null;
      entityType?: string | null;
      entityId?: string | null;
      deviceId?: string | null;
      at?: Date;
    },
    tx?: PostgresJsDatabase,
  ): Promise<{
    claimed: boolean;
    usageEventId: string;
    existing?: { usedBy: string; at: string | null; note: string | null };
  }> {
    const db = tx ?? this.db;
    const approvalId = String(input.approvalId ?? '').trim();
    const usageKey = String(input.usageKey ?? '').trim();
    if (!approvalId || !usageKey) {
      throw new BadRequestException('claimUsage 需要 approvalId 与 usageKey');
    }
    const at = input.at ?? new Date();
    const usageEventId = `approval_usage:${approvalId}:${usageKey}`;
    if (usageEventId.length > 255) {
      throw new BadRequestException(
        `claimUsage 消耗键过长（${usageEventId.length} > 255）：无法记录授权消耗`,
      );
    }
    const rows = await db
      .insert(ewohEvent)
      .values({
        eventId: usageEventId,
        eventType: 'approval_usage',
        status: 'consumed',
        severity: 'info',
        title: `授权消耗：${usageKey}`,
        deviceId: input.deviceId ?? null,
        sourceType: 'platform',
        causationId: approvalId,
        correlationId: approvalId,
        occurredAt: at,
        observedAt: at,
        receivedAt: at,
        createdAt: at,
        orgId: input.orgId ?? null,
        evidenceJson: {
          approvalId,
          usageKey,
          usedBy: input.usedBy,
          at: at.toISOString(),
          note: input.note ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          deviceId: input.deviceId ?? null,
        },
      })
      .onConflictDoNothing({ target: ewohEvent.eventId })
      .returning({ eventId: ewohEvent.eventId });
    if (rows.length > 0) {
      return { claimed: true, usageEventId };
    }
    // 已被消耗：回读原记录，把"谁在什么时候用过"如实带回（不猜、不覆盖）。
    // 租户收敛（org 谓词门禁 NEST 主线 1）：没有 org 上下文就不读——
    // 宁可如实说"操作人未记录"，也不做一次跨租户按键查询。
    const orgScope = String(input.orgId ?? '').trim();
    let existing: Record<string, unknown> = {};
    if (orgScope) {
      const [existingRow] = await db
        .select({ evidenceJson: ewohEvent.evidenceJson })
        .from(ewohEvent)
        .where(and(eq(ewohEvent.eventId, usageEventId), eq(ewohEvent.orgId, orgScope)))
        .limit(1);
      existing = (existingRow?.evidenceJson ?? {}) as Record<string, unknown>;
    }
    return {
      claimed: false,
      usageEventId,
      existing: {
        usedBy: typeof existing.usedBy === 'string' ? existing.usedBy : '未知操作人',
        at: typeof existing.at === 'string' ? existing.at : null,
        note: typeof existing.note === 'string' ? existing.note : null,
      },
    };
  }
}
