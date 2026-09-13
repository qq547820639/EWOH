import {
  IMPROVEMENT_DEFAULT_MAX_ACTIONS,
  IMPROVEMENT_SUBJECT_TYPES,
  deriveActionSubject,
  deriveImprovementActions,
  executionSubjectKey,
  improvementActionId,
  improvementSlug,
  improvementTransitionAllowed,
  validateAcceptanceInput,
  validateImprovementAction,
  type ImprovementMemoryInput,
} from './improvement-action';

function retrospective(overrides: Partial<ImprovementMemoryInput['retrospectives'][number]> = {}) {
  return {
    retrospectiveId: 'RTR-1',
    scope: 'incident',
    targetId: 'DEV-04',
    title: '设备离线复盘',
    publishedAt: '2026-09-11T08:00:00.000Z',
    lessons: [
      { title: '交接时未核对备用设备', detail: '交接清单里没有备用设备状态', severity: 'warning', evidenceIds: ['EVT-1'] },
    ],
    gaps: [],
    ...overrides,
  };
}

function memory(overrides: Partial<ImprovementMemoryInput> = {}): ImprovementMemoryInput {
  return { orgId: 'org-1', detectedAt: '2026-09-12T08:00:00.000Z', retrospectives: [retrospective()], ...overrides };
}

describe('deriveImprovementActions（复盘运行记忆 → 行动项）', () => {
  it('warning/critical 经验条目 → 行动项（优先级由严重度给出，证据指向复盘与条目）', () => {
    const actions = deriveImprovementActions(memory({
      retrospectives: [
        retrospective({
          lessons: [
            { title: 'A 条目', detail: 'd1', severity: 'critical', evidenceIds: ['EVT-1'] },
            { title: 'B 条目', detail: 'd2', severity: 'warning', evidenceIds: [] },
          ],
        }),
      ],
    }));
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ priority: 'high', status: 'proposed', kind: 'process_change', kindSource: 'suggested' });
    expect(actions[1].priority).toBe('medium');
    expect(actions[0].evidenceRefs.map((e) => e.type)).toEqual(['retrospective', 'lesson']);
    expect(validateImprovementAction(actions[0])).toEqual([]);
  });

  it('info 级经验只作记忆保留，不建行动项（避免"每条总结都变成待办"）', () => {
    const actions = deriveImprovementActions(memory({
      retrospectives: [retrospective({ lessons: [{ title: 'I', detail: 'd', severity: 'info', evidenceIds: [] }] })],
    }));
    expect(actions).toEqual([]);
  });

  it('缺口 → 行动项（默认工具/数据类，理由写在 detail 里，等人在接受时确认类型）', () => {
    const actions = deriveImprovementActions(memory({
      retrospectives: [retrospective({ lessons: [], gaps: ['缺少设备停机时长证据'] })],
    }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ sourceType: 'retrospective_gap', kind: 'tooling', kindSource: 'suggested' });
    expect(actions[0].title).toContain('补齐缺口');
    expect(actions[0].evidenceRefs.map((e) => e.type)).toEqual(['retrospective', 'gap']);
  });

  it('确定性：同一输入两次派生完全一致；同一条目重复出现只留一条', () => {
    const input = memory({
      retrospectives: [
        retrospective({ lessons: [{ title: '同一条目', detail: 'd', severity: 'warning', evidenceIds: [] }, { title: '同一条目', detail: 'd', severity: 'warning', evidenceIds: [] }] }),
        retrospective({ retrospectiveId: 'RTR-2', lessons: [{ title: '同一条目', detail: 'd', severity: 'warning', evidenceIds: [] }] }),
      ],
    });
    const first = deriveImprovementActions(input);
    expect(deriveImprovementActions(input)).toEqual(first);
    // 同一条目在不同复盘里是两条（来源不同），同一复盘内重复只留一条
    expect(first).toHaveLength(2);
    expect(new Set(first.map((a) => a.actionId)).size).toBe(2);
  });

  it('中英文标题都有稳定 slug（没人给英文标题时不能退化成随机号）', () => {
    expect(improvementSlug('Check backup device')).toMatch(/^check-backup-device-[0-9a-z]+$/);
    expect(improvementSlug('交接时未核对备用设备')).toMatch(/^zh[0-9a-z]+$/);
    expect(improvementActionId('retrospective_lesson', 'RTR-1', '交接时未核对备用设备')).toBe(
      improvementActionId('retrospective_lesson', 'RTR-1', '交接时未核对备用设备'),
    );
  });

  it('回归：共享同一英文前缀的不同中文标题不得塌成同一条待办', () => {
    // 实测缺陷：slug 只留 ASCII 前缀时，"E2E abc 甲" 与 "E2E abc 乙" 撞号，
    // 两条不同经验被 dedup 静默合并（warning 级经验直接消失）。
    const a = improvementActionId('retrospective_lesson', 'RTR-1', 'E2E abc 甲条目');
    const b = improvementActionId('retrospective_lesson', 'RTR-1', 'E2E abc 乙条目');
    expect(a).not.toBe(b);
    const actions = deriveImprovementActions(memory({
      retrospectives: [retrospective({
        lessons: [
          { title: 'E2E abc 甲条目', detail: 'd1', severity: 'critical', evidenceIds: [] },
          { title: 'E2E abc 乙条目', detail: 'd2', severity: 'warning', evidenceIds: [] },
        ],
      })],
    }));
    expect(actions).toHaveLength(2);
  });

  it('单次扫描有条数上限（按优先级取前 N）', () => {
    const lessons = Array.from({ length: 20 }, (_, i) => ({
      title: `条目 ${i}`,
      detail: 'd',
      severity: i < 3 ? 'critical' : 'warning',
      evidenceIds: [],
    }));
    const actions = deriveImprovementActions(memory({ retrospectives: [retrospective({ lessons })] }));
    expect(actions).toHaveLength(IMPROVEMENT_DEFAULT_MAX_ACTIONS);
    expect(actions.filter((a) => a.priority === 'high')).toHaveLength(3);
  });

  it('空白条目被忽略（不许建"空行动项"）', () => {
    const actions = deriveImprovementActions(memory({
      retrospectives: [retrospective({ lessons: [{ title: '   ', detail: 'd', severity: 'warning', evidenceIds: [] }], gaps: ['  '] })],
    }));
    expect(actions).toEqual([]);
  });
});

