/* NotificationService 契约行为测试（ADR-030 / NO-12f，§17 通知闭环）。
 *
 * 覆盖：org 缺失显式拒绝、角色作用域（非 global 仅见本人角色通知、无角色
 * fail-closed 不可见、global_admin 全量）、状态过滤、markRead 幂等 +
 * 他租户 404。
 * DB 以链式 fake 替换（单元层不依赖真实 PG）。
 */
/// <reference types="jest" />
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationService } from '../notification.service';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function rowOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notificationId: 'NTF-1',
    orgId: ORG_A,
    recipientType: 'role',
    recipientId: 'workshop_lead',
    channel: 'app',
    title: 'Agent 命令待审批',
    body: 'body',
    severity: 'high',
    status: 'pending',
    externalRef: 'appr-1',
    readAt: null,
    createdAt: new Date('2026-08-16T10:00:00Z'),
    ...overrides,
  };
}

/**
 * 谓词求值（**按列名**，不使用"按值嗅探"）。
 *
 * 为什么改：早期实现把条件里出现的字符串收集成"值集合"，再判断行字段是否落在集合里。
 * 这有两个致命问题（NO-44a 实测踩到第二个）：
 *   1. **未知取值被静默当作"没有条件"**——`status='paused'` 不在白名单里，过滤条件
 *      整个消失，假 DB 返回了全部行，于是"非法状态不静默按全部处理"这条契约
 *      在单元层永远测不出来（真库会返回 0 行）；
 *   2. `or(...)` 与 `and(...)` 被压成同一语义，测试通过的其实是巧合。
 * 现在按 drizzle 的 `queryChunks` 递归求值：eq / inArray / isNull / and / or 都按列比较。
 */
const COL_TO_KEY: Record<string, string> = {
  org_id: 'orgId',
  recipient_type: 'recipientType',
  recipient_id: 'recipientId',
  status: 'status',
  notification_id: 'notificationId',
};

function evalChunkText(o: unknown): string | null {
  const v = (o as { value?: unknown } | undefined)?.value;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('');
  if (typeof v === 'string') return v;
  return null;
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  const groups: boolean[][] = [[]];
  let pendingCol: string | null = null;
  for (const raw of chunks) {
    if (typeof raw === 'string') continue;
    // `inArray` 的右值在 drizzle 里是一个**裸数组 chunk**（没有 encoder/queryChunks）：
    // 早期实现只认对象 chunk，于是集合条件被静默丢掉（实测：角色过滤失效、越权行可见）。
    if (Array.isArray(raw)) {
      if (pendingCol) {
        const key = COL_TO_KEY[pendingCol] ?? pendingCol;
        const actual = row[key];
        // 数组元素是 Param 包装（drizzle 的 `inArray` 右值形如 [Param, Param]）：
        // 不解包会得到 '[object Object]'，集合判定恒为 false（实测踩到：角色过滤全空）。
        const candidates = raw.map((v) =>
          v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : String(v),
        );
        groups[groups.length - 1].push(candidates.includes(String(actual)));
        pendingCol = null;
      }
      continue;
    }
    const c = raw as { name?: string; value?: unknown; encoder?: unknown; queryChunks?: unknown[] } | undefined;
    if (!c || typeof c !== 'object') continue;
    // 列引用：drizzle 的 Column 有 name 且没有 encoder
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pendingCol = c.name;
      continue;
    }
    if (!('encoder' in c)) {
      const text = evalChunkText(c);
      if (text !== null) {
        if (/\bor\b/.test(text)) groups.push([]);
        else if (/is\s+null/i.test(text) && pendingCol) {
          const key = COL_TO_KEY[pendingCol] ?? pendingCol;
          groups[groups.length - 1].push(row[key] == null);
          pendingCol = null;
        }
        continue;
      }
      if (Array.isArray(c.queryChunks)) {
        groups[groups.length - 1].push(matches(raw, row));
        continue;
      }
    }
    if ('encoder' in c && 'value' in c && pendingCol) {
      const key = COL_TO_KEY[pendingCol] ?? pendingCol;
      const expected = (c as { value: unknown }).value;
      const actual = row[key];
      if (Array.isArray(expected)) {
        // inArray：值为数组（集合成员判定）
        groups[groups.length - 1].push(expected.map((v) => String(v)).includes(String(actual)));
      } else {
        groups[groups.length - 1].push(actual != null && String(actual) === String(expected));
      }
      pendingCol = null;
      continue;
    }
  }
  if (groups.every((g) => g.length === 0)) return true;
  return groups.some((g) => g.every(Boolean));
}

function createNotificationDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(state.rows.filter((r) => matches(cond, r)))),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          return { returning: jest.fn(async () => hit) };
        }),
      })),
    })),
  };
  const service = new NotificationService(db as never);
  return { db, rows: state.rows, service };
}

describe('NotificationService（NO-12f 通知读写闭环）', () => {
  it('org 缺失显式拒绝', async () => {
    const { service } = createNotificationDb();
    await expect(service.listNotifications('', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('角色作用域：调用者仅见本人角色通知；global_admin 全量', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1', recipientId: 'workshop_lead' }),
      rowOf({ notificationId: 'NTF-2', recipientId: 'dispatcher' }),
      rowOf({ notificationId: 'NTF-3', orgId: ORG_B }),
    ]);
    const mine = await service.listNotifications(ORG_A, { role: 'workshop_lead' });
    expect(mine).toHaveLength(1);
    expect((mine[0] as Record<string, unknown>).notificationId).toBe('NTF-1');
    const global = await service.listNotifications(ORG_A, { isGlobalAdmin: true });
    expect(global).toHaveLength(2);
  });

  it('无角色上下文 → fail-closed 不可见（不猜角色）', async () => {
    const { service } = createNotificationDb([rowOf()]);
    const list = await service.listNotifications(ORG_A, {});
    expect(list).toHaveLength(0);
  });

  it('状态过滤：pending/read', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1', status: 'pending' }),
      rowOf({ notificationId: 'NTF-2', status: 'read', readAt: new Date() }),
    ]);
    const pending = await service.listNotifications(ORG_A, { role: 'workshop_lead', status: 'pending' });
    expect(pending).toHaveLength(1);
    expect((pending[0] as Record<string, unknown>).notificationId).toBe('NTF-1');
    const read = await service.listNotifications(ORG_A, { role: 'workshop_lead', status: 'read' });
    expect(read).toHaveLength(1);
  });

  it('markRead：pending→read 幂等；他租户 404', async () => {
    const { rows, service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1' }),
      rowOf({ notificationId: 'NTF-2', orgId: ORG_B }),
    ]);
    const updated = await service.markRead(ORG_A, 'NTF-1');
    expect((updated as Record<string, unknown>).status).toBe('read');
    expect(rows[0]?.status).toBe('read');
    // 幂等：重复标记不报错
    await expect(service.markRead(ORG_A, 'NTF-1')).resolves.toBeDefined();
    // 他租户通知不存在（org 作用域）
    await expect(service.markRead(ORG_A, 'NTF-2')).rejects.toBeInstanceOf(NotFoundException);
  });

  /* ── 写侧归属校验（对抗审查 2026-09-13）──────────────────────────────
   * 修复前 markRead/retryPush 只按 org 过滤：同租户任意已认证用户可以把
   * **别人的**待办（点名给同事的、发给别的角色的安灯/SLA/审批提醒）标记
   * 已读——等于能静默压制别人的操作提醒（列表按作用域收紧了，写侧没收紧）。
   * 契约：能"看到"（列表作用域）才有资格"动"；不可见 → 与不存在同语义 404。 */
  it('markRead 写侧归属：非本人、非本角色的通知不可标记已读（404，不落写）', async () => {
    const { rows, service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-ROLE-DISP', recipientType: 'role', recipientId: 'dispatcher' }),
      rowOf({ notificationId: 'NTF-USER-OTHER', recipientType: 'user', recipientId: 'user-b' }),
    ]);
    // workshop_lead 既不是 dispatcher 角色、也不是 user-b：两条都不该动
    await expect(
      service.markRead(ORG_A, 'NTF-ROLE-DISP', { roles: ['workshop_lead'], userId: 'user-a' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.markRead(ORG_A, 'NTF-USER-OTHER', { roles: ['workshop_lead'], userId: 'user-a' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('markRead 写侧归属：本角色/点名本人/global_admin 可标记', async () => {
    const { rows, service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-ROLE-MINE', recipientType: 'role', recipientId: 'workshop_lead' }),
      rowOf({ notificationId: 'NTF-USER-ME', recipientType: 'user', recipientId: 'user-a' }),
      rowOf({ notificationId: 'NTF-OTHERS', recipientType: 'role', recipientId: 'dispatcher' }),
    ]);
    // 本角色通知：可标记
    await expect(
      service.markRead(ORG_A, 'NTF-ROLE-MINE', { roles: ['workshop_lead'], userId: 'user-a' }),
    ).resolves.toBeDefined();
    // 点名本人的通知：可标记
    await expect(
      service.markRead(ORG_A, 'NTF-USER-ME', { roles: [], userId: 'user-a' }),
    ).resolves.toBeDefined();
    // global_admin：全量可标记（与其列表全量一致）
    await expect(
      service.markRead(ORG_A, 'NTF-OTHERS', { roles: [], userId: 'admin', isGlobalAdmin: true }),
    ).resolves.toBeDefined();
    expect(rows.map((r) => r.status)).toEqual(['read', 'read', 'read']);
  });

  it('retryPush 写侧归属：非本角色的 failed 通知不可重试（404）', async () => {
    const { rows, service } = createNotificationDb([
      rowOf({
        notificationId: 'NTF-P1',
        channel: 'lark',
        status: 'failed',
        errorMessage: 'lark_webhook_http_500',
        recipientType: 'role',
        recipientId: 'workshop_lead',
      }),
    ]);
    await expect(
      service.retryPush(ORG_A, 'NTF-P1', { roles: ['dispatcher'], userId: 'user-a' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows[0]?.status).toBe('failed');
    // 本角色可重试
    await expect(
      service.retryPush(ORG_A, 'NTF-P1', { roles: ['workshop_lead'], userId: 'user-a' }),
    ).resolves.toBeDefined();
    expect(rows[0]?.status).toBe('pending');
  });
});

describe('NotificationService.retryPush（R-58 / ADR-037 推送重试）', () => {
  it('failed lark → pending + errorMessage 清空（人工重试入队）', async () => {
    const { rows, service } = createNotificationDb([
      rowOf({
        notificationId: 'NTF-P1',
        channel: 'lark',
        status: 'failed',
        errorMessage: 'lark_webhook_http_500',
      }),
    ]);
    const updated = await service.retryPush(ORG_A, 'NTF-P1');
    expect((updated as Record<string, unknown>).status).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.errorMessage).toBeNull();
  });

  it('app 通知重试 → 显式拒绝（仅推送渠道支持）', async () => {
    const { service } = createNotificationDb([rowOf({ notificationId: 'NTF-1', status: 'failed' })]);
    await expect(service.retryPush(ORG_A, 'NTF-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('非 failed 状态重试 → 显式拒绝（不静默重置）', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-P2', channel: 'lark', status: 'sent' }),
    ]);
    await expect(service.retryPush(ORG_A, 'NTF-P2')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('他租户 → 404；org 缺失 → 显式拒绝', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-X', orgId: ORG_B, channel: 'lark', status: 'failed' }),
    ]);
    await expect(service.retryPush(ORG_A, 'NTF-X')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.retryPush('', 'NTF-X')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('toNotification 透出推送字段（sentAt/errorMessage，app 行恒 null）', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1', channel: 'lark', status: 'sent', sentAt: new Date('2026-08-16T09:00:00Z'), errorMessage: null }),
      rowOf({ notificationId: 'NTF-2' }),
    ]);
    const list = await service.listNotifications(ORG_A, { isGlobalAdmin: true });
    const lark = (list as Array<Record<string, unknown>>).find((n) => n.notificationId === 'NTF-1');
    const app = (list as Array<Record<string, unknown>>).find((n) => n.notificationId === 'NTF-2');
    expect(lark?.sentAt).toBe('2026-08-16T09:00:00.000Z');
    expect(app?.sentAt).toBeNull();
    expect(app?.errorMessage).toBeNull();
  });

  /* ── NO-44a：处置结果（提醒的第二个终态维度）────────────────────────── */
  it('status=resolved 可单独查询；未处置行不带处置信息（缺失 ≠ 已处置）', async () => {
    const { service } = createNotificationDb([
      rowOf({
        notificationId: 'NTF-RESOLVED',
        status: 'resolved',
        resolution: 'session_ended',
        resolvedAt: new Date('2026-08-16T11:00:00Z'),
        resolvedBy: 'lead.chen',
        resolutionRef: 'exo-session:S1',
        externalRef: 'exo-session:S1',
      }),
      rowOf({ notificationId: 'NTF-PENDING' }),
    ]);
    const resolved = (await service.listNotifications(ORG_A, { status: 'resolved', isGlobalAdmin: true })) as Array<
      Record<string, unknown>
    >;
    expect(resolved.map((n) => n.notificationId)).toEqual(['NTF-RESOLVED']);
    expect(resolved[0]?.resolution).toBe('session_ended');
    expect(resolved[0]?.resolvedBy).toBe('lead.chen');
    expect(resolved[0]?.resolvedAt).toBe('2026-08-16T11:00:00.000Z');
    expect(resolved[0]?.resolutionRef).toBe('exo-session:S1');

    const pending = (await service.listNotifications(ORG_A, { status: 'pending', isGlobalAdmin: true })) as Array<
      Record<string, unknown>
    >;
    expect(pending.map((n) => n.notificationId)).toEqual(['NTF-PENDING']);
    expect(pending[0]?.resolution).toBeNull();
    expect(pending[0]?.resolvedBy).toBeNull();
  });

  it('markRead 不能把"已处置"降级成"已读"（处置依据不能被覆盖）', async () => {
    const { service, rows } = createNotificationDb([
      rowOf({
        notificationId: 'NTF-RESOLVED',
        status: 'resolved',
        resolution: 'session_corrected',
        resolvedAt: new Date('2026-08-16T11:00:00Z'),
        resolvedBy: 'lead.chen',
        resolutionRef: 'exo-session:NEW',
      }),
    ]);
    const out = (await service.markRead(ORG_A, 'NTF-RESOLVED')) as Record<string, unknown>;
    expect(out.status).toBe('resolved');
    expect(out.resolution).toBe('session_corrected');
    expect(rows[0]?.status).toBe('resolved');
    expect(rows[0]?.readAt).toBeNull();
  });

  it('未登记的状态过滤值不会静默按"全部"处理（不把未知当已知）', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1', status: 'pending' }),
      rowOf({ notificationId: 'NTF-2', status: 'read' }),
    ]);
    const out = (await service.listNotifications(ORG_A, { status: 'paused', isGlobalAdmin: true })) as Array<
      Record<string, unknown>
    >;
    expect(out).toHaveLength(0);
  });
});

