import {
  PLAN_STATUS_BADGE,
  READ_ACTIONS,
  WRITE_ACTIONS,
  planActions,
  planJourney,
  resolveObjectRoute,
  type PlanActionKind,
} from './planActions';
import type { PlanStatus } from '@shared/api.interface';

const ALL_STATUSES: PlanStatus[] = [
  'draft',
  'shadow',
  'approved',
  'dispatched',
  'executing',
  'completed',
  'rejected',
  'superseded',
];

const PLAN_ID = 'PLN-2026-0901-003';

describe('planActions（OD-5 终态行动条 · 动作单一事实源）', () => {
  it.each(ALL_STATUSES)('%s 状态至少提供 1 个后继入口（终态必有出口）', (status) => {
    expect(planActions(status, PLAN_ID).length).toBeGreaterThan(0);
  });

  it('待审批态提供审批与驳回，且为写操作', () => {
    for (const status of ['draft', 'shadow'] as PlanStatus[]) {
      const kinds = planActions(status, PLAN_ID).map((a) => a.kind);
      expect(kinds).toContain('approve');
      expect(kinds).toContain('reject');
    }
  });

  it('已审批态提供下发执行', () => {
    const kinds = planActions('approved', PLAN_ID).map((a) => a.kind);
    expect(kinds).toContain('dispatch');
  });

  it.each(['dispatched', 'executing', 'completed', 'rejected', 'superseded'] as PlanStatus[])(
    '%s 终态提供导航型出口（不再只剩静态文本）',
    (status) => {
      const navigable = planActions(status, PLAN_ID).filter((a) => Boolean(a.route));
      expect(navigable.length).toBeGreaterThan(0);
    },
  );

  it('导航目标的 plan 参数经过编码', () => {
    const actions = planActions('dispatched', 'PLN/with special?chars');
    const navigable = actions.find((a) => a.route);
    expect(navigable?.route).toContain(encodeURIComponent('PLN/with special?chars'));
    expect(actions.find((a) => a.kind === 'viewExecution')?.route).toBe(
      `/factory-operations?plan=${encodeURIComponent('PLN/with special?chars')}`,
    );
    expect(actions.find((a) => a.kind === 'viewHistory')?.route).toBe('/decision-history');
  });

  it('每个状态至多一个主行动（避免双主按钮争夺注意力）', () => {
    for (const status of ALL_STATUSES) {
      const primary = planActions(status, PLAN_ID).filter((a) => a.variant === 'primary');
      expect(primary.length).toBeLessThanOrEqual(1);
    }
  });

  it('动作三分互斥：导航（route）/ 写操作 / 只读，每个动作恰好属于一类', () => {
    for (const status of ALL_STATUSES) {
      for (const action of planActions(status, PLAN_ID)) {
        const categories = [
          Boolean(action.route),
          WRITE_ACTIONS.has(action.kind as PlanActionKind),
          READ_ACTIONS.has(action.kind as PlanActionKind),
        ].filter(Boolean).length;
        expect(categories).toBe(1);
      }
    }
  });

  it('NO-62c：检查新鲜度是**只读**动作（不混进写操作，避免"看一眼就改了东西"）', () => {
    const draft = planActions('draft', PLAN_ID);
    expect(draft.find((a) => a.kind === 'checkFreshness')).toMatchObject({
      kind: 'checkFreshness',
      variant: 'secondary',
    });
    expect(READ_ACTIONS.has('checkFreshness')).toBe(true);
    expect(WRITE_ACTIONS.has('checkFreshness')).toBe(false);
    // 生成人回避（不能自批）时仍可检查新鲜度，但不得出现"审批通过"
    const self = planActions('draft', PLAN_ID, { createdBy: 'u1', currentUserId: 'u1' });
    expect(self.some((a) => a.kind === 'approve')).toBe(false);
    expect(self.some((a) => a.kind === 'checkFreshness')).toBe(true);
  });

  it('未知状态返回空数组而非抛错', () => {
    expect(planActions('bogus' as PlanStatus, PLAN_ID)).toEqual([]);
  });
});

