import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, asc, and, eq, ilike, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohSpatialEntity,
} from '@server/database/schema';
import type { OrgContext } from '../shared/org-context.interceptor';
import {
  canAccessWorkbenchRole,
  canUseWorkbenchDebug,
  canUseWorkbenchSimulation,
  resolveAuthorizedWorkbenchRoles,
  resolveDefaultWorkbenchRole,
  WORKBENCH_ROLES,
  type WorkbenchRole,
} from './workbench-access';
import {
  decodeWorkbenchCursor,
  encodeWorkbenchCursor,
  parseWorkbenchListQuery,
  queryWorkbenchList,
  type WorkbenchCursor,
  type WorkbenchListColumn,
  type WorkbenchListQuery,
  type WorkbenchListQueryInput,
  type WorkbenchListResult,
} from './workbench-list-query';

export const ROLE_WORKBENCH_ROLES = WORKBENCH_ROLES;

export type RoleWorkbenchRole = (typeof ROLE_WORKBENCH_ROLES)[number];

const ACTIVE_STEP_STATUSES = ['pending', 'in_progress', 'paused'];

/** Width of the aggregate reporting window (90 days). */
const AGGREGATE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type MetricStatus =
  | 'no_data'
  | 'not_configured'
  | 'permission_denied'
  | 'source_unavailable'
  | 'stale';

export interface MetricAvailability {
  value: unknown;
  status: MetricStatus;
  calculatedAt: string;
  dataRange: WorkbenchWindow;
  source: string;
}

export interface WorkbenchWindow {
  from: string;
  to: string;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function resultJson(row: { resultJson?: unknown }): Record<string, unknown> {
  return (row.resultJson as Record<string, unknown> | null) ?? {};
}

function mapStepRow(row: {
  stepId: string;
  scheduleTaskId: string;
  name: string;
  status: string;
  resultJson?: unknown;
}) {
  const result = resultJson(row);
  return {
    stepId: row.stepId,
    scheduleTaskId: row.scheduleTaskId,
    name: row.name,
    status: row.status,
    sopPending:
      result.sop !== undefined &&
      !(result.sop as Record<string, unknown> | null)?.signatures,
    exception: Boolean(result.exception),
  };
}

@Injectable()
export class RoleWorkbenchService {
  private readonly logger = new Logger(RoleWorkbenchService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getWorkbench(
    role: string,
    personId?: string,
    actor?: OrgContext,
  ) {
    const { target, authRoles, canSimulate } = this.assertWorkbenchAccess(role, personId, actor);
    const authorizedRoles = resolveAuthorizedWorkbenchRoles(authRoles);
    const canDebug = canUseWorkbenchDebug(authRoles);
    const simulating = target !== resolveDefaultWorkbenchRole(authRoles);

    const orgId = actor?.primaryOrgId ?? '';
    const sourceAvailable = Boolean(orgId);
    const calculatedAt = new Date();
    const dataRange: WorkbenchWindow = {
      from: new Date(calculatedAt.getTime() - AGGREGATE_WINDOW_MS).toISOString(),
      to: calculatedAt.toISOString(),
    };

    let data: Record<string, unknown>;
    if (role === 'operator') {
      data = await this.operatorData(
        orgId,
        personId?.trim() || actor?.userId || '',
        sourceAvailable,
        dataRange,
      );
    } else if (role === 'team_lead') {
      data = await this.teamLeadData(orgId, sourceAvailable, dataRange);
    } else if (role === 'quality') {
      data = await this.qualityData(orgId, sourceAvailable, dataRange);
    } else if (role === 'equipment') {
      data = await this.equipmentData(orgId, sourceAvailable, dataRange);
    } else {
      data = await this.managerData(orgId, sourceAvailable, dataRange);
    }

    return {
      role,
      generatedAt: calculatedAt.toISOString(),
      dataFreshness: calculatedAt.toISOString(),
      authorizedRoles,
      canDebug,
      simulating,
      data,
    };
  }

  // ---------------------------------------------------------------------
  // Database-backed aggregate metrics. Every query is parameterised and
  // org-scoped; aggregates are computed in SQL, never by loading full tables.
  // ---------------------------------------------------------------------

  private async countWhere(table: PgTable, where?: SQL): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(where);
    return rows[0]?.count ?? 0;
  }

