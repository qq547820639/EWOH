/* NO-36a：外骨骼会话执行边界守卫（纯函数）测试。
 *
 * 钉死四条语义：
 *   1. 无会话 → 不阻塞（缺数据 ≠ 有冲突）；
 *   2. 佩戴者本人 + 设备 → 合法（人机同体，物理可行）；
 *   3. 指派给别人 / 没指派人都不是可执行的组合 → 冲突（fail-closed）；
 *   4. 佩戴者引用不可解析（数据缺口）→ 冲突而不是放行。
 * 另测：世界模型设备项 → 会话事实的适配（形状不全不猜）。
 */
/// <reference types="jest" />
import {
  activeSessionFactsFromDevices,
  buildDeviceContextSuggestion,
  describeExoAssignmentConflict,
  describeExoSessionStartConflict,
  findExoAssignmentConflicts,
  findExoSessionStartConflicts,
  type ExoActiveSessionFact,
} from '../exo-assignment-guard';

const DEV_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const WEARER_UUID = '33333333-3333-4333-8333-333333333333';
const OTHER_PERSON = '44444444-4444-4444-8444-444444444444';

const session: ExoActiveSessionFact = {
  sessionId: 'exo-session:test-1',
  businessDeviceId: 'EXO-001',
  deviceUuid: DEV_UUID,
  wearerPersonId: `person:${WEARER_UUID}`,
};

describe('findExoAssignmentConflicts', () => {
  it('无活跃会话 → 无冲突（不因为没有事实而阻塞）', () => {
    expect(
      findExoAssignmentConflicts([{ deviceId: DEV_UUID, personId: OTHER_PERSON }], []),
    ).toEqual([]);
  });

  it('佩戴者本人 + 该设备 → 合法（人机同体；`person:` 前缀与裸 uuid 视为同一人）', () => {
    expect(
      findExoAssignmentConflicts([{ deviceId: DEV_UUID, personId: WEARER_UUID }], [session]),
    ).toEqual([]);
    expect(
      findExoAssignmentConflicts(
        [{ deviceId: DEV_UUID, personId: `person:${WEARER_UUID}` }],
        [session],
      ),
    ).toEqual([]);
  });

  it('指派给别人 → wearer_mismatch（一台外骨骼同一时刻只能由佩戴者使用）', () => {
    const conflicts = findExoAssignmentConflicts(
      [{ deviceId: DEV_UUID, personId: OTHER_PERSON, label: 'assignment:a-1' }],
      [session],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      reason: 'wearer_mismatch',
      deviceUuid: DEV_UUID,
      businessDeviceId: 'EXO-001',
      sessionId: 'exo-session:test-1',
      wearerRef: WEARER_UUID,
      assignedRef: OTHER_PERSON,
      label: 'assignment:a-1',
    });
  });

  it('有会话但本指派没指定人员 → assignee_missing（不能猜谁去用）', () => {
    const conflicts = findExoAssignmentConflicts([{ deviceId: DEV_UUID, personId: null }], [session]);
    expect(conflicts[0]?.reason).toBe('assignee_missing');
  });

  it('佩戴者引用不可解析（数据缺口）→ 冲突而不是放行（fail-closed）', () => {
    const broken: ExoActiveSessionFact = { ...session, wearerPersonId: '   ' };
    const conflicts = findExoAssignmentConflicts(
      [{ deviceId: DEV_UUID, personId: WEARER_UUID }],
      [broken],
    );
    expect(conflicts[0]?.reason).toBe('wearer_mismatch');
    expect(conflicts[0]?.wearerRef).toBeNull();
  });

  it('只检查受影响设备：与其它设备的会话无关', () => {
    const other: ExoActiveSessionFact = {
      sessionId: 'exo-session:test-2',
      businessDeviceId: 'EXO-002',
      deviceUuid: OTHER_UUID,
      wearerPersonId: `person:${WEARER_UUID}`,
    };
    expect(
      findExoAssignmentConflicts([{ deviceId: DEV_UUID, personId: OTHER_PERSON }], [session, other]),
    ).toHaveLength(1);
    expect(
      findExoAssignmentConflicts([{ deviceId: OTHER_UUID, personId: WEARER_UUID }], [session, other]),
    ).toEqual([]);
  });

  it('空指派 / 空设备号不会误报', () => {
    expect(findExoAssignmentConflicts([], [session])).toEqual([]);
    expect(findExoAssignmentConflicts([{ deviceId: '  ', personId: OTHER_PERSON }], [session])).toEqual([]);
  });
});

