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

function collectValues(
  node: unknown,
  sets: { orgIds: Set<string>; roles: Set<string>; statuses: Set<string>; notificationIds: Set<string> },
  seen: WeakSet<object>,
): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, sets, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      if (value.startsWith('org-')) sets.orgIds.add(value);
      if (['workshop_lead', 'dispatcher', '__none__'].includes(value)) sets.roles.add(value);
      if (value === 'pending' || value === 'read' || value === 'failed' || value === 'sent') sets.statuses.add(value);
      if (value.startsWith('NTF-')) sets.notificationIds.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { orgIds: new Set<string>(), roles: new Set<string>(), statuses: new Set<string>(), notificationIds: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.roles.size > 0 && !sets.roles.has(String(row.recipientId))) return false;
  if (sets.statuses.size > 0 && !sets.statuses.has(String(row.status))) return false;
  if (sets.notificationIds.size > 0 && !sets.notificationIds.has(String(row.notificationId))) return false;
  return true;
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
