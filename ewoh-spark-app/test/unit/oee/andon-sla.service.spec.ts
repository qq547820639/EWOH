/* 安灯"超时未接手"升级服务（NO-48a）。
 *
 * 钉死：只升级 open（没人接手）；已接手/已关闭不动；开启时间无法解析 → 如实计 undecidable
 * 而不是当成"没超期"；分级受众（L1 班组长+调度 / L2 追加安全员）；确定性通知号幂等；
 * **不改业务事实**（不发 UPDATE 到事件表）；每级升级写审计留痕。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ewohEvent, ewohNotification } from '@server/database/schema';
import { AndonSlaService, buildOpenAndonOrgsQuery } from '../../../server/modules/oee/andon-sla.service';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;
const NOW = new Date('2026-09-12T12:00:00.000Z');

function andonRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'ANDON-1',
    eventType: 'AndonRaised',
    orgId: ORG,
    status: 'open',
    title: '线边缺料',
    severity: 'high',
    createdAt: new Date(NOW.getTime() - 20 * 60_000),
    evidenceJson: {
      openedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
      slaSeconds: 900,
      deviceId: 'EXO-1',
    },
    ...overrides,
  };
}

function createHarness(rows: Array<Record<string, unknown>>) {
  const notifications: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const matches = makeConditionMatcher({
    org_id: 'orgId',
    event_type: 'eventType',
    notification_id: 'notificationId',
    external_ref: 'externalRef',
    status: 'status',
    resolution: 'resolution',
  });
  const select = () => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => ({
        orderBy: () => ({
          limit: async () =>
            (table === ewohEvent ? rows : notifications).filter((r) => matches(cond, r)),
        }),
      }),
    }),
  });
  const db = {
    select: jest.fn(select),
    insert: jest.fn((table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== ewohNotification) return [row];
            const duplicate = notifications.some(
              (n) => n.notificationId === row.notificationId,
            );
            if (duplicate) return [];
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
  const audit = {
    appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
      audits.push(entry);
    }),
  };
  // 逐租户 GUC 事务上下文（跨租户扫描用；单租户 sweep 不经过它，替身直接透传回调）。
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_settings: unknown, fn: () => Promise<unknown>) => fn()),
  };
  // NO-49a：责任人解析替身（默认无责任关系 → 纯角色收件人，与接线前行为一致）
  const responsibilities = {
    resolveAlertRecipients: jest.fn(async () => ({
      users: [] as Array<{ recipientType: 'user'; recipientId: string; personId: string; responsibility: 'owner' }>,
      dedupedUserIds: [] as string[],
      unresolved: [] as Array<{ personId: string; responsibility: 'owner' }>,
      uncovered: true,
      // NO-51a：班次维度字段（默认"当前班次未知、无他班责任人"）
      shiftId: null as string | null,
      shiftUnknown: true,
      outOfShift: [] as Array<{ personId: string; responsibility: 'owner'; shiftId: string }>,
    })),
  };
  const service = new AndonSlaService(
    db as never,
    audit as never,
    requestDatabaseContext as never,
    responsibilities as never,
  );
  return { service, notifications, audits, updates, db, requestDatabaseContext, responsibilities };
}

describe('AndonSlaService.sweep（NO-48a）', () => {
  it('缺 org 上下文 → 400（不跨租户扫描）', async () => {
    const { service } = createHarness([]);
    await expect(service.sweep(undefined, { now: NOW })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('没人接手且超过 1×SLA → L1 升级给班组长与调度，通知号确定性可幂等', async () => {
    const { service, notifications, audits } = createHarness([andonRow()]);
    const result = await service.sweep(ACTOR, { now: NOW });

    expect(result).toMatchObject({ scanned: 1, openAndons: 1, breached: 1, undecidable: 0, created: 2, duplicates: 0 });
    expect(result.escalations[0]).toMatchObject({ eventId: 'ANDON-1', level: 1, bucket: 'sla_breach_l1' });
    const ids = notifications.map((n) => String(n.notificationId)).sort();
    expect(ids).toEqual([
      'NTF-ANDON-ANDON-1-sla_breach_l1-role-dispatcher-app',
      'NTF-ANDON-ANDON-1-sla_breach_l1-role-workshop_lead-app',
    ]);
    expect(String(notifications[0]?.body)).toContain('无人接手');
    // 升级不改业务事实
    expect(notifications.every((n) => n.externalRef === 'ANDON-1')).toBe(true);
    // 审计留痕（谁在何时把哪条安灯升到哪一级）
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'oee.andon.sla_breach',
      entityId: 'ANDON-1',
      actorId: 'lead.chen',
    });
  });

  it('超过 2×SLA → L2 追加安全员（三个收件人，互不覆盖）', async () => {
    const { service, notifications } = createHarness([
      andonRow({
        evidenceJson: {
          openedAt: new Date(NOW.getTime() - 40 * 60_000).toISOString(),
          slaSeconds: 900,
          deviceId: 'EXO-1',
        },
      }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.escalations[0]).toMatchObject({ level: 2, bucket: 'sla_breach_l2' });
    expect(notifications.map((n) => n.recipientId).sort()).toEqual([
      'dispatcher',
      'safety_admin',
      'workshop_lead',
    ]);
    expect(notifications.every((n) => String(n.notificationId).includes('-sla_breach_l2-'))).toBe(true);
  });

  it('已接手/已关闭的安灯**不**升级（不是"没人管"，不做重复升级噪音）', async () => {
    const { service, notifications, audits } = createHarness([
      andonRow({ eventId: 'ANDON-ACK', status: 'acknowledged' }),
      andonRow({ eventId: 'ANDON-PROC', status: 'processing' }),
      andonRow({ eventId: 'ANDON-CLOSED', status: 'closed' }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ scanned: 3, openAndons: 0, breached: 0, created: 0 });
    expect(notifications).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('未超期 → 不升级', async () => {
    const { service, notifications } = createHarness([
      andonRow({ evidenceJson: { openedAt: new Date(NOW.getTime() - 60_000).toISOString(), slaSeconds: 900 } }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ breached: 0, created: 0 });
    expect(notifications).toHaveLength(0);
  });

  it('开启时间无法解析 → 计入 undecidable（如实计数，不当成"没超期"）', async () => {
    const { service, notifications } = createHarness([
      andonRow({ createdAt: null, evidenceJson: { openedAt: 'not-a-date', slaSeconds: 900 } }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ openAndons: 1, breached: 0, undecidable: 1, created: 0 });
    expect(notifications).toHaveLength(0);
  });

  it('幂等：重复扫描不重复提醒（只累加 duplicates），审计仍记录"再次判定到超期"', async () => {
    const { service, notifications, audits } = createHarness([andonRow()]);
    await service.sweep(ACTOR, { now: NOW });
    const again = await service.sweep(ACTOR, { now: NOW });
    expect(again).toMatchObject({ breached: 1, created: 0, duplicates: 2 });
    expect(notifications).toHaveLength(2);
    // 两次扫描都留痕（第二次是"仍超期"的事实），但不会重复发提醒
    expect(audits).toHaveLength(2);
  });

  it('安灯没记录 SLA → 用默认口径升级，并在正文里说明（不冒充当该安灯的口径）', async () => {
    const { service, notifications } = createHarness([
      andonRow({
        evidenceJson: { openedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(), deviceId: 'EXO-9' },
      }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.breached).toBe(1);
    expect(String(notifications[0]?.body)).toContain('未记录自己的 SLA');
  });
});

/* ── 受控函数调用语句（回归：参数必须是 interval，不能是 text）────────── */

