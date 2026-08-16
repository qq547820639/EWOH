import { NotFoundException } from '@nestjs/common';
import { ControlService, aggregateControlStatus } from '../../../server/modules/control/control.service';
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
} from '@server/database/schema';
import { makeControlDb } from '../../helpers/fake-control-db';

const ACTOR = { userId: 'u1', primaryOrgId: 'ORG-1' } as never;
const ACTOR_ORG2 = { userId: 'u2', primaryOrgId: 'ORG-2' } as never;

function requestSeed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'ctl-1',
    deviceId: 'exo-1',
    commandKeys: ['start', 'stop'],
    idempotencyKey: 'idem-1',
    status: 'created',
    requestedAt: '2026-08-03T00:00:00.000Z',
    orgId: 'ORG-1',
    ...overrides,
  };
}

function commandSeed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: 'att-1',
    requestId: 'ctl-1',
    rootCommandId: 'att-1',
    attemptNo: 1,
    commandKey: 'start',
    status: 'sent',
    sentAt: '2026-08-03T00:00:00.000Z',
    responseAt: null,
    responseJson: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('control aggregation', () => {
  it('uses the latest attempt per command key', () => {
    const status = aggregateControlStatus([
      { attemptId: 'a1', commandKey: 'start', attemptNo: 1, status: 'failed' },
      { attemptId: 'a2', commandKey: 'start', attemptNo: 2, status: 'executed' },
      { attemptId: 'b1', commandKey: 'stop', attemptNo: 1, status: 'executed' },
    ]);
    expect(status).toBe('executed');
  });

  it('aggregates mixed results to partial_success and expiry to timeout', () => {
    expect(
      aggregateControlStatus([
        { attemptId: 'a1', commandKey: 'a', attemptNo: 1, status: 'executed' },
        { attemptId: 'b1', commandKey: 'b', attemptNo: 1, status: 'failed' },
      ]),
    ).toBe('partial_success');
    expect(
      aggregateControlStatus([
        { attemptId: 'a1', commandKey: 'a', attemptNo: 1, status: 'expired' },
      ]),
    ).toBe('timeout');
  });
});

