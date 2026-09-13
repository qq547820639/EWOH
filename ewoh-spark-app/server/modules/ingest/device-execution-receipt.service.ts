import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingExecution } from '@server/database/schema';
import { DEVICE_RECEIPT_SOURCE } from '../scheduler/execution-receipt-provenance';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings, type OrgContext } from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';

/**
 * 设备执行事实接入 —— **`device_receipt` 来源的唯一写入方**。
 *
 * ## 为什么需要它（缺口，2026-09-13 审计）
 *
 * `execution-receipt-provenance.ts` 的资格判定要求「独立设备回执证据」：
 * 持久化执行行必须 `source = 'device_receipt'`。但**全仓没有任何写入方产出该值**——
 * `execution.service.ts` 只写 `'dispatch'`，HTTP 回执路径只可能写 `simulated` /
 * `manual_report`（该文件 :4 的注释自承 "Neither HTTP adapter writes this source"）。
 * 于是 `real` 分支不可达 → `productionTrainingEligible` 恒 false →
 * **任何现场回执都不可能是训练样本**，经验时长模型在生产永远无法从真实反馈训练。
 *
 * ## 为什么不是「放宽那道门」
 *
 * 那道门是**有意的防伪造不变量**：人工上报与模拟回执不得污染生产模型。正确做法不是
 * 放宽它，而是补上**它一直在等的那条合法路径**——由**机器身份**接入的、设备自己测得的
 * 执行事实。
 *
 * ## 安全边界（本实现的核心，逐条都有测试锁定）
 *
 * 1. **来源只能由机器身份写**：本端点走 `IngestGuard`（`X-Ingest-Key`），**不挂**
 *    `RolesGuard`、不接受用户令牌。人类/HTTP 回执路径**无法**产出 `device_receipt`
 *    （`reportedSource` 词表里没有它）。
 * 2. **ingest key 必须带 org 绑定**：legacy 无绑定模式（org 由客户端 `X-Org-Id` 自报）
 *    一律拒绝。理由：无绑定 key 意味着"任何持 key 者可声称任意租户"，用它产出可训练
 *    样本等于把训练数据的租户归属交给客户端自报。
 * 3. **设备只能报自己的活**：`execution.deviceId` 必须非空且**等于**上报的 `deviceId`。
 *    设备 A 不能替设备 B 的设备×任务组合背书。
 * 4. **不创造计划**：设备事实只能**附到已存在的执行行**（按 `(orgId, assignmentId)` 解析）。
 *    设备不能凭"我干完了"凭空生成一条计划外执行——那会让训练样本脱离调度事实。
 * 5. **时间必须是设备测得值**：`actualStartAt` 必填、`COMPLETED` 必须有 `actualEndAt`
 *    且 `end >= start`。**不从 `Date.now()` 兜底**（服务端补的时间不是测量值）。
 * 6. **不碰任务状态机**：本服务只写执行事实（实际时间与来源），不推进任务/方案状态。
 *    任务推进仍由既有 `ExecutionReceiptApplicationService` 负责——两条路径职责分离，
 *    避免"设备上报即改任务状态"这种绕过审批的副作用。
 *
 * ## 仍然不构成"可训练"的充分条件
 *
 * 即便设备成功写入 `device_receipt`，`receiptProvenance` 还要求
 * `task.source === 'real'`、`device.sourceType === 'real'`、方案非 shadow、审批人 ≠ 生成人、
 * 且 `plan.confirmedAt <= execution.actualStartAt`。因此**模拟/演示环境无法因此获得训练样本**
 * ——这正是设计意图（调试环境不得污染生产模型），测试对此有专门断言。
 */

/** 设备执行事实上报（机器面契约）。 */
export interface DeviceExecutionFactDto {
  /** 上报设备（必须与该执行行已记录的 deviceId 一致）。 */
  deviceId: string;
  /** 执行行定位键（设备事实附到既有执行行，不新建）。 */
  assignmentId: string;
  /** 设备测得的实际开始时间（ISO8601）。**必填**——服务端不补时间。 */
  actualStartAt: string;
  /** 设备测得的实际结束时间（ISO8601）。status=COMPLETED 时必填。 */
  actualEndAt?: string;
  /** 设备侧执行状态。 */
  status: 'STARTED' | 'COMPLETED';
  /** 设备侧附加测量（可选，原样留存供溯源，不参与判定）。 */
  metrics?: Record<string, unknown>;
}