  private availability(
    status: MetricStatus,
    value: unknown,
    source: string,
    dataRange: WorkbenchWindow,
  ): MetricAvailability {
    return { value, status, calculatedAt: new Date().toISOString(), dataRange, source };
  }

  private hasAvailability(v: unknown): v is MetricAvailability {
    return (
      !!v &&
      typeof v === 'object' &&
      'status' in (v as Record<string, unknown>) &&
      'source' in (v as Record<string, unknown>)
    );
  }

  /**
   * Runs a single workbench aggregate, returning a per-metric availability
   * marker instead of throwing when the org scope is missing or the query
   * fails, so one bad table never takes down the whole dashboard. Failures
   * are logged, never swallowed silently.
   */
  private async guarded<T>(
    orgId: string,
    source: string,
    sourceAvailable: boolean,
    dataRange: WorkbenchWindow,
    fn: () => Promise<T>,
  ): Promise<T | MetricAvailability> {
    if (!sourceAvailable) {
      return this.availability('source_unavailable', null, source, dataRange);
    }
    try {
      return await fn();
    } catch (err) {
      this.logger.error(`Workbench aggregate '${source}' failed`, err as Error);
      return this.availability('source_unavailable', null, source, dataRange);
    }
  }

  /** operator: caller-owned active steps with SOP / exception flags. */
  private async operatorData(
    orgId: string,
    assignedId: string,
    sourceAvailable: boolean,
    dataRange: WorkbenchWindow,
  ): Promise<Record<string, unknown>> {
    const mySteps = await this.guarded(orgId, 'mySteps', sourceAvailable, dataRange, async () => {
      if (!assignedId) return [];
      const rows = await this.db
        .select({
          stepId: ewohScheduleTaskStep.stepId,
          scheduleTaskId: ewohScheduleTaskStep.scheduleTaskId,
          name: ewohScheduleTaskStep.name,
          status: ewohScheduleTaskStep.status,
          resultJson: ewohScheduleTaskStep.resultJson,
        })
        .from(ewohScheduleTaskStep)
        .where(
          and(
            eq(ewohScheduleTaskStep.orgId, orgId),
            eq(ewohScheduleTaskStep.assignedPersonId, assignedId),
            inArray(ewohScheduleTaskStep.status, ACTIVE_STEP_STATUSES),
          ),
        )
        .orderBy(desc(ewohScheduleTaskStep.updatedAt))
        .limit(2000);
      return rows.map(mapStepRow);
    });

    if (this.hasAvailability(mySteps)) {
      return {
        mySteps,
        sopPendingCount: mySteps,
        exceptionCount: mySteps,
      };
    }
    const list = mySteps as ReturnType<typeof mapStepRow>[];
    return {
      mySteps,
      sopPendingCount: list.filter((step) => step.sopPending).length,
      exceptionCount: list.filter((step) => step.exception).length,
    };
  }

  private async teamLeadData(
    orgId: string,
    sourceAvailable: boolean,
    dataRange: WorkbenchWindow,
  ): Promise<Record<string, unknown>> {
    return {
      delayedOrders: await this.guarded(orgId, 'delayedOrders', sourceAvailable, dataRange, () =>
        this.loadDelayedOrders(orgId),
      ),
      inProgressSteps: await this.guarded(orgId, 'inProgressSteps', sourceAvailable, dataRange, () =>
        this.countStepsInProgress(orgId),
      ),
      materialShortage: await this.guarded(orgId, 'materialShortage', sourceAvailable, dataRange, () =>
        this.countActiveBindings(orgId),
      ),
      qualityBlocks: await this.guarded(orgId, 'qualityBlocks', sourceAvailable, dataRange, () =>
        this.countOpenQualityEvents(orgId),
      ),
      escalatedExceptions: await this.guarded(orgId, 'escalatedExceptions', sourceAvailable, dataRange, () =>
        this.countEscalatedSteps(orgId),
      ),
    };
  }

