/* 任务能力要求规范化与提示（纯函数）。
 *
 * 口径：形状非法拒绝（不猜不截断）；未登记/无法匹配的名称允许但**必须显式提示**
 * （否则任务永远匹配不到资源，而现场不知道原因）。
 */
/// <reference types="jest" />
import {
  CAPABILITY_APPROVAL_VALIDITY_MS,
  CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE,
  MAX_CAPABILITY_NAME_LENGTH,
  MAX_TASK_CAPABILITY_REQUIREMENTS,
  describeCapabilityWarnings,
  describeDeviceCapabilityWarnings,
  describeUnknownCapabilityName,
  DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE,
  buildApprovalUsageKey,
  buildCapabilityRelaxationApprovalSubject,
  buildCapabilityRestoreApprovalSubject,
  buildTaskApprovalUsageKey,
  describeCapabilityApprovalFreshness,
  deviceCapabilityChangeNeedsApproval,
  verifyApprovalFreshness,
  highRiskCapabilitiesBeingRelaxed,
  normalizeCapabilityList,
  suggestSimilarCapabilityNames,
  verifyCapabilityRelaxationApproval,
  verifyCapabilityRestoreApproval,
} from './capability-requirements';

describe('normalizeCapabilityList', () => {
  it('缺省/null = 无要求（不是错误）', () => {
    expect(normalizeCapabilityList(undefined, '设备能力要求')).toEqual({ names: [], errors: [] });
    expect(normalizeCapabilityList(null, '设备能力要求')).toEqual({ names: [], errors: [] });
  });

  it('去空白 / 去空项 / 按首次出现顺序去重', () => {
    const res = normalizeCapabilityList(
      [' exo-lift ', 'vacuum', 'exo-lift', '', '   ', 'crane'],
      '设备能力要求',
    );
    expect(res.errors).toEqual([]);
    expect(res.names).toEqual(['exo-lift', 'vacuum', 'crane']);
  });

  it('非数组 / 非字符串项 / 超长 / 超量 → 显式错误（不隐式转换、不截断）', () => {
    expect(normalizeCapabilityList('exo-lift', '设备能力要求').errors).toHaveLength(1);
    expect(normalizeCapabilityList([1, 'exo-lift'], '设备能力要求').errors[0]).toContain('不是字符串');
    expect(
      normalizeCapabilityList(['x'.repeat(MAX_CAPABILITY_NAME_LENGTH + 1)], '设备能力要求').errors[0],
    ).toContain('字符');
    const tooMany = Array.from({ length: MAX_TASK_CAPABILITY_REQUIREMENTS + 1 }, (_, i) => `cap-${i}`);
    expect(normalizeCapabilityList(tooMany, '设备能力要求').errors[0]).toContain('最多');
  });
});

describe('能力要求提示（不阻断写入，但必须可见）', () => {
  it('设备能力：词表外名称提示"未登记"，词表内不提示', () => {
    const warnings = describeDeviceCapabilityWarnings(
      ['exo-lift', 'custom.magic_lift'],
      (name) => name === 'exo-lift',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'unregistered_capability', name: 'custom.magic_lift' });
    expect(warnings[0].message).toContain('不在能力词表内');
  });

  it('工位能力：按当前是否可能匹配给出提示', () => {
    const warnings = describeCapabilityWarnings(
      ['workstation', 'paint_booth'],
      (name) => name === 'workstation',
      '工位能力要求',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('paint_booth');
    expect(warnings[0].message).toContain('没有任何资源声明该能力');
  });

  it('全部可匹配 → 无提示（不制造噪音）', () => {
    expect(describeCapabilityWarnings(['workstation'], () => true, '工位能力要求')).toEqual([]);
    expect(describeDeviceCapabilityWarnings(['exo-lift'], () => true)).toEqual([]);
  });
});