export interface DeviceExecutionFactResult {
  executionId: string;
  assignmentId: string;
  deviceId: string;
  status: string;
  source: string;
  actualStartAt: string;
  actualEndAt: string | null;
}

/**
 * 执行行允许被设备事实推进的状态词表——**与真实执行状态机同源**
 * （`scheduler/execution-receipt-state.ts` 的 allowed 图 + DB 列注释
 * `PLANNED/DISPATCHED/STARTED/PAUSED/COMPLETED/FAILED/CANCELLED`）。
 *
 * 为什么写这个词表而不是凭感觉：此前写成 `['PLANNED','DISPATCHED','STARTED','IN_PROGRESS']`
 * ——`IN_PROGRESS` 在整个仓库里**不存在**（真实机器是 `PAUSED`），而 `PAUSED` 缺失。
 * 后果：人工经 HTTP 回执把执行行暂停（STARTED→PAUSED）后，设备测得的 COMPLETED
 * 永远被 400 拒收（"执行行已处于 PAUSED"），而 HTTP 状态机本身是允许
 * PAUSED→COMPLETED 的——设备测量事实凭空丢失。
 */
const DEVICE_FACT_ALLOWED_EXEC_STATUSES = ['PLANNED', 'DISPATCHED', 'STARTED', 'PAUSED'];

/** 机器身份上下文：IngestGuard 挂载的租户 + key 绑定事实。 */
export interface IngestMachineContext extends OrgContext {
  /**
   * ingest key 绑定的 orgId；`null` 表示 **legacy 无绑定模式**（org 由客户端自报）。
   * 由 `IngestGuard` 在鉴权通过后挂到 request 上。
   */
  ingestKeyBoundOrgId?: string | null;
}

@Injectable()
export class DeviceExecutionReceiptService {
  private readonly logger = new Logger(DeviceExecutionReceiptService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
  ) {}