  private async qualityData(
    orgId: string,
    sourceAvailable: boolean,
    dataRange: WorkbenchWindow,
  ): Promise<Record<string, unknown>> {
    const pending = await this.guarded(orgId, 'pendingInspections', sourceAvailable, dataRange, () =>
      this.countOpenQualityEvents(orgId),
    );
    const quality = await this.guarded(orgId, 'qualityMetrics', sourceAvailable, dataRange, () =>
      this.countQualityPassFail(orgId),
    );
    const pareto = await this.guarded(orgId, 'defectPareto', sourceAvailable, dataRange, () =>
      this.loadDefectPareto(orgId),
    );

    let firstPassYield: unknown = quality;
    let duplicateDefects: unknown = pareto;
    if (!this.hasAvailability(quality)) {
      const { total, pass } = quality;
      firstPassYield = total > 0 ? Number((pass / total).toFixed(4)) : null;
      duplicateDefects = this.hasAvailability(pareto)
        ? pareto
        : pareto.filter((entry) => entry.count > 1);
    }

    return {
      pendingInspections: pending,
      // No reliable inspection SLA window is defined in the domain model, so
      // this is declared honestly rather than fabricated.
      overdueInspections: this.availability('no_data', null, 'ewoh_event', dataRange),
      duplicateDefects,
      // No disposition workflow exists in the domain model yet.
      dispositions: this.availability('no_data', null, 'none', dataRange),
      firstPassYield,
      defectPareto: pareto,
    };
  }

  private async equipmentData(
    orgId: string,
    sourceAvailable: boolean,
    dataRange: WorkbenchWindow,
  ): Promise<Record<string, unknown>> {
    const distribution = await this.guarded(
      orgId,
      'deviceStatusDistribution',
      sourceAvailable,
      dataRange,
      () => this.loadDeviceStatusDistribution(orgId),
    );
    let abnormalDevices: unknown = distribution;
    let currentDowntime: unknown = distribution;
    let downtimeReasons: unknown = distribution;
    if (!this.hasAvailability(distribution)) {
      abnormalDevices = distribution.fault;
      currentDowntime = distribution.fault + distribution.idle;
      downtimeReasons = distribution.reasons;
    }
    return {
      abnormalDevices,
      currentDowntime,
      downtimeReasons,
      // No maintenance task domain table is wired to the workbench yet.
      maintenanceTasks: this.availability('no_data', null, 'none', dataRange),
      capacityDegradation: this.availability('no_data', null, 'none', dataRange),
    };
  }

  private async managerData(
    orgId: string,
    sourceAvailable: boolean,
    dataRange: WorkbenchWindow,
  ): Promise<Record<string, unknown>> {
    return {
      orderDeliveryRisk: await this.guarded(orgId, 'orderDeliveryRisk', sourceAvailable, dataRange, () =>
        this.countDelayedOrders(orgId),
      ),
      capacityBottleneck: await this.guarded(orgId, 'capacityBottleneck', sourceAvailable, dataRange, () =>
        this.countStepsInProgress(orgId),
      ),
      materialShortage: await this.guarded(orgId, 'materialShortage', sourceAvailable, dataRange, () =>
        this.countAllBindings(orgId),
      ),
      qualityLoss: await this.guarded(orgId, 'qualityLoss', sourceAvailable, dataRange, () =>
        this.countQualityFail(orgId),
      ),
      oeeAnomalies: await this.guarded(orgId, 'oeeAnomalies', sourceAvailable, dataRange, () =>
        this.countFaultDevices(orgId),
      ),
      riskTrend: this.availability('no_data', null, 'none', dataRange),
    };
  }

