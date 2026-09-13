/* ExoSession 契约测试（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 * 覆盖：status 封闭注册表（未知拒绝）、规范身份（device:/person: 前缀）、
 * 结束事实完整（ended/aborted 必须 actualEndAt + endedBy）、时间不倒退、
 * active 不允许 actualEndAt、auditTrail、状态机终态不可复开。
 */
/// <reference types="jest" />
import {
  EXO_DEVIATION_MIN_SAMPLE,
  EXO_LONG_SESSION_THRESHOLD_MS,
  EXO_ON_TIME_TOLERANCE_MS,
  EXO_OVERDUE_REMINDER_GRACE_MS,
  classifyExoSessionReminder,
  exoSessionTransitionAllowed,
  projectExoSessionTiming,
  summarizeExoSessionDeviations,
  validateExoSession,
} from './exo-session';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'exo-session:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    exoId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    personId: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    status: 'active',
    startedAt: '2026-08-16T08:00:00Z',
    auditTrail: true,
    ...overrides,
  };
}

describe('validateExoSession（ADR-032 契约）', () => {
  it('合法 active / ended / aborted 通过', () => {
    expect(validateExoSession(record())).toEqual([]);
    expect(
      validateExoSession(
        record({ status: 'ended', actualEndAt: '2026-08-16T10:00:00Z', endedBy: 'person:op1' }),
      ),
    ).toEqual([]);
    expect(
      validateExoSession(
        record({ status: 'aborted', actualEndAt: '2026-08-16T08:30:00Z', endedBy: 'person:op1', reason: '设备故障' }),
      ),
    ).toEqual([]);
  });

  it('非规范身份拒绝（§7 + ADR-006）', () => {
    expect(validateExoSession(record({ exoId: 'EXO-001' }))[0]).toBe('bad_exo_identity');
    expect(validateExoSession(record({ personId: 'P-001' }))[0]).toBe('bad_person_identity');
  });

  it('结束事实完整：ended 缺 actualEndAt/endedBy 拒绝（§33 不悬空）', () => {
    expect(validateExoSession(record({ status: 'ended', endedBy: 'person:op1' }))[0]).toBe('actual_end_required');
    expect(
      validateExoSession(record({ status: 'ended', actualEndAt: '2026-08-16T10:00:00Z' }))[0],
    ).toBe('ended_by_required');
  });

  it('时间不倒退 + active 不允许 actualEndAt', () => {
    expect(
      validateExoSession(
        record({ status: 'ended', startedAt: '2026-08-16T10:00:00Z', actualEndAt: '2026-08-16T08:00:00Z', endedBy: 'person:op1' }),
      )[0],
    ).toBe('bad_time_order');
    expect(
      validateExoSession(record({ actualEndAt: '2026-08-16T09:00:00Z' }))[0],
    ).toBe('actual_end_not_allowed');
  });

  it('未知 status 与 auditTrail=false 拒绝', () => {
    expect(validateExoSession(record({ status: 'paused' }))[0]).toBe('unknown_status');
    expect(validateExoSession(record({ auditTrail: false }))[0]).toBe('audit_required');
  });
});

describe('exoSessionTransitionAllowed（ADR-032 状态机）', () => {
  it('active→ended/aborted；终态不可复开', () => {
    expect(exoSessionTransitionAllowed('active', 'ended')).toBe(true);
    expect(exoSessionTransitionAllowed('active', 'aborted')).toBe(true);
    expect(exoSessionTransitionAllowed('ended', 'active')).toBe(false);
    expect(exoSessionTransitionAllowed('aborted', 'active')).toBe(false);
    expect(exoSessionTransitionAllowed('active', 'active')).toBe(false);
  });
});