/* R2-SNZ-002（2026-08-17 审计整改）：AccessTokenGuard 只填 roles 数组、
 * 从不设置 role 单值——原先 controller 读取 userContext.role 恒
 * undefined，非 global_admin 用户通知列表恒空（fail-closed 方向的功能
 * 失效）。回归：roles 数组按 recipient_id ∈ roles 匹配（ADR-030 契约），
 * 单值 role 兼容保留。 */
describe('NotificationService.listNotifications roles 数组（R2-SNZ-002）', () => {
  it('roles 数组：多角色调用者可见任一匹配角色的通知', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1', recipientId: 'workshop_lead' }),
      rowOf({ notificationId: 'NTF-2', recipientId: 'dispatcher' }),
      rowOf({ notificationId: 'NTF-3', recipientId: 'safety_admin' }),
      rowOf({ notificationId: 'NTF-4', orgId: ORG_B }),
    ]);
    const list = await service.listNotifications(ORG_A, {
      roles: ['workshop_lead', 'dispatcher'],
    });
    expect(list).toHaveLength(2);
    const ids = (list as Array<Record<string, unknown>>).map((n) => n.notificationId);
    expect(ids).toContain('NTF-1');
    expect(ids).toContain('NTF-2');
    expect(ids).not.toContain('NTF-3');
    expect(ids).not.toContain('NTF-4');
  });

  it('空 roles 数组 → 仍 fail-closed（__none__ 不可见）', async () => {
    const { service } = createNotificationDb([rowOf()]);
    const list = await service.listNotifications(ORG_A, { roles: [] });
    expect(list).toHaveLength(0);
  });

  it('单值 role 兼容保留（旧调用方不回归）', async () => {
    const { service } = createNotificationDb([
      rowOf({ notificationId: 'NTF-1', recipientId: 'workshop_lead' }),
      rowOf({ notificationId: 'NTF-2', recipientId: 'dispatcher' }),
    ]);
    const list = await service.listNotifications(ORG_A, { role: 'workshop_lead' });
    expect(list).toHaveLength(1);
    expect((list[0] as Record<string, unknown>).notificationId).toBe('NTF-1');
  });
});
