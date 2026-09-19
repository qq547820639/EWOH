import { TASK_LOCKED_STATUSES } from './task-lifecycle';
import { Injectable, Inject, Logger, ConflictException, Optional } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohProductionTask,
  ewohSpatialEntity,
  ewohEvent,
  ewohRouteNode,
  ewohRouteEdge,
  ewohWorldStateSnapshot,
  ewohShift,
  ewohResourceReservation,
  ewohSchedulingPlanAssignment,
  ewohDeviceBinding,
} from '@server/database/schema';
import { eq, and, or, sql, isNull, gte, desc, type AnyColumn, type SQL } from 'drizzle-orm';
import { validateCloudWorldSnapshot } from '@shared/world-contract';
import { isEventSeverityRisky } from '@shared/risk';
import type {
  SchedulingEventImpact,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ResourceProjectionService } from './resource-projection.service';
import { MaterialsService } from '../materials/materials.service';
import {
  projectDeviceCapabilities,
  projectPersonCapabilities,
  projectStationCapabilities,
} from './capability-projection';

/** 世界状态快照服务：构建/持久化/新鲜度校验。 */
@Injectable()
export class WorldStateSnapshotService {
  private readonly logger = new Logger(WorldStateSnapshotService.name);

  /**
   * NEST-123（2026-08-17）：锁定/排除重排的任务状态集合——只认契约状态
   * （contracts/state-machines/task.yaml：executing/dispatched），
   * 剔除非契约的 'in_progress'（task.yaml 无此状态，属历史拼写漂移）。
   */
  private static readonly LOCKED_TASK_STATUSES: ReadonlySet<string> = new Set(
    TASK_LOCKED_STATUSES,
  );