describe('planJourney（OD-8 Journey Rail）', () => {
  const DONE_AI = 'done' as const;

  it('生成方案环节恒为已完成', () => {
    for (const status of ALL_STATUSES) {
      expect(planJourney(status, DONE_AI, PLAN_ID)[0].state).toBe('done');
    }
  });

  it.each(ALL_STATUSES)('%s 恰好有一个当前环节或全部完成', (status) => {
    const steps = planJourney(status, DONE_AI, PLAN_ID);
    const current = steps.filter((s) => s.state === 'current');
    expect(current.length).toBeLessThanOrEqual(1);
  });

  it('draft：评审会签为当前环节，下发与执行尚未到达', () => {
    const steps = planJourney('draft', DONE_AI, PLAN_ID);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.review.state).toBe('current');
    expect(byKey.dispatch.state).toBe('todo');
    expect(byKey.execute.state).toBe('todo');
  });

  it('approved：下发执行为当前环节', () => {
    const steps = planJourney('approved', DONE_AI, PLAN_ID);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.review.state).toBe('done');
    expect(byKey.dispatch.state).toBe('current');
  });

  it('dispatched / executing：执行跟踪为当前环节', () => {
    for (const status of ['dispatched', 'executing'] as PlanStatus[]) {
      const byKey = Object.fromEntries(
        planJourney(status, DONE_AI, PLAN_ID).map((s) => [s.key, s]),
      );
      expect(byKey.execute.state).toBe('current');
    }
  });

  it('completed：全部完成', () => {
    const steps = planJourney('completed', DONE_AI, PLAN_ID);
    expect(steps.every((s) => s.state === 'done')).toBe(true);
  });

  it('rejected：流程终止，后续环节为 todo 且不提供路由', () => {
    const steps = planJourney('rejected', DONE_AI, PLAN_ID);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.review.state).toBe('done');
    expect(byKey.dispatch.state).toBe('todo');
    expect(byKey.dispatch.route).toBeUndefined();
    expect(byKey.execute.route).toBeUndefined();
  });

  it('AI 解读生成中时该环节为进行中，可用后转为已完成', () => {
    expect(
      planJourney('draft', 'pending', PLAN_ID).find((s) => s.key === 'narration')?.state,
    ).toBe('current');
    expect(
      planJourney('draft', 'done', PLAN_ID).find((s) => s.key === 'narration')?.state,
    ).toBe('done');
    // 不可用时视为跳过，不阻塞主线停在"生成中"。
    expect(
      planJourney('draft', 'unavailable', PLAN_ID).find((s) => s.key === 'narration')?.state,
    ).toBe('done');
  });

  it('todo 环节一律不提供路由（不产生死链）', () => {
    for (const status of ALL_STATUSES) {
      for (const step of planJourney(status, DONE_AI, PLAN_ID)) {
        if (step.state === 'todo') expect(step.route).toBeUndefined();
      }
    }
  });
});

describe('resolveObjectRoute（OD-9 关联对象下钻）', () => {
  it('调度方案下钻到对象工作台', () => {
    expect(resolveObjectRoute('scheduling_plan', 'PLN-1')).toBe('/o/scheduling_plan/PLN-1');
  });

  it('设备与人员复用既有台账页，不新建页面', () => {
    expect(resolveObjectRoute('device', 'EXO-007')).toBe('/devices');
    expect(resolveObjectRoute('person', 'EMP-1')).toBe('/personnel');
  });

  it('无对应页面的类型返回 undefined（渲染为纯文本）', () => {
    expect(resolveObjectRoute('station', 'ST-1')).toBeUndefined();
    expect(resolveObjectRoute('unknown-type', 'X')).toBeUndefined();
  });

  it('对象 ID 经过 URL 编码', () => {
    expect(resolveObjectRoute('scheduling_plan', 'PLN/a?b')).toBe(
      '/o/scheduling_plan/PLN%2Fa%3Fb',
    );
  });
});

describe('PLAN_STATUS_BADGE（横切 X-3 语义 Token）', () => {
  it.each(ALL_STATUSES)('%s 有中文标签', (status) => {
    expect(PLAN_STATUS_BADGE[status]?.label).toBeTruthy();
  });

  it.each(ALL_STATUSES)('%s 使用 risk-* 语义 Token，不用 Tailwind 默认色族', (status) => {
    const className = PLAN_STATUS_BADGE[status]?.className ?? '';
    expect(className).toMatch(/risk-/);
    expect(className).not.toMatch(/\b(emerald|amber|cyan|red|blue|rose|sky|orange|teal)-\d/);
  });
});

describe('planActions B5 审批独立性（自批过滤）', () => {
  const SELF = { createdBy: 'user-1', currentUserId: 'user-1' };
  const OTHER = { createdBy: 'user-1', currentUserId: 'user-2' };

  it('draft/shadow：生成人被过滤 approve，保留 reject（撤回是合理业务）', () => {
    const kinds = planActions('draft', PLAN_ID, SELF).map((a) => a.kind);
    expect(kinds).not.toContain('approve');
    expect(kinds).toContain('reject');
  });

  it('他人审批不受影响', () => {
    const kinds = planActions('draft', PLAN_ID, OTHER).map((a) => a.kind);
    expect(kinds).toContain('approve');
    expect(kinds).toContain('reject');
  });

  it('createdBy 为 null（存量行）不触发过滤', () => {
    const kinds = planActions('draft', PLAN_ID, {
      createdBy: null,
      currentUserId: 'user-1',
    }).map((a) => a.kind);
    expect(kinds).toContain('approve');
  });

  it('approved 态（下发执行）不受自批过滤影响——独立性只约束审批环节', () => {
    const kinds = planActions('approved', PLAN_ID, SELF).map((a) => a.kind);
    expect(kinds).toContain('dispatch');
  });

  it('guard 缺省时行为不变（向后兼容）', () => {
    const kinds = planActions('draft', PLAN_ID).map((a) => a.kind);
    expect(kinds).toContain('approve');
  });
});