describe('projectExoSessionTiming（NO-36b：预计 vs 实际）', () => {
  const START = '2026-09-12T08:00:00.000Z';
  const NOW = Date.parse('2026-09-12T09:00:00.000Z');

  it('进行中：时长 = now - startedAt，未到预计 → remainingMs，无偏差（无实际结束）', () => {
    const timing = projectExoSessionTiming(
      { status: 'active', startedAt: START, expectedEndAt: '2026-09-12T10:00:00.000Z' },
      { nowMs: NOW },
    );
    expect(timing.durationMs).toBe(60 * 60_000);
    expect(timing.deviationMs).toBeNull();
    expect(timing.deviationState).toBe('unknown');
    expect(timing.overdue).toBe(false);
    expect(timing.overdueMs).toBeNull();
    expect(timing.remainingMs).toBe(60 * 60_000);
  });

  it('进行中且已过预计结束 → overdue + overdueMs（该催收工的确定性依据）', () => {
    const timing = projectExoSessionTiming(
      { status: 'active', startedAt: START, expectedEndAt: '2026-09-12T08:30:00.000Z' },
      { nowMs: NOW },
    );
    expect(timing.overdue).toBe(true);
    expect(timing.overdueMs).toBe(30 * 60_000);
    expect(timing.remainingMs).toBeNull();
    // 还没结束 → 不编造偏差判定
    expect(timing.deviationState).toBe('unknown');
    expect(timing.deviationMs).toBeNull();
  });

  it('终态：偏差 > 容差 → over，< -容差 → early，容差内 → on_time', () => {
    const over = projectExoSessionTiming({
      status: 'ended',
      startedAt: START,
      expectedEndAt: '2026-09-12T09:00:00.000Z',
      actualEndAt: '2026-09-12T10:20:00.000Z',
    });
    expect(over.durationMs).toBe(2 * 3_600_000 + 20 * 60_000);
    expect(over.deviationMs).toBe(80 * 60_000);
    expect(over.deviationState).toBe('over');

    const early = projectExoSessionTiming({
      status: 'ended',
      startedAt: START,
      expectedEndAt: '2026-09-12T09:00:00.000Z',
      actualEndAt: '2026-09-12T08:15:00.000Z',
    });
    expect(early.deviationState).toBe('early');
    expect(early.deviationMs).toBe(-45 * 60_000);

    const onTime = projectExoSessionTiming({
      status: 'ended',
      startedAt: START,
      expectedEndAt: '2026-09-12T09:00:00.000Z',
      actualEndAt: new Date(Date.parse('2026-09-12T09:00:00.000Z') + EXO_ON_TIME_TOLERANCE_MS).toISOString(),
    });
    expect(onTime.deviationState).toBe('on_time');
  });

  it('无预计结束时间 → 偏差恒为 unknown（"没记录"绝不等于准时）', () => {
    const timing = projectExoSessionTiming({
      status: 'ended',
      startedAt: START,
      actualEndAt: '2026-09-12T09:00:00.000Z',
    });
    expect(timing.durationMs).toBe(60 * 60_000);
    expect(timing.deviationMs).toBeNull();
    expect(timing.deviationState).toBe('unknown');
    expect(timing.overdue).toBe(false);
  });

  it('终态缺 actualEndAt → 时长为 null（不拿 now 冒充）；开始时间不可解析 → 时长 null，但偏差仍按"预计/实际"如实给出', () => {
    const missingEnd = projectExoSessionTiming({ status: 'ended', startedAt: START });
    expect(missingEnd.durationMs).toBeNull();
    const brokenStart = projectExoSessionTiming({
      status: 'ended',
      startedAt: 'not-a-time',
      expectedEndAt: '2026-09-12T09:00:00.000Z',
      actualEndAt: '2026-09-12T09:30:00.000Z',
    });
    expect(brokenStart.durationMs).toBeNull();
    // 偏差只依赖「预计结束 + 实际结束」两个事实，与开始时间是否能解析无关：
    // 开始时间坏了不等于"这条会话没有偏差"（两者是不同的数据缺口）。
    expect(brokenStart.deviationMs).toBe(30 * 60_000);
    expect(brokenStart.deviationState).toBe('over');
  });

  it('nowMs 可由调用方给定（可复现），容差可配置', () => {
    const strict = projectExoSessionTiming(
      {
        status: 'ended',
        startedAt: START,
        expectedEndAt: '2026-09-12T09:00:00.000Z',
        actualEndAt: '2026-09-12T09:01:00.000Z',
      },
      { onTimeToleranceMs: 0 },
    );
    expect(strict.deviationState).toBe('over');
    const lenient = projectExoSessionTiming(
      {
        status: 'ended',
        startedAt: START,
        expectedEndAt: '2026-09-12T09:00:00.000Z',
        actualEndAt: '2026-09-12T09:01:00.000Z',
      },
      { onTimeToleranceMs: 5 * 60_000 },
    );
    expect(lenient.deviationState).toBe('on_time');
  });
});