  /**
   * 快照事件采集窗口（2026-08-19 平台加载故障）：模拟器持续生成告警而无人
   * 处理时 open 事件无限累积（实测 36h 达 6.3 万条），collectState 全量拉取
   * + eventImpacts（事件×任务嵌套传播）+ 大 JSON 序列化会把 Node 事件循环
   * 阻塞数十秒——conflicts 接口实测 104s，前端 15s 超时 → 指挥地图/调度生成/
   * 全平台加载失败。三层防御：
   * ① RetentionService 自动过期模拟 open 事件（2h，治本）；
   * ② SimulatorService 去重窗口 30s→120s（降生成速率）；
   * ③ 本查询时间窗 + 限量（纵深防御——即使前两层失效，快照构建也有界）。
   * 语义：安全封锁/事件影响只看近 24h 且最新 500 条 open 事件；更早的陈旧
   * 事件不应永久封锁资源（retention 已将其过期，此处为一致性兜底）。
   */
  private static readonly SNAPSHOT_EVENT_WINDOW_MS = 24 * 3_600_000;
  private static readonly SNAPSHOT_EVENT_LIMIT = 500;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    // T02 / P0-1（G1）：资源视图单一事实源（必选）。persons/devices/stations
    // 统一消费 ResourceProjectionService.projectForSnapshot()（与 resources/state 同源），
    // 消除双轨直读（旧回退分支已删除）。
    private readonly resourceProjectionService: ResourceProjectionService,
    // DR-6：世界快照扩展事实（物料/订单，advisory；Optional 兼容直接构造的
    // 测试替身——缺装配时 materialsNote 显式声明不可用，不伪造）。
    @Optional()
    private readonly materialsService?: MaterialsService,
  ) {}

  /**
   * NEST-101（2026-08-17）：读面 org 条件构造器。ctx 携带非空 primaryOrgId 时
   * 返回 `org_id IS NULL OR org_id = primaryOrgId`（与 RLS USING 等价的分层
   * 过滤；NULL 分支覆盖存量行过渡期）；ctx 缺省返回 undefined——仅限系统
   * 后台流（GUC/RLS 兜底），HTTP 路径必须传 ctx。
   */
  private orgCondition(column: AnyColumn, ctx: OrgContext | undefined): SQL | undefined {
    const orgId = ctx?.primaryOrgId;
    if (!orgId) return undefined;
    return or(isNull(column), eq(column, orgId));
  }

  /**
   * 基于实时的 ewoh 表状态构建并持久化一个世界状态快照。
   * 快照版本形如 WS-YYYYMMDD-NNNN（按天递增）。
   * 仅写路径（调度 run / 事件应用 / 方案生成 / 预览）使用。
   */
  async buildSnapshot(ctx: OrgContext): Promise<WorldStateSnapshot> {
    const state = await this.collectState(ctx);
    // 阶段三（2026-09-19）：调度 run 路径 fail-closed——契约自检违约（如
    // bad_entity_version_*）的快照**拒绝持久化/生成方案**，而不是告警后继续。
    // 违约快照的 entityVersions 是不可信的（曾实测负数版本），在其上派生的一切
    // 排产决策都不应发生。只读路径（buildSnapshotReadOnly）保持告警不阻断。
    const contractErrors = (state as { contractCheck?: { errors?: string[] } })
      .contractCheck?.errors ?? [];
    if (contractErrors.length > 0) {
      throw new ConflictException(
        `WORLD_SNAPSHOT_CONTRACT_VIOLATION: ${contractErrors.slice(0, 6).join(', ')}`,
      );
    }
    const snapshot = await this.allocateAndPersistSnapshot(state, ctx);
    this.logger.log(`world state snapshot built: ${snapshot.snapshotVersion}`);
    return snapshot;
  }

  /**
   * 构建世界状态快照（只读场景：不分配版本号、不持久化）。
   * GET /api/scheduler/context 等高频读轮询使用——原 buildSnapshot 每次调用都
   * 执行计数器 upsert（行锁）+ INSERT 快照（事务 + 表增长），是 context 接口
   * 偶发数秒峰值的来源（2026-08-19 实测定位）。
   * 语义：读轮询不改变世界状态，也不应推进世界版本——snapshotVersion 取最近
   * 一次已持久化快照版本（只有调度 run 才推进版本）；entityVersions 仍真实收集
   * （collectState 实时读表），isPlanStale（方案过期）判断不受影响。
   */
  async buildSnapshotReadOnly(ctx: OrgContext): Promise<WorldStateSnapshot> {
    const state = await this.collectState(ctx);
    const snapshotVersion = await this.latestPersistedSnapshotVersion(ctx);
    return { ...state, snapshotVersion, ts: new Date().toISOString() };
  }

  /** 读取最近一次已持久化快照版本（org 维度；无则返回占位版本）。 */
  private async latestPersistedSnapshotVersion(ctx: OrgContext): Promise<string> {
    const orgId = ctx.primaryOrgId || null;
    const rows = (await this.db.execute(sql`
      SELECT "snapshot_version"
      FROM "ewoh_world_state_snapshot"
      WHERE "org_id" IS NOT DISTINCT FROM ${orgId}
      ORDER BY "created_at" DESC
      LIMIT 1
    `)) as unknown as Array<{ snapshot_version?: string }>;
    return rows[0]?.snapshot_version ?? 'WS-00000000-0000';
  }

  /**
   * 原子分配快照版本并持久化：分配（计数器 upsert）与插入在同一事务内完成，
   * 行锁覆盖「分配 + 插入」窗口，保证并发下版本互异且无缺口。
   * 有界重试：MAX_ATTEMPTS 次；快照版本唯一冲突（23505）或可串行化冲突（40001）
   * 时以全新版本重试，超过上限抛明确错误，绝不无限循环。
   */
  private async allocateAndPersistSnapshot(
    state: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
    ctx: OrgContext,
  ): Promise<WorldStateSnapshot> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(ctx),
          async () => {
            const snapshotVersion = await this.nextSnapshotVersion();
            const snapshot: WorldStateSnapshot = {
              ...state,
              snapshotVersion,
              ts: new Date().toISOString(),
            };
            await this.db.insert(ewohWorldStateSnapshot).values({
              snapshotVersion,
              snapshotJson: snapshot as unknown as Record<string, unknown>,
              // NEST-036 配套（standalone_057 血缘列）：记录构建上下文 org。
              orgId: ctx.primaryOrgId || null,
              createdAt: new Date(),
            });
            return snapshot;
          },
        );
      } catch (err) {
        if (this.isRetryableAllocationError(err)) {
          if (attempt < MAX_ATTEMPTS) {
            this.logger.warn(
              `world snapshot version allocation collision (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          throw new Error(
            `world snapshot version allocation failed after ${MAX_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    }
    throw new Error(
      `world snapshot version allocation failed after ${MAX_ATTEMPTS} attempts`,
    );
  }

  /** 可重试的分配冲突：snapshot_version 唯一冲突（23505）或可串行化冲突（40001）。 */
  private isRetryableAllocationError(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    return code === '23505' || code === '40001';
  }

  /**
   * 汇总当前世界状态（不持久化快照）。供只读查询（如候选资源）复用同一真实状态。
   * NEST-101（2026-08-17）：ctx 可选——HTTP 读路径必须透传认证上下文（org
   * 过滤）；缺省仅限系统后台流（GUC/RLS 兜底）。
   */
  async getCurrentWorldState(ctx?: OrgContext): Promise<
    Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>
  > {
    return this.collectState(ctx);
  }

  async getSnapshot(
    snapshotVersion: string,
  ): Promise<WorldStateSnapshot | null> {
    return (await this.loadSnapshotRow(snapshotVersion))?.snapshot ?? null;
  }

  /**
   * 读取快照行（含归属租户）。
   *
   * 为什么需要 org：新鲜度比较是"同一租户内、同一时刻的两次状态收集"是否相等。
   * 若比较时缺租户上下文，`collectState` 会退化成**跨租户**收集（不按 org 过滤），
   * 而能力台账等租户作用域的数据源又会因缺 org 返回空 → 同一真实状态算出不同
   * 摘要 → 刚生成的方案在审批时被判 PLAN_STALE（2026-09-10 实测：审批路径
   * `assertFreshForApprove` 未透传 ctx，导致所有新增能力口径的设备摘要不一致）。
   * 因此比较一律以**快照自身的租户**为准。
   */
  private async loadSnapshotRow(
    snapshotVersion: string,
  ): Promise<{ snapshot: WorldStateSnapshot; orgId: string | null } | null> {
    const [row] = await this.db
      .select({
        snapshotJson: ewohWorldStateSnapshot.snapshotJson,
        orgId: ewohWorldStateSnapshot.orgId,
      })
      .from(ewohWorldStateSnapshot)
      .where(eq(ewohWorldStateSnapshot.snapshotVersion, snapshotVersion))
      .limit(1);
    if (!row) return null;
    return {
      snapshot: row.snapshotJson as unknown as WorldStateSnapshot,
      orgId: (row.orgId as string | null) ?? null,
    };
  }

  /**
   * 比较用的租户上下文：调用方有 org 用它；没有则回落到**快照自身的 org**
   * （绝不用"无 org"去收集本应租户作用域的状态）。
   */
  private comparisonContext(
    ctx: OrgContext | undefined,
    snapshotOrgId: string | null,
  ): OrgContext | undefined {
    if (ctx?.primaryOrgId) return ctx;
    if (!snapshotOrgId) return ctx;
    return { ...(ctx ?? { userId: 'system', primaryOrgId: snapshotOrgId }), primaryOrgId: snapshotOrgId } as OrgContext;
  }

  /**
   * 判断给定快照是否仍然新鲜：比较 entityVersions 映射与 reservations 列表，
   * 两者完全一致才视为新鲜（基于实体版本，而非粗略计数）。
   * NEST-159 配套：current 可由调用方传入（批量场景一次 collectState 复用，
   * 消除逐 plan 的 N+1 全量状态收集）。
   */
  async isSnapshotFresh(
    snapshotVersion: string,
    ctx?: OrgContext,
    current?: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
  ): Promise<boolean> {
    const row = await this.loadSnapshotRow(snapshotVersion);
    if (!row) return false;
    const snapshot = row.snapshot;
    const currentState = current ?? await this.collectState(this.comparisonContext(ctx, row.orgId));
    const mapsOk = this.mapsEqual(snapshot.entityVersions, currentState.entityVersions);
    const resOk = this.reservationsEqual(snapshot.reservations, currentState.reservations);
    return mapsOk && resOk;
  }

  /**
   * 判断给定快照版本是否已过期（关键状态发生变更）。
   * 返回 true 表示绑定到该快照的方案已过期，审批应拒绝。
   * 与 isSnapshotFresh 互为反义，语义上更贴近"方案过期"判定。
   */
  async isPlanStale(
    snapshotVersion: string,
    ctx?: OrgContext,
    current?: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
  ): Promise<boolean> {
    return !(await this.isSnapshotFresh(snapshotVersion, ctx, current));
  }

  /**
   * NO-62c：**方案过期可解释**——把"PLAN_STALE"从一个裸状态码变成可处置的诊断。
   *
   * 为什么需要：审批被 409 PLAN_STALE 拒绝时，用户只看到"方案已过期"，
   * 既不知道**变了什么**、也不知道是不是自己造成的（例如刚派了本方案的第一波）。
   * 现场结果：审批人反复点"通过"、调度员盲目重排，问题被掩盖而不是被处置（原则 5/7）。
   *
   * 返回的是**差异事实**（不是结论）：哪些实体版本变了、哪些预占增删改了。
   * `ownPlanId` 传入时，本方案自身已派工 assignment/已建预占的变化会被标注为
   * `selfInflicted`（避免把"我自己刚派的第一波"误报成外部变化）。
   */
  async describeStaleness(
    snapshotVersion: string,
    ctx?: OrgContext,
    current?: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
    ownPlanId?: string,
  ): Promise<PlanStalenessReport> {
    const rowRow = await this.loadSnapshotRow(snapshotVersion);
    if (!rowRow) {
      return {
        snapshotVersion,
        snapshotFound: false,
        stale: true,
        changes: [],
        summary: '找不到方案绑定的世界快照（可能已被清理）：无法判断差异，请重新排程',
        checkedAt: new Date().toISOString(),
      };
    }
    const snapshot = rowRow.snapshot;
    const currentState =
      current ?? (await this.collectState(this.comparisonContext(ctx, rowRow.orgId)));
    // NO-62：本方案自身的实体键按**快照行归属的租户**查询（显式 org 谓词，不靠 RLS 兜底）。
    const ownEntityKeys = ownPlanId
      ? await this.ownEntityKeys(ownPlanId, rowRow.orgId)
      : new Set<string>();

    const changes: StalenessChange[] = [];
    const before: Record<string, number> = snapshot.entityVersions ?? {};
    const after: Record<string, number> = (currentState.entityVersions ?? {}) as Record<string, number>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const prev = before[key];
      const next = after[key];
      if (prev === next) continue;
      changes.push({
        kind: 'entity_version',
        entityKey: key,
        entityType: entityTypeOfKey(key),
        entityId: entityIdOfKey(key),
        before: prev ?? null,
        after: next ?? null,
        change: prev === undefined ? 'added' : next === undefined ? 'removed' : 'changed',
        selfInflicted: ownEntityKeys.has(key),
        label:
          prev === undefined
            ? `${entityTypeOfKey(key)} 新增（快照后出现）`
            : next === undefined
              ? `${entityTypeOfKey(key)} 消失（快照后被移除）`
              : `${entityTypeOfKey(key)} 版本 ${prev} → ${next}`,
      });
    }
    const beforeRes = new Map((snapshot.reservations ?? []).map((r) => [r.reservationId, r]));
    const afterRes = new Map(((currentState.reservations ?? []) as WorldStateSnapshot['reservations']).map((r) => [r.reservationId, r]));
    for (const [id, res] of afterRes) {
      const prev = beforeRes.get(id);
      if (!prev) {
        changes.push({
          kind: 'reservation',
          entityKey: `reservation:${res.resourceType}~${res.resourceId}`,
          entityType: res.resourceType,
          entityId: res.resourceId,
          before: null,
          after: id,
          change: 'added',
          selfInflicted: ownEntityKeys.has(`reservation:${res.resourceType}~${res.resourceId}`),
          label: `新增资源预占 ${res.resourceType}:${res.resourceId}`,
        });
        continue;
      }
      if (
        prev.resourceId !== res.resourceId ||
        prev.resourceType !== res.resourceType ||
        prev.startMs !== res.startMs ||
        prev.endMs !== res.endMs
      ) {
        changes.push({
          kind: 'reservation',
          entityKey: `reservation:${res.resourceType}~${res.resourceId}`,
          entityType: res.resourceType,
          entityId: res.resourceId,
          before: `${prev.startMs}-${prev.endMs}`,
          after: `${res.startMs}-${res.endMs}`,
          change: 'changed',
          selfInflicted: ownEntityKeys.has(`reservation:${res.resourceType}~${res.resourceId}`),
          label: `资源预占变更 ${res.resourceType}:${res.resourceId}`,
        });
      }
    }
    for (const [id, res] of beforeRes) {
      if (afterRes.has(id)) continue;
      changes.push({
        kind: 'reservation',
        entityKey: `reservation:${res.resourceType}~${res.resourceId}`,
        entityType: res.resourceType,
        entityId: res.resourceId,
        before: id,
        after: null,
        change: 'removed',
        selfInflicted: ownEntityKeys.has(`reservation:${res.resourceType}~${res.resourceId}`),
        label: `资源预占释放 ${res.resourceType}:${res.resourceId}`,
      });
    }
    const external = changes.filter((c) => !c.selfInflicted);
    const self = changes.filter((c) => c.selfInflicted);
    // NO-64a：**分档**——"事实变化"（必须重新排程）与"仅证据老化"（不阻断，但要如实告知）。
    // 分档必须与闸门**同一实现**（`stalenessVerdict`），否则会出现"页面说只是证据老化、
    // 审批却被拒"的第二套口径。
    const planKeys = ownPlanId ? await this.planDependencyKeys(ownPlanId, rowRow.orgId) : null;
    const verdict = this.stalenessVerdict(snapshot, currentState, planKeys);
    for (const change of changes) {
      if (verdict.contentChanged.includes(change.entityKey)) {
        change.severity = 'content';
      } else if (verdict.blockedEvidence.some((k) => k.startsWith(`${change.entityKey}（`))) {
        change.severity = 'blocked_evidence';
      } else {
        change.severity = 'evidence';
      }
      change.usedByPlan = planKeys ? planKeys.has(change.entityKey) : false;
    }
    const blocked = changes.filter((c) => c.severity === 'blocked_evidence');
    const aged = changes.filter((c) => c.severity === 'evidence');
    const content = changes.filter((c) => c.severity === 'content');
    // 文案按"外部 vs 本方案自身"分组，再按严重度分档——现场要能一眼分清：
    // 外部事实变化（必须重排）/ 依赖资源证据过期（必须重采）/ 仅证据老化（不阻断）。
    const externalContent = content.filter((c) => !c.selfInflicted);
    const externalBlocked = blocked.filter((c) => !c.selfInflicted);
    const externalAged = aged.filter((c) => !c.selfInflicted);
    const summaryParts: string[] = [];
    if (externalContent.length > 0) summaryParts.push(`检测到 ${externalContent.length} 项外部变化`);
    if (externalBlocked.length > 0) {
      summaryParts.push(
        `${externalBlocked.length} 项方案依赖的资源证据已过期（需重新采集后重排）`,
      );
    }
    if (externalAged.length > 0) {
      summaryParts.push(`${externalAged.length} 项仅证据老化（与方案无关，不阻断审批）`);
    }
    return {
      snapshotVersion,
      snapshotFound: true,
      stale: verdict.stale,
      changes,
      externalChangeCount: external.length,
      selfInflictedCount: self.length,
      contentChangeCount: content.length,
      evidenceAgedCount: aged.length,
      blockedEvidenceCount: blocked.length,
      reason: verdict.reason,
      summary: summaryParts.length === 0
        ? self.length > 0
          ? `仅本方案自身的执行效果变化（${self.length} 项）；世界状态未发生外部变化`
          : '世界状态与方案生成时一致'
        : summaryParts.join('；') + (self.length > 0 ? `（另有 ${self.length} 项本方案自身效果）` : ''),
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 本方案自身产生的实体键（已派工任务 + 已建预占）——用于区分"自己改的"与"外部改的"。
   *
   * `orgId` 为快照行归属租户：两张表都带 org 列，查询显式带上 org 谓词
   * （`org_id` 匹配或 NULL legacy 行），与读面 `collectState(ctx)` 同一隔离口径——
   * 不依赖"调用方已经校验过 planId"这条隐式假设（org 谓词静态审计要求显式谓词）。
   */
  private async ownEntityKeys(planId: string, orgId: string | null): Promise<Set<string>> {
    const keys = new Set<string>();
    const orgPredicate = orgId
      ? or(
          eq(ewohSchedulingPlanAssignment.orgId, orgId),
          isNull(ewohSchedulingPlanAssignment.orgId),
        )
      : isNull(ewohSchedulingPlanAssignment.orgId);
    const dispatched = await this.db
      .select({ taskId: ewohSchedulingPlanAssignment.taskId })
      .from(ewohSchedulingPlanAssignment)
      .where(and(
        eq(ewohSchedulingPlanAssignment.planId, planId),
        eq(ewohSchedulingPlanAssignment.status, 'dispatched'),
        orgPredicate,
      ));
    for (const r of dispatched) {
      if (r.taskId) keys.add(`task:${r.taskId}`);
    }
    const reservationOrgPredicate = orgId
      ? or(
          eq(ewohResourceReservation.orgId, orgId),
          isNull(ewohResourceReservation.orgId),
        )
      : isNull(ewohResourceReservation.orgId);
    const ownReservations = await this.db
      .select({
        resourceType: ewohResourceReservation.resourceType,
        resourceId: ewohResourceReservation.resourceId,
      })
      .from(ewohResourceReservation)
      .where(and(
        eq(ewohResourceReservation.planId, planId),
        reservationOrgPredicate,
      ));
    for (const r of ownReservations) {
      keys.add(`reservation:${r.resourceType}~${r.resourceId}`);
    }
    return keys;
  }

  /**
   * NO-64a：方案依赖的世界实体键（判定"证据老化是否与方案有关"）。
   *
   * 依赖 = 方案里每一条派工用到的任务/人员/设备/工位 + 本方案自己的预占。
   * 只有这些实体"证据老化到不可信"才会阻断审批；与方案无关的设备沉默不再阻断
   * （那不是"世界变了"，只是"某台设备没上报"）。
   */
  async planDependencyKeys(planId: string, orgId?: string | null): Promise<Set<string>> {
    const keys = new Set<string>();
    // 租户归属显式进谓词（org 匹配或 NULL 存量行）：静态审计要求 org 表查询链
    // 必须有 org 谓词或已登记豁免，这里不申请豁免——读取依赖集合是业务查询。
    const orgPredicate = orgId
      ? or(
          eq(ewohSchedulingPlanAssignment.orgId, orgId),
          isNull(ewohSchedulingPlanAssignment.orgId),
        )
      : isNull(ewohSchedulingPlanAssignment.orgId);
    const assignments = await this.db
      .select({
        taskId: ewohSchedulingPlanAssignment.taskId,
        personId: ewohSchedulingPlanAssignment.personId,
        deviceId: ewohSchedulingPlanAssignment.deviceId,
        stationId: ewohSchedulingPlanAssignment.stationId,
      })
      .from(ewohSchedulingPlanAssignment)
      .where(and(eq(ewohSchedulingPlanAssignment.planId, planId), orgPredicate));
    for (const row of assignments) {
      if (row.taskId) keys.add(`task:${row.taskId}`);
      if (row.personId) keys.add(`person:${row.personId}`);
      if (row.deviceId) keys.add(`device:${row.deviceId}`);
      if (row.stationId) keys.add(`station:${row.stationId}`);
    }
    for (const key of await this.ownEntityKeys(planId, orgId ?? null)) keys.add(key);
    return keys;
  }

  /**
   * NO-64a：**事实变化 vs 证据老化**的分档判定（审批/派工共用的唯一实现）。
   *
   * 判定规则（与本文件顶部"新鲜度"注释同一口径）：
   *   1. **内容版本不同** → 事实变了 → 硬过期（拒绝）。内容版本排除了"随时间自然变化"
   *      的派生字段（设备 status/online、证据时钟 telemetryUpdatedAt、过期后的状态标签），
   *      所以"心跳"与"只是过了 60 秒"不再被误判为世界变化；
   *   2. **只有版本不同（内容相同）** → 证据老化。若该实体**被本方案依赖**且当前
   *      `dataQuality !== FRESH` → 硬过期（拒绝，原因 `EVIDENCE_STALE`：方案依赖一个
   *      我们已无法背书的资源）；否则**不阻断**，作为 `agedEvidence` 如实报告；
   *   3. 快照缺 `entityContentVersions`（老快照）→ 全部按第 1 条处理（fail-closed，
   *      绝不因为"新字段缺失"而静默放宽）。
   */
  private stalenessVerdict(
    snapshot: WorldStateSnapshot,
    currentState: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
    planKeys: Set<string> | null,
  ): {
    stale: boolean;
    reason: 'CONTENT_CHANGED' | 'EVIDENCE_STALE' | null;
    contentChanged: string[];
    evidenceAged: string[];
    blockedEvidence: string[];
  } {
    const before = snapshot.entityVersions ?? {};
    const after = (currentState.entityVersions ?? {}) as Record<string, number>;
    const beforeContent = snapshot.entityContentVersions;
    const afterContent = (currentState as { entityContentVersions?: Record<string, number> })
      .entityContentVersions;
    const evidence = (currentState as { entityEvidence?: WorldStateSnapshot['entityEvidence'] })
      .entityEvidence ?? {};
    // 老快照/老采集（缺内容版本）→ 严格口径。
    const strict = !beforeContent || !afterContent;

    const contentChanged: string[] = [];
    const evidenceAged: string[] = [];
    const blockedEvidence: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] === after[key]) continue;
      const contentDiffers =
        strict ||
        beforeContent?.[key] === undefined ||
        afterContent?.[key] === undefined ||
        beforeContent[key] !== afterContent[key];
      if (contentDiffers) {
        contentChanged.push(key);
        continue;
      }
      // 只有证据变化：看方案是否依赖它、以及它现在还可不可信。
      const quality = evidence[key]?.dataQuality ?? 'UNKNOWN';
      const used = planKeys === null ? false : planKeys.has(key);
      if (used && quality !== 'FRESH') {
        blockedEvidence.push(`${key}（证据 ${quality}）`);
      } else {
        evidenceAged.push(key);
      }
    }
    const stale = contentChanged.length > 0 || blockedEvidence.length > 0;
    return {
      stale,
      reason: contentChanged.length > 0
        ? 'CONTENT_CHANGED'
        : blockedEvidence.length > 0
          ? 'EVIDENCE_STALE'
          : null,
      contentChanged,
      evidenceAged,
      blockedEvidence,
    };
  }

  /**
   * 审批前的快照新鲜度强校验；过期时抛出 PLAN_STALE 冲突。
   *
   * NO-64a：`planId` 存在时按"事实变化 vs 证据老化"分档（见 `stalenessVerdict`）；
   * 不传 `planId` 的调用方保持历史严格口径（不静默放宽未知调用方）。
   */
  async assertFreshForApprove(
    snapshotVersion: string,
    ctx?: OrgContext,
    planId?: string,
  ): Promise<void> {
    const row = await this.loadSnapshotRow(snapshotVersion);
    if (!row) throw new ConflictException('PLAN_STALE:CONTENT_CHANGED');
    const currentState = await this.collectState(this.comparisonContext(ctx, row.orgId));
    const planKeys = planId ? await this.planDependencyKeys(planId, row.orgId) : null;
    const verdict = this.stalenessVerdict(row.snapshot, currentState, planKeys);
    if (verdict.stale) {
      // 保留 `PLAN_STALE` 前缀（既有判定/文案依赖它），后缀让日志与测试能区分原因。
      throw new ConflictException(`PLAN_STALE:${verdict.reason ?? 'CONTENT_CHANGED'}`);
    }
  }

  /**
   * 派工用的快照新鲜度校验（**波次感知**，2026-09-10 分波次派工）。
   *
   * 为什么不能用 assertFreshForApprove：派工本身会把任务状态从
   * `pending_dispatch` 改为 `dispatched`、并写入资源预占，于是**第一次派工之后
   * 快照必然"过期"**。若第二波仍用严格相等判定，就永远得到 PLAN_STALE——
   * 分波派工在设计上不可用（实测确认）。
   *
   * 正确语义：只检测**外部**变化，忽略本方案自身已提交的效果：
   *  - 本方案已派工 assignment 对应任务的 `task:<id>` 版本条目；
   *  - 本方案创建的资源预占。
   * 外部改动（他方案/他人改任务、新增外部预占、安全事件）仍会导致不一致 → 拒绝。
   * 这不是放宽安全门：安全阻断、工位容量、任务可派发性、预占冲突都在派工路径
   * 事务内外各自实时复核（见 DispatchCoordinator），不依赖快照相等。
   */
  async assertFreshForWave(snapshotVersion: string, planId: string, ctx?: OrgContext): Promise<void> {
    const row = await this.loadSnapshotRow(snapshotVersion);
    if (!row) throw new ConflictException('PLAN_STALE');
    const currentState = await this.collectState(this.comparisonContext(ctx, row.orgId));

    const dispatched = await this.db
      .select({ taskId: ewohSchedulingPlanAssignment.taskId })
      .from(ewohSchedulingPlanAssignment)
      .where(and(
        eq(ewohSchedulingPlanAssignment.planId, planId),
        eq(ewohSchedulingPlanAssignment.status, 'dispatched'),
      ));
    const ownEntityKeys = new Set(
      dispatched.map((r) => r.taskId).filter((id): id is string => Boolean(id)).map((id) => `task:${id}`),
    );
    const ownReservations = await this.db
      .select({
        reservationId: ewohResourceReservation.reservationId,
        resourceType: ewohResourceReservation.resourceType,
        resourceId: ewohResourceReservation.resourceId,
      })
      .from(ewohResourceReservation)
      .where(eq(ewohResourceReservation.planId, planId));
    const ownReservationIds = new Set(ownReservations.map((r) => r.reservationId));
    // entityVersions 除了 `task:<id>` 还包含预占派生的 `reservation:<type>~<id>` 键
    // （实测：只剔除 task 键时，本波新建的两条预占仍导致 diff → 第二波恒 PLAN_STALE）。
    for (const r of ownReservations) {
      ownEntityKeys.add(`reservation:${r.resourceType}~${r.resourceId}`);
    }

    const stripOwn = (versions: Record<string, number>) => {
      const copy: Record<string, number> = {};
      for (const [key, value] of Object.entries(versions)) {
        if (!ownEntityKeys.has(key)) copy[key] = value;
      }
      return copy;
    };
    const withoutOwnReservations = (
      list: WorldStateSnapshot['reservations'] | null | undefined,
    ) => (list ?? []).filter((r) => !ownReservationIds.has(r.reservationId));

    // NO-64a：派工与审批共用同一分档判定——只剔除**本方案自身已提交的效果**
    // （已派工 assignment 对应任务 + 本方案预占），其余按"事实变化 vs 证据老化"判定。
    const strippedSnapshot: WorldStateSnapshot = {
      ...row.snapshot,
      entityVersions: stripOwn(row.snapshot.entityVersions),
      entityContentVersions: row.snapshot.entityContentVersions
        ? stripOwn(row.snapshot.entityContentVersions)
        : undefined,
      reservations: withoutOwnReservations(row.snapshot.reservations),
    };
    const strippedCurrent = {
      ...currentState,
      entityVersions: stripOwn(currentState.entityVersions),
      entityContentVersions: (currentState as { entityContentVersions?: Record<string, number> })
        .entityContentVersions
        ? stripOwn(
            (currentState as { entityContentVersions: Record<string, number> })
              .entityContentVersions,
          )
        : undefined,
      reservations: withoutOwnReservations(currentState.reservations),
    };
    const planKeys = await this.planDependencyKeys(planId, row.orgId);
    const verdict = this.stalenessVerdict(strippedSnapshot, strippedCurrent, planKeys);
    // 预占列表的精确比较保留为**补充**检查（内容版本已覆盖窗口变化，这里是双保险）。
    const reservationsDrift = !this.reservationsEqual(
      strippedSnapshot.reservations,
      strippedCurrent.reservations,
    );
    if (verdict.stale || reservationsDrift) {
      throw new ConflictException(
        `PLAN_STALE:${verdict.reason ?? (reservationsDrift ? 'CONTENT_CHANGED' : 'CONTENT_CHANGED')}`,
      );
    }
  }

  /** 汇总当前世界状态（不持久化）。NEST-101：全部 7 表读路径按 ctx 加 org 条件。 */
  private async collectState(ctx?: OrgContext): Promise<
    Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>
  > {
    // NEST-101（2026-08-17）：org 过滤（org 匹配或 NULL 存量，与 RLS USING
    // 等价）。ctx 缺省/空 org = 系统后台流（GUC/RLS 兜底，HTTP 路径必须传
    // ctx）——无 org 条件时不调用 .where（保持无 where 能力的测试替身兼容）。
    const tasksQuery = this.db.select().from(ewohProductionTask);
    const spatialQuery = this.db.select().from(ewohSpatialEntity);
    const eventsQuery = this.db.select().from(ewohEvent);
    const routeNodesQuery = this.db.select().from(ewohRouteNode);
    const routeEdgesQuery = this.db.select().from(ewohRouteEdge);

    const [
      tasks,
      spatialEntities,
      events,
      routeNodes,
      routeEdges,
      reservations,
      deviceBindings,
    ] = await Promise.all([
      ctx?.primaryOrgId
        ? tasksQuery.where(
            this.orgCondition(ewohProductionTask.orgId, ctx) as SQL,
          )
        : tasksQuery,
      ctx?.primaryOrgId
        ? spatialQuery.where(
            this.orgCondition(ewohSpatialEntity.orgId, ctx) as SQL,
          )
        : spatialQuery,
      // P1（2026-08-19 审计）：events 只取 status='open'——快照的全部消费方
      // （安全封锁循环 / eventImpacts / PriorityEngine / heuristic 求解器 /
      // 前端回放标记）均只消费开放事件，而事件表以万计存量已结事件逐轮全量
      // 进内存（实测 29,405 行/次）是 collectState 的最大内存/延迟项。
      // 契约字段（events[].status: string）不变，仅收窄采集范围。
      // 性能加固（2026-08-19 平台加载故障）：再加 24h 时间窗 + 最新 500 条
      // 限量（见 SNAPSHOT_EVENT_WINDOW_MS 注释）——open 事件无处理时无限累积
      // （36h 实测 6.3 万条）曾把 conflicts 拖到 104s、全平台超时。
      eventsQuery
        .where(
          and(
            eq(ewohEvent.status, 'open'),
            gte(
              ewohEvent.createdAt,
              new Date(Date.now() - WorldStateSnapshotService.SNAPSHOT_EVENT_WINDOW_MS),
            ),
            this.orgCondition(ewohEvent.orgId, ctx),
          ) as SQL,
        )
        .orderBy(desc(ewohEvent.createdAt))
        .limit(WorldStateSnapshotService.SNAPSHOT_EVENT_LIMIT),
      ctx?.primaryOrgId
        ? routeNodesQuery.where(
            this.orgCondition(ewohRouteNode.orgId, ctx) as SQL,
          )
        : routeNodesQuery,
      ctx?.primaryOrgId
        ? routeEdgesQuery.where(
            this.orgCondition(ewohRouteEdge.orgId, ctx) as SQL,
          )
        : routeEdgesQuery,
      this.db
        .select()
        .from(ewohResourceReservation)
        .where(
          and(
            or(
              eq(ewohResourceReservation.status, 'reserved'),
              eq(ewohResourceReservation.status, 'active'),
            ),
            this.orgCondition(ewohResourceReservation.orgId, ctx),
          ),
        ),
      this.db
        .select()
        .from(ewohDeviceBinding)
        .where(
          and(
            eq(ewohDeviceBinding.targetType, 'person'),
            eq(ewohDeviceBinding.status, 'active'),
            this.orgCondition(ewohDeviceBinding.orgId, ctx),
          ),
        ),
    ]);

    const spatialByEntityId = new Map<string, (typeof spatialEntities)[number]>();
    for (const se of spatialEntities) spatialByEntityId.set(se.entityId, se);

    // T02 / P0-1（G1）：persons/devices/stations 资源视图单一事实源（必选）。
    // 统一消费 projectForSnapshot()（与 resources/state 同源），消除双轨直读。
    // NEST-102（2026-08-17）：资源投影同 ctx 透传（org 过滤同源一致）。
    const resourceView = await this.resourceProjectionService.projectForSnapshot(ctx);
    const persons = resourceView.persons;
    // 2026-08-21 修复：任务 spatial_entity_id 采用 route node 工位（NODE-*，
    // route_node 权威坐标）；资源投影只收 workstation/station 空间实体（st-*），
    // 任务引用的 route node 工位缺失 → stationById 查不到 → 候选空 → 求解
    // 0 分配 → 方案 metrics 全 0。此处将任务引用且缺失的 route node 派生为
    // station（坐标取 route node，capacity 默认 1，source=DERIVED 显式标记）。
    const baseStations = resourceView.stations;
    const taskStationIds = new Set<string>();
    for (const t of tasks) {
      if (t.spatialEntityId) taskStationIds.add(t.spatialEntityId);
    }
    const baseStationIdSet = new Set(baseStations.map((s) => s.id));
    const derivedRouteStations = (routeNodes ?? [])
      .filter((rn) => taskStationIds.has(rn.nodeId) && !baseStationIdSet.has(rn.nodeId))
      .map((rn) => ({
        id: rn.nodeId,
        entityId: `station:${rn.nodeId}`,
        name: rn.nodeId,
        x: rn.x ?? null,
        y: rn.y ?? null,
        capacity: 1,
        queue: [] as string[],
        availableWindows: null,
        capabilities: [] as string[],
        maintenance: null,
        qualityFindings: null,
        source: 'DERIVED' as const,
        coordinate:
          rn.x != null && rn.y != null
            ? {
                type: 'FACTORY_CARTESIAN' as const,
                x: rn.x,
                y: rn.y,
                floorId: rn.floor ?? null,
              }
            : { type: 'UNKNOWN' as const },
      }));
    const stations = [...baseStations, ...derivedRouteStations];
    const deviceList = resourceView.devices;

    // NO-12u / ADR-044：能力投影接线（Canonical CapabilityRecord，ADR-043）。
    // 快照实体附 capabilityRecords（契约合法记录）；投影缺口（certification
    // 缺 issuer/expiry 等数据源事实缺失）显式计数绝不静默（§33）。
    const capabilityProjectionIssues: string[] = [];
    const personRows = persons.map((p) => {
      const projection = projectPersonCapabilities(p);
      capabilityProjectionIssues.push(...projection.issues);
      return { ...p, capabilityRecords: projection.records };
    });
    const deviceRows = deviceList.map((d) => {
      // NO-14f：资源视图已按台账解析能力时，直接透传**台账记录**（含
      // subject/evidence/providerType），不再从名称反推一遍记录。
      // 无台账记录（历史/列兜底路径）才走原投影，行为不变。
      const ledgerRecords = (d as { capabilityRecords?: import('@shared/capability').CapabilityRecord[] })
        .capabilityRecords;
      const ledgerIssues = (d as { capabilityLedgerIssues?: string[] }).capabilityLedgerIssues;
      if (ledgerIssues && ledgerIssues.length > 0) {
        capabilityProjectionIssues.push(...ledgerIssues);
      }
      if (ledgerRecords && ledgerRecords.length > 0) {
        return { ...d, capabilityRecords: ledgerRecords };
      }
      const projection = projectDeviceCapabilities(d);
      capabilityProjectionIssues.push(...projection.issues);
      return { ...d, capabilityRecords: projection.records };
    });
    const stationRows = stations.map((s) => {
      const projection = projectStationCapabilities(s);
      capabilityProjectionIssues.push(...projection.issues);
      return { ...s, capabilityRecords: projection.records };
    });

    const taskList = tasks.map((t) => {
      // 派生字段标记：本快照中这些字段来自派生而非真实列（P1-T2）。
      const derived: string[] = [];

      // safetyCritical：新列优先；列无值才派生并带 derived 标记（替代白名单直接猜测）。
      const safetyCritical = t.safetyCritical ?? this.deriveSafetyCritical(t.taskType);
      if (t.safetyCritical == null) derived.push('safetyCritical');
      // preemptible：新列优先（替代固定 false）。
      const preemptible = t.preemptible ?? false;
      if (t.preemptible == null) derived.push('preemptible');
      // skillMatchMode：新列优先（替代固定 'ALL'）；运行时规整为 'ALL'|'ANY'。
      const skillMatchMode: 'ALL' | 'ANY' = t.skillMatchMode === 'ANY' ? 'ANY' : 'ALL';
      if (t.skillMatchMode == null) derived.push('skillMatchMode');
      // productionImpact：新列优先；列无值才按 priority 派生并带标记。
      const productionImpact = t.productionImpact ?? this.deriveProductionImpact(t.priority);
      if (t.productionImpact == null) derived.push('productionImpact');
      // requiredDeviceCapabilities：P1-TREQ 真实列优先（TaskRequirement 业务事实）。
      // 列值为空数组时按 taskType 白名单派生（backfill 兼容旧数据）并标记 derived；
      // 写入真实值的行标记 authoritative（derived[] 可区分）。
      const rawDeviceCaps = this.asStringArray(t.requiredDeviceCapabilities);
      const deviceCaps =
        rawDeviceCaps.length > 0
          ? rawDeviceCaps
          : this.deriveRequiredDeviceCapabilities(t.taskType);
      if (rawDeviceCaps.length === 0) derived.push('requiredDeviceCapabilities');
      // candidateStations：P1-TREQ 真实列优先（TaskRequirement 业务事实）；
      // 列无值则回退空间拓扑派生（zone 内工位/任务自身工位）并标记 derived。
      const rawCandidateStations = this.asStringArray(t.candidateStations);
      const candidateStations =
        rawCandidateStations.length > 0
          ? rawCandidateStations
          : this.deriveCandidateStations(
              t.spatialEntityId,
              spatialByEntityId,
              stations,
              spatialEntities,
            );
      if (rawCandidateStations.length === 0) derived.push('candidateStations');

      return {
        id: t.id,
        entityId: `task:${t.id}`,
        title: t.title,
        taskType: t.taskType,
        priority: t.priority,
        status: t.status,
        assigneeId: t.assigneeId ?? null,
        deviceId: t.deviceId ?? null,
        stationId: t.spatialEntityId ?? null,
        zoneId: t.spatialEntityId
          ? (spatialByEntityId.get(t.spatialEntityId)?.parentId ?? null)
          : null,
        planStart: t.planStart ? t.planStart.toISOString() : null,
        planEnd: t.planEnd ? t.planEnd.toISOString() : null,
        progress: t.progress ?? 0,
        predecessorIds: this.asStringArray(t.predecessorIds),
        requiredSkills: this.asStringArray(t.requiredSkills),
        requiredCertifications: this.asStringArray(t.requiredCertifications),
        // P1-TREQ：设备能力需求——真实列优先（TaskRequirement 业务事实），
        // 列无值才回退 taskType 白名单派生（backfill 兼容，derived[] 标记）。
        // P1-TREQ：设备能力需求——真实列优先（TaskRequirement 业务事实），
        // 列无值才回退 taskType 白名单派生（backfill 兼容，derived[] 标记）。
        requiredDeviceCapabilities: deviceCaps,
        // P1-TREQ：候选工位——真实列优先，无值回退空间拓扑派生（derived[] 标记）。
        candidateStations,
        safetyCritical,
        preemptible,
        skillMatchMode,
        dueAtMs: t.planEnd ? t.planEnd.getTime() : null,
        productionImpact,
        // P1-T2：领域新列透传（有值取真实值，无值显式 null/空数组，绝不伪造）。
        basePriority: t.basePriority ?? null,
        earliestStartMs: t.earliestStartMs ?? null,
        latestFinishMs: t.latestFinishMs ?? null,
        downstreamImpact: t.downstreamImpact ?? null,
        requiredStationCapabilities: this.asStringArray(t.requiredStationCapabilities),
        preferredResources: this.asStringArray(t.preferredResources),
        excludedResources: this.asStringArray(t.excludedResources),
        derived,
      };
    });

    // P0-6 核验（spec §八.10）：backlog 语义 =「工位排队任务数」，与 stations[].queue
    // （真实 queue 列）一致；不是「工位上的全量任务数」（含执行中/已完成）。
    // 注意：backlog[].taskId 字段实为 stationId（既有消费方 buildConflicts /
    // conflict.service 按 stationId 取用，类型命名历史遗留，此处保持形状不改名）。
    const backlog = stations
      .filter((s) => Array.isArray(s.queue) && s.queue.length > 0)
      .map((s) => ({ taskId: s.id, count: s.queue.length }));

    const eventList = events.map((e) => ({
      eventId: e.eventId,
      severity: e.severity ?? 'L1',
      status: e.status ?? 'open',
      eventType: e.eventType ?? null,
    }));

    const routeStatus = routeEdges.map((e) => ({
      edgeId: e.edgeId,
      status: e.status ?? 'open',
      riskLevel: e.riskLevel ?? null,
    }));

    // P0-6：路由边 → 受影响任务索引（edgeId → taskIds）。
    // route graph 边连接 route node；node.stationId 指向工位；任务落在工位。
    // 由 "边连接的工位上的任务" 推导受影响集合——edgeId 与 zoneId 是两套 ID 体系，
    // 旧影响分析用 zoneId 匹配 edgeId 属错配（ROUTE_BLOCKED 永远圈不中任务）。
    // 若 route node 无 stationId 关联，则该边无已知受影响任务（fail-safe，不误伤）。
    const routeEdgeTaskIndex: Record<string, string[]> = {};
    {
      // R2-SCH-015（2026-08-17）：索引化构建——nodeById Map 替代边内线性 find
      //（O(E×N)→O(E)），并倒排 stationId → edgeIds 后按任务直查
      //（任务×边全扫 O(T×E)→O(T×avgEdgesPerStation)；语义不变）。
      const nodeById = new Map(routeNodes.map((n) => [n.nodeId, n]));
      const edgeIdsByStation = new Map<string, string[]>();
      for (const e of routeEdges) {
        const stationIds = new Set<string>();
        const fromNode = nodeById.get(e.fromNodeId);
        const toNode = nodeById.get(e.toNodeId);
        if (fromNode?.stationId) stationIds.add(fromNode.stationId);
        if (toNode?.stationId) stationIds.add(toNode.stationId);
        for (const stationId of stationIds) {
          const list = edgeIdsByStation.get(stationId);
          if (list) list.push(e.edgeId);
          else edgeIdsByStation.set(stationId, [e.edgeId]);
        }
      }
      for (const t of taskList) {
        if (!t.stationId) continue;
        for (const edgeId of edgeIdsByStation.get(t.stationId) ?? []) {
          (routeEdgeTaskIndex[edgeId] ??= []).push(t.id);
        }
      }
    }

    const forbiddenZones = spatialEntities
      .filter((se) => se.entityType === 'restricted_zone')
      .map((se) => ({ zoneId: se.entityId, reason: 'restricted_zone' }));

    const lockedAssignments = taskList
      .filter((t) => WorldStateSnapshotService.LOCKED_TASK_STATUSES.has(t.status))
      .map((t) => ({
        taskId: t.id,
        personId: t.assigneeId,
        deviceId: t.deviceId,
        stationId: t.stationId,
      }));

    // ---- 安全事件映射 ----
    // deviceId → 活跃人员 targetId（仅保留 targetType='person' 且 status='active'）
    const deviceBindingByDevice = new Map<string, string>();
    for (const db of deviceBindings) {
      if (!deviceBindingByDevice.has(db.deviceId)) {
        deviceBindingByDevice.set(db.deviceId, db.targetId);
      }
    }

    const safetyBlockedPersonIds = new Set<string>();
    const safetyBlockedDeviceIds = new Set<string>();
    const safetyForbiddenZones = new Set<string>();

    for (const e of events) {
      if (e.status !== 'open') continue;
      // B7（2026-08-19 审计）：severity 双词汇受理——存量 legacy L2/L3 与新写入
      // canonical critical/high/medium 均触发安全封锁（原只认 legacy → ingest
      // 上报的 canonical critical 安全事件不触发封锁）。L1/low/unknown 不封锁。
      if (!isEventSeverityRisky(e.severity)) continue;

      const reasons: string[] = [];
      const deviceId = e.deviceId ?? null;

      if (deviceId) {
        safetyBlockedDeviceIds.add(deviceId);
        const boundPersonId = deviceBindingByDevice.get(deviceId);
        if (boundPersonId) {
          safetyBlockedPersonIds.add(boundPersonId);
        } else {
          reasons.push(`device ${deviceId} has no active person binding`);
        }
        const affectedZoneId = spatialByEntityId.get(deviceId)?.parentId ?? null;
        if (affectedZoneId) {
          safetyForbiddenZones.add(affectedZoneId);
        } else {
          reasons.push(`device ${deviceId} has no spatial entity to resolve zone`);
        }
      } else {
        // NEST-151（2026-08-17）：无 deviceId 的安全事件不再只留 warn——先从
        // 证据链显式推导禁区/受影响人员/设备（affectedZoneIds 与可选
        // locationZoneId）；证据也不可解析时才降级 warn（fail-safe 不臆造禁区）。
        reasons.push('no deviceId; deriving scope from evidence only');
      }

      // 证据链中可选的影响范围，合并进 blocked 集合
      const evidence = (e.evidenceJson ?? {}) as Record<string, unknown>;
      for (const pid of this.asStringArray(evidence.affectedPersonIds)) {
        safetyBlockedPersonIds.add(pid);
      }
      for (const did of this.asStringArray(evidence.affectedDeviceIds)) {
        safetyBlockedDeviceIds.add(did);
      }
      for (const zid of this.asStringArray(evidence.affectedZoneIds)) {
        safetyForbiddenZones.add(zid);
      }
      // NEST-151：证据链位置区域（单值字段，事件源携带的位置语义）。
      for (const zid of this.asStringArray(evidence.locationZoneId)) {
        safetyForbiddenZones.add(zid);
      }

      if (reasons.length > 0) {
        this.logger.warn(
          `safety event ${e.eventId} (${e.severity}) partially unresolved: ${reasons.join('; ')}`,
        );
      }
    }

    for (const zoneId of safetyForbiddenZones) {
      if (!forbiddenZones.some((z) => z.zoneId === zoneId)) {
        forbiddenZones.push({ zoneId, reason: 'safety_event' });
      }
    }

    // ---- 事件影响范围（P0-2 / eventImpacts）----
    // 为 PriorityEngine 提供"事件 → 受影响任务/资源"的 scope 索引，使开放事件只影响相关任务，
    // 而非无差别作用于所有任务。已锁定/已派出任务（executing/dispatched/in_progress）不纳入受影响集合，
    // 避免对正在执行的任务重新排优。
    // 性能优化（2026-08-21）：倒排索引替代 O(events×tasks) 嵌套循环 → O(events+tasks)。
    const unlockedTasksByDevice = new Map<string, string[]>();
    const unlockedTasksByStation = new Map<string, string[]>();
    const unlockedTasksByZone = new Map<string, string[]>();
    for (const t of taskList) {
      if (WorldStateSnapshotService.LOCKED_TASK_STATUSES.has(t.status)) continue;
      if (t.deviceId) {
        let arr = unlockedTasksByDevice.get(t.deviceId);
        if (!arr) { arr = []; unlockedTasksByDevice.set(t.deviceId, arr); }
        arr.push(t.id);
      }
      if (t.stationId) {
        let arr = unlockedTasksByStation.get(t.stationId);
        if (!arr) { arr = []; unlockedTasksByStation.set(t.stationId, arr); }
        arr.push(t.id);
      }
      if (t.zoneId) {
        let arr = unlockedTasksByZone.get(t.zoneId);
        if (!arr) { arr = []; unlockedTasksByZone.set(t.zoneId, arr); }
        arr.push(t.id);
      }
    }

    const eventImpacts: SchedulingEventImpact[] = events.map((e) => {
      const evidence = (e.evidenceJson ?? {}) as Record<string, unknown>;
      const affectedTaskIds = this.asStringArray(evidence.affectedTaskIds);
      const affectedPersonIds = this.asStringArray(evidence.affectedPersonIds);
      const affectedDeviceIds = this.asStringArray(evidence.affectedDeviceIds);
      const affectedStationIds = this.asStringArray(evidence.affectedStationIds);
      const affectedZoneIds = this.asStringArray(evidence.affectedZoneIds);

      // 事件自身设备：加入受影响设备集合（若未在证据链中）。
      const deviceId = e.deviceId ?? null;
      if (deviceId && !affectedDeviceIds.includes(deviceId)) {
        affectedDeviceIds.push(deviceId);
      }
      // 设备拥有空间实体 → 解析其所在 zone（parentId）；设备自身为工位时录入受影响工位。
      if (deviceId) {
        const deviceSe = spatialByEntityId.get(deviceId);
        const zoneId = deviceSe?.parentId ?? null;
        if (zoneId && !affectedZoneIds.includes(zoneId)) {
          affectedZoneIds.push(zoneId);
        }
        if (
          deviceSe &&
          ['workstation', 'station'].includes(deviceSe.entityType) &&
          !affectedStationIds.includes(deviceId)
        ) {
          affectedStationIds.push(deviceId);
        }
      }

      // 传播到任务：倒排索引 O(1) 查找替代全量扫描 O(tasks)。
      const relatedTaskIds = new Set<string>();
      if (deviceId) {
        for (const tid of (unlockedTasksByDevice.get(deviceId) ?? [])) {
          relatedTaskIds.add(tid);
        }
      }
      for (const sid of affectedStationIds) {
        for (const tid of (unlockedTasksByStation.get(sid) ?? [])) {
          relatedTaskIds.add(tid);
        }
      }
      for (const zid of affectedZoneIds) {
        for (const tid of (unlockedTasksByZone.get(zid) ?? [])) {
          relatedTaskIds.add(tid);
        }
      }
      for (const tid of affectedTaskIds) relatedTaskIds.add(tid);

      return {
        eventId: e.eventId,
        severity: e.severity ?? 'L1',
        status: e.status ?? 'open',
        affectedTaskIds: Array.from(relatedTaskIds),
        affectedPersonIds,
        affectedDeviceIds,
        affectedStationIds,
        affectedZoneIds,
      };
    });

    const reservationList = reservations.map((r) => ({
      reservationId: r.reservationId,
      resourceId: r.resourceId,
      resourceType: r.resourceType,
      startMs: r.startMs,
      endMs: r.endMs,
    }));

    // ---- DR-6：世界模型扩展事实（物料/订单/班次；advisory，不进 entityVersions
    // 新鲜度比较——物料事实变化不使既有方案失效，供解释/展示/候选引擎参考）----
    let materials: import('@shared/scheduler').WorldSnapshotMaterial[] = [];
    let materialsNote: string | null = '物料事实不可用（MaterialsService 未装配）';
    let orderFacts: import('@shared/scheduler').WorldSnapshotOrder[] = [];
    let ordersNote: string | null = null;
    if (this.materialsService && ctx?.primaryOrgId) {
      try {
        const facts = await this.materialsService.getSnapshotFacts(ctx);
        materials = facts.materials;
        materialsNote = facts.materialsNote;
        orderFacts = facts.orders;
        ordersNote = facts.ordersNote;
      } catch (err) {
        materialsNote = `物料事实聚合失败（快照不含物料，不伪造）：${
          err instanceof Error ? err.message : String(err)
        }`;
        this.logger.warn(materialsNote);
      }
    } else if (this.materialsService) {
      materialsNote = '物料事实不可用（缺租户上下文）';
    }
    let shiftFacts: import('@shared/scheduler').WorldSnapshotShift[] = [];
    try {
      const shiftsQuery = this.db.select().from(ewohShift);
      const shiftRows = ctx?.primaryOrgId
        ? await shiftsQuery.where(this.orgCondition(ewohShift.orgId, ctx) as SQL)
        : await shiftsQuery;
      shiftFacts = shiftRows.map((r) => ({
        shiftId: r.shiftId,
        name: r.name,
        code: r.code,
        // PG time 列可能带秒（"16:00:00"）；契约口径 HH:mm。
        startTime: r.startTime.length > 5 ? r.startTime.slice(0, 5) : r.startTime,
        endTime: r.endTime.length > 5 ? r.endTime.slice(0, 5) : r.endTime,
        crossesMidnight: r.crossesMidnight,
        active: r.active,
      }));
    } catch (err) {
      this.logger.warn(`班次定义投影失败（ewoh_shift 可能未迁移）: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- 基于内容的实体版本摘要 ----
    const entityVersions: Record<string, number> = {};
    // NO-64a：内容版本 + 证据（与 entityVersions 同源采集，保证三者口径一致）。
    const entityContentVersions: Record<string, number> = {};
    const entityEvidence: NonNullable<WorldStateSnapshot['entityEvidence']> = {};
    /**
     * 证据状态标签：**只有证据新鲜时**才把权威状态计入内容版本。
     *
     * 为什么：`status` 在投影里是"权威列 + 新鲜度派生"的合成结果——过期的实体一律
     * 显示为 UNKNOWN/OFFLINE。若把派生结果计入内容版本，则"没人上报"会被当成"事实变了"。
     * 反过来，证据新鲜时的 `status` **就是权威列**（人工改成 unavailable/maintenance 也在内），
     * 必须计入内容版本，否则真实的停用/改派会被漏判（那才是安全事故）。
     */
    const freshnessAwareStatus = (
      quality: 'FRESH' | 'STALE' | 'UNKNOWN' | undefined,
      status: string | null | undefined,
    ): string => (quality === 'FRESH' ? String(status ?? '') : '<derived-from-freshness>');
    for (const p of persons) {
      entityVersions[`person:${p.id}`] = this.entityVersion({
        status: p.status,
        healthStatus: p.healthStatus,
        loadLevel: p.loadLevel,
        fatigueLevel: p.fatigueLevel,
        x: p.x,
        y: p.y,
        skills: p.skills,
        certifications: p.certifications,
        shift: p.shift,
        workload: p.workload,
        currentTaskId: p.currentTaskId,
        certificationExpiry: p.certificationExpiry,
      });
      entityContentVersions[`person:${p.id}`] = this.entityVersion({
        status: freshnessAwareStatus(p.dataQuality, p.status),
        healthStatus: p.healthStatus,
        loadLevel: p.loadLevel,
        fatigueLevel: p.fatigueLevel,
        x: p.x,
        y: p.y,
        skills: p.skills,
        certifications: p.certifications,
        shift: p.shift,
        workload: p.workload,
        currentTaskId: p.currentTaskId,
        certificationExpiry: p.certificationExpiry,
      });
      entityEvidence[`person:${p.id}`] = {
        sourceTs: p.sourceTs ?? null,
        dataQuality: p.dataQuality ?? 'UNKNOWN',
        status: p.status ?? null,
      };
    }
    for (const t of taskList) {
      // 任务没有"证据新鲜度"概念：任何差异都是事实变化 → 内容版本与版本一致。
      entityContentVersions[`task:${t.id}`] = entityVersions[`task:${t.id}`] = this.entityVersion({
        status: t.status,
        priority: t.priority,
        planStart: t.planStart,
        planEnd: t.planEnd,
        assigneeId: t.assigneeId,
        deviceId: t.deviceId,
        predecessorIds: t.predecessorIds,
        requiredSkills: t.requiredSkills,
        requiredCertifications: t.requiredCertifications,
        basePriority: t.basePriority,
        earliestStartMs: t.earliestStartMs,
        latestFinishMs: t.latestFinishMs,
        safetyCritical: t.safetyCritical,
        preemptible: t.preemptible,
        skillMatchMode: t.skillMatchMode,
        productionImpact: t.productionImpact,
        downstreamImpact: t.downstreamImpact,
        requiredStationCapabilities: t.requiredStationCapabilities,
        preferredResources: t.preferredResources,
        excludedResources: t.excludedResources,
      });
    }
    for (const d of deviceList) {
      entityContentVersions[`device:${d.id}`] = this.entityVersion({
        status: freshnessAwareStatus(d.dataQuality, d.status),
        // online 同样是新鲜度派生（过期即 false）→ 只在新鲜时计入内容版本；
        // telemetryUpdatedAt 是**证据时钟**本身（每帧心跳都会变），不进内容版本。
        online: d.dataQuality === 'FRESH' ? (d.online ?? false) : '<derived-from-freshness>',
        batteryPct: d.batteryPct,
        capabilities: d.capabilities,
        x: d.x,
        y: d.y,
        locationStationId: d.locationStationId,
        locationConfidence: d.locationConfidence,
        observedCapabilities: d.observedCapabilities ?? null,
        disabledCapabilities: d.disabledCapabilities ?? null,
      });
      entityEvidence[`device:${d.id}`] = {
        sourceTs: d.sourceTs ?? d.telemetryUpdatedAt ?? null,
        dataQuality: d.dataQuality ?? 'UNKNOWN',
        status: d.status ?? null,
      };
      entityVersions[`device:${d.id}`] = this.entityVersion({
        batteryPct: d.batteryPct,
        online: d.online,
        status: d.status,
        capabilities: d.capabilities,
        x: d.x,
        y: d.y,
        locationStationId: d.locationStationId,
        locationConfidence: d.locationConfidence,
        telemetryUpdatedAt: d.telemetryUpdatedAt,
        // NO-14g：观测能力是真实世界状态（设备新增/失去温度、称重等观测维度），
        // 必须进摘要——否则"设备换了传感器"这类变更对调度不可见。
        observedCapabilities: d.observedCapabilities ?? null,
        // NO-15b：人工停用能力同样是世界模型变化（设备"能做什么"变了），
        // 必须进摘要——否则停用后旧方案不会被判 stale，会带着失效能力继续派工。
        disabledCapabilities: d.disabledCapabilities ?? null,
      });
    }
    for (const r of routeStatus) {
      entityContentVersions[`route:${r.edgeId}`] = entityVersions[`route:${r.edgeId}`] =
        this.entityVersion({
          status: r.status,
          riskLevel: r.riskLevel,
        });
    }
    for (const s of stations) {
      entityContentVersions[`station:${s.id}`] = entityVersions[`station:${s.id}`] =
        this.entityVersion({
        name: s.name,
        x: s.x,
        y: s.y,
        capacity: s.capacity,
        queue: s.queue,
        availableWindows: s.availableWindows,
      });
    }
    for (const fz of forbiddenZones) {
      entityContentVersions[`zone:${fz.zoneId}`] = entityVersions[`zone:${fz.zoneId}`] =
        this.entityVersion({
          zoneId: fz.zoneId,
          reason: fz.reason,
        });
    }
    for (const r of reservationList) {
      entityContentVersions[`reservation:${r.resourceType}~${r.resourceId}`] =
        entityVersions[`reservation:${r.resourceType}~${r.resourceId}`] =
          this.entityVersion({ startMs: r.startMs, endMs: r.endMs });
    }
    // 键必须是规范身份（identity kind:value）：旧裸键 'safety' 触发
    // bad_entity_version_key 契约告警（NO-03b 自检留痕）。
    entityContentVersions['risk:safety_block'] = entityVersions['risk:safety_block'] = this.entityVersion({
      safetyBlockedPersonIds: Array.from(safetyBlockedPersonIds),
      safetyBlockedDeviceIds: Array.from(safetyBlockedDeviceIds),
      forbiddenZones,
    });

    // 粗略的整体版本标量，用于展示/排序；权威新鲜度信号见 entityVersions 精确比较。
    // 性能优化（2026-08-21）：SHA-256 → FNV-1a 48-bit（与 entityVersion 同源算法）。
    const versionInput = Object.entries(entityVersions)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}:${v}`)
      .join('|');
    const worldVersion = WorldStateSnapshotService.fnv1a48(versionInput);

    const snapshot = {
      worldVersion,
      entityVersions,
      // NO-64a：内容版本 + 证据（二者必须与 entityVersions 在同一时刻采集，
      // 否则"事实变化/证据老化"的分档会基于不同的世界读快照）。
      entityContentVersions,
      entityEvidence,
      reservations: reservationList,
      safetyBlockedPersonIds: Array.from(safetyBlockedPersonIds),
      safetyBlockedDeviceIds: Array.from(safetyBlockedDeviceIds),
      persons: personRows,
      tasks: taskList,
      devices: deviceRows,
      stations: stationRows,
      backlog,
      events: eventList,
      // P0-2：事件影响 scope（供 PriorityEngine 只消费相关事件）。
      eventImpacts,
      routeStatus,
      // P0-6：edgeId → 受影响任务索引（供 ROUTE_BLOCKED/ROUTE_CONGESTED 影响分析）。
      routeEdgeTaskIndex,
      forbiddenZones,
      lockedAssignments,
      // NO-12u / ADR-044：能力投影缺口显式计数（certification 缺 issuer/expiry 等）。
      capabilityProjectionIssues,
      // DR-6：世界模型扩展事实（物料/订单/班次；advisory）。
      materials,
      materialsNote,
      orders: orderFacts,
      ordersNote,
      shifts: shiftFacts,
    };

    // ADR-008 / NO-03b：快照构建时的契约自检（entityVersions 键 + 实体规范身份引用）。
    // 自检失败显式留痕（errors 落快照 + warn 日志），不静默吞掉也不中断投影构建
    // （投影词表已由 ADR-007 收敛；此处防御未来漂移并给出可观测证据）。
    const contractErrors = validateCloudWorldSnapshot(snapshot);
    if (contractErrors.length > 0) {
      this.logger.warn(
        `world snapshot contract check failed: ${contractErrors.join(', ')}`,
      );
    }
    (snapshot as { contractCheck?: { valid: boolean; errors: string[] } }).contractCheck = {
      valid: contractErrors.length === 0,
      errors: contractErrors,
    };

    return snapshot;
  }

  /**
   * 原子分配形如 WS-YYYYMMDD-NNNN 的快照版本。
   * 必须在调用方事务内执行（buildSnapshot 经 RequestDatabaseContext 保证分配与
   * 插入同事务）：对 ewoh_snapshot_version_counter 按天 upsert（ON CONFLICT (day)
   * DO UPDATE SET last_seq = last_seq + 1），行锁串行化同一天内的并发分配，
   * 保证版本互异且无缺口；ewoh_world_state_snapshot.snapshot_version 唯一约束
   * 保留为最终兜底（冲突由 allocateAndPersistSnapshot 有界重试收敛）。
   */
  private async nextSnapshotVersion(): Promise<string> {
    const day = this.dateStamp(new Date());
    const rows = (await this.db.execute(
      sql`
        INSERT INTO ewoh_snapshot_version_counter (day, last_seq)
        VALUES (${day}, 1)
        ON CONFLICT (day) DO UPDATE SET
          last_seq = ewoh_snapshot_version_counter.last_seq + 1,
          _updated_at = now()
        RETURNING last_seq
      `,
    )) as unknown as Array<{ last_seq?: number | string }>;
    const seq = Number(rows[0]?.last_seq ?? 0);
    return `WS-${day}-${String(seq).padStart(4, '0')}`;
  }

  private dateStamp(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  /**
   * v0.7 Batch5.3：从任务类型派生设备能力需求（重体力/搬运类 → exo-lift）。
   * 与 safetyCritical 白名单同源语义；未命中返回空数组（无能力要求）。
   */
  private deriveRequiredDeviceCapabilities(taskType: string): string[] {
    const t = (taskType ?? '').toLowerCase();
    if (
      t.includes('lift') ||
      t.includes('carry') ||
      t.includes('heavy') ||
      t.includes('handling') ||
      t.includes('搬运') ||
      t.includes('重体力') ||
      t.includes('物料')
    ) {
      return ['exo-lift'];
    }
    return [];
  }

  /** jsonb 数组列可能以 unknown 返回；安全地规整为 string[]。 */
  private asStringArray(v: unknown): string[] {
    return Array.isArray(v)
      ? (v as string[]).filter((x): x is string => typeof x === 'string')
      : [];
  }

  /**
   * NEST-170（2026-08-17）：安全关键任务类型关键词白名单提取为命名常量
   * （派生语义仅兜底 safetyCritical 列 NULL 的存量行；策略化配置属
   * SchedulingPolicy 演进项，本常量与 deriveRequiredDeviceCapabilities 同源）。
   */
  private static readonly SAFETY_CRITICAL_TASK_TYPES: readonly string[] = [
    'lift',
    'carry',
    'heavy_lift',
    'material_handling',
    '搬运',
    '重体力',
    '物料搬运',
    'lifting',
  ];

  /** 优先级 → 生产影响度映射（NEST-170：命名常量，替代散落 switch 字面量）。 */
  private static readonly PRIORITY_PRODUCTION_IMPACT: ReadonlyMap<string, number> =
    new Map([
      ['urgent', 1.0],
      ['critical', 1.0],
      ['high', 0.7],
      ['medium', 0.4],
      ['low', 0.1],
    ]);

  /**
   * v0.7 A1：从任务类型派生安全关键语义（重体力/搬运类），保守默认 false。
   * 仅作白名单匹配，未命中的任务绝不被误判为安全关键（避免误阻断）。
   */
  private deriveSafetyCritical(taskType: string): boolean {
    const t = (taskType ?? '').toLowerCase();
    return WorldStateSnapshotService.SAFETY_CRITICAL_TASK_TYPES.some((k) =>
      t.includes(k.toLowerCase()),
    );
  }

  /**
   * v0.7 A1：从优先级语义派生生产影响度 0..1（越高越影响产线节拍）。
   * urgent/critical 视为最高影响；缺省 0 保持向后兼容。
   */
  private deriveProductionImpact(priority: string): number {
    return (
      WorldStateSnapshotService.PRIORITY_PRODUCTION_IMPACT.get(
        (priority ?? '').toLowerCase(),
      ) ?? 0
    );
  }

  /**
   * v0.7 A1：推导候选工位 = 任务所在 zone（父区域）内的所有工位。
   * 任务绑定工位可解析到父区域 → 返回该区域内全部工位（就近分配候选）；
   * 无 zone 但任务绑定工位本身是工位 → 回退 [stationId]；
   * 均不可解析 → 空数组（求解器回退到无候选约束）。
   */
  private deriveCandidateStations(
    spatialEntityId: string | null,
    spatialByEntityId: Map<string, { entityId: string; entityType: string | null; parentId: string | null }>,
    stations: Array<{ id: string }>,
    allSpatialEntities: Array<{ entityId: string; entityType: string | null; parentId: string | null }>,
  ): string[] {
    if (!spatialEntityId) return [];
    // 2026-08-21 修复：任务工位在 stations（含 route node 派生的 NODE-* 工位）
    // 中时**直接可用**——原实现先查 spatialByEntityId（route node 不在 spatial 表）
    // 命中 `if (!se) return []` 致 candidateStations 恒空 → 求解 0 分配。
    // 兜底检查提升到最前（stations 是权威可排工位集，含 DERIVED 派生项）。
    if (stations.some((s) => s.id === spatialEntityId)) {
      return [spatialEntityId];
    }
    const se = spatialByEntityId.get(spatialEntityId);
    if (!se) return [];
    // 任务绑定工位本身就是 station → 直接回退。
    if (['workstation', 'station'].includes(se.entityType)) {
      return [se.entityId];
    }
    // 任务绑定的是区域/设备 → 取其父区域（zone）内的所有工位。
    const zoneId = se.parentId ?? se.entityId;
    const zone = spatialByEntityId.get(zoneId);
    const zoneChildren = zone
      ? allSpatialEntities.filter((s) => s.parentId === zoneId)
      : allSpatialEntities.filter((s) => s.entityId === zoneId);
    const inZone = zoneChildren
      .filter((s) => ['workstation', 'station'].includes(s.entityType))
      .map((s) => s.entityId);
    if (inZone.length > 0) return inZone;
    return [];
  }

  /**
   * NEST-149 修复（2026-08-17）：djb2 32-bit 哈希 → SHA-256 48-bit 折叠。
   * 性能优化（2026-08-21）：SHA-256 → FNV-1a 48-bit（纯 JS，无 crypto 开销）。
   * 契约（world-contract）冻结 entityVersions: Record<string, number>，故取
   * 48-bit 无符号整数（< 2^53 安全整数域）；碰撞概率极低，且仅影响展示排序
   * 不影响新鲜度判定。FNV-1a 比 SHA-256 快 10-50x（无对象序列化+digest 开销）。
   */
  private hash(str: string): number {
    return WorldStateSnapshotService.fnv1a48(str);
  }

  /** FNV-1a 48-bit 哈希（两个 32-bit pass 拼接，纯 JS 无外部依赖）。 */
  private static fnv1a48(str: string): number {
    // Pass 1: 标准 FNV-1a 32-bit
    let h1 = 0x811c9dc5;
    // Pass 2: offset basis = FNV prime 的模逆（减少两 pass 相关性）
    let h2 = 0x62b821d5;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c;
      h2 = Math.imul(h2, 0x01000193);
    }
    // 48-bit = h1 低 16 位（高位）拼 h2 全 32 位（低位）。
    // 不能写成 (h1>>>0) * 0x100000000 + ... 再 & 0xFFFFFFFFFFFF：
    //   - 乘积可达 ~2^64 > Number.MAX_SAFE_INTEGER，先发生精度丢失；
    //   - & 0xFFFFFFFFFFFF 经 ToInt32 截断成**有符号 32 位**，约 50% 概率
    //     产出负数 —— 违反世界快照契约（entityVersions 值须为 ≥0 整数，
    //     实测 bad_entity_version_value 契约告警 69/158 条目为负）。
    // 现实现最大值 2^48-1 ≈ 2.8e14 < 2^53，恒为非负安全整数。
    const high = (h1 >>> 0) % 0x10000;
    const low = h2 >>> 0;
    return high * 0x100000000 + low;
  }

  /** 基于对象 JSON 序列化内容的实体版本。 */
  private entityVersion(obj: unknown): number {
    return this.hash(JSON.stringify(obj));
  }

  /** 精确比较两个 entityVersions 映射（键集与每个值都需一致）。
   * DATA-FLOW 修复（2026-08-18）：a/b 可能为 null/undefined（collectState 异常分支
   * 或缺字段的存量数据）——原实现 Object.keys(null) 抛 TypeError，导致
   * 冲突中心（ConflictService.derive → isPlanStale）500。空对象防御：空 vs 空 = 相等，
   * 空 vs 非空 = 不等（视为状态变更，安全降级为 stale）。 */
  private mapsEqual(
    a: Record<string, number> | null | undefined,
    b: Record<string, number> | null | undefined,
  ): boolean {
    const aKeys = Object.keys(a ?? {});
    if (aKeys.length !== Object.keys(b ?? {}).length) return false;
    return aKeys.every((k) => (b ?? {})[k] === a[k]);
  }

  /**
   * 精确比较两个 reservations 列表（id/type/时间窗一致）。
   * NEST-150 修复（2026-08-17）：按 reservationId 建 Map 比较（顺序无关）——
   * 旧实现按数组下标配对，列表顺序变化（无 ORDER BY 的并发读）会误判 stale。
   * DATA-FLOW 同款防御（2026-08-19）：a/b 可能为 null/undefined（存量快照缺
   * reservations 键）——与 mapsEqual 同崩溃模式，空 vs 空 = 相等。
   */
  private reservationsEqual(
    a: WorldStateSnapshot['reservations'] | null | undefined,
    b: WorldStateSnapshot['reservations'] | null | undefined,
  ): boolean {
    const la = a ?? [];
    const lb = b ?? [];
    if (la.length !== lb.length) return false;
    const byId = new Map(lb.map((r) => [r.reservationId, r]));
    return la.every((ra) => {
      const rb = byId.get(ra.reservationId);
      return (
        rb != null &&
        ra.resourceId === rb.resourceId &&
        ra.resourceType === rb.resourceType &&
        ra.startMs === rb.startMs &&
        ra.endMs === rb.endMs
      );
    });
  }
}

/**
 * NO-62c：方案过期诊断契约（服务端 → 页面/运维）。字段与 `describeStaleness` 一一对应。
 */
export interface StalenessChange {
  kind: 'entity_version' | 'reservation';
  entityKey: string;
  entityType: string;
  entityId: string;
  before: number | string | null;
  after: number | string | null;
  change: 'added' | 'removed' | 'changed';
  /** true = 本方案自身执行造成的变化（不是外部干扰）。 */
  selfInflicted: boolean;
  label: string;
  /**
   * NO-64a：变化性质。
   * - `content`：事实变化（内容版本变了）→ 必须重新排程；
   * - `blocked_evidence`：本方案依赖的资源证据已过期且不可信 → 必须重新采集/重排；
   * - `evidence`：仅证据老化（与方案无关）→ **不阻断审批**，如实告知。
   */
  severity?: 'content' | 'blocked_evidence' | 'evidence';
  /** 该实体是否被本方案依赖（判断"证据老化是否与方案有关"）。 */
  usedByPlan?: boolean;
}

export interface PlanStalenessReport {
  snapshotVersion: string;
  /** false = 快照行已不存在（无法比较，只能重排）。 */
  snapshotFound: boolean;
  stale: boolean;
  changes: StalenessChange[];
  externalChangeCount?: number;
  selfInflictedCount?: number;
  /** NO-64a：事实变化数（阻断）。 */
  contentChangeCount?: number;
  /** NO-64a：仅证据老化数（不阻断）。 */
  evidenceAgedCount?: number;
  /** NO-64a：方案依赖但证据已过期的实体数（阻断）。 */
  blockedEvidenceCount?: number;
  /** NO-64a：阻断原因（null = 不阻断）。 */
  reason?: 'CONTENT_CHANGED' | 'EVIDENCE_STALE' | null;
  summary: string;
  checkedAt: string;
}

/**
 * 实体键 → 类型（`device:X` → device；`reservation:person~P-1` → reservation）。
 * 键前缀来自 `collectState`：person/task/device/route/station/zone/reservation/risk（safety_block 聚合）。
 */
function entityTypeOfKey(key: string): string {
  const index = key.indexOf(':');
  return index > 0 ? key.slice(0, index) : key;
}

/** 实体键 → 实体 id（保留 id 里的冒号，只有第一个冒号是分隔符）。 */
function entityIdOfKey(key: string): string {
  const index = key.indexOf(':');
  return index > 0 ? key.slice(index + 1) : key;
}
