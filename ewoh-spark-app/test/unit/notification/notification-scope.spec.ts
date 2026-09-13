/* 通知可见范围（NO-32a）——纯函数测试。
 *
 * 为什么值得单测：授权到期提醒要"点名到发起人"，而发起人往往不是 safety_admin；
 * 放宽到用户级的同时**不能**把别人的通知漏给对方。规则本身很短，但错一次就是
 * 通知串号或永远读不到，所以在这里钉死四种范围解析。
 *
 * 端到端行为（本人读得到 / 他人读不到）由 `e2e:approval-expiry` 在真实后端验证。
 */
/// <reference types="jest" />
import { resolveNotificationScope } from '@server/modules/notification/notification.service';

describe('resolveNotificationScope（NO-32a）', () => {
  it('global_admin → all（跨租户仍由 org_id 过滤，不在本函数职责内）', () => {
    expect(resolveNotificationScope({ roles: ['global_admin'], isGlobalAdmin: true })).toEqual({ kind: 'all' });
    // 仅角色名 global_admin、但未被标记为全局管理员 → 不越权
    expect(resolveNotificationScope({ roles: ['global_admin'] })).toEqual({
      kind: 'role+user',
      roles: ['global_admin'],
      userId: '',
    });
  });

  it('有角色 + 有用户 id → role+user（角色通知 ∪ 点名给自己的）', () => {
    expect(resolveNotificationScope({ roles: ['worker'], userId: 'worker.zhangwei' })).toEqual({
      kind: 'role+user',
      roles: ['worker'],
      userId: 'worker.zhangwei',
    });
  });

  it('单值 role 与 roles 数组合并去重语义（兼容旧调用方式）', () => {
    expect(resolveNotificationScope({ role: 'dispatcher', roles: ['dispatcher', 'worker'] })).toEqual({
      kind: 'role+user',
      roles: ['dispatcher', 'worker'],
      userId: '',
    });
  });

  it('只有用户 id → user（只读点名给自己的通知）', () => {
    expect(resolveNotificationScope({ userId: 'worker.zhangwei' })).toEqual({
      kind: 'user',
      userId: 'worker.zhangwei',
    });
  });

  it('既无角色也无用户 id → none（fail-closed：不猜任何通知可见）', () => {
    expect(resolveNotificationScope({})).toEqual({ kind: 'none' });
    expect(resolveNotificationScope({ roles: [], userId: '   ' })).toEqual({ kind: 'none' });
  });

  it('空白角色/id 被剔除（不产生 "__none__" 之外的空匹配）', () => {
    expect(resolveNotificationScope({ roles: ['  ', 'worker'], userId: '  ' })).toEqual({
      kind: 'role+user',
      roles: ['worker'],
      userId: '',
    });
  });
});
