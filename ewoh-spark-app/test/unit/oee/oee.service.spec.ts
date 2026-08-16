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
  it('walks acknowledge -> process -> close and reopens（ADR-031 角色条件）', () => {
    expect(nextAndonStatus('open', 'acknowledge', 'dispatcher')).toBe('acknowledged');
    expect(nextAndonStatus('acknowledged', 'process', 'workshop_lead')).toBe('processing');
    expect(nextAndonStatus('processing', 'close', 'device_ops')).toBe('closed');
    expect(nextAndonStatus('closed', 'reopen', 'safety_admin')).toBe('reopened');
  });

  it('rejects illegal transitions', () => {
    expect(nextAndonStatus('open', 'close', 'dispatcher')).toBeNull();
    expect(nextAndonStatus('closed', 'acknowledge', 'dispatcher')).toBeNull();
  });

  it('reopen 角色强制：非 safety_admin 拒绝（ADR-031 决策 3）', () => {
    expect(nextAndonStatus('closed', 'reopen', 'dispatcher')).toBeNull();
    expect(nextAndonStatus('closed', 'reopen', undefined)).toBeNull();
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
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const openedAt = new Date(Date.now() - 10_000);
    const andonRow = {
      eventId: 'ANDON-1',
      deviceId: 'EXO-1',
      eventType: 'andon',
      title: '异常',
      severity: 'high',
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
    // R-58 / ADR-037：SLA 升级通知带 orgId（§15 租户作用域修复）
    const notificationRow = insertEntries.find(
      (entry) => entry.table === ewohNotification,
    )?.rows as Record<string, unknown>;
    expect(notificationRow.orgId).toBe('org-1');
    expect(notificationRow.channel).toBe('app');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'oee.andon.acknowledge' }),
    );
  });
  it('openAndon 产出 AndonRaised 目录事件（ADR-031：canonical eventType + envelope + level/slaMinutes）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const rows: Array<Record<string, unknown>> = [];
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        rows.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    }));
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService({ insert } as never, audit as never);
    const result = await service.openAndon(
      { deviceId: 'EXO-1', title: '线边缺料', severity: 'L2', slaSeconds: 120 },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(result.eventType).toBe('AndonRaised');
    expect(result.severity).toBe('high'); // ADR-027 词表：legacy L2 → high
    const evidence = result.evidenceJson as Record<string, unknown>;
    expect(evidence.andonId).toBe(result.eventId);
    expect(evidence.slaMinutes).toBe(2);
    expect(evidence.level).toBe('high');
    expect((evidence as Record<string, unknown>).envelope).toBeDefined();
    expect(audit.appendAuditLog).toHaveBeenCalled();
    // R-58 / ADR-037：开灯 → app 通知（orgId 租户作用域）；未配置 lark → 不建推送行
    const notificationRows = rows.filter((r) => r.notificationId && typeof r.notificationId === 'string');
    expect(notificationRows).toHaveLength(1);
    expect(notificationRows[0]?.channel).toBe('app');
    expect(notificationRows[0]?.orgId).toBe('org-1');
    expect(notificationRows[0]?.externalRef).toBe(result.eventId);
  });

  it('openAndon 配置 lark webhook → 同时建 app + lark 推送通知（R-58 / ADR-037）', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    delete process.env.EWOH_SMTP_HOST;
    try {
      const rows: Array<Record<string, unknown>> = [];
      const insert = jest.fn((_table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          rows.push(row);
          return { returning: jest.fn(async () => [row]) };
        }),
      }));
      const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
      const service = new OeeService({ insert } as never, audit as never);
      await service.openAndon(
        { deviceId: 'EXO-1', title: '线边缺料', severity: 'high' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      );
      const notificationRows = rows.filter(
        (r) => r.notificationId && typeof r.notificationId === 'string',
      );
      const channels = notificationRows.map((r) => r.channel).sort();
      expect(channels).toEqual(['app', 'lark']);
      const larkRow = notificationRows.find((r) => r.channel === 'lark');
      expect(larkRow?.orgId).toBe('org-1');
      expect(larkRow?.status).toBe('pending');
    } finally {
      delete process.env.EWOH_LARK_WEBHOOK_URL;
    }
  });

  it('openAndon 配置 SMTP → 同时建 app + email 推送通知（R-62 / ADR-041）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'lead@factory.example';
    try {
      const rows: Array<Record<string, unknown>> = [];
      const insert = jest.fn((_table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          rows.push(row);
          return { returning: jest.fn(async () => [row]) };
        }),
      }));
      const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
      const service = new OeeService({ insert } as never, audit as never);
      await service.openAndon(
        { deviceId: 'EXO-1', title: '线边缺料', severity: 'high' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      );
      const notificationRows = rows.filter(
        (r) => r.notificationId && typeof r.notificationId === 'string',
      );
      const channels = notificationRows.map((r) => r.channel).sort();
      expect(channels).toEqual(['app', 'email']);
      const emailRow = notificationRows.find((r) => r.channel === 'email');
      expect(emailRow?.orgId).toBe('org-1');
      expect(emailRow?.status).toBe('pending');
    } finally {
      delete process.env.EWOH_SMTP_HOST;
      delete process.env.EWOH_SMTP_FROM;
      delete process.env.EWOH_SMTP_TO;
    }
  });

});