describe('ControlService persistence（ADR-077：drizzle 类型安全 + org 归属）', () => {
  it('persists a request with orgId injected and reuses the row for the same idempotency key', async () => {
    const { db, inserts } = makeControlDb();
    const service = new ControlService(db as never);

    const first = await service.createRequest(
      { deviceId: 'exo-1', commandKeys: ['start', 'stop'], idempotencyKey: 'idem-1' },
      ACTOR,
    );
    expect(first.orgId).toBe('ORG-1');
    const requestInsert = inserts.find((i) => i.table === ewohControlRequest);
    expect(requestInsert?.row.orgId).toBe('ORG-1');

    const second = await service.createRequest(
      { deviceId: 'exo-1', commandKeys: ['start', 'stop'], idempotencyKey: 'idem-1' },
      ACTOR,
    );
    expect(second.id).toBe(first.id);
  });

  it('createRequest 无 actor → orgId 列省略（DB GUC default；不伪造 §33）', async () => {
    const { db, inserts } = makeControlDb();
    const service = new ControlService(db as never);
    await service.createRequest({
      deviceId: 'exo-1',
      commandKeys: ['start'],
      idempotencyKey: 'idem-2',
    });
    const requestInsert = inserts.find((i) => i.table === ewohControlRequest);
    expect('orgId' in (requestInsert?.row ?? {})).toBe(false);
  });

  it('persists sent commands with org = 请求行 org', async () => {
    const { db, inserts, updates } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(db as never);

    const result = await service.sendCommand('ctl-1', 'start', ACTOR);

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe('sent');
    const cmdInsert = inserts.find((i) => i.table === ewohControlCommand);
    expect(cmdInsert?.row.orgId).toBe('ORG-1');
    expect(updates.some((u) => u.table === ewohControlRequest)).toBe(true);
  });

  it('persists receipts and results with org = 请求行 org', async () => {
    const { db, inserts } = makeControlDb({
      requests: [requestSeed()],
      commands: [commandSeed()],
    });
    const service = new ControlService(db as never);

    const result = await service.receiveReceipt('ctl-1', 'start', 'executed', { ok: true });

    expect(result.attempts[0].status).toBe('executed');
    const resInsert = inserts.find((i) => i.table === ewohControlResult);
    expect(resInsert?.row.orgId).toBe('ORG-1');
    expect(resInsert?.row.success).toBe(true);
  });

  it('rejects sending commands on terminal requests', async () => {
    const { db } = makeControlDb({
      requests: [requestSeed()],
      commands: [commandSeed({ status: 'executed' })],
    });
    const service = new ControlService(db as never);

    await expect(service.sendCommand('ctl-1', 'start')).rejects.toThrow(/terminal request/);
  });

  it('rejects duplicate sends while an attempt is in flight', async () => {
    const { db } = makeControlDb({
      requests: [requestSeed()],
      commands: [commandSeed({ status: 'sent' })],
    });
    const service = new ControlService(db as never);

    await expect(service.sendCommand('ctl-1', 'start')).rejects.toThrow(/already in flight/);
  });

  it('rejects duplicate receipts for an already-terminal attempt', async () => {
    // start 已 executed + stop 仍 sent → 请求非终态 → 走到 attempt 级重复回执拒绝。
    const { db } = makeControlDb({
      requests: [requestSeed()],
      commands: [
        commandSeed({ status: 'executed' }),
        commandSeed({
          commandId: 'att-2',
          rootCommandId: 'att-2',
          commandKey: 'stop',
          status: 'sent',
        }),
      ],
    });
    const service = new ControlService(db as never);

    await expect(service.receiveReceipt('ctl-1', 'start', 'executed')).rejects.toThrow(
      /Duplicate receipt/,
    );
  });

  it('revoke 更新命令并写审计前状态', async () => {
    const { db, updates } = makeControlDb({
      requests: [requestSeed()],
      commands: [commandSeed({ status: 'sent' })],
    });
    const service = new ControlService(db as never);
    const result = await service.revoke('ctl-1', ACTOR);
    expect(result.attempts[0].status).toBe('failed');
    expect(updates.some((u) => u.table === ewohControlCommand)).toBe(true);
  });

  it('getRequest 跨租户 → NotFound（ADR-077 读面守卫，反枚举）', async () => {
    const { db } = makeControlDb({ requests: [requestSeed({ orgId: 'ORG-1' })] });
    const service = new ControlService(db as never);
    await expect(service.getRequest('ctl-1', ACTOR_ORG2)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getRequest 同租户 → 放行且读回 orgId；NULL legacy 行放行', async () => {
    const { db } = makeControlDb({ requests: [requestSeed({ orgId: 'ORG-1' })] });
    const service = new ControlService(db as never);
    const req = await service.getRequest('ctl-1', ACTOR);
    expect(req.orgId).toBe('ORG-1');

    const { db: db2 } = makeControlDb({ requests: [requestSeed({ orgId: null })] });
    const svc2 = new ControlService(db2 as never);
    const legacy = await svc2.getRequest('ctl-1', ACTOR_ORG2);
    expect(legacy.id).toBe('ctl-1');
  });

  it('surfaces database failures as explainable errors', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => {
          throw new Error('db down');
        }),
      })),
    };
    const service = new ControlService(db as never);
    // §33 不吞异常：底层失败原样显式上抛。
    await expect(
      service.createRequest({
        deviceId: 'exo-1',
        commandKeys: ['start'],
        idempotencyKey: 'idem-x',
      }),
    ).rejects.toThrow('db down');
  });
});

describe('ControlService audit（ADR-077：审计面不变）', () => {
  it('audits request creation with the acting user and after state', async () => {
    const { db } = makeControlDb();
    const auditLogs: Array<Record<string, unknown>> = [];
    const auditService = {
      appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
        auditLogs.push(entry);
      }),
    };
    const service = new ControlService(db as never, auditService as never);
    await service.createRequest(
      { deviceId: 'exo-1', commandKeys: ['start'], idempotencyKey: 'idem-a' },
      ACTOR,
    );
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('control.create');
    expect(auditLogs[0].actorId).toBe('u1');
    expect(auditLogs[0].orgId).toBe('ORG-1');
  });
});
