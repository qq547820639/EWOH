import {
  buildFieldReminders,
  summarizeFieldWork,
  DEFAULT_FIELD_STALE_MS,
  FIELD_EXECUTIONS_ORIGIN,
  EXO_SESSIONS_ORIGIN,
  type FieldExecution,
  type FieldExoSession,
} from './fieldOperationsLogic';

const NOW = Date.parse('2026-09-10T10:00:00.000Z');

function execution(overrides: Partial<FieldExecution> = {}): FieldExecution {
  return {
    executionId: 'EXEC-1',
    assignmentId: 'ASG-1',
    taskId: 'TASK-1',
    planId: 'PLAN-1',
    status: 'DISPATCHED',
    personId: 'P-1',
    plannedStartAt: '2026-09-10T11:00:00.000Z',
    plannedEndAt: '2026-09-10T12:00:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    source: 'dispatch',
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    personId: 'P-1',
    executions: [] as FieldExecution[],
    exoSessions: [] as FieldExoSession[],
    now: NOW,
    dataFresh: true,
    dataUpdatedAt: NOW - 5_000,
    ...overrides,
  };
}

describe('buildFieldReminders（现场提醒派生）', () => {
  it('数据不新鲜时：只给一条可信度提醒，并且不产出任何待办类提醒', () => {
    const reminders = buildFieldReminders(baseInput({
      dataFresh: false,
      // 即使存在一条明显逾期的任务，也不得渲染成"你现在该做这个"
      executions: [execution({ plannedStartAt: '2026-09-10T08:00:00.000Z' })],
    }));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].kind).toBe('RECEIPT_DATA_STALE');
    expect(reminders[0].source.fresh).toBe(false);
    expect(reminders.map((r) => r.kind)).not.toContain('ASSIGNMENT_OVERDUE');
  });

  it('首次加载或请求失败时显示“尚未就绪”，不冒充“数据已过期”', () => {
    const reminders = buildFieldReminders(baseInput({
      dataAvailable: false,
      dataFresh: false,
      dataUpdatedAt: 0,
      executions: [execution({ plannedStartAt: '2026-09-10T08:00:00.000Z' })],
    }));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].kind).toBe('FIELD_DATA_NOT_READY');
    expect(reminders[0].title).toContain('尚未就绪');
    expect(reminders[0].detail).not.toContain('数据已过期');
    expect(reminders.map((r) => r.kind)).not.toContain('ASSIGNMENT_OVERDUE');
  });

  it('已派工且超过计划开工 → overdue，并给出迟到分钟数与关联对象', () => {
    const reminders = buildFieldReminders(baseInput({
      executions: [execution({ plannedStartAt: '2026-09-10T09:00:00.000Z' })],
    }));
    const overdue = reminders.find((r) => r.kind === 'ASSIGNMENT_OVERDUE');
    expect(overdue).toBeDefined();
    expect(overdue!.severity).toBe('overdue');
    expect(overdue!.title).toContain('60 分钟');
    expect(overdue!.assignmentId).toBe('ASG-1');
    expect(overdue!.source.origin).toBe(FIELD_EXECUTIONS_ORIGIN);
    expect(overdue!.source.fresh).toBe(true);
  });

  it('未到计划开工 → attention 而非 overdue（不把未到点说成逾期）', () => {
    const reminders = buildFieldReminders(baseInput({ executions: [execution()] }));
    expect(reminders.map((r) => r.kind)).toContain('ASSIGNMENT_START_DUE');
    expect(reminders.map((r) => r.kind)).not.toContain('ASSIGNMENT_OVERDUE');
  });

  it('进行中任务 → 提示完工回执（未回执不进入偏差与学习统计）', () => {
    const reminders = buildFieldReminders(baseInput({
      executions: [execution({ status: 'STARTED', actualStartAt: '2026-09-10T09:30:00.000Z' })],
    }));
    const started = reminders.find((r) => r.kind === 'STARTED_NEEDS_COMPLETION');
    expect(started).toBeDefined();
    expect(started!.detail).toContain('偏差');
  });

  it('暂停任务按 attention 呈现（比进行中更需要现场注意）', () => {
    const reminders = buildFieldReminders(baseInput({ executions: [execution({ status: 'PAUSED' })] }));
    expect(reminders.find((r) => r.kind === 'STARTED_NEEDS_COMPLETION')!.severity).toBe('attention');
  });

  it('已终结任务不再产生任何现场提醒', () => {
    const reminders = buildFieldReminders(baseInput({
      executions: [
        execution({ status: 'COMPLETED', actualEndAt: '2026-09-10T09:00:00.000Z' }),
        execution({ executionId: 'EXEC-2', status: 'FAILED' }),
        execution({ executionId: 'EXEC-3', status: 'CANCELLED' }),
      ],
    }));
    const taskReminders = reminders.filter((r) => r.kind === 'ASSIGNMENT_START_DUE'
      || r.kind === 'ASSIGNMENT_OVERDUE' || r.kind === 'STARTED_NEEDS_COMPLETION');
    expect(taskReminders).toHaveLength(0);
  });

  it('只显示属于当前操作者的任务（不泄漏他人待办）', () => {
    const reminders = buildFieldReminders(baseInput({
      executions: [
        execution({ personId: 'P-OTHER', plannedStartAt: '2026-09-10T08:00:00.000Z' }),
        execution({ assignmentId: 'ASG-MINE', personId: 'P-1', plannedStartAt: '2026-09-10T08:00:00.000Z' }),
      ],
    }));
    const overdue = reminders.filter((r) => r.kind === 'ASSIGNMENT_OVERDUE');
    expect(overdue).toHaveLength(1);
    expect(overdue[0].assignmentId).toBe('ASG-MINE');
  });

  it('操作者身份缺失时不猜测"我的任务"，只提示未分配', () => {
    const reminders = buildFieldReminders(baseInput({
      personId: null,
      executions: [execution({ plannedStartAt: '2026-09-10T08:00:00.000Z' })],
    }));
    const taskReminders = reminders.filter((r) => r.kind === 'ASSIGNMENT_OVERDUE' || r.kind === 'ASSIGNMENT_START_DUE');
    expect(taskReminders).toHaveLength(0);
  });

  it('无活跃外骨骼会话 → 提示未绑定，且不断言设备故障', () => {
    const reminders = buildFieldReminders(baseInput());
    const unbound = reminders.find((r) => r.kind === 'EXO_SESSION_UNBOUND');
    expect(unbound).toBeDefined();
    expect(unbound!.source.origin).toBe(EXO_SESSIONS_ORIGIN);
    expect(unbound!.detail).not.toMatch(/故障|损坏|离线/);
  });

  it('活跃外骨骼会话超过预期结束时间 → 提示确认延长或结束', () => {
    const reminders = buildFieldReminders(baseInput({
      exoSessions: [{
        sessionId: 'exo-session:1', exoId: 'device:EXO-1', personId: 'P-1',
        status: 'active', startedAt: '2026-09-10T07:00:00.000Z',
        expectedEndAt: '2026-09-10T09:00:00.000Z',
      }],
    }));
    const stale = reminders.find((r) => r.kind === 'EXO_SESSION_STALE');
    expect(stale).toBeDefined();
    expect(stale!.sessionId).toBe('exo-session:1');
    expect(reminders.map((r) => r.kind)).not.toContain('EXO_SESSION_UNBOUND');
  });

  it('会话数据不可用时不断言"未绑定"（读不到 ≠ 没绑定）', () => {
    const reminders = buildFieldReminders(baseInput({
      // 请求失败：exoSessions 为空数组，但这是"未知"而非"没有"
      exoDataAvailable: false,
      exoSessions: [],
    }));
    expect(reminders.map((r) => r.kind)).not.toContain('EXO_SESSION_UNBOUND');
    expect(reminders.map((r) => r.kind)).not.toContain('EXO_SESSION_STALE');
  });

  it('会话数据可用且确实为空 → 才提示未绑定', () => {
    const reminders = buildFieldReminders(baseInput({ exoDataAvailable: true, exoSessions: [] }));
    expect(reminders.map((r) => r.kind)).toContain('EXO_SESSION_UNBOUND');
  });

  it('他人外骨骼会话不计入我的提醒（会话按 personId 归属）', () => {
    const reminders = buildFieldReminders(baseInput({
      exoSessions: [{
        sessionId: 'exo-session:other', exoId: 'device:EXO-9', personId: 'P-OTHER',
        status: 'active', startedAt: '2026-09-10T07:00:00.000Z',
      }],
    }));
    expect(reminders.map((r) => r.kind)).toContain('EXO_SESSION_UNBOUND');
  });

  it('每条提醒都必须携带来源与依据时间（可信度不可缺省）', () => {
    const reminders = buildFieldReminders(baseInput({
      executions: [
        execution({ plannedStartAt: '2026-09-10T08:00:00.000Z' }),
        execution({ executionId: 'EXEC-2', status: 'STARTED' }),
      ],
      exoSessions: [{
        sessionId: 'exo-session:1', exoId: 'device:EXO-1', personId: 'P-1',
        status: 'active', startedAt: '2026-09-10T07:00:00.000Z',
        expectedEndAt: '2026-09-10T09:00:00.000Z',
      }],
    }));
    expect(reminders.length).toBeGreaterThan(0);
    for (const reminder of reminders) {
      expect(reminder.source.origin).toMatch(/^GET \/api\//);
      expect(reminder.source.asOf).not.toBeNull();
      expect(typeof reminder.source.fresh).toBe('boolean');
      expect(reminder.title.length).toBeGreaterThan(0);
      expect(reminder.detail.length).toBeGreaterThan(0);
    }
  });

  it('不产生任何设备控制类输出（提醒 ≠ 指令）', () => {
    const reminders = buildFieldReminders(baseInput({
      executions: [execution({ plannedStartAt: '2026-09-10T08:00:00.000Z' })],
      exoSessions: [{
        sessionId: 'exo-session:1', exoId: 'device:EXO-1', personId: 'P-1',
        status: 'active', startedAt: '2026-09-10T07:00:00.000Z',
      }],
    }));
    const blob = JSON.stringify(reminders);
    for (const forbidden of ['joint', 'torque', 'assistLevel', '限速', '力矩', '关节', '急停']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it('默认陈旧阈值为 5 分钟（与现场数据新鲜度约定一致）', () => {
    expect(DEFAULT_FIELD_STALE_MS).toBe(300_000);
  });

  // ── 攻击面 c：现场人员按"北京时间"读表 ────────────────────────────────
  // 提醒 detail 里的时间不是给系统看的（判定已用毫秒完成），是给人看的。
  // 直接拼接 UTC ISO（如 2026-09-10T02:00:00.000Z）会让 UTC+8 的工人把
  // 02:00Z 读成"凌晨 2 点"，与页面其余时间（统一 Asia/Shanghai 渲染）相差
  // 8 小时，工人据此判断"该不该开工"必然出错。
  it('等待开工的 detail 用北京时间呈现计划开始，不直接拼接 UTC ISO', () => {
    const reminders = buildFieldReminders(baseInput({
      // NOW=10:00Z，次日 02:00Z 未到 → 走"等待开工"分支。
      executions: [execution({ plannedStartAt: '2026-09-11T02:00:00.000Z' })],
    }));
    const due = reminders.find((r) => r.kind === 'ASSIGNMENT_START_DUE');
    expect(due).toBeDefined();
    // 02:00Z = 北京时间 10:00。
    expect(due!.detail).toContain('10:00');
    expect(due!.detail).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('外骨骼会话超期的 detail 同样用北京时间呈现预期结束时间', () => {
    const reminders = buildFieldReminders(baseInput({
      exoSessions: [{
        sessionId: 'exo-session:1', exoId: 'device:EXO-1', personId: 'P-1',
        status: 'active', startedAt: '2026-09-10T01:00:00.000Z',
        expectedEndAt: '2026-09-10T01:30:00.000Z',
      }],
    }));
    const stale = reminders.find((r) => r.kind === 'EXO_SESSION_STALE');
    expect(stale).toBeDefined();
    // 01:30Z = 北京时间 09:30。
    expect(stale!.detail).toContain('09:30');
    expect(stale!.detail).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe('summarizeFieldWork（现场工作量汇总）', () => {
  it('按状态分别计数，且只统计本人', () => {
    const executions: FieldExecution[] = [
      execution({ executionId: 'E1', status: 'DISPATCHED' }),
      execution({ executionId: 'E2', status: 'STARTED' }),
      execution({ executionId: 'E3', status: 'PAUSED' }),
      execution({ executionId: 'E4', status: 'COMPLETED' }),
      execution({ executionId: 'E5', status: 'PLANNED', plannedStartAt: '2000-01-01T00:00:00.000Z' }),
      execution({ executionId: 'E6', status: 'DISPATCHED', personId: 'P-OTHER' }),
    ];
    // 显式传入时钟：否则"逾期"会随真实时间漂移，用例不再可复现。
    const summary = summarizeFieldWork(executions, 'P-1', NOW);
    expect(summary.open).toBe(2);
    expect(summary.started).toBe(2);
    expect(summary.done).toBe(1);
    // E5 计划开工时间已远早于当前时间 → 计入逾期。
    expect(summary.overdue).toBe(1);
  });

  it('personId 缺失时返回全零，而不是统计全厂', () => {
    expect(summarizeFieldWork([execution()], null, NOW)).toEqual({ open: 0, started: 0, overdue: 0, done: 0 });
  });
});