  private async loadDelayedOrders(orgId: string) {
    const rows = await this.db
      .select({
        scheduleTaskId: ewohScheduleTask.scheduleTaskId,
        title: ewohScheduleTask.title,
        status: ewohScheduleTask.status,
        planEnd: ewohScheduleTask.planEnd,
      })
      .from(ewohScheduleTask)
      .where(this.delayedOrderWhere(orgId))
      .orderBy(asc(ewohScheduleTask.planEnd))
      .limit(2000);
    return rows.map((row) => ({
      scheduleTaskId: row.scheduleTaskId,
      title: row.title,
      status: row.status,
      planEnd: iso(row.planEnd),
    }));
  }

  private countDelayedOrders(orgId: string): Promise<number> {
    return this.countWhere(ewohScheduleTask, this.delayedOrderWhere(orgId));
  }

  private delayedOrderWhere(orgId: string): SQL {
    return and(
      eq(ewohScheduleTask.orgId, orgId),
      notInArray(ewohScheduleTask.status, ['completed', 'cancelled']),
      isNotNull(ewohScheduleTask.planEnd),
      sql`${ewohScheduleTask.planEnd} < now()`,
    ) as SQL;
  }

  private countStepsInProgress(orgId: string): Promise<number> {
    return this.countWhere(
      ewohScheduleTaskStep,
      and(eq(ewohScheduleTaskStep.orgId, orgId), eq(ewohScheduleTaskStep.status, 'in_progress')),
    );
  }

  private countActiveBindings(orgId: string): Promise<number> {
    return this.countWhere(
      ewohResourceBinding,
      and(eq(ewohResourceBinding.orgId, orgId), eq(ewohResourceBinding.status, 'active')),
    );
  }

  private countAllBindings(orgId: string): Promise<number> {
    return this.countWhere(ewohResourceBinding, eq(ewohResourceBinding.orgId, orgId));
  }

  private countOpenQualityEvents(orgId: string): Promise<number> {
    return this.countWhere(
      ewohEvent,
      and(
        eq(ewohEvent.orgId, orgId),
        eq(ewohEvent.status, 'open'),
        eq(ewohEvent.eventType, 'quality'),
      ),
    );
  }

  private countEscalatedSteps(orgId: string): Promise<number> {
    return this.countWhere(
      ewohScheduleTaskStep,
      and(
        eq(ewohScheduleTaskStep.orgId, orgId),
        sql`${ewohScheduleTaskStep.resultJson}->>'exception' IS NOT NULL AND ${ewohScheduleTaskStep.resultJson}->>'exception' <> ''`,
      ),
    );
  }

