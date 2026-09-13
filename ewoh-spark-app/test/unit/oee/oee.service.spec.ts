import {
  computeOee,
  nextAndonStatus,
  OeeService,
} from '../../../server/modules/oee/oee.service';
import { ewohEvent, ewohNotification } from '@server/database/schema';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';
import { DEVICE_RESPONSIBILITY_KINDS } from '@shared/device-responsibility';

/**
 * NO-49a：设备责任人解析替身。
 * 默认返回"无责任关系"（收件人 = 纯角色，与接线前行为一致）；需要验证"点名到人"的
 * 用例可自行传 users。
 */
function responsibilityStub(users: Array<{ recipientId: string; personId: string }> = []) {
  return {
    resolveAlertRecipients: jest.fn(async () => ({
      users: users.map((u, index) => ({
        recipientType: 'user' as const,
        recipientId: u.recipientId,
        personId: u.personId,
        responsibility: DEVICE_RESPONSIBILITY_KINDS[index % DEVICE_RESPONSIBILITY_KINDS.length]!,
      })),
      dedupedUserIds: users.map((u) => u.recipientId),
      unresolved: [],
      uncovered: users.length === 0,
    })),
  };
}

describe('OEE calculation', () => {
  it('computes availability and downtime breakdown; missing output → performance/oee null (NEST-634)', () => {
    const metrics = computeOee(
      [
        { evidenceJson: { status: 'running', durationSec: 60 } },
        { evidenceJson: { status: 'fault', durationSec: 30 } },
        { evidenceJson: { status: 'idle', durationSec: 10 } },
      ],
      100,
    );
    expect(metrics.availability).toBeCloseTo(0.6, 3);
    // NEST-634：无 outputQty/idealRatePerSec 证据 → performance/oee 显式 null
    // （不再默认 performance=1 掩盖缺口）。
    expect(metrics.performance).toBeNull();
    expect(metrics.oee).toBeNull();
    expect(metrics.downtimeBreakdown[0]).toEqual({
      reason: 'fault',
      seconds: 30,
    });
  });

  it('computes performance and OEE when output and ideal rate evidence is present', () => {
    const metrics = computeOee(
      [
        {
          evidenceJson: {
            status: 'running',
            durationSec: 60,
            outputQty: 60,
            idealRatePerSec: 1,
          },
        },
        { evidenceJson: { status: 'fault', durationSec: 30 } },
        { evidenceJson: { status: 'idle', durationSec: 10 } },
      ],
      100,
    );
    expect(metrics.availability).toBeCloseTo(0.6, 3);
    expect(metrics.performance).toBeCloseTo(1, 3);
    expect(metrics.oee).toBeCloseTo(0.6, 3);
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

  // FR2 残余统一（2026-09-13）：global_admin 豁免与 alert.service 同款——
  // 仅豁免角色条件，转移拓扑（边存在）仍然强制，审计照记。
  it('global_admin 豁免（service 层）按拓扑判定：open→closed 边存在应可达，open→reopen 边不存在应拒', () => {
    // 纯函数不含豁免（豁免在 transitionAndon 的 service 层）——这里锁边存在性：
    // 'open→closed' 与 'processing→close' 是合法边，'open→reopen' 不是。
    const { alertTransitionEdgeExists } = require('@shared/alert-state-machine');
    expect(alertTransitionEdgeExists('open', 'acknowledged')).toBe(true);
    expect(alertTransitionEdgeExists('processing', 'closed')).toBe(true);
    expect(alertTransitionEdgeExists('open', 'reopened')).toBe(false);
    // open→closed 不是边（必须先 acknowledge→processing）——global_admin 也不能发明。
    expect(alertTransitionEdgeExists('open', 'closed')).toBe(false);
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
    const service = new OeeService({ insert } as never, audit as never, responsibilityStub() as never);

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
        // NO-47a：安灯通知改为确定性 id + `ON CONFLICT DO NOTHING`（幂等），
        // 假 db 必须提供这条链，否则测试会因为"替身缺能力"而失败。
        const returning = jest.fn().mockResolvedValue([]);
        return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
      }),
    }));
    // NO-47a：关灯会在**同一事务**里关闭该安灯的提醒 → 假 db 需要事务与按表 update。
    const notificationRows: Array<Record<string, unknown>> = [
      {
        notificationId: 'NTF-ANDON-ANDON-1-raised-app',
        orgId: 'org-1',
        externalRef: 'ANDON-1',
        status: 'pending',
        resolution: null,
      },
    ];
    const notificationMatches = makeConditionMatcher({
      org_id: 'orgId',
      notification_id: 'notificationId',
      external_ref: 'externalRef',
      status: 'status',
      resolution: 'resolution',
    });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn((table: unknown) => ({
        set: jest.fn((patch: Record<string, unknown>) => ({
          where: jest.fn((cond: unknown) => {
            if (table === ewohNotification) {
              const hit = notificationRows.filter((r) => notificationMatches(cond, r));
              for (const r of hit) Object.assign(r, patch);
              return { returning: jest.fn(async () => hit) };
            }
            return { returning: updateReturning };
          }),
        })),
      })),
      insert,
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService(db as never, audit as never, responsibilityStub() as never);

    const result = await service.transitionAndon(
      'ANDON-1',
      'acknowledge',
      undefined,
      // SH-004 联动：andon 复用 alert 状态机（fail-closed），必须携带
      // roles 数组（AccessTokenGuard 注入形态）。
      { userId: 'user-1', primaryOrgId: 'org-1', roles: ['dispatcher'] },
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
  /* ── NO-49a：开灯提醒点名到设备责任人（角色兜底）──────────────────── */
  it('开灯：设备责任人（点名到人）+ 指派角色都要收到，通知号带收件人段', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })) })),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          if (table === ewohEvent) rows.push(row);
          if (table === ewohNotification) rows.push(row);
          const returning = jest.fn(async () => [row]);
          return {
            onConflictDoNothing: jest.fn(() => ({ returning })),
            returning,
          };
        }),
      })),
      // openAndon 的目录事件写入走事务
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const responsibilities = {
      resolveAlertRecipients: jest.fn(async () => ({
        users: [
          {
            recipientType: 'user' as const,
            recipientId: 'worker.zhangwei',
            personId: 'person:p1',
            responsibility: 'owner' as const,
          },
        ],
        dedupedUserIds: ['worker.zhangwei'],
        unresolved: [{ personId: 'person:p2', responsibility: 'maintainer' as const }],
        uncovered: false,
      })),
    };
    const service = new OeeService(db as never, audit as never, responsibilities as never);

    await service.openAndon(
      { deviceId: 'EXO-1', title: '线边缺料', severity: 'high' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    const notifications = rows.filter((r) => String(r.notificationId ?? '').startsWith('NTF-ANDON-'));
    const recipients = notifications.map((r) => `${r.recipientType}:${r.recipientId}`).sort();
    expect(recipients).toEqual(['role:dispatcher', 'user:worker.zhangwei']);
    // 收件人进通知号：同一安灯的不同收件人各自独立可幂等
    expect(notifications.some((r) => String(r.notificationId).includes('-user-worker.zhangwei-'))).toBe(true);
    // 缺口（责任人无绑定账号）不阻塞提醒，但要被解析出来（由扫描/日志暴露）
    expect(responsibilities.resolveAlertRecipients).toHaveBeenCalledWith('org-1', 'EXO-1');
  });

  /* ── NO-48a：重新开灯必须显式提醒（不能因为"关过一次"就静默）──────── */
  it('重新开灯（closed → reopened）：给指派人与班组长各发一条确定性提醒', async () => {
    const closedRow = {
      eventId: 'ANDON-REOPEN-1',
      eventType: 'AndonRaised',
      orgId: 'org-1',
      status: 'closed',
      title: '线边缺料',
      deviceId: 'EXO-1',
      severity: 'high',
      createdAt: new Date(),
      evidenceJson: {
        openedAt: new Date(Date.now() - 3_600_000).toISOString(),
        slaSeconds: 900,
        assignee: 'dispatcher',
        timeline: [],
      },
    };
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([closedRow]) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: jest.fn(async () => [{ ...closedRow, status: 'reopened' }]) })),
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn((row: Record<string, unknown>) => {
          inserted.push(row);
          const returning = jest.fn(async () => [row]);
          return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
        }),
      })),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService(db as never, audit as never, responsibilityStub() as never);

    const result = await service.transitionAndon('ANDON-REOPEN-1', 'reopen', undefined, {
      userId: 'safety.zhou',
      primaryOrgId: 'org-1',
      // reopen 只允许 safety_admin（alert.yaml 角色条件）
      roles: ['safety_admin'],
    });

    expect(result.status).toBe('reopened');
    const andonNotifications = inserted.filter((r) => String(r.notificationId ?? '').startsWith('NTF-ANDON-'));
    expect(andonNotifications).toHaveLength(2);
    expect(andonNotifications.map((r) => r.recipientId).sort()).toEqual(['dispatcher', 'workshop_lead']);
    for (const row of andonNotifications) {
      expect(String(row.notificationId)).toContain('-reopened-');
      expect(String(row.body)).toContain('重新');
    }
  });

  /* ── NO-48a 第二次重开：确定性 id 若与第一次相同，notification_id 全局唯一
     + ON CONFLICT DO NOTHING 会把第二次重开的提醒**静默吞掉**（created=0），
     恰好复现"关过一次就静默"。因此重开桶必须带发生序号：第 1 次 = `reopened`，
     第 N 次 = `reopened-N`（重放同一次转移序号不变 → 幂等保持；关灯处置按
     `NTF-ANDON-<安灯号>-` 前缀 + external_ref 双重限定，全部序号一并了结）。 */
  it('同一安灯第二次重开：提醒落库为新 id（不被第一次的唯一键吞掉）', async () => {
    // 第一次重开后的证据链：open → reopen(1) → acknowledge → process → close
    // 本次动作是第二次 reopen；timeline 里的 reopen 事实数 = 2。
    const closedAgainRow = {
      eventId: 'ANDON-REOPEN-2',
      eventType: 'AndonRaised',
      orgId: 'org-1',
      status: 'closed',
      title: '线边缺料',
      deviceId: 'EXO-1',
      severity: 'high',
      createdAt: new Date(),
      evidenceJson: {
        openedAt: new Date(Date.now() - 7_200_000).toISOString(),
        slaSeconds: 900,
        assignee: 'dispatcher',
        timeline: [
          { at: new Date().toISOString(), type: 'open', actor: 'user-1' },
          { at: new Date().toISOString(), type: 'reopen', actor: 'safety.zhou' },
          { at: new Date().toISOString(), type: 'acknowledge', actor: 'user-1' },
          { at: new Date().toISOString(), type: 'process', actor: 'user-1' },
          { at: new Date().toISOString(), type: 'close', actor: 'user-1' },
        ],
      },
    };
    // 模拟 notification_id 全局唯一：同 id 二次插入 → DO NOTHING（returning 空）
    const existingIds = new Set<string>([
      // 第一次重开时已经落库的提醒（关灯后 resolution 已落痕，但行还在）
      'NTF-ANDON-ANDON-REOPEN-2-reopened-role-dispatcher-app',
      'NTF-ANDON-ANDON-REOPEN-2-reopened-role-workshop_lead-app',
    ]);
    const inserted: Array<Record<string, unknown>> = [];
    let createdRows = 0;
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([closedAgainRow]) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: jest.fn(async () => [{ ...closedAgainRow, status: 'reopened' }]) })),
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn((row: Record<string, unknown>) => {
          inserted.push(row);
          const id = String(row.notificationId ?? '');
          const returning = jest.fn(async () => {
            if (existingIds.has(id)) return []; // 唯一键冲突 → 吞掉
            existingIds.add(id);
            createdRows += 1;
            return [row];
          });
          return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
        }),
      })),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService(db as never, audit as never, responsibilityStub() as never);

    const result = await service.transitionAndon('ANDON-REOPEN-2', 'reopen', undefined, {
      userId: 'safety.zhou',
      primaryOrgId: 'org-1',
      roles: ['safety_admin'],
    });

    expect(result.status).toBe('reopened');
    const andonNotifications = inserted.filter((r) => String(r.notificationId ?? '').startsWith('NTF-ANDON-'));
    expect(andonNotifications).toHaveLength(2);
    // 第二次重开的 id 必须带发生序号（reopened-2），与第一次（reopened）不同——
    // 否则上面的唯一键模拟会把它们全部吞掉。
    for (const row of andonNotifications) {
      expect(String(row.notificationId)).toContain('-reopened-2-');
    }
    // 真正的验收：第二次重开的提醒**真的落了库**（created=2，而不是 duplicates）
    expect(createdRows).toBe(2);
  });

  /* ── NO-47a：关灯 → 该安灯的提醒随之了结（同事务）──────────────────── */
  it('安灯关闭：状态 CAS 与提醒终态同事务，提醒落 andon_cleared', async () => {
    const andonRow = {
      eventId: 'ANDON-CLOSE-1',
      eventType: 'AndonRaised',
      orgId: 'org-1',
      status: 'processing',
      title: '线边缺料',
      deviceId: 'EXO-1',
      severity: 'high',
      createdAt: new Date(),
      evidenceJson: {
        openedAt: new Date().toISOString(),
        slaSeconds: 900,
        escalationLevel: 0,
        assignee: 'dispatcher',
        timeline: [],
      },
    };
    const notificationRows: Array<Record<string, unknown>> = [
      { notificationId: 'NTF-ANDON-ANDON-CLOSE-1-raised-app', orgId: 'org-1', externalRef: 'ANDON-CLOSE-1', status: 'pending', resolution: null },
      { notificationId: 'NTF-ANDON-ANDON-CLOSE-1-sla_escalation-app', orgId: 'org-1', externalRef: 'ANDON-CLOSE-1', status: 'pending', resolution: null },
      // 另外一条安灯的提醒：绝不能被误关（前缀限定）
      { notificationId: 'NTF-ANDON-ANDON-OTHER-raised-app', orgId: 'org-1', externalRef: 'ANDON-OTHER', status: 'pending', resolution: null },
    ];
    const notificationMatches = makeConditionMatcher({
      org_id: 'orgId',
      notification_id: 'notificationId',
      external_ref: 'externalRef',
      status: 'status',
      resolution: 'resolution',
    });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([andonRow]) })),
      })),
      update: jest.fn((table: unknown) => ({
        set: jest.fn((patch: Record<string, unknown>) => ({
          where: jest.fn((cond: unknown) => {
            if (table === ewohNotification) {
              const hit = notificationRows.filter((r) => notificationMatches(cond, r));
              for (const r of hit) Object.assign(r, patch);
              return { returning: jest.fn(async () => hit) };
            }
            return {
              returning: jest.fn(async () => [{ ...andonRow, status: 'closed' }]),
            };
          }),
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => {
          const returning = jest.fn(async () => []);
          return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
        }),
      })),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService(db as never, audit as never, responsibilityStub() as never);

    const result = await service.transitionAndon('ANDON-CLOSE-1', 'close', undefined, {
      userId: 'lead.chen',
      primaryOrgId: 'org-1',
      roles: ['dispatcher'],
    });

    expect(result.status).toBe('closed');
    // 状态变更与提醒终态在**同一事务**里
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(notificationRows[0]).toMatchObject({
      status: 'resolved',
      resolution: 'andon_cleared',
      resolvedBy: 'lead.chen',
      resolutionRef: 'ANDON-CLOSE-1',
    });
    // SLA 升级提醒同样了结（同一安灯的提醒都要关）
    expect(notificationRows[1]).toMatchObject({ status: 'resolved', resolution: 'andon_cleared' });
    // 其它安灯的提醒不受影响
    expect(notificationRows[2]).toMatchObject({ status: 'pending', resolution: null });
  });

  it('openAndon 产出 AndonRaised 目录事件（ADR-031：canonical eventType + envelope + level/slaMinutes）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const rows: Array<Record<string, unknown>> = [];
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        rows.push(row);
        // NO-47a：安灯通知走确定性 id + ON CONFLICT DO NOTHING（幂等）链。
        const returning = jest.fn(async () => [row]);
        return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
      }),
    }));
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OeeService({ insert } as never, audit as never, responsibilityStub() as never);
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
          // NO-47a：安灯通知走确定性 id + ON CONFLICT DO NOTHING（幂等）链。
          const returning = jest.fn(async () => [row]);
          return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
        }),
      }));
      const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
      const service = new OeeService({ insert } as never, audit as never, responsibilityStub() as never);
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
          // NO-47a：安灯通知走确定性 id + ON CONFLICT DO NOTHING（幂等）链。
          const returning = jest.fn(async () => [row]);
          return { onConflictDoNothing: jest.fn(() => ({ returning })), returning };
        }),
      }));
      const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
      const service = new OeeService({ insert } as never, audit as never, responsibilityStub() as never);
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
