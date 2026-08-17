import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
  ewohDeviceConfig,
} from '@server/database/schema';
import { AuditService, type AuditLogEntry } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';
import { ApprovalPersistenceService } from '../approval/approval-persistence.service';

export type AttemptStatus =
  | 'pending'
  | 'sent'
  | 'gateway_received'
  | 'executed'
  | 'failed'
  | 'expired';

export interface ControlAttempt {
  attemptId: string;
  commandKey: string;
  attemptNo: number;
  status: AttemptStatus;
  receipt?: Record<string, unknown>;
}

export interface ControlRequest {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  commandKeys: string[];
  attempts: ControlAttempt[];
  createdAt: string;
  /** 组织归属（ADR-077；读回 Fact，null=legacy 行）。 */
  orgId?: string | null;
  /** R2-SMI-001：持久化行状态（created/pending_approval/approved/…/revoked）。 */
  status?: string;
}

/**
 * R2-SMI-001（INV-005）：高危物理指令集合——急停/载人移动类命令进入
 * pending_approval 审批链后才允许下发。普通启停（start/stop）保持直发。
 */
export const HIGH_RISK_COMMAND_KEYS: ReadonlySet<string> = new Set([
  'emergency_stop',
  'e_stop',
  'estop',
  'emergency_brake',
  'move_to',
  'carry_move',
]);

/** R2-SMI-001：按命令键风险分级（任一高危键 → 整单高危）。 */
export function classifyControlRisk(commandKeys: string[]): 'high' | 'normal' {
  return commandKeys.some((key) => HIGH_RISK_COMMAND_KEYS.has(key))
    ? 'high'
    : 'normal';
}

interface ControlRequestRow {
  request_id: string;
  device_id: string;
  command_keys: unknown;
  idempotency_key: string | null;
  status: string;
  requested_at: unknown;
  org_id?: string | null;
}

interface ControlCommandRow {
  command_id: string;
  request_id: string;
  root_command_id: string;
  attempt_no: number;
  command_key: string;
  status: string;
  sent_at: unknown;
  response_at: unknown;
  response_json: unknown;
  error_code: string | null;
  error_message: string | null;
}

let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export function aggregateControlStatus(attempts: ControlAttempt[]): string {
  const latest = new Map<string, ControlAttempt>();
  for (const attempt of attempts) {
    const existing = latest.get(attempt.commandKey);
    if (!existing || attempt.attemptNo > existing.attemptNo) {
      latest.set(attempt.commandKey, attempt);
    }
  }
  const statuses = Array.from(latest.values()).map((attempt) => attempt.status);
  if (statuses.length === 0) {
    return 'created';
  }
  if (statuses.some((status) => status === 'expired')) {
    return 'timeout';
  }
  if (statuses.every((status) => status === 'executed')) {
    return 'executed';
  }
  if (statuses.every((status) => status === 'failed')) {
    return 'failed';
  }
  if (statuses.some((status) => status === 'executed') && statuses.some((status) => status === 'failed')) {
    return 'partial_success';
  }
  return 'pending_gateway';
}

const TERMINAL_REQUEST_STATUSES = new Set(['executed', 'failed', 'timeout', 'revoked']);
/**
 * R2-SMI-009（修正）：sendCommand/receiveReceipt 的行状态守卫排除 'failed'——
 * control.yaml aggregation.retry_new_attempt:true 允许 latest attempt 全败后
 * 同 request 重发新 attempt（重发后聚合写回 pending_gateway）。'failed' 行
 * 状态不得阻断重试通道；executed/timeout/revoked 仍 fail-closed。
 */
const NON_RETRYABLE_REQUEST_STATUSES = new Set(['executed', 'timeout', 'revoked']);
const NO_FURTHER_ACTION_STATUSES = new Set(['executed', 'timeout']);
const IN_FLIGHT_ATTEMPT_STATUSES = new Set(['pending', 'sent', 'gateway_received']);

@Injectable()
export class ControlService {
  private readonly logger = new Logger(ControlService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly approvalService?: ApprovalPersistenceService,
  ) {}

