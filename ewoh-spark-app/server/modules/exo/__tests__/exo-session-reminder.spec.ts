/* 外骨骼会话主动提醒测试（NO-37a）。
 *
 * 钉死的语义：
 *   1. 只扫**活跃**会话，且只对"超过预计结束（+宽限）"或"连续佩戴达阈值"提醒；
 *   2. 收件人 = 班组长角色 + **佩戴者本人绑定账号**（账号↔人员绑定 `ewoh_user.person_id`）；
 *      查不到绑定 → 如实进 `unresolvedWearers`，不静默丢弃；
 *   3. **幂等**：通知 id 由 (会话号, 桶, 收件人, 渠道) 确定性推导 + ON CONFLICT
 *      DO NOTHING；重复扫描只增加 duplicates；
 *   4. 正文给出可行动事实（设备/佩戴者/开始/已佩戴/预计结束/已超时）+ 边界声明
 *      （平台只管理会话绑定，不下发设备指令）；
 *   5. 只读：扫描不写会话表（fake db 里没有任何 update 入口）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import {
  ExoSessionReminderService,
} from '@server/modules/exo/exo-session-reminder.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;
const NOW = new Date('2026-09-12T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

interface HarnessOptions {
  sessions?: Array<Record<string, unknown>>;
  /** person_id → username 的绑定（模拟 ewoh_user）。 */
  bindings?: Array<{ person_id: string; username: string }>;
  /** 模拟"通知已存在"的确定性 id 集合（重复扫描）。 */
  existingNotificationIds?: Set<string>;
  /** 让 select 抛出（验证逐租户失败隔离）。 */
  failSelect?: boolean;
}

interface HarnessOptionsWithConsistency extends HarnessOptions {
  /** NO-42a：双源校验结果替身（缺省 = 没有活跃会话的判定）。 */
  consistency?: { summary?: Record<string, number>; sessions?: Array<Record<string, unknown>> };
}

function createHarness(options: HarnessOptionsWithConsistency = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const existing = options.existingNotificationIds ?? new Set<string>();
  const db = {
    select: jest.fn(() => {
      if (options.failSelect) {
        throw new Error('select failed (injected)');
      }
      return {
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue(options.sessions ?? []),
        })),
      };
    }),
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          onConflictDoNothing: jest.fn(() => ({
            returning: jest
              .fn()
              .mockResolvedValue(
                existing.has(String(values.notificationId))
                  ? []
                  : [{ notificationId: values.notificationId }],
              ),
          })),
        };
      }),
    })),
    execute: jest.fn().mockResolvedValue(options.bindings ?? []),
  };
  // 后台扫描必须经系统事务设置 GUC（否则 RLS 挡住全部行）——用替身记录调用，
  // 既验证顺序，也验证"每个租户都开了一个带 GUC 的事务"。
  const transactions: Array<{ settings: Array<{ name: string; value: string }> }> = [];
  const requestDatabaseContext = {
    runInTransaction: jest.fn(
      async (settings: Array<{ name: string; value: string }>, operation: () => Promise<unknown>) => {
        transactions.push({ settings });
        return operation();
      },
    ),
  };
  // NO-42a：提醒服务复用 NO-41a 的一致性判定（不在提醒里再算一套口径）。
  const exoSessions = {
    listTelemetryConsistency: jest.fn(async () => ({
      summary: options.consistency?.summary ?? {},
      sessions: options.consistency?.sessions ?? [],
    })),
  };
  const service = new ExoSessionReminderService(
    db as never,
    requestDatabaseContext as never,
    exoSessions as never,
  );
  return { service, inserted, db, existing, transactions, requestDatabaseContext, exoSessions };
}

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'exo-session:NO37-1',
    exoId: 'device:EXO-001',
    personId: `person:63000000-0000-4000-8000-000000000001`,
    status: 'active',
    startedAt: new Date(NOW.getTime() - 5 * 3_600_000),
    expectedEndAt: new Date(NOW.getTime() - 60 * 60_000),
    ...overrides,
  };
}

