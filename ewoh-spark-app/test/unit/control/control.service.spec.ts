import { ControlService, aggregateControlStatus } from '../../../server/modules/control/control.service';

const requestRow = {
  request_id: 'ctl-1',
  device_id: 'exo-1',
  command_keys: ['start', 'stop'],
  idempotency_key: 'idem-1',
  status: 'created',
  requested_at: '2026-08-03T00:00:00.000Z',
};

const commandRow = (overrides: Record<string, unknown> = {}) => ({
  command_id: 'att-1',
  request_id: 'ctl-1',
  root_command_id: 'att-1',
  attempt_no: 1,
  command_key: 'start',
  status: 'sent',
  sent_at: '2026-08-03T00:00:00.000Z',
  response_at: null,
  response_json: null,
  error_code: null,
  error_message: null,
  ...overrides,
});

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

describe('ControlService persistence', () => {
  it('persists a request and reuses the row for the same idempotency key', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([requestRow]);
    const service = new ControlService({ execute } as never);

    const first = await service.createRequest({
      deviceId: 'exo-1',
      commandKeys: ['start', 'stop'],
      idempotencyKey: 'idem-1',
    });
    const second = await service.createRequest({
      deviceId: 'exo-1',
      commandKeys: ['start', 'stop'],
      idempotencyKey: 'idem-1',
    });

    expect(first.id).toBe('ctl-1');
    expect(second.id).toBe('ctl-1');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(execute.mock.calls[1][0])).toContain('ewoh_control_request');
    expect(JSON.stringify(execute.mock.calls[1][0])).toContain('idem-1');
  });

  it('persists sent commands to ewoh_control_command', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow()]);
    const service = new ControlService({ execute } as never);

    const result = await service.sendCommand('ctl-1', 'start');

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe('sent');
    expect(JSON.stringify(execute.mock.calls[2][0])).toContain('ewoh_control_command');
  });

  it('persists receipts and results and aggregates the latest attempt', async () => {
    const executedCommand = commandRow({
      status: 'executed',
      response_at: '2026-08-03T00:00:01.000Z',
      response_json: { ok: true },
    });
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([executedCommand]);
    const service = new ControlService({ execute } as never);

    const result = await service.receiveReceipt('ctl-1', 'start', 'executed', { ok: true });

    expect(result.attempts[0].status).toBe('executed');
    expect(JSON.stringify(execute.mock.calls[2][0])).toContain('ewoh_control_command');
    expect(JSON.stringify(execute.mock.calls[3][0])).toContain('ewoh_control_result');
  });

  it('rejects sending commands on terminal requests', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow({ status: 'executed' })]);
    const service = new ControlService({ execute } as never);

    await expect(service.sendCommand('ctl-1', 'start')).rejects.toThrow(
      /terminal request/,
    );
  });

  it('rejects duplicate sends while an attempt is in flight', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow({ status: 'sent' })]);
    const service = new ControlService({ execute } as never);

    await expect(service.sendCommand('ctl-1', 'start')).rejects.toThrow(
      /already in flight/,
    );
  });

  it('rejects duplicate receipts for an already-terminal attempt', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([
        commandRow({ status: 'executed' }),
        commandRow({
          command_id: 'att-2',
          root_command_id: 'att-2',
          command_key: 'stop',
          status: 'sent',
        }),
      ]);
    const service = new ControlService({ execute } as never);

    await expect(
      service.receiveReceipt('ctl-1', 'start', 'executed', { ok: true }),
    ).rejects.toThrow(/Duplicate receipt/);
  });

  it('rejects receipts on terminal requests', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([
        commandRow({ status: 'executed', response_at: '2026-08-03T00:00:01.000Z' }),
        commandRow({
          command_id: 'att-2',
          root_command_id: 'att-2',
          command_key: 'stop',
          status: 'executed',
          response_at: '2026-08-03T00:00:01.000Z',
        }),
      ]);
    const service = new ControlService({ execute } as never);

    await expect(
      service.receiveReceipt('ctl-1', 'start', 'executed', { ok: true }),
    ).rejects.toThrow(/terminal request/);
  });

  it('uses the latest attempt per command key when computing status', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([
        commandRow({ attempt_no: 1, status: 'failed' }),
        commandRow({ attempt_no: 2, status: 'executed', command_id: 'att-2', root_command_id: 'att-1' }),
      ]);
    const service = new ControlService({ execute } as never);

    const { status } = await service.getStatus('ctl-1');

    expect(status).toBe('executed');
  });

  it('surfaces database failures as explainable errors', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('connection refused'));
    const service = new ControlService({ execute } as never);

    await expect(service.getRequest('ctl-1')).rejects.toThrow(/failed/);
  });
});

describe('ControlService audit', () => {
  const ACTOR = { userId: 'user-1', primaryOrgId: 'org-1' };

  it('audits request creation with the acting user and after state', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestRow]);
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ControlService(
      { execute } as never,
      auditService as never,
    );

    const result = await service.createRequest(
      {
        deviceId: 'exo-1',
        commandKeys: ['start'],
        idempotencyKey: 'idem-1',
      },
      ACTOR,
    );

    expect(result.id).toBe('ctl-1');
    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'control.create',
        entityType: 'control_request',
        entityId: 'ctl-1',
        before: null,
        after: expect.objectContaining({
          deviceId: 'exo-1',
          commandKeys: ['start', 'stop'],
          status: 'created',
        }),
      }),
    );
  });

  it('audits command submission with before/after attempt state', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow()]);
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ControlService(
      { execute } as never,
      auditService as never,
    );

    await service.sendCommand('ctl-1', 'start', ACTOR);

    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'control.command.send',
        entityType: 'control_command',
        before: expect.objectContaining({
          requestId: 'ctl-1',
          commandKey: 'start',
          previousAttemptCount: 0,
        }),
        after: expect.objectContaining({
          commandKey: 'start',
          attemptNo: 1,
          status: 'sent',
        }),
      }),
    );
  });

  it('audits revoke with before/after request status', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestRow])
      .mockResolvedValueOnce([commandRow({ status: 'failed' })]);
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ControlService(
      { execute } as never,
      auditService as never,
    );

    await service.revoke('ctl-1', ACTOR);

    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'control.revoke',
        entityType: 'control_request',
        entityId: 'ctl-1',
        before: expect.objectContaining({ status: 'pending_gateway' }),
        after: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
