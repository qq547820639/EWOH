import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc } from 'drizzle-orm';
import {
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohSpatialEntity,
  ewohWorldState,
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
  parseWorkbenchListQuery,
  queryWorkbenchList,
  type WorkbenchListQueryInput,
  type WorkbenchListResult,
} from './workbench-list-query';

export const ROLE_WORKBENCH_ROLES = WORKBENCH_ROLES;

export type RoleWorkbenchRole = (typeof ROLE_WORKBENCH_ROLES)[number];

const ACTIVE_STEP_STATUSES = ['pending', 'in_progress', 'paused'];

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function resultJson(row: { resultJson?: unknown }): Record<string, unknown> {
  return (row.resultJson as Record<string, unknown> | null) ?? {};
}

function latestStateByEntity(
  states: Array<{ entityId: string; stateJson: unknown; ts: Date }>,
) {
  const map = new Map<string, Record<string, unknown>>();
  for (const state of states) {
    if (!map.has(state.entityId)) {
      map.set(
        state.entityId,
        (state.stateJson as Record<string, unknown> | null) ?? {},
      );
    }
  }
  return map;
}

@Injectable()
export class RoleWorkbenchService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getWorkbench(
    role: string,
    personId?: string,
    actor?: OrgContext,
  ) {
    if (!ROLE_WORKBENCH_ROLES.includes(role as RoleWorkbenchRole)) {
      throw new BadRequestException(
        `role must be one of ${ROLE_WORKBENCH_ROLES.join(', ')}`,
      );
    }
    const target = role as WorkbenchRole;
    const authRoles = actor?.roles ?? [];

    // Server-side RBAC: a forged `role` query param must never grant access.
    // Only users whose auth roles authorize the target role may view it;
    // admins may additionally simulate any role.
    const canSimulate = canUseWorkbenchSimulation(authRoles);
    if (
      !canAccessWorkbenchRole(authRoles, target) &&
      !canSimulate
    ) {
      throw new ForbiddenException(
        `You are not authorized to view the '${target}' workbench`,
      );
    }

    // personId is only honored for the caller's own identity or an admin
    // simulating an operator; otherwise the request is rejected, never
    // silently downgraded.
    if (personId && personId.trim()) {
      const isSelf = Boolean(actor && personId.trim() === actor.userId);
      if (!isSelf && !canSimulate) {
        throw new ForbiddenException(
          'You may only query your own operator workbench',
        );
      }
    }

    const authorizedRoles = resolveAuthorizedWorkbenchRoles(authRoles);
    const canDebug = canUseWorkbenchDebug(authRoles);
    const simulating = target !== resolveDefaultWorkbenchRole(authRoles);

    const [tasks, steps, events, entities, states, materials] = await Promise.all([
      this.db
        .select()
        .from(ewohScheduleTask)
        .orderBy(desc(ewohScheduleTask.updatedAt))
        .limit(5000),
      this.db
        .select()
        .from(ewohScheduleTaskStep)
        .orderBy(desc(ewohScheduleTaskStep.updatedAt))
        .limit(5000),
      this.db
        .select()
        .from(ewohEvent)
        .orderBy(desc(ewohEvent.createdAt))
        .limit(5000),
      this.db
        .select()
        .from(ewohSpatialEntity)
        .orderBy(desc(ewohSpatialEntity.updatedAt))
        .limit(5000),
      this.db
        .select()
        .from(ewohWorldState)
        .orderBy(desc(ewohWorldState.ts))
        .limit(5000),
      this.db
        .select()
        .from(ewohResourceBinding)
        .orderBy(desc(ewohResourceBinding.startTime))
        .limit(5000),
    ]);

    const stateByEntity = latestStateByEntity(states);
    const now = new Date();
    const delayedOrders = tasks
      .filter(
        (task) =>
          !['completed', 'cancelled'].includes(task.status) &&
          task.planEnd &&
          task.planEnd < now,
      )
      .map((task) => ({
        scheduleTaskId: task.scheduleTaskId,
        title: task.title,
        status: task.status,
        planEnd: iso(task.planEnd),
      }));
    const qualityEvents = events.filter(
      (event) => event.eventType === 'quality',
    );
    const qualityPass = qualityEvents.filter(
      (event) =>
        (event.evidenceJson as { result?: string } | null)?.result === 'pass',
    ).length;
    const qualityFail = qualityEvents.filter(
      (event) =>
        (event.evidenceJson as { result?: string } | null)?.result !== 'pass',
    ).length;
    const defectCounts = new Map<string, number>();
    for (const event of qualityEvents) {
      const defect = String(
        (event.evidenceJson as { defectCode?: string } | null)?.defectCode ??
          'UNKNOWN',
      );
      defectCounts.set(defect, (defectCounts.get(defect) ?? 0) + 1);
    }
    const defectPareto = [...defectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([defectCode, count]) => ({ defectCode, count }));
    const deviceStates = entities
      .filter((entity) => entity.entityType === 'device')
      .map((entity) => ({
        entityId: entity.entityId,
        name: entity.name,
        status: String(stateByEntity.get(entity.entityId)?.status ?? 'unknown'),
      }));
    const faultDevices = deviceStates.filter(
      (device) => device.status === 'fault',
    );
    const idleDevices = deviceStates.filter(
      (device) => device.status === 'idle',
    );
    const exceptionSteps = steps.filter(
      (step) => Boolean(resultJson(step).exception),
    );

    let data: Record<string, unknown>;
    if (role === 'operator') {
      const assignedId = personId?.trim() || actor?.userId || '';
      const mySteps = steps.filter(
        (step) =>
          step.assignedPersonId === assignedId &&
          ACTIVE_STEP_STATUSES.includes(step.status),
      );
      data = {
        mySteps: mySteps.map((step) => ({
          stepId: step.stepId,
          scheduleTaskId: step.scheduleTaskId,
          name: step.name,
          status: step.status,
          sopPending:
            resultJson(step).sop !== undefined &&
            !(resultJson(step).sop as Record<string, unknown>).signatures,
          exception: Boolean(resultJson(step).exception),
        })),
        sopPendingCount: mySteps.filter(
          (step) =>
            resultJson(step).sop !== undefined &&
            !(resultJson(step).sop as Record<string, unknown>).signatures,
        ).length,
        exceptionCount: mySteps.filter((step) =>
          Boolean(resultJson(step).exception),
        ).length,
      };
    } else if (role === 'team_lead') {
      data = {
        delayedOrders,
        inProgressSteps: steps.filter(
          (step) => step.status === 'in_progress',
        ).length,
        materialShortage: materials.filter(
          (binding) => binding.status === 'active',
        ).length,
        qualityBlocks: qualityEvents.filter(
          (event) => event.status === 'open',
        ).length,
        escalatedExceptions: exceptionSteps.length,
      };
    } else if (role === 'quality') {
      data = {
        pendingInspections: qualityEvents.filter(
          (event) => event.status === 'open',
        ).length,
        overdueInspections: 0,
        duplicateDefects: defectPareto.filter((entry) => entry.count > 1),
        dispositions: [],
        firstPassYield:
          qualityEvents.length > 0
            ? Number((qualityPass / qualityEvents.length).toFixed(4))
            : null,
        defectPareto,
      };
    } else if (role === 'equipment') {
      data = {
        abnormalDevices: faultDevices,
        currentDowntime: faultDevices.length + idleDevices.length,
        downtimeReasons: Object.fromEntries(
          deviceStates.reduce<Map<string, number>>((counts, device) => {
            counts.set(device.status, (counts.get(device.status) ?? 0) + 1);
            return counts;
          }, new Map()),
        ),
        maintenanceTasks: [],
        capacityDegradation: [],
      };
    } else {
      data = {
        orderDeliveryRisk: delayedOrders.length,
        capacityBottleneck: steps.filter(
          (step) => step.status === 'in_progress',
        ).length,
        materialShortage: materials.length,
        qualityLoss: qualityFail,
        oeeAnomalies: faultDevices.length,
        riskTrend: [],
      };
    }

    return {
      role,
      generatedAt: now.toISOString(),
      authorizedRoles,
      canDebug,
      simulating,
      data,
    };
  }

  /**
   * Server-side paginated / filtered / sorted access to a single workbench
   * list. Re-runs the role's RBAC gate (getWorkbench) then extracts the target
   * list and applies the bounded query. Object-shaped lists (e.g. device-status
   * distributions) are normalised to `[key, value]` rows so every list can be
   * filtered and sorted uniformly.
   */
  async getWorkbenchList(
    role: string,
    listKey: string,
    query: WorkbenchListQueryInput | Record<string, unknown> = {},
    personId?: string,
    actor?: OrgContext,
  ): Promise<WorkbenchListResult> {
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
    return queryWorkbenchList(rows, columns, parseWorkbenchListQuery(query));
  }
}
