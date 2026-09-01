import {
  alertJourney,
  availableAlertActions,
  isAlertActionAllowed,
  severityBadge,
} from './alertActions';

/**
 * 契约来源：`shared/alert-state-machine.ts`（ADR-031 单一事实源）。
 *
 * 真实转移表（务必以该模块为准，不要凭推断）：
 *   open        → acknowledged  roles: ['handler']
 *   acknowledged→ processing    roles: ['handler']
 *   processing  → closed        roles: ['handler']
 *   closed      → reopened      roles: ['safety_admin']   ← 唯一专属角色
 *   reopened    → acknowledged  roles: ['handler']
 *   reopened    → processing    roles: ['handler']
 *
 * `handler` = { dispatcher, workshop_lead, device_ops }（见 HANDLER_ROLES）。
 * 因此角色盲区的真实表现是：
 *   ① safety_admin 对 handler 转移无权，但旧实现会给它显示确认/处置/关闭按钮 → 点击必 400；
 *   ② 非 safety_admin 点击「重开」必 400；
 *   ③ reopened 态有两个合法转移，旧实现只给一个（漏了「处置」）。
 */

const HANDLER_ROLES = ['dispatcher', 'workshop_lead', 'device_ops'];

const actionsOf = (status: string | null, roles: string[] | null) =>
  availableAlertActions(status, roles).map((a) => a.action);

describe('availableAlertActions（修复角色盲区）', () => {
  it('无角色信息时一律不返回动作（SH-004 fail-closed）', () => {
    expect(actionsOf('open', null)).toEqual([]);
    expect(actionsOf('open', [])).toEqual([]);
    expect(actionsOf('closed', null)).toEqual([]);
  });

  it('handler 三角色均可执行确认 / 处置 / 关闭', () => {
    for (const role of HANDLER_ROLES) {
      expect(actionsOf('open', [role])).toEqual(['acknowledge']);
      expect(actionsOf('acknowledged', [role])).toEqual(['process']);
      expect(actionsOf('processing', [role])).toEqual(['close']);
    }
  });

  it('safety_admin 不在 handler 内——旧实现会给它显示必 400 的按钮', () => {
    expect(actionsOf('open', ['safety_admin'])).toEqual([]);
    expect(actionsOf('acknowledged', ['safety_admin'])).toEqual([]);
    expect(actionsOf('processing', ['safety_admin'])).toEqual([]);
  });

  it('重开仅 safety_admin，其余角色明确不可', () => {
    expect(actionsOf('closed', ['safety_admin'])).toEqual(['reopen']);
    for (const role of HANDLER_ROLES) {
      expect(actionsOf('closed', [role])).toEqual([]);
    }
  });

  it('reopened 态返回两个合法动作（旧 actionFor 只给一个）', () => {
    expect(actionsOf('reopened', ['workshop_lead'])).toEqual(['acknowledge', 'process']);
  });

  it('reopened 态 safety_admin 无动作', () => {
    expect(actionsOf('reopened', ['safety_admin'])).toEqual([]);
  });

  it('global_admin 短路放行（对齐服务层 alert.service.ts:54-56）', () => {
    expect(actionsOf('open', ['global_admin'])).toContain('acknowledge');
    expect(actionsOf('closed', ['global_admin'])).toContain('reopen');
  });

  it('多角色时任一满足即放行', () => {
    expect(actionsOf('closed', ['dispatcher', 'safety_admin'])).toEqual(['reopen']);
    expect(actionsOf('closed', ['dispatcher', 'workshop_lead'])).toEqual([]);
  });

  it('status 为 null 时按 open 处理（与后端默认值一致）', () => {
    expect(actionsOf(null, ['dispatcher'])).toEqual(actionsOf('open', ['dispatcher']));
  });

  it('未知状态返回空数组而非抛错', () => {
    expect(actionsOf('bogus', ['dispatcher'])).toEqual([]);
  });
});

describe('isAlertActionAllowed', () => {
  it('无角色拒绝、global_admin 放行', () => {
    expect(isAlertActionAllowed('open', 'acknowledged', null)).toBe(false);
    expect(isAlertActionAllowed('open', 'acknowledged', [])).toBe(false);
    expect(isAlertActionAllowed('open', 'acknowledged', ['global_admin'])).toBe(true);
  });

  it('handler 放行确认、safety_admin 拒绝', () => {
    expect(isAlertActionAllowed('open', 'acknowledged', ['dispatcher'])).toBe(true);
    expect(isAlertActionAllowed('open', 'acknowledged', ['safety_admin'])).toBe(false);
  });

  it('遍历角色，任一满足即允许（与后端 .some 语义一致）', () => {
    expect(isAlertActionAllowed('closed', 'reopened', ['dispatcher', 'safety_admin'])).toBe(true);
    expect(isAlertActionAllowed('closed', 'reopened', ['dispatcher', 'workshop_lead'])).toBe(false);
  });
});

describe('alertJourney（J2 RK-2 流程带派生）', () => {
  const keyOf = (status: string | null) =>
    Object.fromEntries(alertJourney(status, 'EVT-1').map((s) => [s.key, s]));

  it('open：确认为当前环节，处置/关闭未到达', () => {
    const byKey = keyOf('open');
    expect(byKey.detect.state).toBe('done');
    expect(byKey.confirm.state).toBe('current');
    expect(byKey.process.state).toBe('todo');
    expect(byKey.close.state).toBe('todo');
  });

  it('acknowledged：处置为当前环节', () => {
    expect(keyOf('acknowledged').process.state).toBe('current');
  });

  it('processing：关闭为当前环节', () => {
    expect(keyOf('processing').close.state).toBe('current');
  });

  it('closed：全部完成', () => {
    const steps = alertJourney('closed', 'EVT-1');
    expect(steps.every((s) => s.state === 'done')).toBe(true);
  });

  it('reopened：回到确认环节（流程重启）', () => {
    expect(keyOf('reopened').confirm.state).toBe('current');
    expect(keyOf('reopened').process.state).toBe('todo');
  });

  it('null 状态按 open 处理', () => {
    expect(keyOf(null).confirm.state).toBe('current');
  });

  it('done 环节带工作台路由，todo 环节不带（不产生死链）', () => {
    for (const step of alertJourney('open', 'EVT-1')) {
      if (step.state === 'todo') expect(step.route).toBeUndefined();
      else expect(step.route).toBe('/o/alert/EVT-1');
    }
  });

  it('eventId 经过 URL 编码', () => {
    const route = alertJourney('closed', 'EVT/a?b').find((s) => s.route)?.route ?? '';
    expect(route).toContain(encodeURIComponent('EVT/a?b'));
  });
});

describe('severityBadge（J2 设计规格补充 §1）', () => {
  it('五档映射到语义 Token，不用 Tailwind 默认色族', () => {
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const cfg = severityBadge(severity);
      expect(cfg.className).toMatch(/risk-/);
      expect(cfg.className).not.toMatch(/\b(emerald|amber|red|blue|rose|sky|teal)-\d/);
    }
  });

  it('critical 与 high 同 token 但图标不同（形状通道区分等级）', () => {
    const critical = severityBadge('critical');
    const high = severityBadge('high');
    expect(critical.className).toBe(high.className);
    expect(critical.Icon).not.toBe(high.Icon);
  });

  it('未知/null 落兜底档，不抛错', () => {
    for (const severity of [null, undefined, 'bogus', '']) {
      expect(severityBadge(severity).label).toBe('未知');
    }
  });
});
