import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ewohScheduleTaskStep } from '@server/database/schema';
import { MesService } from '../mes/mes.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ControlService } from '../control/control.service';
import { ewohSchedulingPlanAssignment } from '@server/database/schema';

export const SCAN_PREFIXES = [
  ['WO:', 'work_order'],
  ['ORDER:', 'order'],
  ['STEP:', 'step'],
  ['DEVICE:', 'device'],
  ['DEV:', 'device'],
  ['MATERIAL:', 'material'],
  ['MAT:', 'material'],
  ['BATCH:', 'batch'],
  ['STATION:', 'station'],
  ['STN:', 'station'],
  ['FACTORY:', 'factory'],
  ['PLANT:', 'factory'],
] as const;

export type ScanType =
  | 'work_order'
  | 'order'
  | 'step'
  | 'device'
  | 'material'
  | 'batch'
  | 'station'
  | 'factory';

export interface ParsedScanValue {
  scanType: ScanType;
  reference: string;
}

export function parseScanValue(value: string): ParsedScanValue | null {
  const normalized = value?.trim() ?? '';
  const upper = normalized.toUpperCase();
  for (const [prefix, scanType] of SCAN_PREFIXES) {
    if (upper.startsWith(prefix)) {
      const reference = normalized.slice(prefix.length).trim();
      if (!reference) {
        return null;
      }
      return { scanType, reference };
    }
  }
  return null;
}