describe('ExoSessionReminderService（NO-37a 会话主动提醒）', () => {
  it('缺 org 上下文 → 400（不跨租户扫描）', async () => {
    const { service } = createHarness();
    await expect(service.sweep(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('超过预计结束 → 班组长 + 佩戴者本人各一条；正文含事实与边界声明', async () => {
    const { service, inserted } = createHarness({
      sessions: [activeSession()],
      bindings: [{ person_id: '63000000-0000-4000-8000-000000000001', username: 'worker.zhangwei' }],
    });
    const result = await service.sweep(ACTOR, { now: NOW });

    expect(result).toMatchObject({
      orgId: ORG,
      scanned: 1,
      overdue: 1,
      longRunning: 0,
      created: 2,
      duplicates: 0,
      unresolvedWearers: [],
    });
    expect(inserted).toHaveLength(2);
    const roleRow = inserted.find((row) => row.recipientType === 'role');
    const userRow = inserted.find((row) => row.recipientType === 'user');
    expect(roleRow).toMatchObject({
      notificationId: 'NTF-EXO-exo-sessionNO37-1-overdue-app',
      recipientId: 'workshop_lead',
      channel: 'app',
      severity: 'high',
      externalRef: 'exo-session:NO37-1',
    });
    expect(userRow).toMatchObject({
      notificationId: 'NTF-EXO-exo-sessionNO37-1-overdue-user-worker.zhangwei-app',
      recipientId: 'worker.zhangwei',
    });
    const body = String(roleRow?.body ?? '');
    expect(body).toContain('EXO-001');
    expect(body).toContain('63000000-0000-4000-8000-000000000001');
    expect(body).toContain('已佩戴 5 小时');
    expect(body).toContain('已超时 1 小时');
    expect(body).toContain('exo-session:NO37-1');
    expect(body).toContain('不下发任何设备指令');
    expect(String(userRow?.title ?? '')).toContain('你本人佩戴中');
  });

  it('连续佩戴达阈值且没填预计结束 → long_running（medium），正文如实说"未记录预计结束时间"', async () => {
    const { service, inserted } = createHarness({
      sessions: [
        activeSession({ expectedEndAt: null, startedAt: new Date(NOW.getTime() - 4.5 * 3_600_000) }),
      ],
      bindings: [],
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ scanned: 1, overdue: 0, longRunning: 1, created: 1 });
    // 没有绑定账号 → 只发角色通知，且**如实列出**未解析的佩戴者
    expect(result.unresolvedWearers).toEqual(['person:63000000-0000-4000-8000-000000000001']);
    expect(inserted[0]).toMatchObject({
      notificationId: 'NTF-EXO-exo-sessionNO37-1-long_running-app',
      severity: 'medium',
    });
    expect(String(inserted[0]?.body ?? '')).toContain('未记录预计结束时间');
  });

  it('幂等：同一会话同一桶重复扫描 → duplicates 增加、不再写行', async () => {
    const { service, existing, inserted } = createHarness({
      sessions: [activeSession()],
      bindings: [{ person_id: '63000000-0000-4000-8000-000000000001', username: 'worker.zhangwei' }],
    });
    const first = await service.sweep(ACTOR, { now: NOW });
    expect(first.created).toBe(2);
    for (const row of inserted) existing.add(String(row.notificationId));
    inserted.length = 0;
    const second = await service.sweep(ACTOR, { now: NOW });
    expect(second).toMatchObject({ created: 0, duplicates: 2 });
    expect(inserted).toHaveLength(2); // 仍会尝试写入，但被唯一约束吞掉（不是先查后写）
  });

  it('不在桶内 / 非活跃会话 → 不提醒（缺证据不编造）', async () => {
    const { service, inserted } = createHarness({
      sessions: [
        activeSession({ expectedEndAt: new Date(NOW.getTime() + 3_600_000), startedAt: new Date(NOW.getTime() - 60_000) }),
        activeSession({ sessionId: 'exo-session:ENDED', status: 'ended', actualEndAt: new Date(NOW.getTime() - 60_000) }),
      ],
      bindings: [],
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    // 第二条理论上不会出现在活跃查询里；这里 fake 直接返回两行，验证分类器不会误报终态
    expect(result.created).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('全租户扫描：单租户失败只留痕，其它租户照常处理', async () => {
    let calls = 0;
    const inserted: Array<Record<string, unknown>> = [];
    // execute 的调用顺序：第 1 次是"有活跃会话的租户"扫描，之后每次是佩戴者绑定查询。
    // （不能用 SQL 文本判别：drizzle 的 sql 对象 stringify 后不含表名——实测踩过。）
    let executeCalls = 0;
    const db = {
      execute: jest.fn(async () => {
        executeCalls += 1;
        if (executeCalls === 1) {
          return [{ org_id: 'org-bad' }, { org_id: 'org-good' }];
        }
        return [{ person_id: 'p-1', username: 'worker.zhangwei' }];
      }),
      select: jest.fn(() => {
        calls += 1;
        if (calls === 1) throw new Error('injected failure for org-bad');
        return {
          from: jest.fn(() => ({
            where: jest.fn().mockResolvedValue([activeSession({ personId: 'person:p-1' })]),
          })),
        };
      }),
      insert: jest.fn(() => ({
        values: jest.fn((values: Record<string, unknown>) => {
          inserted.push(values);
          return {
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue([{ notificationId: values.notificationId }]),
            })),
          };
        }),
      })),
    };
    const transactions: Array<{ settings: Array<{ name: string; value: string }> }> = [];
    const service = new ExoSessionReminderService(
      db as never,
      {
        runInTransaction: async (
          settings: Array<{ name: string; value: string }>,
          operation: () => Promise<unknown>,
        ) => {
          transactions.push({ settings });
          return operation();
        },
      } as never,
      { listTelemetryConsistency: async () => ({ summary: {}, sessions: [] }) } as never,
    );
    const result = await service.sweepAllActiveOrgs({ now: NOW });
    expect(result.orgs).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.orgId).toBe('org-bad');
    expect(result.created).toBeGreaterThan(0);
    expect(inserted.length).toBeGreaterThan(0);
    // 两个租户都会开事务（失败租户的事务随后抛错/回滚），但**每个**事务的 GUC 都必须
    // 带上该租户：RLS 策略按 app.current_org_id 判定，GUC 缺失就等于"看不见任何行"。
    expect(transactions).toHaveLength(2);
    const orgsInGuc = transactions.map(
      (tx) => tx.settings.find((setting) => setting.name === 'app.current_org_id')?.value,
    );
    expect(orgsInGuc.sort()).toEqual(['org-bad', 'org-good']);
  });
});

/* ── NO-42a：证据维度冲突进入提醒（会话声明 × 遥测）──────────────────────── */
describe('ExoSessionReminderService · 遥测冲突提醒（NO-42a）', () => {
  const conflictSession = { personId: 'person:P-1' };

  it('佩戴人不一致 → 生成 telemetry_wearer_mismatch 提醒（班组长 + 佩戴者本人，high）', async () => {
    const { service, inserted } = createHarness({
      sessions: [activeSession({ sessionId: 'exo-session:MM', ...conflictSession })],
      bindings: [{ person_id: 'P-1', username: 'worker.zhangwei' }],
      consistency: {
        summary: { wearer_mismatch: 1 },
        sessions: [
          {
            sessionId: 'exo-session:MM',
            exoId: 'device:EXO-001',
            personId: 'person:P-1',
            verdict: 'wearer_mismatch',
            reason: '遥测上报的佩戴人是 P-9，而会话记录的是 P-1：两源不一致',
            needsHumanCheck: true,
          },
        ],
      },
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    const telemetryRows = inserted.filter((row) => String(row.notificationId).includes('telemetry_wearer_mismatch'));
    expect(telemetryRows).toHaveLength(2);
    expect(telemetryRows.map((row) => row.recipientId).sort()).toEqual(['worker.zhangwei', 'workshop_lead']);
    expect(telemetryRows.every((row) => row.severity === 'high')).toBe(true);
    const roleRow = telemetryRows.find((row) => row.recipientType === 'role');
    expect(roleRow).toMatchObject({
      notificationId: 'NTF-EXO-exo-sessionMM-telemetry_wearer_mismatch-app',
      externalRef: 'exo-session:MM',
    });
    expect(String(roleRow?.body ?? '')).toContain('两源不一致');
    expect(String(roleRow?.body ?? '')).toContain('结束会话');
    expect(result.telemetry).toMatchObject({ wearerMismatch: 1, inactiveSuspect: 0 });
  });

  it('刚佩戴不久（时间桶未命中）但遥测冲突 → 仍要点名到佩戴者本人（解析范围必须覆盖全部活跃会话）', async () => {
    const { service, inserted } = createHarness({
      // 30 分钟前开始、预计结束还在未来：时间桶不命中，只有遥测冲突。
      sessions: [
        activeSession({
          sessionId: 'exo-session:FRESH',
          startedAt: new Date(NOW.getTime() - 30 * 60_000),
          expectedEndAt: new Date(NOW.getTime() + 60 * 60_000),
          personId: 'person:P-1',
        }),
      ],
      bindings: [{ person_id: 'P-1', username: 'worker.zhangwei' }],
      consistency: {
        summary: { wearer_mismatch: 1 },
        sessions: [
          {
            sessionId: 'exo-session:FRESH',
            exoId: 'device:EXO-001',
            personId: 'person:P-1',
            verdict: 'wearer_mismatch',
            reason: '两源不一致',
            needsHumanCheck: true,
          },
        ],
      },
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    const telemetryRows = inserted.filter((row) => String(row.notificationId).includes('telemetry_wearer_mismatch'));
    expect(telemetryRows.map((row) => row.recipientId).sort()).toEqual(['worker.zhangwei', 'workshop_lead']);
    expect(result.unresolvedWearers).toEqual([]);
  });

  it('遥测疑似无人佩戴 → telemetry_inactive_suspect（medium）；一致/无遥测不提醒', async () => {
    const { service, inserted } = createHarness({
      sessions: [activeSession({ sessionId: 'exo-session:IN', ...conflictSession })],
      bindings: [{ person_id: 'P-1', username: 'worker.zhangwei' }],
      consistency: {
        summary: { inactive_suspect: 1, consistent: 1, no_telemetry: 1 },
        sessions: [
          { sessionId: 'exo-session:IN', exoId: 'device:EXO-001', personId: 'person:P-1', verdict: 'inactive_suspect', reason: '疑似未佩戴', needsHumanCheck: true },
          { sessionId: 'exo-session:OK', exoId: 'device:EXO-002', personId: 'person:P-2', verdict: 'consistent', reason: '一致', needsHumanCheck: false },
          { sessionId: 'exo-session:NO', exoId: 'device:EXO-003', personId: 'person:P-3', verdict: 'no_telemetry', reason: '无佐证', needsHumanCheck: false },
        ],
      },
    });
    const result = await service.sweep(ACTOR, { now: NOW });
    const telemetryRows = inserted.filter((row) => String(row.notificationId).includes('telemetry_'));
    expect(telemetryRows).toHaveLength(2); // 只有 inactive_suspect 触发
    expect(telemetryRows.every((row) => row.severity === 'medium')).toBe(true);
    expect(result.telemetry).toMatchObject({ inactiveSuspect: 1, wearerMismatch: 0 });
    expect(result.telemetry.verdicts).toMatchObject({ consistent: 1, no_telemetry: 1 });
  });

  it('幂等：同一冲突重复扫描 → duplicates 增加、不再写行（一次冲突只叫一次）', async () => {
    const conflict = {
      sessionId: 'exo-session:MM2',
      exoId: 'device:EXO-001',
      personId: 'person:P-1',
      verdict: 'wearer_mismatch',
      reason: '两源不一致',
      needsHumanCheck: true,
    };
    const { service, existing, inserted } = createHarness({
      sessions: [activeSession({ sessionId: 'exo-session:MM2', ...conflictSession })],
      bindings: [{ person_id: 'P-1', username: 'worker.zhangwei' }],
      consistency: { summary: { wearer_mismatch: 1 }, sessions: [conflict] },
    });
    const first = await service.sweep(ACTOR, { now: NOW });
    expect(first.telemetry.wearerMismatch).toBe(1);
    for (const row of inserted) existing.add(String(row.notificationId));
    inserted.length = 0;
    const second = await service.sweep(ACTOR, { now: NOW });
    const secondTelemetry = second.notifications.filter((n) => String(n.bucket).startsWith('telemetry_'));
    expect(secondTelemetry.every((n) => n.created === false)).toBe(true);
    expect(secondTelemetry).toHaveLength(2);
  });
});