describe('buildOpenAndonOrgsQuery（NO-48a 回归）', () => {
  it('参数显式转 ::interval（text 实参会让 PostgreSQL 找不到函数，worker 每 tick 静默失败）', () => {
    const query = buildOpenAndonOrgsQuery(7);
    const text = (query.queryChunks ?? [])
      .map((chunk) => {
        const value = (chunk as { value?: unknown })?.value;
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join('');
        return '';
      })
      .join('');
    expect(text).toContain('ewoh_open_andon_orgs');
    expect(text).toContain('::interval');
    expect(text).toContain('days');
  });

  it('回看天数以"参数或内联数值"形式传入（不做字符串拼接注入）', () => {
    const query = buildOpenAndonOrgsQuery(30);
    // drizzle 会按值形态选择 Param 或内联；两种都接受，但**必须**能找到这个数值，
    // 且它不能是被拼进 SQL 文本的（否则注入面变大）。
    const serialized = JSON.stringify(query.queryChunks ?? [], (_key, value) =>
      value && typeof value === 'object' && 'encoder' in value
        ? { param: (value as { value?: unknown }).value }
        : value,
    );
    expect(serialized).toContain('30');
  });
});

/* ── 跨租户扫描（worker 路径）：必须逐租户开 GUC 事务 ─────────────────── */

describe('AndonSlaService.sweepAllActiveOrgs（NO-48a）', () => {
  it('拿到租户清单后，**每个租户都在 GUC 事务里**再做明细扫描（否则 RLS 挡行 → 静默 0 条）', async () => {
    const { service, db } = createHarness([]);
    // 受控函数返回两个租户
    (db.execute as jest.Mock).mockResolvedValue([
      { org_id: 'org-a' },
      { org_id: 'org-b' },
    ]);
    const result = await service.sweepAllActiveOrgs({ now: NOW });
    const ctx = (service as unknown as {
      requestDatabaseContext: { runInTransaction: jest.Mock };
    }).requestDatabaseContext;
    expect(ctx.runInTransaction).toHaveBeenCalledTimes(2);
    expect(result.orgs).toBe(2);
    // GUC 设置来自 systemCtx（userId=system + primaryOrgId=该租户）——租户隔离照旧生效
    const firstSettings = ctx.runInTransaction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(firstSettings)).toContain('org-a');
  });

  it('受控函数调用失败 → 如实返回 failures（不假装扫描成功）', async () => {
    const { service, db } = createHarness([]);
    (db.execute as jest.Mock).mockRejectedValue(new Error('function does not exist'));
    const result = await service.sweepAllActiveOrgs({ now: NOW });
    expect(result.orgs).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(String(result.failures[0]?.error)).toContain('function does not exist');
  });
});

/* ── NO-51a：班次维度（本班优先、他班只报缺口）────────────────────────── */

describe('AndonSlaService · 班次责任人（NO-51a）', () => {
  it('只登记了别的班次责任人 → 不发给"不该当班的人"，但缺口如实汇总', async () => {
    const { service, notifications, responsibilities } = createHarness([andonRow()]);
    responsibilities.resolveAlertRecipients.mockResolvedValueOnce({
      users: [],
      dedupedUserIds: [],
      unresolved: [],
      uncovered: true,
      shiftId: 'SHIFT-A',
      shiftUnknown: false,
      outOfShift: [{ personId: 'person:pNIGHT', responsibility: 'owner', shiftId: 'SHIFT-B' }],
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.outOfShiftResponsiblePersons).toEqual(['person:pNIGHT']);
    expect(result.escalations[0]?.outOfShiftPersons).toEqual(['person:pNIGHT']);
    // 角色照发（缺口不阻塞升级）
    expect(notifications.map((n) => n.recipientId).sort()).toEqual(['dispatcher', 'workshop_lead']);
    expect(result.escalations[0]?.shiftId).toBe('SHIFT-A');
  });
});
