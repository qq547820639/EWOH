import { Injectable, Logger } from '@nestjs/common';
import type {
  SchedulingAssignment,
  SchedulingPlanV2,
  SchedulingPlanMetrics,
  SchedulingPolicy,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { EligibilityService } from './eligibility.service';
import { RoutingService } from './routing.service';

/** 求解器输入约束（来自重排/锁定）。 */
export interface SolverConstraint {
  taskId?: string;
  personId?: string;
  deviceId?: string;
  stationId?: string;
  zoneId?: string;
  type?: string;
}

export interface SolveOptions {
  planId: string;
  planName?: string;
  triggerType: string;
  triggerEntityId: string | null;
  snapshotVersion: string;
  horizonMinutes: number;
  baselineAssignee?: Map<string, string | null>;
}

interface Candidate {
  personId: string;
  deviceId: string | null;
  stationId: string | null;
  zoneId: string | null;
  startMs: number;
  endMs: number;
  walkingMeters: number;
  waitMinutes: number;
  lateMinutes: number;
  changeCost: number;
  cost: number;
  reasons: string[];
  alternatives: Array<Record<string, unknown>>;
}

const DEFAULT_DURATION_MS = 30 * 60 * 1000;

/**
 * 确定性启发式求解器（无 LLM）。
 * 输入世界状态快照 + 资格服务 + 路由服务 + 策略权重 + 锁定约束，
 * 执行 任务×人员×设备×时间窗 的联合调度。
 */
@Injectable()
export class SolverService {
  private readonly logger = new Logger(SolverService.name);

  constructor(
    private readonly eligibilityService: EligibilityService,
    private readonly routingService: RoutingService,
  ) {}

  /** 用三种策略权重生成方案 A/B/C。 */
  async solveVariants(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2[]> {
    const base: SchedulingPolicy = {
      latenessWeight: 1,
      walkingWeight: 1,
      workloadBalanceWeight: 1,
      stationWaitWeight: 1,
      changeCostWeight: 1,
    };
    const variants: Array<{ suffix: string; label: string; policy: SchedulingPolicy }> = [
      {
        suffix: 'A',
        label: '准时优先',
        policy: { ...base, latenessWeight: 3, changeCostWeight: 0.5 },
      },
      {
        suffix: 'B',
        label: '负荷均衡',
        policy: { ...base, workloadBalanceWeight: 3, walkingWeight: 1.5, latenessWeight: 0.5 },
      },
      {
        suffix: 'C',
        label: '均衡',
        policy: { ...base },
      },
    ];

    const plans: SchedulingPlanV2[] = [];
    for (const variant of variants) {
      const plan = await this.solve(snapshot, constraints, {
        ...opts,
        planId: `${opts.planId}${variant.suffix}`,
        planName: variant.label,
        policy: variant.policy,
      });
      plans.push(plan);
    }
    return plans;
  }

  /** 单次求解，返回一个完整方案。 */
  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SolverConstraint[],
    opts: SolveOptions & { policy: SchedulingPolicy },
  ): Promise<SchedulingPlanV2> {
    const now = Date.now();
    const horizonEndMs = now + opts.horizonMinutes * 60 * 1000;
    const policy = opts.policy;

    const doneTaskIds = new Set<string>(
      snapshot.tasks
        .filter((t) => ['completed', 'done'].includes(t.status))
        .map((t) => t.id),
    );

    // 锁定约束：LOCKED_PERSON 强制指定人员，LOCKED_DEVICE 强制指定设备。
    const lockedPersonByTask = new Map<string, string>();
    const lockedDeviceByTask = new Map<string, string>();
    for (const c of constraints) {
      if (c.type === 'LOCKED_PERSON' && c.taskId && c.personId)
        lockedPersonByTask.set(c.taskId, c.personId);
      if (c.type === 'LOCKED_DEVICE' && c.taskId && c.deviceId)
        lockedDeviceByTask.set(c.taskId, c.deviceId);
    }

    const eligibleTasks = snapshot.tasks
      .filter((t) => ['draft', 'pending', 'queued'].includes(t.status))
      .sort((a, b) => this.priorityRank(a.priority) - this.priorityRank(b.priority));

    const assignments: SchedulingAssignment[] = [];
    const violations: Array<Record<string, unknown>> = [];
    const bookedPerson = new Map<string, number>(); // personId -> last end ms
    const bookedDevice = new Map<string, number>(); // deviceId -> last end ms
    const assignedMinutes = new Map<string, number>(); // personId -> total assigned ms
    const personById = new Map(snapshot.persons.map((p) => [p.id, p]));
    const deviceById = new Map(snapshot.devices.map((d) => [d.id, d]));
    const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));

    let totalWalking = 0;
    let totalLateMs = 0;
    let totalWaitMs = 0;
    let totalChange = 0;

    for (const task of eligibleTasks) {
      const deadlineMs = task.planEnd ? Date.parse(task.planEnd) : horizonEndMs;
      const earliestStartMs = Math.max(
        now,
        task.planStart ? Date.parse(task.planStart) : now,
      );

      // 前置任务未完成 → 记 violation 并跳过。
      const predPending = task.predecessorIds.some((p) => !doneTaskIds.has(p));
      if (predPending) {
        violations.push({
          taskId: task.id,
          reason: 'predecessor_pending',
          type: 'infeasible',
        });
        continue;
      }

      const taskStation = task.stationId ? stationById.get(task.stationId) : null;
      const candidates: Candidate[] = [];

      const candidatePersons = snapshot.persons.filter((p) =>
        this.personMatchesLock(p.id, task.id, lockedPersonByTask),
      );

      for (const person of candidatePersons) {
        const personStation = person.stationId ? stationById.get(person.stationId) : null;
        const walkingMeters = this.estimateWalking(personStation, taskStation);
        const walkingMs = walkingMeters * 1000; // 1 m/s 的粗略步行时间

        const deviceCandidates = this.devicesForTask(task, deviceById, lockedDeviceByTask);
        for (const device of deviceCandidates) {
          const eligibility = this.eligibilityService.check(
            {
              id: person.id,
              status: person.status,
              skills: person.skills,
              certifications: [],
              stationId: person.stationId,
              loadLevel: person.loadLevel,
              fatigueLevel: person.fatigueLevel,
              healthStatus: person.healthStatus,
            },
            {
              id: task.id,
              taskType: task.taskType,
              requiredSkills: [task.taskType],
              requiredCertifications: [],
              stationId: task.stationId,
              zoneId: task.zoneId,
              predIds: task.predecessorIds,
            },
            device
              ? {
                  id: device.id,
                  batteryPct: device.batteryPct,
                  online: device.online,
                  status: device.status,
                }
              : null,
            {
              now,
              bookedTimeSlots: [],
              lockedPersonIds: snapshot.lockedAssignments
                .filter((la) => la.taskId !== task.id)
                .map((la) => la.personId ?? '')
                .filter(Boolean),
              forbiddenZones: snapshot.forbiddenZones.map((f) => f.zoneId),
              minBatteryPct: 15,
              maxContinuousLoad: 0.9,
              safetyBlockedPersonIds: snapshot.events
                .filter((e) => e.severity === 'L3' && e.status === 'open')
                .map(() => ''),
              predecessorDone: (id) => doneTaskIds.has(id),
            },
          );

          if (!eligibility.eligible) {
            candidates.push({
              personId: person.id,
              deviceId: device ? device.id : null,
              stationId: task.stationId,
              zoneId: task.zoneId,
              startMs: 0,
              endMs: 0,
              walkingMeters,
              waitMinutes: 0,
              lateMinutes: 0,
              changeCost: 0,
              cost: Number.POSITIVE_INFINITY,
              reasons: eligibility.reasons,
              alternatives: [{ reasons: eligibility.reasons }],
            });
            continue;
          }

          const startMs = this.earliestStart(
            earliestStartMs + walkingMs,
            bookedPerson.get(person.id),
            device ? bookedDevice.get(device.id) : undefined,
          );
          const durationMs = task.planEnd && task.planStart
            ? Date.parse(task.planEnd) - Date.parse(task.planStart)
            : DEFAULT_DURATION_MS;
          const endMs = startMs + Math.max(durationMs, 1);

          const lateMs = Math.max(0, endMs - deadlineMs);
          const waitMs = Math.max(0, startMs - earliestStartMs);
          const baselineAssignee = opts.baselineAssignee?.get(task.id);
          const changeCost = baselineAssignee && baselineAssignee !== person.id ? 1 : 0;
          const currentPersonLoad = person.loadLevel ?? 0;

          const cost =
            policy.latenessWeight * lateMs +
            policy.walkingWeight * walkingMeters * 1000 +
            policy.workloadBalanceWeight * currentPersonLoad * 60 * 1000 +
            policy.stationWaitWeight * waitMs +
            policy.changeCostWeight * changeCost * 60 * 1000;

          candidates.push({
            personId: person.id,
            deviceId: device ? device.id : null,
            stationId: task.stationId,
            zoneId: task.zoneId,
            startMs,
            endMs,
            walkingMeters,
            waitMinutes: waitMs / 60000,
            lateMinutes: lateMs / 60000,
            changeCost,
            cost,
            reasons: [],
            alternatives: [],
          });
        }
      }

      const feasible = candidates
        .filter((c) => c.cost !== Number.POSITIVE_INFINITY)
        .sort((a, b) => a.cost - b.cost);
      const best = feasible[0];

      if (!best) {
        violations.push({
          taskId: task.id,
          reason: 'no_eligible_resource',
          type: 'infeasible',
          alternatives: candidates.map((c) => ({ reasons: c.reasons })),
        });
        continue;
      }

      // 预定资源
      bookedPerson.set(best.personId, best.endMs);
      if (best.deviceId) bookedDevice.set(best.deviceId, best.endMs);
      assignedMinutes.set(
        best.personId,
        (assignedMinutes.get(best.personId) ?? 0) + (best.endMs - best.startMs),
      );
      totalWalking += best.walkingMeters;
      totalLateMs += best.lateMinutes * 60000;
      totalWaitMs += best.waitMinutes * 60000;
      totalChange += best.changeCost;

      const routeId = await this.safeRouteId(best.personId, task.id);
      assignments.push({
        assignmentId: `ASG-${opts.planId}-${task.id}`,
        taskId: task.id,
        personId: best.personId,
        deviceId: best.deviceId,
        stationId: best.stationId,
        zoneId: best.zoneId,
        plannedStart: new Date(best.startMs).toISOString(),
        plannedEnd: new Date(best.endMs).toISOString(),
        routeId,
        status: 'proposed',
        reasons: best.reasons,
        alternatives: best.alternatives,
      });
      doneTaskIds.add(task.id);
    }

    const maxWorkload = Math.max(
      0,
      Math.max(0, ...Array.from(assignedMinutes.values())),
    );
    const metrics: SchedulingPlanMetrics = {
      lateMinutes: Math.round(totalLateMs / 60000),
      walkingMeters: Math.round(totalWalking),
      stationWaitMinutes: Math.round(totalWaitMs / 60000),
      maxWorkload: Math.round(maxWorkload / 60000),
      changeCost: totalChange,
    };

    return {
      planId: opts.planId,
      planName: opts.planName,
      version: 1,
      status: 'shadow',
      trigger: { type: opts.triggerType, entityId: opts.triggerEntityId },
      snapshotVersion: opts.snapshotVersion,
      horizonMinutes: opts.horizonMinutes,
      assignments,
      metrics,
      baselineDelta: this.computeBaselineDelta(metrics, snapshot),
      violations,
      createdAt: new Date().toISOString(),
    };
  }

  private personMatchesLock(
    personId: string,
    taskId: string,
    locked: Map<string, string>,
  ): boolean {
    const lockedPerson = locked.get(taskId);
    return lockedPerson ? lockedPerson === personId : true;
  }

  private devicesForTask(
    task: WorldStateSnapshot['tasks'][number],
    deviceById: Map<string, WorldStateSnapshot['devices'][number]>,
    locked: Map<string, string>,
  ): Array<WorldStateSnapshot['devices'][number] | null> {
    const lockedDevice = locked.get(task.id);
    if (lockedDevice) {
      const d = deviceById.get(lockedDevice);
      return d ? [d] : [];
    }
    const onlineDevices = Array.from(deviceById.values()).filter(
      (d) => d.online && d.batteryPct >= 15,
    );
    // 无设备时允许 null（人员纯手工作业）。
    return onlineDevices.length > 0 ? onlineDevices : [null];
  }

  private earliestStart(
    lowerBoundMs: number,
    personFreeAtMs: number | undefined,
    deviceFreeAtMs: number | undefined,
  ): number {
    return Math.max(
      lowerBoundMs,
      personFreeAtMs ?? 0,
      deviceFreeAtMs ?? 0,
    );
  }

  private estimateWalking(
    from: { x: number; y: number } | undefined,
    to: { x: number; y: number } | undefined,
  ): number {
    if (!from || !to) return 0;
    return Math.hypot(to.x - from.x, to.y - from.y);
  }

  private async safeRouteId(
    personId: string,
    taskId: string,
  ): Promise<string | null> {
    try {
      const route = await this.routingService.calculateRoute(personId, taskId);
      return route.routeId;
    } catch {
      return null;
    }
  }

  private priorityRank(priority: string): number {
    switch (priority) {
      case 'critical':
      case 'urgent':
        return 0;
      case 'high':
        return 1;
      case 'medium':
        return 2;
      default:
        return 3;
    }
  }

  private computeBaselineDelta(
    metrics: SchedulingPlanMetrics,
    snapshot: WorldStateSnapshot,
  ): Record<string, unknown> {
    const baselineLate = snapshot.tasks
      .filter((t) => t.planEnd && Date.parse(t.planEnd) < Date.now())
      .length;
    return {
      lateMinutesDelta: metrics.lateMinutes - baselineLate,
      walkingMetersDelta: metrics.walkingMeters,
      stationWaitMinutesDelta: metrics.stationWaitMinutes,
      maxWorkloadDelta: metrics.maxWorkload,
    };
  }
}