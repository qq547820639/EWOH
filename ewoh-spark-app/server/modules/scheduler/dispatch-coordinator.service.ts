import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
  ewohProductionTask,
  ewohAssignmentEvent,
  ewohDevice,
} from '@server/database/schema';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DispatchCoordinatorResult } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { ResourceReservationService, type ReservationInput } from './resource-reservation.service';
import {
  projectDispatchDecision,
  projectResourceReservationDecision,
} from './decision-projection';
import { appendPlanDecisionRecords } from './decision-ledger';
import type { DecisionRecord } from '@shared/decision';
import { OutboxService } from './outbox.service';
import { TaskService } from '../task/task.service';
import {
  TaskLifecycle,
  TASK_PRE_DISPATCH_STATUS,
  requiresPreDispatchNormalization,
} from './task-lifecycle';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { TravelCostService } from './travel-cost.service';
import {
  activeSessionFactsFromDevices,
  describeExoAssignmentConflict,
  findExoAssignmentConflicts,
} from '../exo/exo-assignment-guard';

/** 事务化的执行闭环：校验 → 预占 → 下发 → 审计 → 出站事件。 */
@Injectable()
export class DispatchCoordinatorService {
  private readonly logger = new Logger(DispatchCoordinatorService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly reservationService: ResourceReservationService,
    private readonly outboxService: OutboxService,
    private readonly auditService: AuditService,
    private readonly taskService: TaskService,
    // T02 / P0-1（G1）：观测基线反馈（必选；生产路径始终注入）。
    private readonly feedbackService: SchedulingFeedbackService,
    // P1-SCHED-004：统一默认任务时长来源（必选；Solver/Plan/Reservation/Dispatch 共享同一策略）。
    private readonly policyService: SchedulingPolicyService,
    // §5.4 ADVISORY 模式：safety-critical 降级路线阻断判定（必选；scheduler.module 已注册）。
    private readonly travelCostService: TravelCostService,
  ) {}

  /**
   * NO-36a：断言这批 assignment 不与"佩戴中"事实冲突（冲突 → 409，fail-closed）。
   *
   * 规则实现只有一处（`exo-assignment-guard.findExoAssignmentConflicts`），此处
   * 只负责把世界状态设备项适配成会话事实并抛出可读错误。
   */
  private async assertNoExoSessionConflict(
    assignments: Array<{ deviceId: string; personId: string | null; label: string }>,
    devices: readonly {
      id?: string | null;
      deviceId?: string | null;
      activeExoSession?: { sessionId?: string | null; personId?: string | null } | null;
    }[],
    errorCode: string,
    suffix = '',
  ): Promise<void> {
    const withDevice = assignments.filter((a) => a.deviceId);
    if (withDevice.length === 0) return;
    const facts = activeSessionFactsFromDevices(devices);
    if (facts.length === 0) return;
    const conflicts = findExoAssignmentConflicts(withDevice, facts);
    if (conflicts.length === 0) return;
    const head = conflicts.slice(0, 3).map(describeExoAssignmentConflict);
    const more =
      conflicts.length > head.length ? `（另有 ${conflicts.length - head.length} 项同类冲突）` : '';
    throw new ConflictException(`${errorCode}：${head.join('；')}${more}${suffix}`);
  }