  private async countQualityPassFail(orgId: string) {
    const rows = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        pass: sql<number>`count(*) filter (where ${ewohEvent.evidenceJson}->>'result' = 'pass')::int`,
        fail: sql<number>`count(*) filter (where ${ewohEvent.evidenceJson}->>'result' = 'fail')::int`,
      })
      .from(ewohEvent)
      .where(and(eq(ewohEvent.orgId, orgId), eq(ewohEvent.eventType, 'quality')));
    const row = rows[0];
    return { total: row?.total ?? 0, pass: row?.pass ?? 0, fail: row?.fail ?? 0 };
  }

  private async countQualityFail(orgId: string): Promise<number> {
    const { fail } = await this.countQualityPassFail(orgId);
    return fail;
  }

  private async loadDefectPareto(orgId: string) {
    const rows = await this.db
      .select({
        defectCode: sql<string>`${ewohEvent.evidenceJson}->>'defectCode'`,
        count: sql<number>`count(*)::int`,
      })
      .from(ewohEvent)
      .where(and(eq(ewohEvent.orgId, orgId), eq(ewohEvent.eventType, 'quality')))
      .groupBy(sql`${ewohEvent.evidenceJson}->>'defectCode'`)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
    return rows.map((row) => ({ defectCode: row.defectCode ?? 'UNKNOWN', count: row.count }));
  }

  private async loadDeviceStatusDistribution(orgId: string) {
    const rows = await this.db
      .select({
        status: ewohSpatialEntity.status,
        count: sql<number>`count(*)::int`,
      })
      .from(ewohSpatialEntity)
      .where(and(eq(ewohSpatialEntity.orgId, orgId), eq(ewohSpatialEntity.entityType, 'device')))
      .groupBy(ewohSpatialEntity.status);

    const reasons: Record<string, number> = {};
    let fault = 0;
    let idle = 0;
    for (const row of rows) {
      const status = String(row.status ?? 'unknown');
      reasons[status] = row.count;
      if (status === 'fault') fault = row.count;
      else if (status === 'idle') idle = row.count;
    }
    return { fault, idle, reasons };
  }

  private countFaultDevices(orgId: string): Promise<number> {
    return this.countWhere(
      ewohSpatialEntity,
      and(
        eq(ewohSpatialEntity.orgId, orgId),
        eq(ewohSpatialEntity.entityType, 'device'),
        eq(ewohSpatialEntity.status, 'fault'),
      ),
    );
  }

  /**
   * Server-side paginated / filtered / sorted access to a single workbench
   * list. Re-runs the role's RBAC gate then executes a REAL PostgreSQL query
   * (parameterised WHERE including mandatory org_id + ORDER BY + LIMIT) with
   * both accurate COUNT (offset mode) and stable keyset cursor pagination
   * (cursor mode). Object-shaped lists (e.g. device-status distributions)
   * are normalised to `[key, value]` rows so every list can be filtered and
   * sorted uniformly.
   */
  async getWorkbenchList(
    role: string,
    listKey: string,
    query: WorkbenchListQueryInput | Record<string, unknown> = {},
    personId?: string,
    actor?: OrgContext,
  ): Promise<WorkbenchListResult> {
    this.assertWorkbenchAccess(role, personId, actor);
    const orgId = actor?.primaryOrgId ?? '';
    const parsed = parseWorkbenchListQuery(query);

    const source = LIST_SOURCES[listKey];
    if (source && orgId) {
      return this.queryPgList(source, parsed, orgId, personId ?? actor?.userId);
    }

    // Fallback for object-shaped lists / missing org context: normalise the
    // dashboard-produced rows and paginate in memory (bounded, never a full
    // table scan of the workbench source tables).
    const workbench = await this.getWorkbench(role, personId, actor);
    const raw = (workbench.data as Record<string, unknown>)[listKey];
    let rows: Array<Record<string, unknown>> = [];
    if (Array.isArray(raw)) {
      rows = raw as Array<Record<string, unknown>>;
    } else if (raw && typeof raw === 'object') {
      rows = Object.entries(raw as Record<string, unknown>).map(
        ([key, value]) => ({ key, value }),
      );
    }
    const columns =
      rows.length > 0
        ? Object.keys(rows[0]).map((key) => ({ key, label: key }))
        : [];
    return queryWorkbenchList(rows, columns, parsed);
  }

  /**
   * Server-side RBAC gate shared by the dashboard and every list query. A
   * forged `role` param must never grant access; `personId` is only honoured
   * for the caller's own identity or an admin simulating an operator.
   */
  private assertWorkbenchAccess(
    role: string,
    personId?: string,
    actor?: OrgContext,
  ): { target: WorkbenchRole; authRoles: string[]; canSimulate: boolean } {
    if (!ROLE_WORKBENCH_ROLES.includes(role as RoleWorkbenchRole)) {
      throw new BadRequestException(
        `role must be one of ${ROLE_WORKBENCH_ROLES.join(', ')}`,
      );
    }
    const target = role as WorkbenchRole;
    const authRoles = actor?.roles ?? [];
    const canSimulate = canUseWorkbenchSimulation(authRoles);
    if (!canAccessWorkbenchRole(authRoles, target) && !canSimulate) {
      throw new ForbiddenException(
        `You are not authorized to view the '${target}' workbench`,
      );
    }
    if (personId && personId.trim()) {
      const isSelf = Boolean(actor && personId.trim() === actor.userId);
      if (!isSelf && !canSimulate) {
        throw new ForbiddenException(
          'You may only query your own operator workbench',
        );
      }
    }
    return { target, authRoles, canSimulate };
  }

  /**
   * Executes a real PostgreSQL keyset/offset query for a tabular list. The
   * WHERE clause always includes a mandatory `org_id` predicate plus any
   * role/list-specific filters; the ORDER BY is `(sortColumn, uniqueColumn)`
   * so cursor pagination is stable and duplicate-safe even with equal sort
   * values. `total` is an accurate COUNT (never a full-table read).
   */
  private async queryPgList<T>(
    source: WorkbenchPgListSource,
    query: WorkbenchListQuery,
    orgId: string,
    personId?: string,
  ): Promise<WorkbenchListResult<T>> {
    const sort =
      (query.sortKey && source.sortable[query.sortKey]
        ? source.sortable[query.sortKey]
        : source.defaultSort) ?? source.defaultSort;
    const dir: 'asc' | 'desc' = query.sortDir ?? sort.dir;
    const sortCol = sort.column;
    const uniqueCol = source.uniqueColumn;

    const filters = [eq(source.orgColumn, orgId)];
    if (source.statusColumn && source.activeStatuses) {
      filters.push(inArray(source.statusColumn, source.activeStatuses));
    }
    if (source.personColumn && personId) {
      filters.push(eq(source.personColumn, personId));
    }
    if (source.extraWhere) {
      filters.push(source.extraWhere());
    }
    if (query.filter && source.searchableColumn) {
      filters.push(
        ilike(source.searchableColumn, `%${query.filter.replace(/[%_]/g, '\\$&')}%`),
      );
    }

    const baseWhere = and(...filters);

    // Accurate total for the current (org + status + search + person) predicate.
    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(source.table)
      .where(baseWhere);
    const total = countRows[0]?.count ?? 0;

    if (query.cursor) {
      const decoded = decodeWorkbenchCursor(query.cursor);
      if (!decoded) {
        return this.emptyResult<T>(query, total);
      }
      const cursorWhere = this.cursorPredicate(sortCol, uniqueCol, decoded, dir);
      const rows = await this.db
        .select()
        .from(source.table)
        .where(and(baseWhere, cursorWhere))
        .orderBy(dir === 'asc' ? asc(sortCol) : desc(sortCol), asc(uniqueCol))
        .limit(query.pageSize + 1);
      const hasMore = rows.length > query.pageSize;
      const pageRows = hasMore ? rows.slice(0, query.pageSize) : rows;
      const items = pageRows.map(source.mapRow) as T[];
      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeWorkbenchCursor({
              sortValue: String((last as Record<string, unknown>)[sort.key] ?? ''),
              id: String((last as Record<string, unknown>)[source.uniqueKey] ?? ''),
            } satisfies WorkbenchCursor)
          : null;
      return {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore,
        hasNextPage: hasMore,
        nextCursor,
        status: 'ok',
        dataFreshness: new Date().toISOString(),
      };
    }

    // Offset mode.
    const rows = await this.db
      .select()
      .from(source.table)
      .where(baseWhere)
      .orderBy(dir === 'asc' ? asc(sortCol) : desc(sortCol), asc(uniqueCol))
      .limit(query.pageSize)
      .offset(query.offset);
    const items = rows.map(source.mapRow) as T[];
    const hasMore = query.offset + query.pageSize < total;
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore,
      hasNextPage: hasMore,
      nextCursor: null,
      status: 'ok',
      dataFreshness: new Date().toISOString(),
    };
  }

  /** Builds the keyset row-comparison predicate: (sortCol, uniqueCol) beyond cursor. */
  private cursorPredicate(
    sortCol: WorkbenchColumnRef,
    uniqueCol: WorkbenchColumnRef,
    cursor: WorkbenchCursor,
    dir: 'asc' | 'desc',
  ): SQL {
    const cv = cursor.sortValue;
    const id = cursor.id;
    if (dir === 'asc') {
      return sql`(${sortCol} > ${cv}) OR (${sortCol} = ${cv} AND ${uniqueCol} > ${id})`;
    }
    return sql`(${sortCol} < ${cv}) OR (${sortCol} = ${cv} AND ${uniqueCol} > ${id})`;
  }

  private emptyResult<T>(
    query: WorkbenchListQuery,
    total: number,
  ): WorkbenchListResult<T> {
    return {
      items: [],
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: false,
      hasNextPage: false,
      nextCursor: null,
      status: 'ok',
      dataFreshness: new Date().toISOString(),
    };
  }
}