  async createRequest(input: {
    deviceId: string;
    commandKeys: string[];
    idempotencyKey: string;
  }, actor?: OrgContext): Promise<ControlRequest> {
    if (!input.deviceId?.trim() || !input.commandKeys?.length || !input.idempotencyKey?.trim()) {
      throw new BadRequestException('deviceId, commandKeys and idempotencyKey are required');
    }
    const existing = await this.findByIdempotencyKey(input.idempotencyKey, actor);
    if (existing) {
      return existing;
    }
    // R2-SMI-001：按命令风险分级——高危单进 pending_approval 审批链。
    const risk = classifyControlRisk(input.commandKeys);
    const approvalRequired = risk === 'high';
    // R2-SMI-002：目标设备租户归属断言——已注册设备的 org 必须与发起方
    // 一致（global_admin 显式豁免；未注册设备无 org 事实可断言，网关投递
    // 自然失败，不额外放行跨租户物理面）。
    await this.assertDeviceInOrg(
      input.deviceId,
      actor?.primaryOrgId,
      actor?.isGlobalAdmin === true,
    );
    const request: ControlRequest = {
      id: nextId('ctl'),
      deviceId: input.deviceId,
      idempotencyKey: input.idempotencyKey,
      commandKeys: [...input.commandKeys],
      attempts: [],
      createdAt: new Date().toISOString(),
    };
    try {
      // ADR-077：drizzle 类型安全路径（消除 public. 硬编码）；org 缺省省略
      // 列由 DB GUC default 填充（GUC 空 → NOT NULL 显式失败，fail-closed §33）。
      const [row] = await this.db
        .insert(ewohControlRequest)
        .values({
          requestId: request.id,
          deviceId: request.deviceId,
          controlType: 'device_command',
          commandKeys: request.commandKeys,
          status: approvalRequired ? 'pending_approval' : 'created',
          idempotencyKey: request.idempotencyKey,
          requestedBy: actor?.userId,
          riskLevel: risk,
          ...(actor?.primaryOrgId ? { orgId: actor.primaryOrgId } : {}),
        })
        .returning();
      const createdRequest = this.mapRequest(this.rowFromSelect(row), [], row.orgId);
      if (approvalRequired) {
        // R2-SMI-001（INV-005）：联动 approval 域创建审批实例（角色由
        // APPROVAL_ROLE_POLICY 服务端映射，R2-SMI-003）。审批模块缺失时
        // fail-closed——高危单宁可不创建也不绕过审批。
        if (!this.approvalService) {
          throw new InternalServerErrorException(
            'high-risk control request requires the approval module (INV-005)',
          );
        }
        await this.approvalService.createApproval(
          // roles 仅展示性输入：审批图由服务端按 entityType 映射（R2-SMI-003）。
          { entityType: 'control_request', entityId: createdRequest.id, roles: [] },
          actor,
        );
      }
      await this.recordAudit(
        {
          action: 'control.create',
          entityType: 'control_request',
          entityId: createdRequest.id,
          before: null,
          after: {
            deviceId: createdRequest.deviceId,
            commandKeys: createdRequest.commandKeys,
            idempotencyKey: createdRequest.idempotencyKey,
            status: approvalRequired ? 'pending_approval' : 'created',
            riskLevel: risk,
          },
          // R2-SMI-001：高危创建审计标 risk。
          risk: approvalRequired,
        },
        actor,
      );
      return createdRequest;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const concurrent = await this.findByIdempotencyKey(input.idempotencyKey, actor);
        if (concurrent) {
          return concurrent;
        }
      }
      // 审批联动的业务异常（如 org 缺失 401）原样上抛，不吞成 500。
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwPersistence('create control request', error);
    }
  }

  async sendCommand(
    requestId: string,
    commandKey: string,
    actor?: OrgContext,
  ): Promise<ControlRequest> {
    const requestRow = await this.getRequest(requestId, actor);
    // R2-SMI-009（修正）：行状态 'failed' 放行重试（retry_new_attempt 契约）。
    if (NON_RETRYABLE_REQUEST_STATUSES.has(requestRow.status ?? '')) {
      throw new BadRequestException(
        `Cannot send command on terminal request ${requestId}`,
      );
    }
    const requestStatus = aggregateControlStatus(requestRow.attempts);
    if (NO_FURTHER_ACTION_STATUSES.has(requestStatus)) {
      throw new BadRequestException(
        `Cannot send command on terminal request ${requestId}`,
      );
    }
    if (!requestRow.commandKeys.includes(commandKey)) {
      throw new BadRequestException(`Unknown commandKey ${commandKey}`);
    }
    const latestAttempt = [...requestRow.attempts]
      .filter((attempt) => attempt.commandKey === commandKey)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0];
    if (latestAttempt && IN_FLIGHT_ATTEMPT_STATUSES.has(latestAttempt.status)) {
      throw new BadRequestException(
        `Attempt already in flight for commandKey ${commandKey}`,
      );
    }
    // R2-SMI-001：审批闸门——pending_approval 请求必须等审批实例 approved
    //（control.yaml pending_approval→approved，role:approver）才允许下发。
    const rowStatusBeforeSend = await this.ensureApprovedForSend(requestRow, actor);
    // R2-SMI-002：下发前复核目标设备租户归属（以发起方/请求行 org 断言）。
    await this.assertDeviceInOrg(
      requestRow.deviceId,
      actor?.primaryOrgId ?? requestRow.orgId,
      actor?.isGlobalAdmin === true,
    );
    const attemptNo =
      requestRow.attempts.filter((attempt) => attempt.commandKey === commandKey).length + 1;
    const commandId = nextId('att');
    const rootCommandId =
      requestRow.attempts.find((attempt) => attempt.commandKey === commandKey)?.attemptId ??
      commandId;
    // ADR-077：命令行归属 = 请求行 org（§3 单一事实源）。
    const cmdOrg = requestRow.orgId ?? actor?.primaryOrgId ?? null;
    const isHighRisk = classifyControlRisk(requestRow.commandKeys) === 'high';
    try {
      // NEST-425：attemptNo 由 DB 侧子查询原子生成（max+1），配合
      // standalone_058 唯一约束 (request_id, command_key, attempt_no)——
      // 并发 send 同 commandKey 的重复序号在 DB 层显式冲突（23505），
      // 不再依赖内存 filter.length+1 的读-算-写窗口。
      await this.db.insert(ewohControlCommand).values({
        commandId,
        requestId,
        rootCommandId,
        attemptNo: sql`(select coalesce(max(${ewohControlCommand.attemptNo}), 0) + 1
                        from ${ewohControlCommand}
                        where ${ewohControlCommand.requestId} = ${requestId}
                          and ${ewohControlCommand.commandKey} = ${commandKey})`,
        commandKey,
        status: 'sent',
        sentAt: new Date(),
        idempotencyKey: requestRow.idempotencyKey,
        ...(cmdOrg ? { orgId: cmdOrg } : {}),
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          `Concurrent send for commandKey ${commandKey} on request ${requestId}`,
        );
      }
      throw error;
    }
    const attempt: ControlAttempt = {
      attemptId: commandId,
      commandKey,
      attemptNo,
      status: 'sent',
    };
    await this.updateRequestStatus(
      requestId,
      aggregateControlStatus([...requestRow.attempts, attempt]),
      requestRow.orgId,
      // R2-SMI-009：以读回的行状态为 CAS 前值（审批通过后为 'approved'）。
      rowStatusBeforeSend,
    );
    await this.recordAudit(
      {
        action: 'control.command.send',
        entityType: 'control_command',
        entityId: commandId,
        before: {
          requestId,
          commandKey,
          previousAttemptCount: requestRow.attempts.length,
        },
        after: {
          commandKey,
          attemptNo,
          status: 'sent',
        },
        // R2-SMI-001：高危指令下发审计标 risk:true。
        risk: isHighRisk,
      },
      actor,
    );
    return this.getRequest(requestId, actor);
  }

  /**
   * R2-SMI-001：审批闸门。非 pending_approval 请求直接放行；pending_approval
   * 请求按 (control_request, requestId) 查最近审批实例：
   *   - approved → CAS 落 approved（approver 角色的落地点）并放行；
   *   - 其余（pending/rejected/cancelled/expired/bypassed/缺失）→ 403/409 fail-closed。
   * 返回闸门通过后的当前行状态（作为后续状态写回的 CAS 前值）。
   */
  private async ensureApprovedForSend(
    request: ControlRequest,
    actor?: OrgContext,
  ): Promise<string> {
    if (request.status !== 'pending_approval') {
      return request.status ?? 'created';
    }
    if (!this.approvalService) {
      throw new InternalServerErrorException(
        `Control request ${request.id} awaits approval but the approval module is unavailable`,
      );
    }
    const instance = await this.approvalService.findLatestForEntity(
      'control_request',
      request.id,
      actor,
    );
    if (!instance) {
      // 数据不一致（审批实例缺失）：fail-closed，绝不放行。
      throw new ConflictException(
        `Approval instance missing for pending_approval request ${request.id}`,
      );
    }
    if (instance.status !== 'approved') {
      throw new ForbiddenException(
        `Control request ${request.id} awaits approval (approval status: ${instance.status})`,
      );
    }
    const rows = await this.db
      .update(ewohControlRequest)
      .set({
        status: 'approved',
        approvedAt: new Date(),
        approvedBy: instance.steps.find((step) => step.status === 'approved')
          ? actor?.userId ?? 'approver'
          : 'approver',
      })
      .where(
        and(
          eq(ewohControlRequest.requestId, request.id),
          eq(ewohControlRequest.status, 'pending_approval'),
          ...(request.orgId ? [eq(ewohControlRequest.orgId, request.orgId)] : []),
        ),
      )
      .returning({ requestId: ewohControlRequest.requestId });
    if (!rows || rows.length === 0) {
      throw new ConflictException('STATE_CONFLICT');
    }
    return 'approved';
  }

  /**
   * R2-SMI-002：设备租户归属断言。设备已注册（ewoh_device_config 有行且带
   * org）时，org 必须与发起方一致，否则 404（反枚举）；未注册/NULL org
   * legacy 设备行与无 org 上下文的内部可信流放行（RLS 继续兜底）。
   */
  private async assertDeviceInOrg(
    deviceId: string,
    expectedOrgId: string | null | undefined,
    isGlobalAdmin = false,
  ): Promise<void> {
    const expectedOrg = expectedOrgId?.trim() || null;
    if (!expectedOrg || isGlobalAdmin) {
      return;
    }
    const [device] = await this.db
      .select({ orgId: ewohDeviceConfig.orgId })
      .from(ewohDeviceConfig)
      .where(eq(ewohDeviceConfig.deviceId, deviceId))
      .limit(1);
    if (device?.orgId && device.orgId !== expectedOrg) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }
  }

  async receiveReceipt(
    requestId: string,
    commandKey: string,
    result: 'executed' | 'failed',
    receipt?: Record<string, unknown>,
    actor?: OrgContext,
  ): Promise<ControlRequest> {
    // NEST-423：读回带 actor（org 守卫；NULL legacy 行放行与getRequest一致）。
    const request = await this.getRequest(requestId, actor);
    // R2-SMI-009（修正）：行状态 'failed' 放行重试回执（retry_new_attempt 契约）。
    if (NON_RETRYABLE_REQUEST_STATUSES.has(request.status ?? '')) {
      throw new BadRequestException(
        `Cannot record receipt on terminal request ${requestId}`,
      );
    }
    const requestStatus = aggregateControlStatus(request.attempts);
    if (NO_FURTHER_ACTION_STATUSES.has(requestStatus)) {
      throw new BadRequestException(
        `Cannot record receipt on terminal request ${requestId}`,
      );
    }
    // R2-SMI-002：回执路径同样断言设备归属（请求行 org）。
    await this.assertDeviceInOrg(
      request.deviceId,
      request.orgId ?? actor?.primaryOrgId,
      actor?.isGlobalAdmin === true,
    );
    const latest = [...request.attempts]
      .filter((attempt) => attempt.commandKey === commandKey)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0];
    if (!latest) {
      throw new BadRequestException(`No attempt for commandKey ${commandKey}`);
    }
    if (latest.status === 'executed' || latest.status === 'failed') {
      throw new BadRequestException(
        `Duplicate receipt for commandKey ${commandKey}`,
      );
    }
    const receiptJson = receipt ?? {};
    await this.db
      .update(ewohControlCommand)
      .set({
        status: result,
        responseAt: new Date(),
        responseJson: receiptJson,
        errorCode: result === 'failed' ? 'COMMAND_FAILED' : null,
        errorMessage: result === 'failed' ? 'Command failed' : null,
      })
      .where(
        and(
          eq(ewohControlCommand.requestId, requestId),
          eq(ewohControlCommand.commandId, latest.attemptId),
        ),
      );
    // ADR-077：回执行归属 = 请求行 org。
    await this.db.insert(ewohControlResult).values({
      resultId: nextId('res'),
      requestId,
      commandId: latest.attemptId,
      resultType: 'command_receipt',
      resultCode: result,
      resultJson: receiptJson,
      success: result === 'executed',
      ...(request.orgId ? { orgId: request.orgId } : {}),
    });
    const updatedAttempts = request.attempts.map((attempt) =>
      attempt.attemptId === latest.attemptId
        ? { ...attempt, status: result, receipt }
        : attempt,
    );
    await this.updateRequestStatus(
      requestId,
      aggregateControlStatus(updatedAttempts),
      request.orgId,
      // R2-SMI-009：以读回的行状态为 CAS 前值。
      request.status ?? undefined,
    );
    return this.getRequest(requestId);
  }

  async revoke(requestId: string, actor?: OrgContext): Promise<ControlRequest> {
    const request = await this.getRequest(requestId, actor);
    const status = aggregateControlStatus(request.attempts);
    // NEST-424：control.yaml terminal 含 partial_success——mixed 结果的请求
    // 已有命令执行成功，revoke 不再把 partial_success 当可撤销状态放行。
    if (
      TERMINAL_REQUEST_STATUSES.has(request.status ?? '') ||
      ['executed', 'failed', 'timeout', 'partial_success'].includes(status)
    ) {
      throw new BadRequestException(`Cannot revoke terminal request ${requestId}`);
    }
    await this.db
      .update(ewohControlCommand)
      .set({ status: 'failed', responseAt: new Date(), errorMessage: 'revoked by operator' })
      .where(
        and(
          eq(ewohControlCommand.requestId, requestId),
          inArray(ewohControlCommand.status, ['pending', 'sent', 'gateway_received']),
        ),
      );
    const revokedAttempts = request.attempts.map((attempt) =>
      attempt.status === 'pending' || attempt.status === 'sent' || attempt.status === 'gateway_received'
        ? { ...attempt, status: 'failed' as const }
        : attempt,
    );
    // R2-SMI-001：control.yaml non_executing→revoked 终态——尚未向网关发出
    // 任何命令的请求（created/pending_approval/approved）撤销后落 revoked，
    // 不再回退为 'created'；已有 in-flight 命令的撤销维持聚合语义（failed）。
    const nextStatus =
      request.attempts.length === 0 ? 'revoked' : aggregateControlStatus(revokedAttempts);
    await this.updateRequestStatus(
      requestId,
      nextStatus,
      request.orgId,
      // R2-SMI-009：以读回的行状态为 CAS 前值。
      request.status ?? undefined,
    );
    await this.recordAudit(
      {
        action: 'control.revoke',
        entityType: 'control_request',
        entityId: requestId,
        before: { status: request.status ?? status },
        after: { status: nextStatus },
      },
      actor,
    );
    return this.getRequest(requestId, actor);
  }

  async getRequest(requestId: string, actor?: OrgContext): Promise<ControlRequest> {
    const rows = await this.db
      .select({
        requestId: ewohControlRequest.requestId,
        deviceId: ewohControlRequest.deviceId,
        commandKeys: ewohControlRequest.commandKeys,
        idempotencyKey: ewohControlRequest.idempotencyKey,
        status: ewohControlRequest.status,
        requestedAt: ewohControlRequest.requestedAt,
        orgId: ewohControlRequest.orgId,
      })
      .from(ewohControlRequest)
      .where(eq(ewohControlRequest.requestId, requestId));
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`Control request ${requestId} not found`);
    }
    // ADR-077：读面 org 守卫（org 匹配或 NULL legacy 放行，跨租户 404）。
    assertTenantVisible(row.orgId, actor, `Control request ${requestId}`);
    const commandRows = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        requestId: ewohControlCommand.requestId,
        rootCommandId: ewohControlCommand.rootCommandId,
        attemptNo: ewohControlCommand.attemptNo,
        commandKey: ewohControlCommand.commandKey,
        status: ewohControlCommand.status,
        sentAt: ewohControlCommand.sentAt,
        responseAt: ewohControlCommand.responseAt,
        responseJson: ewohControlCommand.responseJson,
        errorCode: ewohControlCommand.errorCode,
        errorMessage: ewohControlCommand.errorMessage,
      })
      .from(ewohControlCommand)
      .where(eq(ewohControlCommand.requestId, requestId))
      .orderBy(desc(ewohControlCommand.attemptNo));
    return this.mapRequest(
      {
        request_id: row.requestId,
        device_id: row.deviceId,
        command_keys: row.commandKeys,
        idempotency_key: row.idempotencyKey,
        status: row.status,
        requested_at: row.requestedAt,
        org_id: row.orgId,
      },
      commandRows.map((command) => ({
        attemptId: command.commandId,
        commandKey: command.commandKey,
        attemptNo: Number(command.attemptNo),
        status: command.status as AttemptStatus,
        receipt: this.asReceipt(command.responseJson),
      })),
      row.orgId,
    );
  }

  async getStatus(requestId: string, actor?: OrgContext): Promise<{ request: ControlRequest; status: string }> {
    const request = await this.getRequest(requestId, actor);
    return { request, status: aggregateControlStatus(request.attempts) };
  }

  private async findByIdempotencyKey(
    idempotencyKey: string,
    actor?: OrgContext,
  ): Promise<ControlRequest | null> {
    const rows = await this.db
      .select({
        requestId: ewohControlRequest.requestId,
        deviceId: ewohControlRequest.deviceId,
        commandKeys: ewohControlRequest.commandKeys,
        idempotencyKey: ewohControlRequest.idempotencyKey,
        status: ewohControlRequest.status,
        requestedAt: ewohControlRequest.requestedAt,
        orgId: ewohControlRequest.orgId,
      })
      .from(ewohControlRequest)
      .where(
        and(
          eq(ewohControlRequest.idempotencyKey, idempotencyKey),
          ...(actor?.primaryOrgId
            ? [eq(ewohControlRequest.orgId, actor.primaryOrgId)]
            : []),
        ),
      )
      .orderBy(desc(ewohControlRequest.requestedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    assertTenantVisible(row.orgId, actor, `Control request ${row.requestId}`);
    return this.mapRequest(
      {
        request_id: row.requestId,
        device_id: row.deviceId,
        command_keys: row.commandKeys,
        idempotency_key: row.idempotencyKey,
        status: row.status,
        requested_at: row.requestedAt,
        org_id: row.orgId,
      },
      [],
      row.orgId,
    );
  }

  /**
   * R2-SMI-009：请求行状态写回带行级 CAS——WHERE 追加 eq(status, 聚合前
   * 行状态)，0 行命中抛 409（并发回执/撤销/下发互相覆盖时显式冲突，
   * 调用方/客户端重读重算，而非静默回退为过时聚合值）。
   */
  private async updateRequestStatus(
    requestId: string,
    status: string,
    orgId?: string | null,
    expectedStatus?: string,
  ): Promise<void> {
    const rows = await this.db
      .update(ewohControlRequest)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(ewohControlRequest.requestId, requestId),
          ...(orgId ? [eq(ewohControlRequest.orgId, orgId)] : []),
          ...(expectedStatus
            ? [eq(ewohControlRequest.status, expectedStatus)]
            : []),
        ),
      )
      .returning({ requestId: ewohControlRequest.requestId });
    if (expectedStatus && (!rows || rows.length === 0)) {
      throw new ConflictException('STATE_CONFLICT');
    }
  }

  private rowFromSelect(row: unknown): ControlRequestRow {
    const r = row as {
      requestId: string;
      deviceId: string;
      commandKeys: unknown;
      idempotencyKey: string | null;
      status: string;
      requestedAt: unknown;
      orgId?: string | null;
    };
    return {
      request_id: r.requestId,
      device_id: r.deviceId,
      command_keys: r.commandKeys,
      idempotency_key: r.idempotencyKey,
      status: r.status,
      requested_at: r.requestedAt,
      org_id: r.orgId,
    };
  }

  private mapRequest(
    row: ControlRequestRow,
    attempts: ControlAttempt[] = [],
    orgId?: string | null,
  ): ControlRequest {
    return {
      id: row.request_id,
      deviceId: row.device_id,
      idempotencyKey: row.idempotency_key ?? '',
      commandKeys: this.parseJsonArray(row.command_keys),
      attempts,
      createdAt: this.toIso(row.requested_at),
      // ADR-077：org 归属读回（additive；null=legacy 行）。
      orgId: orgId ?? row.org_id ?? null,
      // R2-SMI-001：持久化行状态读回（pending_approval/approved/revoked 等）。
      status: row.status,
    };
  }

  private parseJsonArray(value: unknown): string[] {
    const parsed = this.parseJson(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }

  private parseJson(value: unknown): unknown {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  private asReceipt(value: unknown): Record<string, unknown> | undefined {
    const parsed = this.parseJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }

  private toIso(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return new Date(value).toISOString();
    }
    return new Date().toISOString();
  }

  private isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string })?.code === '23505';
  }

  private async recordAudit(
    entry: Omit<AuditLogEntry, 'actorId' | 'orgId'>,
    actor?: OrgContext,
  ): Promise<void> {
    if (!this.auditService) {
      return;
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      ...entry,
    });
  }

  private throwPersistence(context: string, error: unknown): never {
    this.logger.error(
      `${context} failed`,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw new InternalServerErrorException(`${context} failed`);
  }
}
