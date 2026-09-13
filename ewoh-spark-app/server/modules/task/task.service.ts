import {
  Injectable,
  Inject,
  Logger,
  Optional,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ewohProductionTask, ewohSpatialEntity } from '@server/database/schema';
import { isValidUuid } from '@server/common/uuid';
import { AuditService } from '../shared/audit.service';
import { ExoSessionService } from '../exo/exo-session.service';
import { DEVICE_CAPABILITY_NAMES, isRegisteredCapability } from '@shared/device-capability';
import {
  CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE,
  buildCapabilityRelaxationApprovalSubject,
  buildTaskApprovalUsageKey,
  describeCapabilityWarnings,
  describeDeviceCapabilityWarnings,
  highRiskCapabilitiesBeingRelaxed,
  normalizeCapabilityList,
  verifyCapabilityRelaxationApproval,
} from '@shared/capability-requirements';
import { isHighRiskCapability } from '@shared/device-capability';
import { ApprovalPersistenceService } from '../approval/approval-persistence.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface CreateTaskDto {
  title: string;
  taskType: string;
  priority?: string;
  description?: string;
  assigneeId?: string;
  deviceId?: string;
  spatialEntityId?: string;
  planStart?: string;
  planEnd?: string;
  /**
   * 任务对设备能力的要求（调度按 `requiredDeviceCapabilities ⊆ device.capabilities`
   * 匹配）。开放词表：未登记能力名允许写入，但响应会给出显式提示（见 warnings）。
   */
  requiredDeviceCapabilities?: string[];
  /** 任务对工位能力的要求（与工位投影 capabilities 匹配；工位能力取自空间实体类型）。 */
  requiredStationCapabilities?: string[];
}

/** 任务能力要求写入结果（含"当前无法匹配"的显式提示，不静默）。 */
export interface TaskCapabilityRequirementsResult {
  taskId: string;
  requiredDeviceCapabilities: string[];
  requiredStationCapabilities: string[];
  warnings: string[];
}

// A1（任务写路径事件接线）：TaskModule 保持依赖叶子（不 import SchedulerModule），
// 通过回调注册表把任务写事件暴露给调度侧。TaskSchedulingBridge（scheduler 模块）
// 在启动时注册回调 → injectSchedulingEvent，避免 TaskModule→SchedulerModule 循环依赖。
export type TaskEventTrigger = 'TASK_CREATED' | 'TASK_UPDATED';
export type TaskEventListener = (
  taskId: string,
  trigger: TaskEventTrigger,
  actor?: OrgContext,
) => void;

export interface TaskActionTransition {
  action: string;
  from: string;
  to: string;
}

/**
 * Canonical Execution Model 任务状态机运行时消费面（ADR-049 / NO-12z，§3/§31）。
 *
 * 单一事实源 = contracts/state-machines/task.yaml；本表为其 TS 消费面，
 * 由 test/unit/task/task-state-machine-contract.spec.ts 逐条锁步
 * （显式转换 + 穷举负例 + 检查器负测试）——修改本表必须同步契约，
 * 漂移在构建期显式暴露（§31 单一语义，无第二事实源）。
 */
export const TASK_ACTIONS: TaskActionTransition[] = [
  { action: 'submit', from: 'draft', to: 'pending_confirm' },
  { action: 'request_approval', from: 'pending_confirm', to: 'pending_approval' },
  { action: 'skip_approval', from: 'pending_confirm', to: 'pending_dispatch' },
  { action: 'approve', from: 'pending_approval', to: 'pending_dispatch' },
  { action: 'reject', from: 'pending_approval', to: 'draft' },
  { action: 'dispatch', from: 'pending_dispatch', to: 'dispatched' },
  // DR-5 方案取消/回滚：派发后、开始执行前，任务退回待派发池（重新可排程）。
  { action: 'rollback_dispatch', from: 'dispatched', to: 'pending_dispatch' },
  { action: 'rollback_dispatch', from: 'received', to: 'pending_dispatch' },
  { action: 'receive', from: 'dispatched', to: 'received' },
  { action: 'start', from: 'received', to: 'executing' },
  { action: 'pause', from: 'executing', to: 'paused' },
  { action: 'resume', from: 'paused', to: 'executing' },
  { action: 'exception', from: 'executing', to: 'exception' },
  { action: 'resolve', from: 'exception', to: 'executing' },
  { action: 'complete', from: 'executing', to: 'completed' },
];

