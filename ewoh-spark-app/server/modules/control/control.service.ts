import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, desc, inArray } from 'drizzle-orm';
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
} from '@server/database/schema';
import { AuditService, type AuditLogEntry } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';

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

const TERMINAL_REQUEST_STATUSES = new Set(['executed', 'failed', 'timeout']);
const NO_FURTHER_ACTION_STATUSES = new Set(['executed', 'timeout']);
const IN_FLIGHT_ATTEMPT_STATUSES = new Set(['pending', 'sent', 'gateway_received']);

@Injectable()
export class ControlService {
  private readonly logger = new Logger(ControlService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly auditService?: AuditService,
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
          status: 'created',
          idempotencyKey: request.idempotencyKey,
          ...(actor?.primaryOrgId ? { orgId: actor.primaryOrgId } : {}),
        })
        .returning();
      const createdRequest = this.mapRequest(this.rowFromSelect(row), [], row.orgId);
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
            status: 'created',
          },
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
      this.throwPersistence('create control request', error);
    }
  }

  async sendCommand(
    requestId: string,
    commandKey: string,
    actor?: OrgContext,
  ): Promise<ControlRequest> {
    const requestRow = await this.getRequest(requestId, actor);
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
    const attemptNo =
      requestRow.attempts.filter((attempt) => attempt.commandKey === commandKey).length + 1;
    const commandId = nextId('att');
    const rootCommandId =
      requestRow.attempts.find((attempt) => attempt.commandKey === commandKey)?.attemptId ??
      commandId;
    // ADR-077：命令行归属 = 请求行 org（§3 单一事实源）。
    const cmdOrg = requestRow.orgId ?? actor?.primaryOrgId ?? null;
    await this.db.insert(ewohControlCommand).values({
      commandId,
      requestId,
      rootCommandId,
      attemptNo,
      commandKey,
      status: 'sent',
      sentAt: new Date(),
      idempotencyKey: requestRow.idempotencyKey,
      ...(cmdOrg ? { orgId: cmdOrg } : {}),
    });
    const attempt: ControlAttempt = {
      attemptId: commandId,
      commandKey,
      attemptNo,
      status: 'sent',
    };
    await this.updateRequestStatus(requestId, aggregateControlStatus([...requestRow.attempts, attempt]), requestRow.orgId);
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
      },
      actor,
    );
    return this.getRequest(requestId, actor);
  }

  async receiveReceipt(
    requestId: string,
    commandKey: string,
    result: 'executed' | 'failed',
    receipt?: Record<string, unknown>,
  ): Promise<ControlRequest> {
    const request = await this.getRequest(requestId);
    const requestStatus = aggregateControlStatus(request.attempts);
    if (NO_FURTHER_ACTION_STATUSES.has(requestStatus)) {
      throw new BadRequestException(
        `Cannot record receipt on terminal request ${requestId}`,
      );
    }
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
    await this.updateRequestStatus(requestId, aggregateControlStatus(updatedAttempts), request.orgId);
    return this.getRequest(requestId);
  }

  async revoke(requestId: string, actor?: OrgContext): Promise<ControlRequest> {
    const request = await this.getRequest(requestId, actor);
    const status = aggregateControlStatus(request.attempts);
    if (['executed', 'failed', 'timeout'].includes(status)) {
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
    await this.updateRequestStatus(requestId, aggregateControlStatus(revokedAttempts), request.orgId);
    await this.recordAudit(
      {
        action: 'control.revoke',
        entityType: 'control_request',
        entityId: requestId,
        before: { status },
        after: { status: aggregateControlStatus(revokedAttempts) },
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

  private async updateRequestStatus(
    requestId: string,
    status: string,
    orgId?: string | null,
  ): Promise<void> {
    await this.db
      .update(ewohControlRequest)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(ewohControlRequest.requestId, requestId),
          ...(orgId ? [eq(ewohControlRequest.orgId, orgId)] : []),
        ),
      );
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