describe('能力名笔误检测（NO-18a）', () => {
  const KNOWN = ['exo-lift', 'exo-lite', 'vacuum', 'crane', 'observe.temperature'];

  it('分隔符/大小写差异 → 给出疑似笔误建议', () => {
    expect(suggestSimilarCapabilityNames('exo_lift', KNOWN)).toContain('exo-lift');
    expect(suggestSimilarCapabilityNames('ExoLift', KNOWN)).toContain('exo-lift');
    expect(suggestSimilarCapabilityNames('exo lite', KNOWN)).toContain('exo-lite');
  });

  it('拼写错误（少字母/多字母/换字母）→ 给出建议', () => {
    expect(suggestSimilarCapabilityNames('exo-lif', KNOWN)).toContain('exo-lift');
    expect(suggestSimilarCapabilityNames('vaccum', KNOWN)).toContain('vacuum');
    expect(suggestSimilarCapabilityNames('crain', KNOWN)).toContain('crane');
  });

  it('完全不相关 → 不猜（宁可不提示也不误导）', () => {
    expect(suggestSimilarCapabilityNames('paint_booth', KNOWN)).toEqual([]);
    expect(suggestSimilarCapabilityNames('', KNOWN)).toEqual([]);
  });

  it('完全相同不算笔误', () => {
    expect(suggestSimilarCapabilityNames('exo-lift', KNOWN)).toEqual([]);
  });

  it('文案：有相近名称给"是否指"，没有则保持原样', () => {
    expect(describeUnknownCapabilityName('exo_lift', KNOWN, '设备能力')).toContain('是否指 exo-lift');
    expect(describeUnknownCapabilityName('paint_booth', KNOWN, '设备能力')).toBe('设备能力「paint_booth」');
  });
});

