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
import { sql, type SQL } from 'drizzle-orm';
import { AuditService, type AuditLogEntry } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

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
}

interface ControlRequestRow {
  request_id: string;
  device_id: string;
  command_keys: unknown;
  idempotency_key: string | null;
  status: string;
  requested_at: unknown;
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
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
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
      const [row] = await this.db.execute(sql`
        insert into public.ewoh_control_request (
          request_id, device_id, control_type, command_keys, status, idempotency_key
        ) values (
          ${request.id}, ${request.deviceId}, 'device_command',
          ${JSON.stringify(request.commandKeys)}::jsonb, 'created', ${request.idempotencyKey}
        )
        returning request_id, device_id, command_keys, idempotency_key, status, requested_at
      `);
      const createdRequest = this.mapRequest(row as unknown as ControlRequestRow);
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
        const concurrent = await this.findByIdempotencyKey(input.idempotencyKey);
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
    const requestRow = await this.getRequest(requestId);
    if (!requestRow.commandKeys.includes(commandKey)) {
      throw new BadRequestException(`Unknown commandKey ${commandKey}`);
    }
    const attemptNo =
      requestRow.attempts.filter((attempt) => attempt.commandKey === commandKey).length + 1;
    const commandId = nextId('att');
    const rootCommandId =
      requestRow.attempts.find((attempt) => attempt.commandKey === commandKey)?.attemptId ??
      commandId;
    await this.safeExecute('send control command', sql`
      insert into public.ewoh_control_command (
        command_id, request_id, root_command_id, attempt_no, command_key, status, sent_at, idempotency_key
      ) values (
        ${commandId}, ${requestId}, ${rootCommandId}, ${attemptNo}, ${commandKey}, 'sent', now(), ${requestRow.idempotencyKey}
      )
    `);
    const attempt: ControlAttempt = {
      attemptId: commandId,
      commandKey,
      attemptNo,
      status: 'sent',
    };
    await this.updateRequestStatus(requestId, aggregateControlStatus([...requestRow.attempts, attempt]));
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
    return this.getRequest(requestId);
  }

  async receiveReceipt(
    requestId: string,
    commandKey: string,
    result: 'executed' | 'failed',
    receipt?: Record<string, unknown>,
  ): Promise<ControlRequest> {
    const request = await this.getRequest(requestId);
    const latest = [...request.attempts]
      .filter((attempt) => attempt.commandKey === commandKey)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0];
    if (!latest) {
      throw new BadRequestException(`No attempt for commandKey ${commandKey}`);
    }
    const receiptJson = receipt ? JSON.stringify(receipt) : '{}';
    await this.safeExecute('record control command result', sql`
      update public.ewoh_control_command
      set status = ${result}, response_at = now(), response_json = ${receiptJson}::jsonb,
          error_code = ${result === 'failed' ? 'COMMAND_FAILED' : null},
          error_message = ${result === 'failed' ? 'Command failed' : null}
      where request_id = ${requestId} and command_id = ${latest.attemptId}
    `);
    await this.safeExecute('persist control result', sql`
      insert into public.ewoh_control_result (
        result_id, request_id, command_id, result_type, result_code, result_json, success
      ) values (
        ${nextId('res')}, ${requestId}, ${latest.attemptId}, 'command_receipt',
        ${result}, ${receiptJson}::jsonb, ${result === 'executed'}
      )
    `);
    const updatedAttempts = request.attempts.map((attempt) =>
      attempt.attemptId === latest.attemptId
        ? { ...attempt, status: result, receipt }
        : attempt,
    );
    await this.updateRequestStatus(requestId, aggregateControlStatus(updatedAttempts));
    return this.getRequest(requestId);
  }

  async revoke(requestId: string, actor?: OrgContext): Promise<ControlRequest> {
    const request = await this.getRequest(requestId);
    const status = aggregateControlStatus(request.attempts);
    if (['executed', 'failed', 'timeout'].includes(status)) {
      throw new BadRequestException(`Cannot revoke terminal request ${requestId}`);
    }
    await this.safeExecute('revoke control commands', sql`
      update public.ewoh_control_command
      set status = 'failed', response_at = now(), error_message = 'revoked by operator'
      where request_id = ${requestId} and status in ('pending', 'sent', 'gateway_received')
    `);
    const revokedAttempts = request.attempts.map((attempt) =>
      attempt.status === 'pending' || attempt.status === 'sent' || attempt.status === 'gateway_received'
        ? { ...attempt, status: 'failed' as const }
        : attempt,
    );
    await this.updateRequestStatus(requestId, aggregateControlStatus(revokedAttempts));
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
    return this.getRequest(requestId);
  }

  async getRequest(requestId: string): Promise<ControlRequest> {
    const rows = await this.safeExecute<ControlRequestRow>('read control request', sql`
      select request_id, device_id, command_keys, idempotency_key, status, requested_at
      from public.ewoh_control_request
      where request_id = ${requestId}
    `);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`Control request ${requestId} not found`);
    }
    const commandRows = await this.safeExecute<ControlCommandRow>('read control commands', sql`
      select command_id, request_id, root_command_id, attempt_no, command_key, status,
             sent_at, response_at, response_json, error_code, error_message
      from public.ewoh_control_command
      where request_id = ${requestId}
      order by attempt_no asc
    `);
    return this.mapRequest(
      row,
      commandRows.map((command) => ({
        attemptId: command.command_id,
        commandKey: command.command_key,
        attemptNo: Number(command.attempt_no),
        status: command.status as AttemptStatus,
        receipt: this.asReceipt(command.response_json),
      })),
    );
  }

  async getStatus(requestId: string): Promise<{ request: ControlRequest; status: string }> {
    const request = await this.getRequest(requestId);
    return { request, status: aggregateControlStatus(request.attempts) };
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<ControlRequest | null> {
    const rows = await this.safeExecute<ControlRequestRow>('read control request by idempotency key', sql`
      select request_id, device_id, command_keys, idempotency_key, status, requested_at
      from public.ewoh_control_request
      where idempotency_key = ${idempotencyKey}
      order by requested_at desc
      limit 1
    `);
    return rows[0] ? this.mapRequest(rows[0]) : null;
  }

  private async updateRequestStatus(requestId: string, status: string): Promise<void> {
    await this.safeExecute('update control request status', sql`
      update public.ewoh_control_request
      set status = ${status}, _updated_at = now()
      where request_id = ${requestId}
    `);
  }

  private mapRequest(row: ControlRequestRow, attempts: ControlAttempt[] = []): ControlRequest {
    return {
      id: row.request_id,
      deviceId: row.device_id,
      idempotencyKey: row.idempotency_key ?? '',
      commandKeys: this.parseJsonArray(row.command_keys),
      attempts,
      createdAt: this.toIso(row.requested_at),
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

  private async safeExecute<T>(context: string, query: SQL): Promise<T[]> {
    try {
      return (await this.db.execute(query)) as T[];
    } catch (error) {
      this.throwPersistence(context, error);
    }
  }

  private throwPersistence(context: string, error: unknown): never {
    this.logger.error(
      `${context} failed`,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw new InternalServerErrorException(`${context} failed`);
  }
}