describe('describeExoAssignmentConflict', () => {
  it('说清设备、会话、佩戴者、被指派人，并给出解决方向', () => {
    const [conflict] = findExoAssignmentConflicts(
      [{ deviceId: DEV_UUID, personId: OTHER_PERSON }],
      [session],
    );
    const text = describeExoAssignmentConflict(conflict);
    expect(text).toContain('EXO-001');
    expect(text).toContain('exo-session:test-1');
    expect(text).toContain(WEARER_UUID);
    expect(text).toContain(OTHER_PERSON);
    expect(text).toContain('结束会话');
  });

  it('业务设备号缺失时如实说明（不假装知道是哪台设备）', () => {
    const [conflict] = findExoAssignmentConflicts(
      [{ deviceId: DEV_UUID, personId: OTHER_PERSON }],
      [{ ...session, businessDeviceId: null }],
    );
    expect(describeExoAssignmentConflict(conflict)).toContain('业务设备号未记录');
  });

  it('未指派人员时说明"没有指定人员"而不是编一个名字', () => {
    const [conflict] = findExoAssignmentConflicts([{ deviceId: DEV_UUID, personId: null }], [session]);
    const text = describeExoAssignmentConflict(conflict);
    expect(text).toContain('没有指定人员');
    expect(text).toContain(WEARER_UUID);
  });
});

describe('activeSessionFactsFromDevices（世界模型适配器）', () => {
  it('带活跃会话的设备 → 事实；无会话 / 形状不全 → 忽略（不猜也不据此封锁）', () => {
    const facts = activeSessionFactsFromDevices([
      {
        id: DEV_UUID,
        deviceId: 'EXO-001',
        activeExoSession: { sessionId: 'exo-session:test-1', personId: `person:${WEARER_UUID}` },
      },
      { id: OTHER_UUID, deviceId: 'EXO-002', activeExoSession: null },
      { id: '33333333-3333-4333-8333-33333333333f', activeExoSession: { sessionId: '', personId: 'person:x' } },
      { id: '', activeExoSession: { sessionId: 'exo-session:broken', personId: 'person:x' } },
    ]);
    expect(facts).toEqual([
      {
        deviceUuid: DEV_UUID,
        businessDeviceId: 'EXO-001',
        sessionId: 'exo-session:test-1',
        wearerPersonId: `person:${WEARER_UUID}`,
      },
    ]);
  });

  it('设备列表为空 → 空事实（派工路径不会因此报错）', () => {
    expect(activeSessionFactsFromDevices([])).toEqual([]);
  });
});

/* ── NO-39a：反方向边界（开始会话时查在飞任务指派）────────────────────────── */
describe('findExoSessionStartConflicts', () => {
  const task = (overrides: Record<string, unknown> = {}) => ({
    taskId: 'T-1',
    title: '搬运任务',
    status: 'dispatched',
    deviceUuid: DEV_UUID,
    assigneeId: OTHER_PERSON,
    ...overrides,
  });

  it('在飞任务指派给别人 → assignee_mismatch（这台设备此刻被别人的任务占用）', () => {
    const conflicts = findExoSessionStartConflicts([task()], {
      deviceUuid: DEV_UUID,
      wearerPersonId: `person:${WEARER_UUID}`,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      reason: 'assignee_mismatch',
      taskId: 'T-1',
      status: 'dispatched',
      assigneeRef: OTHER_PERSON,
      wearerRef: WEARER_UUID,
    });
  });

  it('在飞任务的受派人就是佩戴者 → 合法（同一个人，人机同体）', () => {
    expect(
      findExoSessionStartConflicts(
        [task({ assigneeId: WEARER_UUID })],
        { deviceUuid: DEV_UUID, wearerPersonId: `person:${WEARER_UUID}` },
      ),
    ).toEqual([]);
  });

  it('在飞任务没有指定人员 → assignee_missing（不能猜谁去用）', () => {
    const conflicts = findExoSessionStartConflicts([task({ assigneeId: null })], {
      deviceUuid: DEV_UUID,
      wearerPersonId: `person:${WEARER_UUID}`,
    });
    expect(conflicts[0]?.reason).toBe('assignee_missing');
  });

  it('别的设备的在飞任务 / 佩戴者引用不可解析 → 前者不冲突、后者 fail-closed', () => {
    expect(
      findExoSessionStartConflicts([task({ deviceUuid: OTHER_UUID })], {
        deviceUuid: DEV_UUID,
        wearerPersonId: `person:${WEARER_UUID}`,
      }),
    ).toEqual([]);
    const broken = findExoSessionStartConflicts([task()], {
      deviceUuid: DEV_UUID,
      wearerPersonId: '   ',
    });
    expect(broken[0]?.reason).toBe('assignee_mismatch');
    expect(broken[0]?.wearerRef).toBeNull();
  });

  it('空输入 / 空设备号不会误报', () => {
    expect(
      findExoSessionStartConflicts([], { deviceUuid: DEV_UUID, wearerPersonId: `person:${WEARER_UUID}` }),
    ).toEqual([]);
    expect(
      findExoSessionStartConflicts([task()], { deviceUuid: '  ', wearerPersonId: `person:${WEARER_UUID}` }),
    ).toEqual([]);
  });
});