describe('classifyExoSessionReminder（NO-37a：平台侧主动提醒）', () => {
  const NOW = Date.parse('2026-09-12T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('超过预计结束 + 宽限 → overdue（优先于长时间桶）', () => {
    const decision = classifyExoSessionReminder(
      {
        status: 'active',
        startedAt: iso(NOW - 5 * 3_600_000),
        expectedEndAt: iso(NOW - 60 * 60_000),
      },
      { nowMs: NOW },
    );
    expect(decision).toEqual({
      bucket: 'overdue',
      overdueMs: 60 * 60_000,
      durationMs: 5 * 3_600_000,
    });
  });

  it('刚过预计结束但在宽限内 → 先不打扰（避免 5 分钟轻微超时就叫人）', () => {
    const decision = classifyExoSessionReminder(
      {
        status: 'active',
        startedAt: iso(NOW - 3_600_000),
        expectedEndAt: iso(NOW - 5 * 60_000),
      },
      { nowMs: NOW },
    );
    expect(decision).toBeNull();
    // 宽限可配置：把宽限设为 0 时同一事实立刻提醒（证明不是"永不提醒"）。
    expect(
      classifyExoSessionReminder(
        {
          status: 'active',
          startedAt: iso(NOW - 3_600_000),
          expectedEndAt: iso(NOW - 5 * 60_000),
        },
        { nowMs: NOW, overdueGraceMs: 0 },
      )?.bucket,
    ).toBe('overdue');
  });

  it('连续佩戴达阈值（即使没填预计结束时间）→ long_running', () => {
    const decision = classifyExoSessionReminder(
      { status: 'active', startedAt: iso(NOW - EXO_LONG_SESSION_THRESHOLD_MS) },
      { nowMs: NOW },
    );
    expect(decision).toEqual({
      bucket: 'long_running',
      overdueMs: null,
      durationMs: EXO_LONG_SESSION_THRESHOLD_MS,
    });
    // 阈值可配置（测试与现场可调），且"差一分钟"不提醒。
    expect(
      classifyExoSessionReminder(
        { status: 'active', startedAt: iso(NOW - EXO_LONG_SESSION_THRESHOLD_MS + 60_000) },
        { nowMs: NOW },
      ),
    ).toBeNull();
  });

  it('终态不提醒（已经收工，不需要核实）', () => {
    for (const status of ['ended', 'aborted']) {
      expect(
        classifyExoSessionReminder(
          {
            status,
            startedAt: iso(NOW - 8 * 3_600_000),
            expectedEndAt: iso(NOW - 6 * 3_600_000),
            actualEndAt: iso(NOW - 5 * 3_600_000),
          },
          { nowMs: NOW },
        ),
      ).toBeNull();
    }
  });

  it('开始时间不可解析 → 不猜（既不按长时间提醒，也不冒充正常）', () => {
    expect(
      classifyExoSessionReminder({ status: 'active', startedAt: 'not-a-time' }, { nowMs: NOW }),
    ).toBeNull();
  });

  it('未到预计结束且未达长时间阈值 → 不提醒', () => {
    expect(
      classifyExoSessionReminder(
        {
          status: 'active',
          startedAt: iso(NOW - 30 * 60_000),
          expectedEndAt: iso(NOW + 30 * 60_000),
        },
        { nowMs: NOW },
      ),
    ).toBeNull();
  });

  it('默认宽限/阈值是本模块导出常量（页面与通知共用同一口径）', () => {
    expect(EXO_OVERDUE_REMINDER_GRACE_MS).toBe(15 * 60_000);
    expect(EXO_LONG_SESSION_THRESHOLD_MS).toBe(4 * 3_600_000);
  });
});