describe('对象归属 deriveActionSubject（NO-58a：复发度量的前提）', () => {
  it('incident 复盘：person: 前缀 → person，station/workstation 前缀 → station，其余按设备', () => {
    expect(deriveActionSubject('incident', 'person:63000000-0000-4000-8000-000000000001')).toEqual({
      subjectType: 'person',
      subjectId: 'person:63000000-0000-4000-8000-000000000001',
    });
    expect(deriveActionSubject('incident', 'workstation:WS-12')).toEqual({ subjectType: 'station', subjectId: 'station:WS-12' });
    expect(deriveActionSubject('incident', 'station:WS-12')).toEqual({ subjectType: 'station', subjectId: 'station:WS-12' });
    expect(deriveActionSubject('INCIDENT', 'DEV-04')).toEqual({ subjectType: 'device', subjectId: 'DEV-04' });
  });

  it('plan/shift 复盘没有单一对象 → null（显式不可度量，不硬算成某台设备）', () => {
    expect(deriveActionSubject('plan', 'PLAN-1')).toBeNull();
    expect(deriveActionSubject('shift', 'SHIFT-EARLY')).toBeNull();
    expect(deriveActionSubject('incident', '   ')).toBeNull();
  });

  it('派生结果只会落在封闭词表内（页面/DB CHECK 同源）', () => {
    for (const scope of ['incident', 'plan', 'shift', '']) {
      for (const id of ['DEV-04', 'person:P-1', 'station:WS-1', 'workstation:WS-1', '']) {
        const subject = deriveActionSubject(scope, id);
        if (subject === null) continue;
        expect(IMPROVEMENT_SUBJECT_TYPES).toContain(subject.subjectType);
        expect(subject.subjectId.trim()).not.toBe('');
      }
    }
  });

  it('派生出的归属写进行动项（经验与缺口都要带，否则复发度量对缺口类失效）', () => {
    const actions = deriveImprovementActions(memory({
      retrospectives: [retrospective({ gaps: ['缺少停机时长证据'] })],
    }));
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.subjectType).toBe('device');
      expect(action.subjectId).toBe('DEV-04');
    }
  });

  it('显式传入的 subject 优先（服务层从 DB 读到的归属不被覆盖）', () => {
    const actions = deriveImprovementActions(memory({
      retrospectives: [retrospective({ scope: 'incident', targetId: 'DEV-04', subject: { subjectType: 'person', subjectId: 'person:P-1' } })],
    }));
    expect(actions[0].subjectType).toBe('person');
    expect(actions[0].subjectId).toBe('person:P-1');
  });

  it('非 incident 复盘派生的行动项归属为空（必须显式空，而不是缺字段）', () => {
    const actions = deriveImprovementActions(memory({ retrospectives: [retrospective({ scope: 'plan', targetId: 'PLAN-1' })] }));
    expect(actions[0].subjectType).toBeNull();
    expect(actions[0].subjectId).toBeNull();
    expect(validateImprovementAction(actions[0])).toEqual([]);
  });

  it('执行事实表键归一：规范身份引用（person:/station:）→ 裸 id（否则 count 永远 0 行）', () => {
    expect(executionSubjectKey('person', 'person:63000000-0000-4000-8000-000000000001'))
      .toBe('63000000-0000-4000-8000-000000000001');
    expect(executionSubjectKey('person', 'worker:P-1')).toBe('P-1');
    expect(executionSubjectKey('station', 'station:WS-12')).toBe('WS-12');
    expect(executionSubjectKey('station', 'workstation:WS-12')).toBe('WS-12');
    // 设备名不做任何猜测性剥离（`DEV-04` 原样）
    expect(executionSubjectKey('device', 'DEV-04')).toBe('DEV-04');
    expect(executionSubjectKey('person', '  ')).toBe('');
    // 大小写不敏感前缀（`Person:` 也算规范前缀）
    expect(executionSubjectKey('person', 'Person:P-1')).toBe('P-1');
  });

  it('归属成对校验：只有一半（半成品写入）必须被拒', () => {
    const action = deriveImprovementActions(memory())[0];
    expect(validateImprovementAction({ ...action, subjectType: null })).toEqual(
      expect.arrayContaining(['subject_pair_must_match']),
    );
    expect(validateImprovementAction({ ...action, subjectId: null })).toEqual(
      expect.arrayContaining(['subject_pair_must_match']),
    );
    expect(validateImprovementAction({ ...action, subjectType: 'robot' })).toEqual(
      expect.arrayContaining(['unknown_subject_type']),
    );
  });
});