/** 契约 any_non_terminal → cancelled 的非终态集合（task.yaml 锁步）。 */
export const TASK_NON_TERMINAL = [
  'draft',
  'pending_confirm',
  'pending_approval',
  'pending_dispatch',
  'dispatched',
  'received',
  'executing',
  'paused',
  'exception',
] as const;

/** 契约 terminal 集合（task.yaml 锁步）。 */
export const TASK_TERMINAL = ['completed', 'cancelled'] as const;

export function nextTaskStatus(current: string, action: string): string | null {
  if (action === 'cancel') {
    return (TASK_NON_TERMINAL as readonly string[]).includes(current)
      ? 'cancelled'
      : null;
  }
  for (const transition of TASK_ACTIONS) {
    if (transition.action === action && transition.from === current) {
      return transition.to;
    }
  }
  return null;
}

/**
 * 最短合法动作链（ADR-050 / NO-13a，与边缘 shortest_task_path 同语义，
 * §31：双实现各自锁步于同一契约图 task.yaml）。
 *
 * 返回从 current 到 target 的最短 action 序列（BFS）；不可达 → null；
 * current == target → []（已一致，no-op）。
 */
export function taskActionPath(current: string, target: string): string[] | null {
  if (current === target) return [];
  const edges = new Map<string, Array<{ to: string; action: string }>>();
  for (const t of TASK_ACTIONS) {
    if (!edges.has(t.from)) edges.set(t.from, []);
    edges.get(t.from)!.push({ to: t.to, action: t.action });
  }
  const queue: string[] = [current];
  const prev = new Map<string, { state: string; action: string } | null>([
    [current, null],
  ]);
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (state === target) break;
    for (const edge of edges.get(state) ?? []) {
      if (prev.has(edge.to)) continue;
      prev.set(edge.to, { state, action: edge.action });
      queue.push(edge.to);
    }
  }
  if (!prev.has(target)) return null;
  const actions: string[] = [];
  let cursor = prev.get(target);
  while (cursor != null) {
    actions.unshift(cursor.action);
    cursor = prev.get(cursor.state);
  }
  return actions;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  private readonly taskListeners = new Set<TaskEventListener>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    /** NO-20a：高风险能力放宽的审批核对（可选注入，保持既有单测构造兼容）。 */
    @Optional() private readonly approvalService?: ApprovalPersistenceService,
    /**
     * NO-36a：外骨骼会话权威事实（TaskModule 已 import ExoSessionModule，生产路径
     * 始终注入；保留可选形参只为兼容既有单测的手工构造）。
     *
     * 与 `approvalService` 的关键区别：**缺装配不等于放行**。指定了设备却拿不到
     * 会话事实时，createTask 抛 503 `EXO_SESSION_GUARD_UNAVAILABLE`（fail-closed），
     * 绝不静默跳过执行边界判定——2026-09 那次"审批端口缺失导致闸门失效"的教训。
     */
    private readonly exoSessionService?: ExoSessionService,
  ) {}

  /** A1：注册任务写事件监听（调度桥接用）；fire-and-forget，监听器异常不影响任务主流程。 */
  onTaskEvent(fn: TaskEventListener): void {
    this.taskListeners.add(fn);
  }

  private emitTaskEvent(taskId: string, trigger: TaskEventTrigger, actor?: OrgContext): void {
    for (const fn of this.taskListeners) {
      try {
        fn(taskId, trigger, actor);
      } catch (e) {
        this.logger.warn(
          `task event listener failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * NEST-612（2026-08-17 审计整改）：任务读写带 org 谓词（global_admin 放行）；
   * 写入显式 orgId（缺租户上下文 fail-closed）。列表补 LIMIT（原先无界全表）。
   */
  private orgCondition(actor?: OrgContext) {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: task operations require tenant context',
      );
    }
    return eq(ewohProductionTask.orgId, orgId);
  }

  async listTasks(actor?: OrgContext) {
    const orgCond = this.orgCondition(actor);
    return this.db
      .select()
      .from(ewohProductionTask)
      .where(orgCond)
      .orderBy(desc(ewohProductionTask.createdAt))
      .limit(500);
  }

  async getTask(id: string, actor?: OrgContext) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    const orgCond = this.orgCondition(actor);
    const [row] = await this.db
      .select()
      .from(ewohProductionTask)
      .where(orgCond ? and(eq(ewohProductionTask.id, id), orgCond) : eq(ewohProductionTask.id, id));
    if (!row) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return row;
  }

  async createTask(body: CreateTaskDto, actor?: OrgContext) {
    if (!body.title?.trim() || !body.taskType?.trim()) {
      throw new BadRequestException('title and taskType are required');
    }
    // 写入必须带**显式** orgId（业务表 insert 不允许 NULL 归属）。
    // ⚠️ 2026-09-12 修复：此前用 `orgCondition(actor)` 判空，而 global_admin 的
    // orgCondition 恰好返回 undefined（"不加租户过滤"的语义）——于是**平台管理员
    // 反而无法创建任务**，且报错说"org context missing"（实际 org 在令牌里）。
    // 现在直接取 actor.primaryOrgId：有归属就写，没有才拒绝。
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: task creation requires tenant org context',
      );
    }
    // 能力要求：形状/长度/数量非法一律拒绝（不猜不截断）；未登记名允许但显式提示
    const deviceReqs = normalizeCapabilityList(body.requiredDeviceCapabilities, '设备能力要求');
    const stationReqs = normalizeCapabilityList(body.requiredStationCapabilities, '工位能力要求');
    const errors = [...deviceReqs.errors, ...stationReqs.errors];
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));
    const warnings = await this.capabilityRequirementWarnings(
      deviceReqs.names,
      stationReqs.names,
      orgId,
    );
    // NO-36a：外骨骼会话是执行边界——创建任务时若直接指定了"设备 + 人员"，
    // 必须与"该设备正被谁佩戴"的权威事实一致（佩戴者本人 = 人机同体，合法；
    // 指派别人 / 不指派人都不是物理上可执行的组合）。任务创建是除方案派工之外的
    // 第二条指派写路径，硬约束必须在这条路上同样成立（原则 8：执行边界不因入口而异）。
    //
    // 判定与会话读取放在**同一个事务**里（与派工的事务内复查同一思路）：闸门读到的
    // 会话事实与任务写入属于同一原子单元，避免"判定后、写入前"的窗口被并发会话利用。
    const [row] = await this.db.transaction(async (tx) => {
      if (body.deviceId?.trim()) {
        if (!this.exoSessionService) {
          // fail-closed：判定不了就不写（既不静默放行，也不谎称冲突）。
          throw new ServiceUnavailableException(
            'EXO_SESSION_GUARD_UNAVAILABLE：本实例未装配外骨骼会话服务，无法校验'
            + '"该设备是否正被别人佩戴"这一执行边界，任务未创建；请检查部署装配后重试。',
          );
        }
        await this.exoSessionService.assertAssignmentsAllowed(
          orgId,
          [
            {
              deviceId: body.deviceId.trim(),
              personId: body.assigneeId ?? null,
              label: `task:new(${body.title.trim().slice(0, 40)})`,
            },
          ],
          tx,
          'EXO_SESSION_ASSIGNMENT_CONFLICT',
        );
      }
      return tx
        .insert(ewohProductionTask)
        .values({
          title: body.title.trim(),
          taskType: body.taskType.trim(),
          priority: body.priority ?? 'medium',
          description: body.description ?? null,
          assigneeId: body.assigneeId ?? null,
          deviceId: body.deviceId ?? null,
          spatialEntityId: body.spatialEntityId ?? null,
          planStart: body.planStart ? new Date(body.planStart) : null,
          planEnd: body.planEnd ? new Date(body.planEnd) : null,
          status: 'draft',
          source: 'manual',
          orgId,
          ...(deviceReqs.names.length > 0 ? { requiredDeviceCapabilities: deviceReqs.names } : {}),
          ...(stationReqs.names.length > 0
            ? { requiredStationCapabilities: stationReqs.names }
            : {}),
        })
        .returning();
    });
    // 原则 8：影响派工资格的写路径必须留审计（含能力要求这一"为什么匹配不到"的依据）
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
      action: 'task.create',
      entityType: 'production_task',
      entityId: row.id,
      after: {
        status: row.status,
        requiredDeviceCapabilities: deviceReqs.names,
        requiredStationCapabilities: stationReqs.names,
      },
      metadata: { warnings: warnings.length > 0 ? warnings : undefined },
    });
    // A1：任务创建成功 → 通知调度桥（fire-and-forget，触发事件驱动重排）
    this.emitTaskEvent(row.id, 'TASK_CREATED', actor);
    return { ...row, capabilityWarnings: warnings };
  }

  /**
   * 变更任务的能力要求（能力模型的**唯一人工写入口**）。
   *
   * 为什么单列一个端点：能力要求决定该任务能被哪些资源承接，是执行边界的一部分；
   * 而此前两列只有种子/直连库能写。语义与设备能力生命周期一致：
   * 形状非法拒绝；未登记/当前无法匹配的名称**允许**但显式提示；变更留审计；
   * 成功后触发 TASK_UPDATED（事件驱动重排把新要求纳入下一次求解）。
   */
  async updateTaskRequirements(
    id: string,
    body: {
      requiredDeviceCapabilities?: string[];
      requiredStationCapabilities?: string[];
      /** 高风险放宽时必须携带：已获批的审批实例 id（见下方闸门说明）。 */
      approvalId?: string;
    },
    actor?: OrgContext,
  ): Promise<TaskCapabilityRequirementsResult> {
    const existing = await this.getTask(id, actor);
    const orgCond = this.orgCondition(actor);
    const deviceReqs = normalizeCapabilityList(body?.requiredDeviceCapabilities, '设备能力要求');
    const stationReqs = normalizeCapabilityList(body?.requiredStationCapabilities, '工位能力要求');
    const errors = [...deviceReqs.errors, ...stationReqs.errors];
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    const orgId = (existing as { orgId?: string | null }).orgId ?? actor?.primaryOrgId ?? '';

    // ---- NO-20a：高风险能力"放宽"必须经安全管理员审批（原则 4/6）----
    // 去掉高风险要求（crane / exo-lift / interact.assist）会放宽"谁可以承接该任务"，
    // 属执行边界变更：调度员不得单独决定。新增高风险要求是收紧，不需要审批。
    const previousDevice = Array.isArray(
      (existing as { requiredDeviceCapabilities?: unknown }).requiredDeviceCapabilities,
    )
      ? ((existing as { requiredDeviceCapabilities: unknown[] }).requiredDeviceCapabilities).map(String)
      : [];
    const relaxedHighRisk = highRiskCapabilitiesBeingRelaxed(
      previousDevice,
      deviceReqs.names,
      isHighRiskCapability,
    );
    let approvedBy: string | null = null;
    /** NO-22a：审批通过/有效期留痕（事后对账这次放宽是否在时效内）。 */
    let approvedAtForAudit: string | null = null;
    let approvalExpiresAtForAudit: string | null = null;
    if (relaxedHighRisk.length > 0) {
      const approvalId = (body?.approvalId ?? '').trim();
      const approvalSubject = buildCapabilityRelaxationApprovalSubject({
        taskId: id,
        taskTitle: (existing as { title?: string | null }).title ?? null,
        relaxedHighRisk,
        resultingDeviceCapabilities: deviceReqs.names,
        resultingStationCapabilities: stationReqs.names,
      });
      if (!approvalId) {
        throw new ConflictException(
          `HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL：放宽高风险能力（${relaxedHighRisk.join('、')}）` +
            '需安全管理员审批，调度员不得单独决定。请先创建审批：POST /api/approvals ' +
            `{entityType:'${CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE}', entityId:'${id}', subject:` +
            `${JSON.stringify(approvalSubject)}}，获批后带 approvalId 重新提交本次变更。`,
        );
      }
      if (!this.approvalService) {
        // 与 dashboard 一致：装配缺失不得伪装成"审批无效"。
        throw new ServiceUnavailableException(
          'APPROVAL_PORT_UNAVAILABLE：本实例未装配审批服务，无法校验高风险能力放宽审批' +
            '（既不静默放行，也不谎报审批不存在），请检查部署装配后重试。',
        );
      }
      const approval = await this.approvalService
        .getApproval(approvalId, actor)
        .catch(() => null);
      const verification = verifyCapabilityRelaxationApproval(
        approval
          ? {
              status: approval.status,
              steps: approval.steps,
              approvedAt: approval.approvedAt ?? null,
              evidence: {
                entityType: approval.entityType,
                entityId: approval.entityId,
                subject: approval.subject,
              },
            }
          : null,
        {
          taskId: id,
          relaxedHighRisk,
          resultingDeviceCapabilities: deviceReqs.names,
          resultingStationCapabilities: stationReqs.names,
        },
      );
      if (!verification.ok) {
        throw new ConflictException(
          `APPROVAL_INVALID：${verification.reason ?? '审批校验未通过'}` +
            '（放行条件：审批已通过且在 24 小时有效期内、对象为本任务、变更指纹逐字一致、该审批未用于本任务）',
        );
      }
      approvedBy = approvalId;
      approvedAtForAudit = verification.approvedAt ?? null;
      approvalExpiresAtForAudit = verification.expiresAt ?? null;
    }

    const warnings = await this.capabilityRequirementWarnings(
      deviceReqs.names,
      stationReqs.names,
      orgId,
    );
    // NO-22a：授权消耗与任务写入同事务——写失败则消耗回滚（不会白烧一次授权）。
    const [row] = await this.db.transaction(async (tx) => {
      if (approvedBy && this.approvalService) {
        const claim = await this.approvalService.claimUsage(
          {
            approvalId: approvedBy,
            usageKey: buildTaskApprovalUsageKey(id),
            usedBy: (actor?.userId ?? '').trim() || 'system',
            note: relaxedHighRisk.length > 0 ? `放宽 ${relaxedHighRisk.join('、')}` : null,
            orgId: String(orgId ?? '') || null,
            entityType: 'task_capability_change',
            entityId: id,
            at: new Date(),
          },
          tx as unknown as PostgresJsDatabase,
        );
        if (!claim.claimed) {
          const used = claim.existing;
          throw new ConflictException(
            'APPROVAL_ALREADY_CONSUMED：该审批已用于本任务的这次放宽' +
              (used?.at ? `（${used.at}` : '（时间未记录') +
              (used?.usedBy ? ` 由 ${used.usedBy}` : '') +
              '）。若需再次放宽请重新申请审批。',
          );
        }
      }
      return tx
        .update(ewohProductionTask)
        .set({
          requiredDeviceCapabilities: deviceReqs.names,
          requiredStationCapabilities: stationReqs.names,
        })
        .where(orgCond ? and(eq(ewohProductionTask.id, id), orgCond) : eq(ewohProductionTask.id, id))
        .returning();
    });
    if (!row) throw new NotFoundException(`Task ${id} not found`);

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: String(orgId ?? ''),
      action: 'task.requirements.update',
      entityType: 'production_task',
      entityId: row.id,
      before: {
        requiredDeviceCapabilities: (existing as { requiredDeviceCapabilities?: unknown })
          .requiredDeviceCapabilities ?? [],
        requiredStationCapabilities: (existing as { requiredStationCapabilities?: unknown })
          .requiredStationCapabilities ?? [],
      },
      after: {
        requiredDeviceCapabilities: deviceReqs.names,
        requiredStationCapabilities: stationReqs.names,
      },
      metadata: {
        warnings: warnings.length > 0 ? warnings : undefined,
        // 高风险放宽留痕：这次放宽是谁批的、批于何时、有效期到何时（可对账）
        approvalId: approvedBy ?? undefined,
        approvalApprovedAt: approvedAtForAudit ?? undefined,
        approvalExpiresAt: approvalExpiresAtForAudit ?? undefined,
        relaxedHighRiskCapabilities: relaxedHighRisk.length > 0 ? relaxedHighRisk : undefined,
      },
    });
    // 能力要求变化 → 触发重排（旧方案是按旧要求算出来的）
    this.emitTaskEvent(row.id, 'TASK_UPDATED', actor);

    return {
      taskId: row.id,
      requiredDeviceCapabilities: deviceReqs.names,
      requiredStationCapabilities: stationReqs.names,
      warnings,
      ...(approvedBy
        ? { approvalId: approvedBy, relaxedHighRiskCapabilities: relaxedHighRisk }
        : {}),
    };
  }

  /**
   * "当前无法匹配"提示：设备能力看词表登记；工位能力看本租户工位实际声明过的能力
   * （工位能力取自空间实体类型，没有固定词表，如实按现状核对而不是猜）。
   */
  private async capabilityRequirementWarnings(
    deviceNames: readonly string[],
    stationNames: readonly string[],
    orgId: string,
  ): Promise<string[]> {
    const warnings = describeDeviceCapabilityWarnings(
      deviceNames,
      isRegisteredCapability,
      DEVICE_CAPABILITY_NAMES,
    ).map((w) => w.message);
    if (stationNames.length > 0) {
      const rows = await this.db
        .selectDistinct({ entityType: ewohSpatialEntity.entityType })
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.orgId, orgId),
            inArray(ewohSpatialEntity.entityType, ['workstation', 'station']),
          ),
        );
      const observed = new Set(rows.map((r) => String(r.entityType)));
      warnings.push(
        ...describeCapabilityWarnings(
          stationNames,
          (name) => observed.has(name),
          '工位能力要求',
        ).map((w) => w.message),
      );
    }
    return warnings;
  }

  async transitionTaskState(id: string, action: string, actor?: OrgContext) {
    const task = await this.getTask(id, actor);
    const status = nextTaskStatus(task.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${task.status}`,
      );
    }
    const before = task.status;
    // R2-SNZ-015：写谓词补 orgId 列（与 quality/workorder 对齐的纵深防御；
    // global_admin 放行，与读侧 orgCondition 语义一致）。
    const transitionOrgCond = actor?.isGlobalAdmin
      ? undefined
      : eq(ewohProductionTask.orgId, actor?.primaryOrgId?.trim() ?? '__none__');
    const [row] = await this.db
      .update(ewohProductionTask)
      .set({ status })
      .where(
        transitionOrgCond
          ? and(
              eq(ewohProductionTask.id, id),
              eq(ewohProductionTask.status, before),
              transitionOrgCond,
            )
          : and(eq(ewohProductionTask.id, id), eq(ewohProductionTask.status, before)),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `task.${action}`,
      entityType: 'production_task',
      entityId: row.id,
      before: { status: before },
      after: { status: row.status },
    });
    // A1：任务状态变更成功 → 通知调度桥（TASK_UPDATED，触发事件驱动重排）
    this.emitTaskEvent(row.id, 'TASK_UPDATED', actor);
    return row;
  }
}