describe('高风险放宽的审批闸门（NO-20a）', () => {
  const isHighRisk = (n: string) => ['crane', 'exo-lift', 'interact.assist'].includes(n);

  it('识别"被放宽"的高风险能力（去掉才算放宽；新增是收紧）', () => {
    expect(highRiskCapabilitiesBeingRelaxed(['crane', 'vacuum'], ['vacuum'], isHighRisk)).toEqual(['crane']);
    expect(highRiskCapabilitiesBeingRelaxed(['vacuum'], ['crane'], isHighRisk)).toEqual([]);
    expect(highRiskCapabilitiesBeingRelaxed(['observe.temperature'], [], isHighRisk)).toEqual([]);
    expect(highRiskCapabilitiesBeingRelaxed(['crane', 'exo-lift'], [], isHighRisk)).toEqual(['crane', 'exo-lift']);
  });

  it('审批对象描述含可逐字核对的变更指纹', () => {
    const subject = buildCapabilityRelaxationApprovalSubject({
      taskId: 'T-1',
      taskTitle: '吊装任务',
      relaxedHighRisk: ['crane'],
      resultingDeviceCapabilities: ['vacuum'],
      resultingStationCapabilities: ['workstation'],
    });
    expect(subject.objectType).toBe(CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE);
    expect(subject.objectId).toBe('T-1');
    expect(subject.title).toContain('crane');
    expect(subject.metrics).toEqual({
      relaxedHighRiskCapabilities: 'crane',
      resultingDeviceCapabilities: 'vacuum',
      resultingStationCapabilities: 'workstation',
    });
  });

  it('校验：状态/对象/指纹三者一致才放行', () => {
    const subject = buildCapabilityRelaxationApprovalSubject({
      taskId: 'T-1',
      relaxedHighRisk: ['crane'],
      resultingDeviceCapabilities: [],
    });
    const approved = {
      status: 'approved',
      steps: [{ status: 'approved' }],
      approvedAt: new Date().toISOString(),
      evidence: { entityType: CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE, entityId: 'T-1', subject },
    };
    const expected = { taskId: 'T-1', relaxedHighRisk: ['crane'], resultingDeviceCapabilities: [] };
    // 放行时回传时效信息（调用方据此写入审计：批于何时、何时失效）
    expect(verifyCapabilityRelaxationApproval(approved, expected)).toMatchObject({ ok: true });
    const result = verifyCapabilityRelaxationApproval(approved, expected);
    expect(result.approvedAt).toBe(approved.approvedAt);
    expect(Date.parse(String(result.expiresAt))).toBeGreaterThan(Date.parse(approved.approvedAt));
  });

  it('拒绝：未通过 / 有未完成步骤 / 对象不符 / 指纹不符（覆盖范围被偷换）', () => {
    const subject = buildCapabilityRelaxationApprovalSubject({
      taskId: 'T-1',
      relaxedHighRisk: ['crane'],
      resultingDeviceCapabilities: [],
    });
    const expected = { taskId: 'T-1', relaxedHighRisk: ['crane'], resultingDeviceCapabilities: [] };
    const base = {
      status: 'approved',
      steps: [{ status: 'approved' }],
      approvedAt: new Date().toISOString(),
      evidence: { entityType: CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE, entityId: 'T-1', subject },
    };
    expect(verifyCapabilityRelaxationApproval(null, expected).ok).toBe(false);
    expect(verifyCapabilityRelaxationApproval({ ...base, status: 'pending' }, expected)).toMatchObject({
      ok: false,
    });
    expect(
      verifyCapabilityRelaxationApproval({ ...base, steps: [{ status: 'approved' }, { status: 'pending' }] }, expected),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('未完成') });
    expect(
      verifyCapabilityRelaxationApproval(
        { ...base, evidence: { ...base.evidence, entityId: 'T-OTHER' } },
        expected,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不是本任务') });
    expect(
      verifyCapabilityRelaxationApproval(
        { ...base, evidence: { ...base.evidence, entityType: 'task' } },
        expected,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('类型不符') });
    // 审批只批了 crane，但本次想放宽 crane + exo-lift → 必须拒绝
    expect(
      verifyCapabilityRelaxationApproval(base, {
        taskId: 'T-1',
        relaxedHighRisk: ['crane', 'exo-lift'],
        resultingDeviceCapabilities: [],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不一致') });
    // 审批批的是"变更后要求 vacuum"，本次却是空要求 → 必须拒绝
    const subjectWithVacuum = buildCapabilityRelaxationApprovalSubject({
      taskId: 'T-1',
      relaxedHighRisk: ['crane'],
      resultingDeviceCapabilities: ['vacuum'],
    });
    expect(
      verifyCapabilityRelaxationApproval(
        { ...base, evidence: { ...base.evidence, subject: subjectWithVacuum } },
        expected,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('目标设备能力要求') });
  });
});

describe('设备侧高风险能力恢复的审批闸门（NO-21a，与任务侧同一口径）', () => {
  it('只有"恢复高风险能力"需要审批（停用/低中风险都不需要）', () => {
    // 恢复高风险 → 需要审批（设备重新投运是安全决定）
    expect(
      deviceCapabilityChangeNeedsApproval({ targetStatus: 'active', previousStatus: 'disabled', risk: 'high' }),
    ).toBe(true);
    // 停用 = 收紧 → 不加流程
    expect(
      deviceCapabilityChangeNeedsApproval({ targetStatus: 'disabled', previousStatus: 'active', risk: 'high' }),
    ).toBe(false);
    // 中/低风险恢复 → 人工理由留痕即可
    expect(
      deviceCapabilityChangeNeedsApproval({ targetStatus: 'active', previousStatus: 'disabled', risk: 'medium' }),
    ).toBe(false);
    expect(
      deviceCapabilityChangeNeedsApproval({ targetStatus: 'active', previousStatus: 'disabled', risk: null }),
    ).toBe(false);
    // 本来就是生效状态（幂等 no-op）→ 不需要
    expect(
      deviceCapabilityChangeNeedsApproval({ targetStatus: 'active', previousStatus: 'active', risk: 'high' }),
    ).toBe(false);
  });

  it('审批对象可覆盖一批设备（一次维护授权多台恢复）', () => {
    const subject = buildCapabilityRestoreApprovalSubject({
      capabilityKey: 'exo-lift',
      deviceIds: ['EXO-2', 'EXO-1', 'EXO-1'],
      reason: '助力模块已检修',
    });
    expect(subject.objectType).toBe(DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE);
    expect(subject.objectId).toBe('capability:exo-lift');
    expect(subject.title).toContain('exo-lift');
    expect(subject.metrics).toEqual({ capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' });
    expect(subject.summary).toContain('助力模块已检修');
  });

  it('校验：名单内的设备放行；名单外/能力不符/未通过一律拒绝', () => {
    const subject = buildCapabilityRestoreApprovalSubject({
      capabilityKey: 'exo-lift',
      deviceIds: ['EXO-1', 'EXO-2'],
    });
    const approved = {
      status: 'approved',
      steps: [{ status: 'approved' }],
      approvedAt: new Date().toISOString(),
      evidence: { entityType: DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE, entityId: 'capability:exo-lift', subject },
    };
    expect(
      verifyCapabilityRestoreApproval(approved, { capabilityKey: 'exo-lift', deviceId: 'EXO-1' }),
    ).toMatchObject({ ok: true });
    expect(
      verifyCapabilityRestoreApproval(approved, { capabilityKey: 'exo-lift', deviceId: 'EXO-9' }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不在获批名单内') });
    // 能力名不符 → 先被"审批对象"拦住（对象 id 就是 capability:<能力名>），拒绝即可
    expect(
      verifyCapabilityRestoreApproval(approved, { capabilityKey: 'crane', deviceId: 'EXO-1' }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('capability:exo-lift') });
    expect(
      verifyCapabilityRestoreApproval({ ...approved, status: 'pending' }, { capabilityKey: 'exo-lift', deviceId: 'EXO-1' }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('尚未通过') });
    expect(verifyCapabilityRestoreApproval(null, { capabilityKey: 'exo-lift', deviceId: 'EXO-1' })).toMatchObject({
      ok: false,
    });
  });
});

describe('授权时效与消耗（NO-22a）', () => {
  const subject = buildCapabilityRestoreApprovalSubject({
    capabilityKey: 'exo-lift',
    deviceIds: ['EXO-1'],
    reason: '助力模块已检修',
  });
  const approvedAtMs = Date.parse('2026-09-11T08:00:00.000Z');
  const approvalAt = (msFromApproval: number, at = approvedAtMs) => ({
    status: 'approved',
    steps: [{ status: 'approved' }],
    approvedAt: new Date(at).toISOString(),
    evidence: {
      entityType: DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE,
      entityId: 'capability:exo-lift',
      subject,
    },
  });
  const check = (approval: unknown, nowMs: number) =>
    verifyCapabilityRestoreApproval(approval as never, {
      capabilityKey: 'exo-lift',
      deviceId: 'EXO-1',
      nowMs,
    });

  it('有效期 24 小时：批准后 23 小时仍放行，25 小时后必须重新审批', () => {
    expect(CAPABILITY_APPROVAL_VALIDITY_MS).toBe(24 * 60 * 60 * 1000);
    const fresh = check(approvalAt(0), approvedAtMs + 23 * 3_600_000);
    expect(fresh).toMatchObject({ ok: true });
    expect(fresh.expiresAt).toBe(new Date(approvedAtMs + CAPABILITY_APPROVAL_VALIDITY_MS).toISOString());
    expect(check(approvalAt(0), approvedAtMs + 25 * 3_600_000)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('超出有效期'),
    });
  });

  it('缺少/非法通过时间 → 拒绝（无法判断时效的凭证不得当有效凭证，原则 7）', () => {
    const base = approvalAt(0);
    expect(check({ ...base, approvedAt: undefined }, approvedAtMs)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('缺少通过时间'),
    });
    expect(check({ ...base, approvedAt: 'not-a-date' }, approvedAtMs)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('缺少通过时间'),
    });
  });

  it('消耗键：同一 (审批, 能力, 设备) 稳定可复现；不同设备互不干扰', () => {
    expect(buildApprovalUsageKey({ capabilityKey: 'exo-lift', deviceId: 'EXO-1' })).toBe(
      'capability:exo-lift|device:EXO-1',
    );
    expect(buildApprovalUsageKey({ capabilityKey: 'exo-lift', deviceId: 'EXO-1' })).toBe(
      buildApprovalUsageKey({ capabilityKey: 'exo-lift', deviceId: 'EXO-1' }),
    );
    expect(buildApprovalUsageKey({ capabilityKey: 'exo-lift', deviceId: 'EXO-2' })).not.toBe(
      buildApprovalUsageKey({ capabilityKey: 'exo-lift', deviceId: 'EXO-1' }),
    );
    expect(buildTaskApprovalUsageKey('T-1')).toBe('task:T-1');
  });

  it('verifyApprovalFreshness：独立可复用的时效校验（控制类审批等无指纹闸门复用）', () => {
    const nowMs = Date.parse('2026-09-12T10:00:00.000Z');
    expect(verifyApprovalFreshness(null, { nowMs })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不存在'),
    });
    expect(verifyApprovalFreshness({ status: 'approved' }, { nowMs })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('缺少通过时间'),
    });
    const fresh = verifyApprovalFreshness(
      { status: 'approved', approvedAt: new Date(nowMs - 3_600_000).toISOString() },
      { nowMs },
    );
    expect(fresh).toMatchObject({ ok: true });
    expect(Date.parse(String(fresh.expiresAt)) - Date.parse(String(fresh.approvedAt))).toBe(
      CAPABILITY_APPROVAL_VALIDITY_MS,
    );
    expect(
      verifyApprovalFreshness(
        { status: 'approved', approvedAt: new Date(nowMs - 25 * 3_600_000).toISOString() },
        { nowMs },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('超出有效期') });
  });

  it('时效文案（设备侧与任务侧共用）：有效/过期/缺时间三态', () => {
    const nowMs = Date.parse('2026-09-11T12:00:00.000Z');
    const fresh = describeCapabilityApprovalFreshness(new Date(nowMs - 3 * 3_600_000).toISOString(), nowMs);
    expect(fresh.valid).toBe(true);
    expect(fresh.label).toContain('剩余有效期约 21 小时');
    const stale = describeCapabilityApprovalFreshness(new Date(nowMs - 25 * 3_600_000).toISOString(), nowMs);
    expect(stale.valid).toBe(false);
    expect(stale.label).toContain('已过期');
    expect(describeCapabilityApprovalFreshness(null, nowMs)).toEqual({
      valid: false,
      label: '缺少通过时间（无法判断时效）',
    });
  });
});