/** A column reference we can build predicates/order-by against. */
export type WorkbenchColumnRef = PgColumn;

/** A single tabular list backed directly by a PostgreSQL table. */
export interface WorkbenchPgListSource {
  table: PgTable;
  orgColumn: WorkbenchColumnRef;
  uniqueColumn: WorkbenchColumnRef;
  /** JS row key of the unique column (used to build the keyset cursor). */
  uniqueKey: string;
  personColumn?: WorkbenchColumnRef;
  statusColumn?: WorkbenchColumnRef;
  activeStatuses?: string[];
  searchableColumn?: WorkbenchColumnRef;
  extraWhere?: () => SQL;
  sortable: Record<string, { column: WorkbenchColumnRef; key: string; type: 'text' | 'timestamptz' | 'number'; dir: 'asc' | 'desc' }>;
  defaultSort: { column: WorkbenchColumnRef; key: string; type: 'text' | 'timestamptz' | 'number'; dir: 'asc' | 'desc' };
  mapRow: (row: Record<string, unknown>) => Record<string, unknown>;
  columns: WorkbenchListColumn[];
}

const LIST_SOURCES: Record<string, WorkbenchPgListSource> = {
  mySteps: {
    table: ewohScheduleTaskStep,
    orgColumn: ewohScheduleTaskStep.orgId,
    uniqueColumn: ewohScheduleTaskStep.stepId,
    uniqueKey: 'stepId',
    personColumn: ewohScheduleTaskStep.assignedPersonId,
    statusColumn: ewohScheduleTaskStep.status,
    activeStatuses: ACTIVE_STEP_STATUSES,
    searchableColumn: ewohScheduleTaskStep.name,
    sortable: {
      name: { column: ewohScheduleTaskStep.name, key: 'name', type: 'text', dir: 'asc' },
      status: { column: ewohScheduleTaskStep.status, key: 'status', type: 'text', dir: 'asc' },
      scheduleTaskId: { column: ewohScheduleTaskStep.scheduleTaskId, key: 'scheduleTaskId', type: 'text', dir: 'asc' },
    },
    defaultSort: { column: ewohScheduleTaskStep.updatedAt, key: 'updatedAt', type: 'timestamptz', dir: 'desc' },
    mapRow: (row) => {
      const result = resultJson(row);
      return {
        stepId: row.step_id,
        scheduleTaskId: row.schedule_task_id,
        name: row.name,
        status: row.status,
        sopPending:
          result.sop !== undefined &&
          !(result.sop as Record<string, unknown> | null)?.signatures,
        exception: Boolean(result.exception),
      };
    },
    columns: [
      { key: 'name', label: '工序' },
      { key: 'scheduleTaskId', label: '工单号' },
      { key: 'status', label: '状态' },
      { key: 'sopPending', label: 'SOP 待签' },
      { key: 'exception', label: '异常' },
    ],
  },
  delayedOrders: {
    table: ewohScheduleTask,
    orgColumn: ewohScheduleTask.orgId,
    uniqueColumn: ewohScheduleTask.scheduleTaskId,
    uniqueKey: 'scheduleTaskId',
    statusColumn: ewohScheduleTask.status,
    activeStatuses: ['draft', 'pending', 'in_progress', 'paused'],
    searchableColumn: ewohScheduleTask.title,
    extraWhere: () =>
      sql`${ewohScheduleTask.planEnd} IS NOT NULL AND ${ewohScheduleTask.planEnd} < now()`,
    sortable: {
      scheduleTaskId: { column: ewohScheduleTask.scheduleTaskId, key: 'scheduleTaskId', type: 'text', dir: 'asc' },
      title: { column: ewohScheduleTask.title, key: 'title', type: 'text', dir: 'asc' },
      status: { column: ewohScheduleTask.status, key: 'status', type: 'text', dir: 'asc' },
      planEnd: { column: ewohScheduleTask.planEnd, key: 'planEnd', type: 'timestamptz', dir: 'asc' },
    },
    defaultSort: { column: ewohScheduleTask.planEnd, key: 'planEnd', type: 'timestamptz', dir: 'asc' },
    mapRow: (row) => ({
      scheduleTaskId: row.schedule_task_id,
      title: row.title,
      status: row.status,
      planEnd: iso(row.plan_end as Date | string | null),
    }),
    columns: [
      { key: 'scheduleTaskId', label: '工单号' },
      { key: 'title', label: '标题' },
      { key: 'status', label: '状态' },
      { key: 'planEnd', label: '计划完成' },
    ],
  },
  abnormalDevices: {
    table: ewohSpatialEntity,
    orgColumn: ewohSpatialEntity.orgId,
    uniqueColumn: ewohSpatialEntity.entityId,
    uniqueKey: 'entityId',
    statusColumn: ewohSpatialEntity.status,
    activeStatuses: ['fault'],
    searchableColumn: ewohSpatialEntity.name,
    extraWhere: () => sql`${ewohSpatialEntity.entityType} = 'device'`,
    sortable: {
      name: { column: ewohSpatialEntity.name, key: 'name', type: 'text', dir: 'asc' },
      entityId: { column: ewohSpatialEntity.entityId, key: 'entityId', type: 'text', dir: 'asc' },
      status: { column: ewohSpatialEntity.status, key: 'status', type: 'text', dir: 'asc' },
    },
    defaultSort: { column: ewohSpatialEntity.name, key: 'name', type: 'text', dir: 'asc' },
    mapRow: (row) => ({
      entityId: row.entity_id,
      name: row.name,
      status: row.status,
    }),
    columns: [
      { key: 'entityId', label: '设备' },
      { key: 'name', label: '名称' },
      { key: 'status', label: '状态' },
    ],
  },
  pendingInspections: {
    table: ewohEvent,
    orgColumn: ewohEvent.orgId,
    uniqueColumn: ewohEvent.eventId,
    uniqueKey: 'eventId',
    statusColumn: ewohEvent.status,
    activeStatuses: ['open'],
    searchableColumn: ewohEvent.title,
    extraWhere: () => sql`${ewohEvent.eventType} = 'quality'`,
    sortable: {
      eventId: { column: ewohEvent.eventId, key: 'eventId', type: 'text', dir: 'asc' },
      title: { column: ewohEvent.title, key: 'title', type: 'text', dir: 'asc' },
      status: { column: ewohEvent.status, key: 'status', type: 'text', dir: 'asc' },
      createdAt: { column: ewohEvent.createdAt, key: 'createdAt', type: 'timestamptz', dir: 'desc' },
    },
    defaultSort: { column: ewohEvent.createdAt, key: 'createdAt', type: 'timestamptz', dir: 'desc' },
    mapRow: (row) => ({
      eventId: row.event_id,
      title: row.title,
      status: row.status,
      createdAt: iso(row.created_at as Date | string | null),
    }),
    columns: [
      { key: 'eventId', label: '事件' },
      { key: 'title', label: '标题' },
      { key: 'status', label: '状态' },
      { key: 'createdAt', label: '时间' },
    ],
  },
};