describe('validateImprovementAction（fail-closed）', () => {
  const base = () => deriveImprovementActions(memory())[0];

  it('接受必须有人/期限/判据（"做完了"要能被别人判断）', () => {
    expect(validateImprovementAction({ ...base(), status: 'accepted' })).toEqual(
      expect.arrayContaining(['accepted_requires_owner']),
    );
    expect(
      validateImprovementAction({ ...base(), status: 'accepted', owner: 'P-1' }),
    ).toEqual(expect.arrayContaining(['accepted_requires_due_at']));
    expect(
      validateImprovementAction({ ...base(), status: 'accepted', owner: 'P-1', dueAt: '2026-09-20T00:00:00.000Z' }),
    ).toEqual(expect.arrayContaining(['accepted_requires_criteria']));
  });

  it('完成必须有完成人/时间/结果说明', () => {
    const accepted = {
      ...base(),
      status: 'accepted',
      owner: 'P-1',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
      acceptedBy: 'lead.chen',
      acceptedAt: '2026-09-12T09:00:00.000Z',
    };
    expect(validateImprovementAction(accepted)).toEqual([]);
    expect(validateImprovementAction({ ...accepted, status: 'completed' })).toEqual(
      expect.arrayContaining(['completed_requires_completer']),
    );
    expect(
      validateImprovementAction({
        ...accepted,
        status: 'completed',
        completedBy: 'P-1',
        completedAt: '2026-09-18T00:00:00.000Z',
      }),
    ).toEqual(expect.arrayContaining(['completed_requires_outcome']));
  });

  it('拒绝/放弃必须给理由；没有证据不许立项', () => {
    expect(validateImprovementAction({ ...base(), status: 'rejected', decidedBy: 'lead.chen', decidedAt: '2026-09-12T09:00:00.000Z' })).toEqual(
      expect.arrayContaining(['decision_requires_reason']),
    );
    expect(validateImprovementAction({ ...base(), evidenceRefs: [] })).toContain('missing_evidence');
  });

  it('未知类型/状态/优先级 → 拒绝', () => {
    expect(validateImprovementAction({ ...base(), kind: 'magic' })).toContain('unknown_kind');
    expect(validateImprovementAction({ ...base(), status: 'archived' })).toContain('unknown_status');
    expect(validateImprovementAction({ ...base(), priority: 'urgent' })).toContain('unknown_priority');
  });
});

describe('状态机与接受输入', () => {
  it('proposed→accepted/rejected；accepted→completed/dropped；终态不可再动', () => {
    expect(improvementTransitionAllowed('proposed', 'accepted')).toBe(true);
    expect(improvementTransitionAllowed('proposed', 'completed')).toBe(false);
    expect(improvementTransitionAllowed('accepted', 'completed')).toBe(true);
    expect(improvementTransitionAllowed('completed', 'accepted')).toBe(false);
    expect(improvementTransitionAllowed('rejected', 'accepted')).toBe(false);
  });

  it('validateAcceptanceInput：三项必填 + 人可在接受时改类型', () => {
    expect(validateAcceptanceInput({})).toEqual([
      'owner_required',
      'due_at_required',
      'acceptance_criteria_required',
    ]);
    expect(
      validateAcceptanceInput({ owner: 'P-1', dueAt: '2026-09-20T00:00:00.000Z', acceptanceCriteria: 'c' }),
    ).toEqual([]);
    expect(
      validateAcceptanceInput({ owner: 'P-1', dueAt: '2026-09-20T00:00:00.000Z', acceptanceCriteria: 'c', kind: 'training' }),
    ).toEqual([]);
    expect(
      validateAcceptanceInput({ owner: 'P-1', dueAt: '2026-09-20T00:00:00.000Z', acceptanceCriteria: 'c', kind: 'magic' }),
    ).toEqual(['unknown_kind']);
  });
});