describe('describeExoSessionStartConflict', () => {
  it('说清任务、受派人、佩戴者与解决方向', () => {
    const [conflict] = findExoSessionStartConflicts(
      [{ taskId: 'T-9', title: '焊接', status: 'executing', deviceUuid: DEV_UUID, assigneeId: OTHER_PERSON }],
      { deviceUuid: DEV_UUID, wearerPersonId: `person:${WEARER_UUID}` },
    );
    const text = describeExoSessionStartConflict(conflict);
    expect(text).toContain('焊接');
    expect(text).toContain('T-9');
    expect(text).toContain('executing');
    expect(text).toContain(OTHER_PERSON);
    expect(text).toContain(WEARER_UUID);
    expect(text).toContain('改派给佩戴者');
  });

  it('任务没写受派人时说明"没有指定执行人"而不是编一个名字', () => {
    const [conflict] = findExoSessionStartConflicts(
      [{ taskId: 'T-10', title: null, status: 'received', deviceUuid: DEV_UUID, assigneeId: null }],
      { deviceUuid: DEV_UUID, wearerPersonId: `person:${WEARER_UUID}` },
    );
    expect(describeExoSessionStartConflict(conflict)).toContain('没有指定执行人');
  });
});

/* ── NO-40a：设备上下文建议（页面据此决定绑定哪张任务）──────────────────── */
describe('buildDeviceContextSuggestion', () => {
  const NOW = Date.parse('2026-09-12T12:00:00.000Z');
  const task = (overrides: Record<string, unknown> = {}) => ({
    taskId: 'T-1',
    title: '搬运任务',
    status: 'dispatched',
    assigneeId: WEARER_UUID,
    planEnd: new Date(NOW + 3_600_000).toISOString(),
    ...overrides,
  });

  it('唯一在飞任务 + 受派人就是本次人员 + 计划未过期 → 建议绑定并继承计划结束', () => {
    const suggestion = buildDeviceContextSuggestion([task()], { nowMs: NOW, personId: `person:${WEARER_UUID}` });
    expect(suggestion.taskId).toBe('T-1');
    expect(suggestion.assigneeMatches).toBe(true);
    expect(suggestion.expectedEndAt).toBe(new Date(NOW + 3_600_000).toISOString());
    expect(suggestion.reason).toContain('可继承任务计划结束时间');
  });

  it('无在飞任务 → 不绑定（没有依据把这次佩戴记到某张任务上）', () => {
    const suggestion = buildDeviceContextSuggestion([], { nowMs: NOW, personId: `person:${WEARER_UUID}` });
    expect(suggestion.taskId).toBeNull();
    expect(suggestion.expectedEndAt).toBeNull();
    expect(suggestion.reason).toContain('没有在飞任务');
  });

  it('多张在飞任务 → 不给建议（绑定哪张是人的决定）', () => {
    const suggestion = buildDeviceContextSuggestion(
      [task(), task({ taskId: 'T-2' })],
      { nowMs: NOW, personId: `person:${WEARER_UUID}` },
    );
    expect(suggestion.taskId).toBeNull();
    expect(suggestion.reason).toContain('不替现场选择');
  });

  it('受派人不是本次人员 → 仍给建议但标记不匹配，并说明会被执行边界拒绝', () => {
    const suggestion = buildDeviceContextSuggestion([task({ assigneeId: OTHER_PERSON })], {
      nowMs: NOW,
      personId: `person:${WEARER_UUID}`,
    });
    expect(suggestion.taskId).toBe('T-1');
    expect(suggestion.assigneeMatches).toBe(false);
    expect(suggestion.reason).toContain('会被执行边界拒绝');
  });

  it('任务没有受派人 / 计划已过期 / 没有计划 → 如实说明，不继承过期计划', () => {
    const noAssignee = buildDeviceContextSuggestion([task({ assigneeId: null })], {
      nowMs: NOW,
      personId: `person:${WEARER_UUID}`,
    });
    expect(noAssignee.reason).toContain('没有指定受派人');

    const expired = buildDeviceContextSuggestion([task({ planEnd: new Date(NOW - 60_000).toISOString() })], {
      nowMs: NOW,
      personId: `person:${WEARER_UUID}`,
    });
    expect(expired.expectedEndAt).toBeNull();
    expect(expired.reason).toContain('已过期，不继承');

    const noPlan = buildDeviceContextSuggestion([task({ planEnd: null })], {
      nowMs: NOW,
      personId: `person:${WEARER_UUID}`,
    });
    expect(noPlan.expectedEndAt).toBeNull();
    expect(noPlan.reason).toContain('没有计划结束时间');
  });
});
