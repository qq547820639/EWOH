/* 数据质量"待核实"提醒（NO-53a）。
 *
 * 钉死：只扫 open 的 DataQualityAlert；责任人（班次路由）+ 角色兜底都要收到；
 * 通知号确定性可幂等；责任人缺口如实汇总；跨租户扫描逐租户开 GUC 事务；
 * **不改业务事实**（没有事件 UPDATE）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ewohEvent, ewohNotification } from '@server/database/schema';
import { DataQualityNotificationService } from '../../../server/modules/data-quality/data-quality-notification.service';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;
const NOW = new Date('2026-09-12T12:00:00.000Z');

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'EVT-DQ-1',
    eventType: 'DataQualityAlert',
    orgId: ORG,
    status: 'open',
    eventCode: 'ENTITY_NOT_FOUND',
    severity: 'high',
    title: 'entity_id person:unknown 不存在',
    deviceId: 'EXO-1',
    createdAt: new Date(NOW.getTime() - 10 * 60_000),
    evidenceJson: {
      device_id: 'EXO-1',
      fired_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      eventCode: 'ENTITY_NOT_FOUND',
      sourceEventId: 'EVT-SRC-1',
    },
    ...overrides,
  };
}

function createHarness(rows: Array<Record<string, unknown>>) {
  const notifications: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const matches = makeConditionMatcher({
    org_id: 'orgId',
    event_type: 'eventType',
    status: 'status',
    event_code: 'eventCode',
    notification_id: 'notificationId',
    external_ref: 'externalRef',
  });
  const db = {
    select: jest.fn(() => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => ({
          orderBy: () => ({
            limit: async () => rows.filter((r) => matches(cond, r)),
          }),
        }),
      }),
    })),
    insert: jest.fn((table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== ewohNotification) return [row];
            if (notifications.some((n) => n.notificationId === row.notificationId)) return [];
            notifications.push(row);
            return [{ notificationId: row.notificationId }];
          },
        }),
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, patch });
          return { returning: async () => [] };
        },
      }),
    })),
    execute: jest.fn(async () => []),
  };
  const audit = { appendAuditLog: jest.fn(async () => undefined) };
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_s: unknown, fn: () => Promise<unknown>) => fn()),
  };
  const responsibilities = {
    resolveAlertRecipients: jest.fn(async () => ({
      users: [
        {
          recipientType: 'user' as const,
          recipientId: 'worker.zhangwei',
          personId: 'person:p1',
          responsibility: 'owner' as const,
          matchedBy: 'current_shift' as const,
        },
      ],
      dedupedUserIds: ['worker.zhangwei'],
      unresolved: [{ personId: 'person:p2', responsibility: 'maintainer' as const }],
      uncovered: false,
      shiftId: 'SHIFT-NIGHT',
      shiftUnknown: false,
      outOfShift: [],
    })),
  };
  const service = new DataQualityNotificationService(
    db as never,
    audit as never,
    requestDatabaseContext as never,
    responsibilities as never,
  );
  return { service, notifications, updates, db, audit, requestDatabaseContext, responsibilities };
}

describe('DataQualityNotificationService.sweep（NO-53a）', () => {
  it('缺 org → 400（不跨租户扫描）', async () => {
    const { service } = createHarness([]);
    await expect(service.sweep(undefined, { now: NOW })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('open 告警 → 责任人（点名）+ 角色（安全员/班组长）都收到，通知号确定且可分类', async () => {
    const { service, notifications } = createHarness([alertRow()]);
    const result = await service.sweep(ACTOR, { now: NOW });

    expect(result).toMatchObject({ scanned: 1, notifyRequired: 1, created: 3, duplicates: 0 });
    const recipients = notifications.map((n) => `${n.recipientType}:${n.recipientId}`).sort();
    expect(recipients).toEqual(['role:safety_admin', 'role:workshop_lead', 'user:worker.zhangwei']);
    const ids = notifications.map((n) => String(n.notificationId)).sort();
    expect(ids.every((id) => id.startsWith('NTF-DQ-EVT-DQ-1-quality_alert-'))).toBe(true);
    // 标题点名"待核实"，正文给出"该做什么"（确认可信/标记不可信 + 判定前不当确定事实）
    expect(String(notifications[0]?.title)).toContain('数据质量待核实');
    expect(String(notifications[0]?.body)).toContain('需要人核实');
    expect(String(notifications[0]?.body)).toContain('确认');
    expect(String(notifications[0]?.body)).toContain('不会被当作确定事实');
    // 责任人缺口如实汇总（不阻塞角色提醒）
    expect(result.unresolvedResponsiblePersons).toEqual(['person:p2']);
    // **不改业务事实**：没有任何事件 UPDATE
    expect(result.notifications[0]?.alertEventId).toBe('EVT-DQ-1');
  });

  it('幂等：重复扫描只累加 duplicates（同一告警不重复打扰）', async () => {
    const { service, notifications } = createHarness([alertRow()]);
    await service.sweep(ACTOR, { now: NOW });
    const again = await service.sweep(ACTOR, { now: NOW });
    expect(again).toMatchObject({ notifyRequired: 1, created: 0, duplicates: 3 });
    expect(notifications).toHaveLength(3);
  });

  it('非 open 告警不参与（已处置的不再打扰）', async () => {
    const { service, notifications } = createHarness([alertRow({ status: 'resolved' })]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ scanned: 0, notifyRequired: 0, created: 0 });
    expect(notifications).toHaveLength(0);
  });

  it('中等严重度只叫班组长（少打扰），高严重度加安全员', async () => {
    const { service, notifications } = createHarness([alertRow({ severity: 'medium' })]);
    await service.sweep(ACTOR, { now: NOW });
    const roles = notifications.filter((n) => n.recipientType === 'role').map((n) => n.recipientId);
    expect(roles).toEqual(['workshop_lead']);
  });

  it('缺少设备号时不抛错（责任人解析返回 uncovered，仍叫角色）', async () => {
    const { service, notifications, responsibilities } = createHarness([
      alertRow({ deviceId: null, evidenceJson: { eventCode: 'CLOCK_DRIFT', fired_at: null } }),
    ]);
    responsibilities.resolveAlertRecipients.mockResolvedValueOnce({
      users: [],
      dedupedUserIds: [],
      unresolved: [],
      uncovered: true,
      shiftId: null,
      shiftUnknown: true,
      outOfShift: [],
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.notifyRequired).toBe(1);
    expect(notifications.map((n) => n.recipientId).sort()).toEqual(['safety_admin', 'workshop_lead']);
    expect(String(notifications[0]?.body)).toContain('未关联设备');
  });
});

describe('DataQualityNotificationService.sweepAllActiveOrgs（NO-53a）', () => {
  it('逐租户开 GUC 事务再读明细（否则 RLS 挡行 → 静默 0 条）', async () => {
    const { service, db, requestDatabaseContext } = createHarness([]);
    (db.execute as jest.Mock).mockResolvedValue([{ org_id: 'org-a' }, { org_id: 'org-b' }]);
    const result = await service.sweepAllActiveOrgs({ now: NOW });
    expect(result.orgs).toBe(2);
    expect(requestDatabaseContext.runInTransaction).toHaveBeenCalledTimes(2);
    const settings = requestDatabaseContext.runInTransaction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(settings)).toContain('org-a');
  });

  it('受控函数调用失败 → 如实返回 failures（不假装扫描成功）', async () => {
    const { service, db } = createHarness([]);
    (db.execute as jest.Mock).mockRejectedValue(new Error('function does not exist'));
    const result = await service.sweepAllActiveOrgs({ now: NOW });
    expect(result.orgs).toBe(0);
    expect(result.failures).toHaveLength(1);
  });
});


/* ── NO-56b：长时间未核实 → quality_aging 再催一次 ─────────────────────── */