@Injectable()
export class MobileService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly mesService: MesService,
    private readonly controlService?: ControlService,
  ) {}

  async listWorkbench(personId: string, actor?: OrgContext) {
    // personId 是人员域业务 ID；actor.personId 是签名令牌里的可信绑定。
    // 缺上下文/绑定不能返回空列表伪装成“没有任务”，必须让调用方看到拒绝原因。
    const requestedPersonId = personId?.trim() ?? '';
    if (!requestedPersonId) {
      throw new BadRequestException('personId is required');
    }
    if (!actor?.primaryOrgId || !actor.personId) {
      throw new ForbiddenException(
        'workbench queries require trusted organization and person bindings',
      );
    }
    // NEST-412：水平越权收敛——仅本人（或 global_admin/管理角色）可查工作台，
    // 任意已认证用户传他人 personId 枚举他人工序的面关闭。
    const roles = actor.roles ?? [];
    const isPrivileged =
      roles.includes('global_admin') ||
      roles.includes('dispatcher') ||
      roles.includes('workshop_lead');
    if (!isPrivileged && actor.personId !== requestedPersonId) {
      throw new ForbiddenException(
        'workbench queries are limited to the caller (personId mismatch)',
      );
    }
    // NEST-444：raw SQL org 谓词改 eq()（drizzle 惯用写法，列类型由 schema 保证）。
    return this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(
        and(
          eq(ewohScheduleTaskStep.assignedPersonId, requestedPersonId),
          eq(ewohScheduleTaskStep.orgId, actor.primaryOrgId),
          inArray(ewohScheduleTaskStep.status, [
            'pending',
            'in_progress',
            'paused',
          ]),
        ),
      )
      .orderBy(desc(ewohScheduleTaskStep.actualStart));
  }

  /** R2-SAM-002：scan/order 透传租户上下文（MES orgCondition 对
   * undefined actor 已 fail-closed，facade 不再是无 org 过滤的旁路）。 */
  async scan(value: string, actor?: OrgContext) {
    const normalized = value?.trim() ?? '';
    if (!normalized) {
      throw new BadRequestException('scanValue or orderId is required');
    }
    const parsed = parseScanValue(normalized);
    if (!parsed) {
      return this.scanOrder(normalized, actor);
    }
    if (parsed.scanType === 'work_order' || parsed.scanType === 'order') {
      return this.scanOrder(parsed.reference, actor);
    }
    if (parsed.scanType === 'step') {
      const step = await this.mesService.getStep(parsed.reference, actor);
      const workOrder = await this.mesService.getWorkOrder(
        step.scheduleTaskId,
        actor,
      );
      return { scanType: 'step', step, workOrder: workOrder.workOrder };
    }
    return {
      scanType: parsed.scanType,
      reference: parsed.reference,
      recognized: true,
      context: {
        scanValue: normalized,
        entityId: parsed.reference,
      },
    };
  }

  async scanOrder(orderId: string, actor?: OrgContext) {
    return this.mesService.getWorkOrder(orderId, actor);
  }

  async getOrder(orderId: string, actor?: OrgContext) {
    const detail = await this.mesService.getWorkOrder(orderId, actor);
    // NO-79a：现场问题"我的工单为什么没动"——若工单已派给设备，附上该设备的
    // **执行边界摘要**（在飞/排队/未交付/最久等待），判定与执行边界面板同一实现。
    // 查不到派工设备或查询失败 → 如实 null（不伪造"设备正常"）。
    const deviceExecution = await this.readAssignedDeviceExecution(
      String(detail.workOrder?.scheduleTaskId ?? orderId),
      actor,
    );
    return { ...detail, deviceExecution };
  }

  private async readAssignedDeviceExecution(taskId: string, actor?: OrgContext) {
    return this.readAssignedDeviceExecutions(taskId, actor);
  }

  /**
   * NO-85a：多设备协同的**合并执行摘要**——对全部派工设备各取执行边界，
   * 主设备（最新派工）给完整摘要，其余设备聚合成"延误计数"。
   * 现场语义：首台设备空闲 ≠ 万事大吉——协同设备卡住时工单照样推不动，
   * 必须让工人在工单卡上看到"另一台还没就绪"。
   */
  private async readAssignedDeviceExecutions(taskId: string, actor?: OrgContext) {
    if (!this.controlService || !actor?.primaryOrgId) return null;
    try {
      // 多设备协同工单：取**全部**派工设备；执行摘要展示主设备（最新派工），
      // 其余设备数由客户端显示"+N 台"（NO-79a 后续：不静默丢弃协同设备事实）。
      const assignments = await this.db
        .select({ deviceId: ewohSchedulingPlanAssignment.deviceId })
        .from(ewohSchedulingPlanAssignment)
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.taskId, taskId),
            // standalone_057 后 org_id NOT NULL；移动端不得为可能残留的 NULL
            // 行打开跨租户旁路。
            eq(ewohSchedulingPlanAssignment.orgId, actor.primaryOrgId),
          ),
        )
        .orderBy(desc(ewohSchedulingPlanAssignment.createdAt));
      const deviceIds = [...new Set(assignments.map((a) => String(a.deviceId ?? '').trim()))].filter(Boolean);
      const deviceId = deviceIds[0] ?? '';
      if (deviceId === '') return null;
      const boundary = await this.controlService.listDeviceCommands(deviceId, { limit: 10 }, actor);
      // 其余协同设备的延误聚合（NO-85a）：不逐台展开（移动端空间有限），
      // 只回答"还有几台没就绪、最久的在等什么"。
      const otherStuck: Array<{ deviceId: string; queued: number; awaitingDelivery: number; overdue: number }> = [];
      for (const otherId of deviceIds.slice(1)) {
        try {
          const other = await this.controlService.listDeviceCommands(otherId, { limit: 5 }, actor);
          const stuck =
            other.summary.inFlight + other.summary.queued + other.summary.awaitingDelivery + (other.summary.overdue ?? 0);
          if (stuck > 0) {
            otherStuck.push({
              deviceId: otherId,
              queued: other.summary.queued,
              awaitingDelivery: other.summary.awaitingDelivery,
              overdue: other.summary.overdue ?? 0,
            });
          }
        } catch {
          // 单台设备查询失败不影响主摘要（其余台数里已含它）
        }
      }
      return {
        otherStuckCount: otherStuck.length,
        otherStuck,
        deviceId,
        inFlight: boundary.summary.inFlight,
        queued: boundary.summary.queued,
        awaitingDelivery: boundary.summary.awaitingDelivery,
        overdue: boundary.summary.overdue ?? 0,
        oldestWaitingMs: boundary.summary.oldestWaitingMs ?? null,
        busyBlocker: boundary.summary.busyBlocker,
        queuedReasons: boundary.summary.queuedReasons ?? null,
      };
    } catch {
      return null;
    }
  }

  async transitionStep(
    orderId: string,
    stepId: string,
    action: string,
    body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    return this.mesService.transitionStep(orderId, stepId, action, body, actor);
  }

  async forceResolveStep(
    orderId: string,
    stepId: string,
    body: {
      resolution: 'local' | 'server';
      idempotencyKey?: string;
      action?: string;
      payload?: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    return this.mesService.forceResolveStep(orderId, stepId, body, actor);
  }

  async inspectStep(
    orderId: string,
    body: {
      stepId: string;
      result: 'pass' | 'fail' | 'rework';
      defectCode?: string;
      quantity?: number;
      note?: string;
      idempotencyKey?: string;
    },
    actor?: OrgContext,
  ) {
    return this.mesService.qualityInspection(orderId, body, actor);
  }
}
