import {
  computeOee,
  nextAndonStatus,
  OeeService,
} from '../../../server/modules/oee/oee.service';
import { ewohNotification } from '@server/database/schema';

describe('OEE calculation', () => {
  it('computes availability and downtime breakdown', () => {
    const metrics = computeOee(
      [
        { evidenceJson: { status: 'running', durationSec: 60 } },
        { evidenceJson: { status: 'fault', durationSec: 30 } },
        { evidenceJson: { status: 'idle', durationSec: 10 } },
      ],
      100,
    );
    expect(metrics.availability).toBeCloseTo(0.6, 3);
    expect(metrics.oee).toBeCloseTo(0.6, 3);
    expect(metrics.downtimeBreakdown[0]).toEqual({
      reason: 'fault',
      seconds: 30,
    });
  });

  it('uses recorded durations as planned time when not supplied', () => {
    const metrics = computeOee(
      [
        { evidenceJson: { status: 'running', durationSec: 30 } },
        { evidenceJson: { status: 'changeover', durationSec: 30 } },
      ],
      0,
    );
    expect(metrics.availability).toBeCloseTo(0.5, 3);
  });
});

describe('Andon state machine', () => {
  it('walks acknowledge -> process -> close and reopens', () => {
    expect(nextAndonStatus('open', 'acknowledge')).toBe('acknowledged');
    expect(nextAndonStatus('acknowledged', 'process')).toBe('processing');
    expect(nextAndonStatus('processing', 'close')).toBe('closed');
    expect(nextAndonStatus('closed', 'reopen')).toBe('reopened');
  });

  it('rejects illegal transitions', () => {
    expect(nextAndonStatus('open', 'close')).toBeNull();
    expect(nextAndonStatus('closed', 'acknowledge')).toBeNull();
  });
});

describe('OeeService persistence', () => {
  it('records a device status event with audit', async () => {
    const row = { eventId: 'ST-1', status: 'closed' };
    const returning = jest.fn().mockResolvedValue([row]);
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn(() => ({ returning })),
    }));
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService({ insert } as never, audit as never);

    const result = await service.recordDeviceStatus(
      {
        deviceId: 'EXO-1',
        status: 'fault',
        reason: 'sensor',
        startedAt: '2026-08-03T00:00:00.000Z',
        endedAt: '2026-08-03T00:01:00.000Z',
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.eventId).toBe('ST-1');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'oee.device_status.record' }),
    );
  });

  it('escalates an andon when acknowledgment exceeds SLA and creates notification', async () => {
    const openedAt = new Date(Date.now() - 10_000);
    const andonRow = {
      eventId: 'ANDON-1',
      deviceId: 'EXO-1',
      eventType: 'andon',
      title: '异常',
      severity: 'L2',
      status: 'open',
      createdAt: openedAt,
      evidenceJson: {
        openedAt: openedAt.toISOString(),
        slaSeconds: 1,
        escalationLevel: 0,
        assignee: 'dispatcher',
        timeline: [],
      },
    };
    const selectWhere = jest.fn().mockResolvedValue([andonRow]);
    const updateReturning = jest.fn().mockResolvedValue([
      { ...andonRow, status: 'acknowledged' },
    ]);
    const insertEntries: Array<{ table: unknown; rows: unknown }> = [];
    const insert = jest.fn((table: unknown) => ({
      values: jest.fn((rows: unknown) => {
        insertEntries.push({ table, rows });
        return { returning: jest.fn().mockResolvedValue([]) };
      }),
    }));
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
      insert,
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService(db as never, audit as never);

    const result = await service.transitionAndon(
      'ANDON-1',
      'acknowledge',
      undefined,
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.status).toBe('acknowledged');
    expect(
      insertEntries.some((entry) => entry.table === ewohNotification),
    ).toBe(true);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'oee.andon.acknowledge' }),
    );
  });
});