  async recordFact(
    input: DeviceExecutionFactDto,
    ctx?: IngestMachineContext,
  ): Promise<DeviceExecutionFactResult> {
    const orgId = String(ctx?.primaryOrgId ?? '').trim();
    if (orgId === '') {
      throw new BadRequestException('device execution fact: 缺少租户上下文');
    }
    // 边界 2：legacy 无绑定 key 一律拒绝（不得用客户端自报的 org 产出可训练来源）。
    if (ctx?.ingestKeyBoundOrgId == null) {
      throw new ForbiddenException(
        'DEVICE_FACT_REQUIRES_BOUND_KEY: 设备执行事实只接受带 org 绑定的 ingest key'
          + '（legacy 无绑定模式下租户由客户端自报，不能用它产出 device_receipt 来源）',
      );
    }
    if (ctx.ingestKeyBoundOrgId.toLowerCase() !== orgId.toLowerCase()) {
      throw new ForbiddenException('DEVICE_FACT_ORG_MISMATCH: ingest key 绑定 org 与请求租户不一致');
    }

    const deviceId = String(input?.deviceId ?? '').trim();
    const assignmentId = String(input?.assignmentId ?? '').trim();
    if (deviceId === '' || assignmentId === '') {
      throw new BadRequestException('device execution fact: deviceId 与 assignmentId 必填');
    }
    // 边界 5：时间必须是设备测得值，服务端不从 now() 兜底。
    const actualStartAt = this.parseDeviceTime(input?.actualStartAt, 'actualStartAt');
    if (actualStartAt === null) {
      throw new BadRequestException(
        'device execution fact: actualStartAt 必填且必须可解析（服务端不代填测量时间）',
      );
    }
    const status = String(input?.status ?? '').trim().toUpperCase();
    if (status !== 'STARTED' && status !== 'COMPLETED') {
      throw new BadRequestException(
        `device execution fact: status 只接受 STARTED/COMPLETED，收到 "${input?.status ?? ''}"`,
      );
    }
    let actualEndAt: Date | null = null;
    if (status === 'COMPLETED') {
      actualEndAt = this.parseDeviceTime(input?.actualEndAt, 'actualEndAt');
      if (actualEndAt === null) {
        throw new BadRequestException('device execution fact: status=COMPLETED 必须带 actualEndAt');
      }
      if (actualEndAt.getTime() < actualStartAt.getTime()) {
        throw new BadRequestException('device execution fact: actualEndAt 早于 actualStartAt');
      }
    }

    const gucSettings = buildGucSettings(ctx as OrgContext);

    return this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      // FOR UPDATE：两条写路径（设备事实 / HTTP 回执）与重试乱序并发时，读-改-写
      // 必须持行锁串行化——否则两个事务都能读到"可推进"的旧快照、后提交者把先
      // 提交者（例如 COMPLETED）覆盖回更早状态（与 ExecutionReceiptApplicationService
      // 对同一张表的锁定口径一致）。
      const [row] = await this.db
        .select()
        .from(ewohSchedulingExecution)
        .where(
          and(
            eq(ewohSchedulingExecution.orgId, orgId),
            eq(ewohSchedulingExecution.assignmentId, assignmentId),
          ),
        )
        .for('update')
        .limit(1);
      // 边界 4：不创造计划——设备事实只能附到既有执行行。
      if (!row) {
        throw new NotFoundException(
          `DEVICE_FACT_NO_EXECUTION: 租户内不存在 assignment=${assignmentId} 的执行行（设备事实不创建计划）`,
        );
      }
      // 边界 3：设备只能报自己的活。
      const executionDeviceId = String(row.deviceId ?? '').trim();
      if (executionDeviceId === '') {
        throw new ForbiddenException(
          'DEVICE_FACT_NO_DEVICE_BOUND: 该执行行没有绑定设备，不接受设备事实'
            + '（缺数据 ≠ 可放行，不猜设备）',
        );
      }
      if (executionDeviceId !== deviceId) {
        throw new ForbiddenException(
          `DEVICE_FACT_DEVICE_MISMATCH: 执行行设备为 ${executionDeviceId}，上报设备为 ${deviceId}`
            + '（设备不得替他人背书）',
        );
      }
      const currentStatus = String(row.status ?? '').toUpperCase();
      if (!DEVICE_FACT_ALLOWED_EXEC_STATUSES.includes(currentStatus)) {
        throw new BadRequestException(
          `DEVICE_FACT_EXEC_TERMINAL: 执行行已处于 ${currentStatus}，不再接受设备事实`,
        );
      }

      // 条件 UPDATE（CAS）：where 里**重复**状态守卫。SELECT FOR UPDATE 已把并发
      // 串行化，但替身/降级路径（事务退化）下锁不再是保证——把"行仍处于可推进状态"
      // 写进谓词，0 行命中就显式冲突，绝不把迟到的重试（at-least-once 桥的乱序帧）
      // 静默落成状态回退（实测复现：COMPLETED 被迟到的 STARTED 覆盖回 STARTED）。
      const updated = await this.db
        .update(ewohSchedulingExecution)
        .set({
          actualStartAt,
          ...(actualEndAt ? { actualEndAt } : {}),
          status,
          // 边界 1：这个字面量在整个仓库里**只有这里**会写。
          source: DEVICE_RECEIPT_SOURCE,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(ewohSchedulingExecution.id, row.id),
            inArray(ewohSchedulingExecution.status, DEVICE_FACT_ALLOWED_EXEC_STATUSES),
          ),
        )
        .returning({ id: ewohSchedulingExecution.id });
      if (!updated || updated.length === 0) {
        throw new ConflictException(
          `DEVICE_FACT_EXEC_STATE_CHANGED: 执行行状态在处理期间已被并发推进（assignment=${assignmentId}），`
            + '本次设备事实未被接受；请按当前状态重试或走 HTTP 回执路径',
        );
      }

      await this.auditService.appendAuditLog({
        actorId: `device:${deviceId}`,
        orgId,
        action: 'execution.device_fact_recorded',
        entityType: 'scheduling_execution',
        entityId: String(row.executionId),
        reason:
          `设备执行事实上行 status=${status} start=${actualStartAt.toISOString()}`
          + `${actualEndAt ? ` end=${actualEndAt.toISOString()}` : ''}（来源 device_receipt，`
          + '仅机器身份可写；是否可训练仍由 receiptProvenance 独立判定）',
      });

      this.logger.log(
        `device execution fact recorded org=${orgId} device=${deviceId} `
          + `assignment=${assignmentId} status=${status}`,
      );

      return {
        executionId: String(row.executionId),
        assignmentId,
        deviceId,
        status,
        source: DEVICE_RECEIPT_SOURCE,
        actualStartAt: actualStartAt.toISOString(),
        actualEndAt: actualEndAt ? actualEndAt.toISOString() : null,
      };
    });
  }

  /** 解析设备上报时间；不可解析返回 null（由调用方给出**具名**拒绝原因，不抛原始异常）。 */
  private parseDeviceTime(value: unknown, field: string): Date | null {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      this.logger.warn(`device execution fact: ${field} 不可解析（原值已丢弃不猜测）`);
      return null;
    }
    return new Date(ms);
  }
}