  /**
   * P1-SCHED-004：统一默认任务时长来源（SchedulingPolicyConfig.defaultTaskDurationMs）。
   * Solver / Plan / Reservation / Dispatch 共享同一值，禁止各层硬编码不同默认。
   */
  private async resolveDefaultDurationMs(): Promise<number> {
    try {
      const config = await this.policyService.getConfig();
      const configured = config?.defaultTaskDurationMs;
      if (typeof configured === 'number' && configured > 0) {
        return configured;
      }
    } catch (err) {
      this.logger.warn(
        `policy default duration unavailable, using 30min fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 1_800_000; // 与 SchedulingPolicyService 默认一致（30 分钟）
  }

  /**
   * 原子下发：所有 DB 写入在单个事务内完成，任一步失败整体回滚。
   * 步骤 2 的快照新鲜度校验在事务之前执行。
   */
  /**
   * 派工（支持**分波次 / 部分执行**）。
   *
   * `wave.assignmentIds`：
   *  - 省略/空 → 派发全部待派工 assignment（原有行为，向后兼容）；
   *  - 提供 → 只派发这些 assignment（"一波"）。
   *
   * 语义（借 Timefold 的 pinning 思想：已派工 = 已确认发布，重排不得移动）：
   *  1. **波内全有或全无**：波内任一 assignment 不满足前置条件即拒绝整波，
   *     绝不半应用（避免"部分预占"这种无法解释的中间态）。
   *  2. 计划状态仅在**本波覆盖全部待派工 assignment**时才 CAS 到 `dispatched`
   *     （契约终态，语义是"全部转任务"）；否则保持 `approved`。
   *     把部分派工写成 `dispatched` 会让半成品方案看起来已终结——正是
   *     "不得把缺失伪造成确定事实"要禁止的。
   *  3. 已提交的波不因后续波失败而回滚；剩余范围显式回传，由调用方决定。
   */
  async dispatch(
    planId: string,
    ctx: OrgContext,
    wave?: { assignmentIds?: string[] },
  ): Promise<DispatchCoordinatorResult> {
    // NEST-008 修复（2026-08-17）：dispatch 初始 SELECT 补 org 条件（org 匹配
    // 或 NULL 存量）——事务前无 GUC 的裸读此前仅靠 RLS 兜底且存在时序缺口；
    // 跨租户 planId 直接 404（与"不存在"同语义，反枚举）。
    const orgCond = ctx.primaryOrgId
      ? or(
          isNull(ewohSchedulePlan.orgId),
          eq(ewohSchedulePlan.orgId, ctx.primaryOrgId),
        )
      : undefined;
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(
        orgCond
          ? and(eq(ewohSchedulePlan.planId, planId), orgCond)
          : eq(ewohSchedulePlan.planId, planId),
      )
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    if (plan.status !== 'approved') {
      throw new ConflictException('PLAN_NOT_APPROVED');
    }

    // 快照新鲜度校验（事务之前，NEST-101：透传 ctx 同 org 时间切片比较）。
    // 用**波次感知**版本：派工自身会改任务状态并写预占，严格相等判定会让第二波
    // 永远 PLAN_STALE（实测）。该版本仍会因**外部**变化而拒绝。
    await this.worldStateSnapshotService.assertFreshForWave(
      plan.snapshotVersion ?? '',
      planId,
      ctx,
    );

    // v0.7 Batch6.3 SAFETY_EVENT 派工熔断：方案基于最新世界状态时，
    // 若任何派工涉及被安全事件阻断（L2/L3 open）的人员/设备 → 拒绝下发。
    // 安全阻断不可被人工覆盖绕过（与求解器 SAFETY_BLOCK 硬约束同源语义）。
    // P0-7：同时从当前世界状态读取工位容量（station.capacity），供预占容量感知。
    // NEST-101：世界状态读取透传 ctx（org 过滤）。
    const currentWorld = await this.worldStateSnapshotService.getCurrentWorldState(ctx);
    // NEST-009（2026-08-17）：本次 dispatch 的固定基准时间——缺失 plannedStart
    // 的 assignment 统一使用同一 nowMs（此前逐 assignment 取 Date.now()，
    // 重试/慢事务下预占时间窗漂移）。
    const dispatchNowMs = Date.now();

    // 波次感知（自查修正 2026-09-13）：下方四个事务前 fail-fast 预检（安全熔断/
    // 外骨骼会话/ADVISORY 降级路由/工位容量）原按**全方案** approved 集合判定，
    // 而事务内的权威复查与实际预占只作用于**本波**。分波派工后全方案口径会让
    // "他波的冲突"挡住"本波的合法派工"（实测路径：波 2 的任务被安全阻断 → 波 1
    // 派工 409 SAFETY_BLOCK_DISPATCH；波 3 的工位窗与波 1 预占重叠 → 波 2 派工
    // 409 STATION_CAPACITY）。预检作用域收敛到本波：未指定波次时仍为全量
    // approved（整单派工行为不变）。波内全有或全无校验仍由事务内
    // DISPATCH_WAVE_INVALID 权威判定，预检不重复做。
    const waveScopeIds = wave?.assignmentIds?.length
      ? new Set(wave.assignmentIds)
      : null;
    const inWaveScope = (a: { assignmentId: string | null }): boolean =>
      !waveScopeIds || (a.assignmentId != null && waveScopeIds.has(a.assignmentId));

    const stationCapacityById = new Map<string, number>(
      (currentWorld.stations ?? []).map((s) => [s.id, s.capacity ?? 1]),
    );
    {
      const blockedPersons = new Set(currentWorld.safetyBlockedPersonIds ?? []);
      const blockedDevices = new Set(currentWorld.safetyBlockedDeviceIds ?? []);
      if (blockedPersons.size > 0 || blockedDevices.size > 0) {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.planId, planId),
              eq(ewohSchedulingPlanAssignment.status, 'approved'),
            ),
          );
        const blocked = assignments
          .filter(inWaveScope)
          .filter(
            (a) =>
              (a.personId && blockedPersons.has(a.personId)) ||
              (a.deviceId && blockedDevices.has(a.deviceId)),
          );
        if (blocked.length > 0) {
          throw new ConflictException(
            `SAFETY_BLOCK_DISPATCH: ${blocked.length} assignment(s) reference safety-blocked resources`,
          );
        }
      }
    }

    // NO-36a：外骨骼会话是**执行边界**，不是"生成时看一眼"的提示。
    // 方案从生成→审批→下发之间可能隔了很久（实测审批流程以分钟计），期间有人先戴上
    // 那台外骨骼、或佩戴者易主，物理事实已经变了。事务前先 fail-fast 一次，给出
    // 明确错误（不浪费一次事务）；事务内还会用最新世界状态再复查一次（见下）。
    // 无租户上下文的系统路径（GUC/RLS 兜底）不做会话判定——与其它 org 条件同口径。
    {
      const assignments = await this.db
        .select()
        .from(ewohSchedulingPlanAssignment)
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.planId, planId),
            eq(ewohSchedulingPlanAssignment.status, 'approved'),
          ),
        );
      await this.assertNoExoSessionConflict(
        assignments
          .filter(inWaveScope)
          .map((a) => ({
            deviceId: a.deviceId ?? '',
            personId: a.personId ?? null,
            label: `assignment:${a.assignmentId}`,
          })),
        currentWorld.devices ?? [],
        'EXO_SESSION_DISPATCH_CONFLICT',
      );
    }

    // §5.4 ADVISORY 模式 fail-closed：euclidean 降级仅参考，safety-critical 任务
    // 不得自动 dispatch 降级路径（route graph 不可达 → 拒绝派工，非安全任务正常放行）。
    // 与 SAFETY_BLOCK 同级位于事务之外，fail-fast 且异常即整体失败（无部分提交）。
    {
      const config = await this.policyService.getConfig();
      if (config.routeCostMode === 'ADVISORY') {
        const assignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(
            and(
              eq(ewohSchedulingPlanAssignment.planId, planId),
              eq(ewohSchedulingPlanAssignment.status, 'approved'),
            ),
          );
        for (const a of assignments.filter(inWaveScope)) {
          if (!a.taskId || !a.personId) continue;
          const [task] = await this.db
            .select({ safetyCritical: ewohProductionTask.safetyCritical })
            .from(ewohProductionTask)
            .where(eq(ewohProductionTask.id, a.taskId))
            .limit(1);
          if (!task || !task.safetyCritical) continue;
          // R-6（2026-09-13）：透传本方案租户 ctx.primaryOrgId——路由图按租户
          // 分桶缓存（此前不传 → loadGraph 读穿不缓存 → 逐 assignment 全图 SELECT）。
          const cost = await this.travelCostService.estimate(
            a.personId,
            a.taskId,
            undefined,
            undefined,
            { orgId: ctx.primaryOrgId ?? null },
          );
          if (cost.source === 'euclidean_fallback') {
            throw new ConflictException(
              `SAFETY_CRITICAL_DEGRADED_ROUTE: task=${a.taskId} has degraded route under ADVISORY mode`,
            );
          }
        }
      }
    }

    // P1-SCHED-004：统一默认时长（与 Solver/Policy 一致），仅在 assignment 缺失
    // plannedEnd 时作为兜底，避免 1h 硬编码与 solver 30min 不一致。
    const fallbackDurationMs = await this.resolveDefaultDurationMs();

    // P0-7：下发前 station 容量预检（fail-fast，与求解器/预占容量语义一致）。
    {
      const assignments = await this.db
        .select()
        .from(ewohSchedulingPlanAssignment)
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.planId, planId),
            eq(ewohSchedulingPlanAssignment.status, 'approved'),
          ),
        );
      const stationInputs: ReservationInput[] = [];
      for (const a of assignments.filter(inWaveScope)) {
        if (!a.stationId) continue;
        const startMs = a.plannedStart ? a.plannedStart.getTime() : dispatchNowMs;
        const endMs = a.plannedEnd
          ? a.plannedEnd.getTime()
          : startMs + fallbackDurationMs;
        stationInputs.push({
          resourceType: 'station',
          resourceId: a.stationId,
          startMs,
          endMs,
          capacity: stationCapacityById.get(a.stationId) ?? 1,
        });
      }
      if (stationInputs.length > 0) {
        await this.reservationService.assertStationCapacityAvailable(
          stationInputs,
          ctx,
        );
      }
    }

    const outboxEventIds: string[] = [];
    const taskIds: string[] = [];
    let assignmentCount = 0;
    /** 本波之外仍未派工的 assignment（部分执行时非空）。 */
    let waveRemaining: Array<{ assignmentId: string }> = [];
    /** 本波实际派工的 assignment ID（可追溯本波范围）。 */
    let assignmentsDispatched: string[] = [];

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        // 取本方案全部 assignment 后在代码里**显式**分区，而不是依赖
        // `status='approved'` 这一复合 SQL 谓词来决定波次边界。
        // 理由：波次边界是正确性关键判定（决定哪些资源被预占、计划是否进终态），
        // 放在显式分支里既可读、可测，也不受 SQL 谓词构造方式影响。
        const planAssignments = await this.db
          .select()
          .from(ewohSchedulingPlanAssignment)
          .where(eq(ewohSchedulingPlanAssignment.planId, planId));
        const proposed = planAssignments.filter((a) => a.status === 'approved');
        // 波次选择（波内全有或全无）：请求的 ID 必须都还在 approved 待派工集合里。
        const requested = wave?.assignmentIds?.length ? new Set(wave.assignmentIds) : null;
        let assignments = proposed;
        if (requested) {
          const byId = new Map(proposed.map((a) => [a.assignmentId, a]));
          const unknown = [...requested].filter((id) => !byId.has(id));
          if (unknown.length > 0) {
            // 不做部分应用：明确列出不可派工项，让调用方修正后重试。
            throw new ConflictException(
              `DISPATCH_WAVE_INVALID: ${unknown.length} assignment(s) 不在本方案待派工集合内`
              + `（可能已派工、属于他方案或不存在）：${unknown.slice(0, 5).join(', ')}`,
            );
          }
          assignments = [...requested].map((id) => byId.get(id)!);
          if (assignments.length === 0) {
            throw new ConflictException('DISPATCH_WAVE_EMPTY: 请求的波次为空');
          }
        }
        const dispatchedIds = new Set(assignments.map((a) => a.assignmentId));
        const remaining = proposed.filter((a) => !dispatchedIds.has(a.assignmentId));
        waveRemaining = remaining;
        assignmentsDispatched = [...dispatchedIds];
        assignmentCount = assignments.length;

        // R2-SSV-14（2026-08-17）：事务内复查安全阻断事实——安全阻断集合与
        // 快照新鲜度此前均在事务前读取（TOCTOU：预检与提交之间发生
        // SAFETY_EVENT/快照过期时派工仍会提交，SAFETY_BLOCK_DISPATCH 被绕过）。
        // 事务内以最新世界状态复查关键事实，安全熔断与提交同一串行化域。
        {
          const txWorld =
            await this.worldStateSnapshotService.getCurrentWorldState(ctx);
          const txBlockedPersons = new Set(txWorld.safetyBlockedPersonIds ?? []);
          const txBlockedDevices = new Set(txWorld.safetyBlockedDeviceIds ?? []);
          if (txBlockedPersons.size > 0 || txBlockedDevices.size > 0) {
            const blockedTx = assignments.filter(
              (a) =>
                (a.personId && txBlockedPersons.has(a.personId)) ||
                (a.deviceId && txBlockedDevices.has(a.deviceId)),
            );
            if (blockedTx.length > 0) {
              throw new ConflictException(
                `SAFETY_BLOCK_DISPATCH_TX: ${blockedTx.length} assignment(s) reference safety-blocked resources (in-transaction recheck)`,
              );
            }
          }
          // 事务内复查同样必须用**波次感知**版本：本方案的上一波已改任务状态并
          // 写入预占，严格相等判定会让第二波在此处再次 PLAN_STALE（实测定位）。
          await this.worldStateSnapshotService.assertFreshForWave(
            plan.snapshotVersion ?? '',
            planId,
            ctx,
          );
          // NO-39a：先锁住本波涉及的设备行（`FOR UPDATE`），与"开始外骨骼会话"
          // 事务互斥——否则两端各读到"对方还没写"的旧状态时，会同时提交出
          // "任务已下发给 A" + "B 正在佩戴该设备"这种物理上不可能的状态。
          // 排序后加锁：多设备时避免两个派工事务互相等待（死锁）。
          {
            const deviceUuids = [
              ...new Set(
                assignments
                  .map((a) => (a.deviceId ?? '').trim())
                  .filter((id) => id !== ''),
              ),
            ].sort();
            if (deviceUuids.length > 0) {
              await this.db
                .select({ id: ewohDevice.id })
                .from(ewohDevice)
                .where(inArray(ewohDevice.id, deviceUuids))
                .orderBy(ewohDevice.id)
                .for('update');
            }
          }

          // NO-36a：事务内复查外骨骼会话事实（TOCTOU + 提交时刻权威判定）。
          // 与上面的安全阻断复查同一理由：预检与提交之间可能有人戴上设备。
          // 事务回滚保证"要么整波下发，要么一条都不下发"（无半成品方案）。
          await this.assertNoExoSessionConflict(
            assignments.map((a) => ({
              deviceId: a.deviceId ?? '',
              personId: a.personId ?? null,
              label: `assignment:${a.assignmentId}`,
            })),
            txWorld.devices ?? [],
            'EXO_SESSION_DISPATCH_CONFLICT_TX',
            '（提交时刻复查：世界状态在审批/预检之后发生了变化）',
          );
        }

        // 4. 预检任务可下发性（遵循 TaskService 状态机语义）。
        //
        // 2026-09-13（golden path 实测缺陷）：此前这里对第一条不可下发的任务直接抛
        // 裸 `ConflictException('PLAN_TASK_NOT_DISPATCHABLE')` —— 用户只看到一个错误码，
        // 不知道**是哪条任务、处于什么状态、该做什么**；而一条这样的任务会让**整波**
        // 派工失败（实测：15 条 assignment 的波次被 1 条 `draft` 任务全部挡下）。
        // 这不是放宽闸门（拒绝仍 fail-closed —— 契约 task.yaml 规定
        // draft → pending_confirm → pending_approval → pending_dispatch 必须由
        // creator/dispatcher/approver 逐步推进，不得由派工默认跳过），
        // 而是把"为什么不能派"如实说清：按仓库既有约定输出 `CODE: 明细`
        // （同 POLICY_GATE_INSUFFICIENT_EVIDENCE），并保留原错误码前缀，
        // 使既有的按码匹配（前端/脚本）不受影响。
        const taskByAssignmentId = new Map<
          string,
          typeof ewohProductionTask.$inferSelect
        >();
        const blockedTasks: Array<{ taskId: string; status: string }> = [];
        for (const a of assignments) {
          if (!a.taskId) continue;
          const [task] = await this.db
            .select()
            .from(ewohProductionTask)
            .where(eq(ewohProductionTask.id, a.taskId))
            .limit(1);
          if (!task) {
            throw new NotFoundException(`Task ${a.taskId} not found`);
          }
          if (!TaskLifecycle.isDispatchable(task.status)) {
            blockedTasks.push({ taskId: String(a.taskId), status: String(task.status) });
            continue;
          }
          taskByAssignmentId.set(a.assignmentId, task);
        }
        if (blockedTasks.length > 0) {
          const detail = blockedTasks
            .map((t) => `${t.taskId}(${t.status} → 需先推进到 ${TASK_PRE_DISPATCH_STATUS})`)
            .join('; ');
          throw new ConflictException(
            `PLAN_TASK_NOT_DISPATCHABLE: ${blockedTasks.length}/${assignments.length} 条任务`
              + `未处于可派发状态，整波未下发（无半成品方案）——${detail}`,
          );
        }

        // 5. CAS 更新方案状态（double-dispatch 守卫）。
        // 分波次语义：只有本波覆盖全部待派工 assignment 时才进入契约终态
        // `dispatched`；否则保持 `approved`（方案尚未全部转任务）。
        if (remaining.length === 0) {
          const updated = await this.db
            .update(ewohSchedulePlan)
            .set({ status: 'dispatched' })
            .where(
              and(
                eq(ewohSchedulePlan.planId, planId),
                eq(ewohSchedulePlan.status, 'approved'),
              ),
            )
            .returning();
          if (updated.length === 0) {
            throw new ConflictException('PLAN_CONCURRENT_DISPATCH');
          }
        } else {
          // 部分派工：不改计划状态，但必须以 CAS 确认方案仍是 approved——
          // 并发场景下方案可能已被他人整单派工或取消，此时本波不应继续。
          const stillApproved = await this.db
            .update(ewohSchedulePlan)
            .set({ status: 'approved' })
            .where(
              and(
                eq(ewohSchedulePlan.planId, planId),
                eq(ewohSchedulePlan.status, 'approved'),
              ),
            )
            .returning();
          if (stillApproved.length === 0) {
            throw new ConflictException('PLAN_CONCURRENT_DISPATCH');
          }
        }

        // 6. 预占资源（person + device + station）。
        // NO-13k / ADR-060：收集真实预占结果（台账事实），事务末统一
        // 追加 resource_reservation 决策记录（§12 Decision History）。
        const reservationDecisions: Array<{
          assignment: typeof ewohSchedulingPlanAssignment.$inferSelect;
          results: Awaited<ReturnType<ResourceReservationService['reserve']>>;
        }> = [];
        for (const a of assignments) {
          const startMs = a.plannedStart
            ? a.plannedStart.getTime()
            : dispatchNowMs;
          const endMs = a.plannedEnd
            ? a.plannedEnd.getTime()
            : startMs + fallbackDurationMs;
          const inputs: ReservationInput[] = [];
          if (a.personId) {
            inputs.push({
              resourceType: 'person',
              resourceId: a.personId,
              startMs,
              endMs,
            });
          }
          if (a.deviceId) {
            inputs.push({
              resourceType: 'device',
              resourceId: a.deviceId,
              startMs,
              endMs,
            });
          }
          if (a.stationId) {
            inputs.push({
              resourceType: 'station',
              resourceId: a.stationId,
              startMs,
              endMs,
              // P0-7：容量感知预占（station 允许多个重叠任务，count < capacity）。
              capacity: stationCapacityById.get(a.stationId) ?? 1,
            });
          }
          if (inputs.length > 0) {
            const results = await this.reservationService.reserve(
              planId,
              a.assignmentId,
              a.taskId ?? null,
              inputs,
              ctx,
            );
            reservationDecisions.push({ assignment: a, results });
          }
        }

        // 7. 更新任务（assignee/device/version），pending_dispatch → dispatched。
        for (const a of assignments) {
          if (!a.taskId) continue;
          const task = taskByAssignmentId.get(a.assignmentId);
          if (!task) continue;
          await this.db
            .update(ewohProductionTask)
            .set({
              assigneeId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
              version: (task.version ?? 1) + 1,
            })
            .where(eq(ewohProductionTask.id, a.taskId));

          if (TaskLifecycle.isPreDispatch(task.status)) {
            // 存量归一化（2026-09-10）：契约外历史状态 pending/queued 不在
            // task.yaml 状态机里，'dispatch' 动作没有对应边，直接调
            // transitionTaskState 会抛 "Transition dispatch not allowed"。
            // 先把任务收敛到契约状态 pending_dispatch，再走状态机；否则
            // 方案会被标记 dispatched 而任务永远停在 pending（plan 与 task
            // 状态分叉，且无人知道为什么）。归一化必然可观测。
            if (requiresPreDispatchNormalization(task.status)) {
              this.logger.warn(
                `任务 ${a.taskId} 处于契约外历史状态 '${task.status}'，派发前归一化为 `
                  + `'${TASK_PRE_DISPATCH_STATUS}'（contracts/state-machines/task.yaml）`,
              );
              await this.db
                .update(ewohProductionTask)
                .set({ status: TASK_PRE_DISPATCH_STATUS })
                .where(
                  and(
                    eq(ewohProductionTask.id, a.taskId),
                    eq(ewohProductionTask.status, task.status),
                  ),
                );
            }
            await this.taskService.transitionTaskState(a.taskId, 'dispatch', ctx);
          }
        }

        // 8. 更新分配状态。
        for (const a of assignments) {
          await this.db
            .update(ewohSchedulingPlanAssignment)
            .set({ status: 'dispatched' })
            .where(eq(ewohSchedulingPlanAssignment.assignmentId, a.assignmentId));
        }

        // 9. 写入分配事件。
        for (const a of assignments) {
          await this.db.insert(ewohAssignmentEvent).values({
            // NEST-047（2026-08-17）：Date.now()+短随机后缀 → randomUUID。
            eventId: `EVT-${randomUUID()}`,
            assignmentId: a.assignmentId,
            taskId: a.taskId ?? null,
            personId: a.personId ?? null,
            deviceId: a.deviceId ?? null,
            fromStatus: 'approved',
            toStatus: 'dispatched',
            actor: ctx.userId,
            reason: 'plan dispatched',
          });
        }

        // 10. 审计。
        await this.auditService.appendAuditLog({
          actorId: ctx.userId,
          orgId: ctx.primaryOrgId,
          action: 'scheduler.plan.dispatch',
          entityType: 'schedule_plan',
          entityId: planId,
          before: { status: plan.status },
          after: { status: 'dispatched', assignments: assignments.length },
        });

        // 11. 出站事件。
        for (const a of assignments) {
          const evt = await this.outboxService.enqueue(
            'assignment.dispatched',
            a.assignmentId,
            {
              planId,
              taskId: a.taskId ?? null,
              personId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
            },
            ctx.primaryOrgId,
          );
          outboxEventIds.push(evt.id);
          if (a.taskId) taskIds.push(a.taskId);
        }
        const planEvt = await this.outboxService.enqueue(
          'plan.dispatched',
          planId,
          { planId, assignments: assignments.length },
          ctx.primaryOrgId,
        );
        outboxEventIds.push(planEvt.id);

        // 12. NO-13k/NO-13l（ADR-060/061）：预占（kind #4）+ 派工（kind #5）
        // 决策记录单次读-追加-回写进方案决策台账（与派工同事务原子；
        // 投影缺口/追加失败 log 显式绝不阻断派工主流程，§2/§33）。
        try {
          const projected = this.projectReservationDecisionRecords(
            planId,
            reservationDecisions,
            ctx,
          );
          const dispatchProjection = projectDispatchDecision({
            planId,
            assignmentRiskLevels: assignments.map((a) => a.riskLevel ?? null),
            dispatchCount: assignmentCount,
            outboxEventIds,
            orgId: ctx.primaryOrgId ?? '',
            operator: ctx.userId ?? null,
            now: new Date(),
          });
          const issues = [...projected.issues];
          if (dispatchProjection.record) {
            projected.records.push(dispatchProjection.record);
          }
          issues.push(...dispatchProjection.issues);
          if (issues.length > 0) {
            this.logger.warn(
              `派工决策投影缺口（显式跳过，§33）：${issues.join(',')}`,
            );
          }
          await this.appendDecisionRecords(planId, projected.records, ctx.primaryOrgId || null);
        } catch (err) {
          this.logger.warn(
            `派工决策台账追加失败（不阻断派工主流程）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    // 观测型：记录 planned 基线反馈。失败不影响下发（仅记录日志）。
    try {
      await this.feedbackService.recordBaseline(planId, undefined, ctx);
    } catch (err) {
      this.logger.warn(
        `scheduling feedback baseline skipped for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const dispatchedIds = assignmentsDispatched;
    return {
      planId,
      dispatchedAt: new Date().toISOString(),
      dispatchedAssignments: assignmentCount,
      reservedAssignments: assignmentCount,
      taskIds,
      outboxEventIds,
      // 分波次可观测性：剩余非空即"部分执行"，调用方/UI 必须显式呈现，
      // 不能只看 planId 就认为方案已全部转任务。
      planStatus: waveRemaining.length === 0 ? 'dispatched' : 'approved',
      dispatchedAssignmentIds: dispatchedIds,
      remainingAssignmentIds: waveRemaining.map((a) => a.assignmentId),
      remainingAssignments: waveRemaining.length,
    };
  }

  /**
   * NO-13k / ADR-060：预占结果 → resource_reservation 决策记录（契约门内；
   * 缺口显式计数，§33 绝不静默丢弃/伪造）。
   */
  private projectReservationDecisionRecords(
    planId: string,
    entries: Array<{
      assignment: typeof ewohSchedulingPlanAssignment.$inferSelect;
      results: Awaited<ReturnType<ResourceReservationService['reserve']>>;
    }>,
    ctx: OrgContext,
  ): { records: DecisionRecord[]; issues: string[] } {
    const records: DecisionRecord[] = [];
    const issues: string[] = [];
    const now = new Date();
    for (const entry of entries) {
      for (const reservation of entry.results) {
        const projected = projectResourceReservationDecision({
          planId,
          assignmentId: entry.assignment.assignmentId,
          taskId: entry.assignment.taskId ?? null,
          reservation,
          assignmentRiskLevel: entry.assignment.riskLevel ?? null,
          orgId: ctx.primaryOrgId ?? '',
          operator: ctx.userId ?? null,
          now,
        });
        if (projected.record) {
          records.push(projected.record);
        }
        for (const reason of projected.issues) {
          issues.push(`${entry.assignment.assignmentId}:${reason}`);
        }
      }
    }
    return { records, issues };
  }

  /**
   * NO-13k/NO-13l（ADR-060/061）：决策记录追加 decision_records_json
   * （ADR-062 决策 2 §31 单一实现；与派工同事务原子；无 CAS——本事务内
   * double-dispatch 已由 PLAN_CONCURRENT_DISPATCH 守卫）。
   */
  private async appendDecisionRecords(
    planId: string,
    records: DecisionRecord[],
    orgId?: string | null,
  ): Promise<void> {
    // NEST-024：决策台账追加携带 org 条件（跨租户 planId 不再被追加）。
    await appendPlanDecisionRecords(this.db, planId, records, orgId ?? null);
  }
}