describe('summarizeExoSessionDeviations（NO-38a：偏差 → 经验）', () => {
  const NOW = Date.parse('2026-09-12T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const expected = iso(NOW - 2 * 3_600_000);

  function ended(
    sessionId: string,
    deviceId: string,
    personId: string,
    deviationMinutes: number | null,
    actualOffsetMinutes = 0,
  ) {
    return {
      sessionId,
      deviceId,
      personId,
      status: 'ended',
      expectedEndAt: deviationMinutes === null ? null : expected,
      actualEndAt:
        deviationMinutes === null
          ? iso(NOW - 3_600_000)
          : iso(Date.parse(expected) + deviationMinutes * 60_000 + actualOffsetMinutes * 60_000),
    };
  }

  it('可比样本足够时给出准时率/均值/中位数/最差超时', () => {
    const summary = summarizeExoSessionDeviations(
      [
        ended('S-1', 'EXO-1', 'person:P-1', 0),
        ended('S-2', 'EXO-1', 'person:P-1', 1),
        ended('S-3', 'EXO-1', 'person:P-1', 60),
        ended('S-4', 'EXO-1', 'person:P-1', -30),
      ],
      { nowMs: NOW, groupBy: 'device' },
    );
    const group = summary.groups.find((g) => g.key === 'EXO-1');
    expect(group).toMatchObject({
      sessions: 4,
      completed: 4,
      comparable: 4,
      onTime: 2,
      over: 1,
      early: 1,
      notComparable: 0,
      insufficientSample: false,
      onTimeRate: 0.5,
      worstOverMs: 60 * 60_000,
      bestEarlyMs: 30 * 60_000,
    });
    expect(group?.meanDeviationMs).toBe(Math.round((0 + 60_000 + 3_600_000 - 1_800_000) / 4));
    expect(summary.totals.comparable).toBe(4);
    expect(summary.notes.join('｜')).toContain('只有同时记录了');
  });

  it('可比样本不足 → 不给准时率（null + 明说"证据不足"），但计数照给', () => {
    const summary = summarizeExoSessionDeviations(
      [ended('S-1', 'EXO-1', 'person:P-1', 60), ended('S-2', 'EXO-1', 'person:P-1', 0)],
      { nowMs: NOW, groupBy: 'device' },
    );
    const group = summary.groups[0];
    expect(group).toMatchObject({ comparable: 2, over: 1, onTime: 1, insufficientSample: true });
    expect(group.onTimeRate).toBeNull();
    expect(group.notes.join('｜')).toContain('只给计数，不给准时率结论');
    expect(EXO_DEVIATION_MIN_SAMPLE).toBe(3);
  });

  it('缺预计结束的会话计入不可比，且**不**参与比率（缺失 ≠ 准时）', () => {
    const summary = summarizeExoSessionDeviations(
      [
        ended('S-1', 'EXO-1', 'person:P-1', 0),
        ended('S-2', 'EXO-1', 'person:P-1', 0),
        ended('S-3', 'EXO-1', 'person:P-1', 0),
        ended('S-4', 'EXO-1', 'person:P-1', null),
      ],
      { nowMs: NOW, groupBy: 'device' },
    );
    const group = summary.groups[0];
    expect(group).toMatchObject({ sessions: 4, comparable: 3, notComparable: 1, onTimeRate: 1 });
    expect(group.notes.join('｜')).toContain('另有 1 条不可比');
    expect(summary.notes.join('｜')).toContain('无证据');
  });

  it('按人员分组；设备号缺失归入"设备未记录"（不猜是哪台）', () => {
    const summary = summarizeExoSessionDeviations(
      [
        ended('S-1', 'EXO-1', 'person:P-1', 5),
        ended('S-2', 'EXO-1', 'person:P-2', 0),
        { ...ended('S-3', 'EXO-1', 'person:P-2', 0), deviceId: null },
      ],
      { nowMs: NOW, groupBy: 'person' },
    );
    expect(summary.groupBy).toBe('person');
    expect(summary.groups.map((g) => g.key).sort()).toEqual(['person:P-1', 'person:P-2']);

    const byDevice = summarizeExoSessionDeviations(
      [{ ...ended('S-1', 'EXO-1', 'person:P-1', 5), deviceId: null }],
      { nowMs: NOW, groupBy: 'device' },
    );
    expect(byDevice.groups[0].key).toBe('设备未记录');
  });

  it('空输入：不给任何比率，说明"窗口内没有会话记录"', () => {
    const summary = summarizeExoSessionDeviations([], { nowMs: NOW });
    expect(summary).toMatchObject({ scanned: 0, windowDays: 30, groupBy: 'device' });
    expect(summary.totals).toMatchObject({ sessions: 0, comparable: 0, onTimeRate: null, insufficientSample: true });
    expect(summary.totals.notes.join('｜')).toContain('没有会话记录');
    expect(summary.groups).toEqual([]);
  });

  it('NO-42a：可比样本率 = 可比 / 已收工；无样本 → null（不是 0%）', () => {
    const summary = summarizeExoSessionDeviations(
      [
        ended('S-1', 'EXO-1', 'person:P-1', 0),
        ended('S-2', 'EXO-1', 'person:P-1', null),
        ended('S-3', 'EXO-1', 'person:P-1', null),
        ended('S-4', 'EXO-1', 'person:P-1', 10),
      ],
      { nowMs: NOW, groupBy: 'device' },
    );
    expect(summary.plannedCoverageRate).toBeCloseTo(0.5, 5);
    expect(summarizeExoSessionDeviations([], { nowMs: NOW }).plannedCoverageRate).toBeNull();
  });

  it('窗口/分组/门槛可配置且被规范化（非法值不炸）', () => {
    const summary = summarizeExoSessionDeviations([], {
      nowMs: NOW,
      windowDays: 9999,
      groupBy: 'person',
      minSample: 0,
    });
    expect(summary.windowDays).toBe(365);
    expect(summary.minSample).toBe(EXO_DEVIATION_MIN_SAMPLE);
    expect(summary.groupBy).toBe('person');
    expect(summary.generatedAt).toBe(new Date(NOW).toISOString());
  });
});