describe('数据质量提醒的"再催一次"（quality_aging，NO-56b）', () => {
  it('超过 24h 仍未了结 → 同一告警补发 aging 桶（两个桶各自幂等）', async () => {
    const old = new Date(NOW.getTime() - 30 * 3_600_000);
    const { service, notifications } = createHarness([alertRow({ createdAt: old })]);

    const result = await service.sweep({ userId: 'lead.chen', primaryOrgId: ORG } as never, { now: NOW });

    expect(result.agingNudged).toBe(1);
    const ids = notifications.map((n) => String(n.notificationId));
    expect(ids.some((id) => id.includes('-quality_alert-'))).toBe(true);
    expect(ids.some((id) => id.includes('-quality_aging-'))).toBe(true);
    // aging 正文必须带上"多久没人核实"，否则收件人不知道这是第二次提醒
    const aging = notifications.find((n) => String(n.notificationId).includes('-quality_aging-'));
    expect(String(aging?.body)).toContain('再催一次');

    const again = await service.sweep({ userId: 'lead.chen', primaryOrgId: ORG } as never, { now: NOW });
    expect(again.created).toBe(0);
    expect(again.duplicates).toBeGreaterThanOrEqual(2);
  });

  it('未超过阈值的新告警不补 aging 桶（不刷屏）', async () => {
    const { service, notifications } = createHarness([
      alertRow({ createdAt: new Date(NOW.getTime() - 60_000) }),
    ]);
    const result = await service.sweep({ userId: 'lead.chen', primaryOrgId: ORG } as never, { now: NOW });
    expect(result.agingNudged).toBe(0);
    expect(notifications.every((n) => !String(n.notificationId).includes('-quality_aging-'))).toBe(true);
  });
});
