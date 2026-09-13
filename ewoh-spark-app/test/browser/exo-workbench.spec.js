/* 外骨骼作业台浏览器验收 —— NO-33a。
 *
 * 这一页要回答现场三个问题：
 *   1. 谁还戴着哪台（进行中会话、已用时长）？
 *   2. 有没有**忘记收工**（长时间未结束要明确提示核实，而不是静静躺着）？
 *   3. 没正常收工能不能留下理由（中止必须写理由，终态不可复开）？
 *
 * 用 mock 数据层；真实后端会话生命周期由 `e2e:exo-session` 覆盖。
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { ROLES, mockApi, openSession, startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

// 用**真实时钟**做基准：页面里的"已进行多久"是按 Date.now() 算的，
// 固定一个未来时间会让所有会话都算成 0 分钟（实测踩过）。
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const LONG_ACTIVE = {
  sessionId: 'S-LONG',
  exoId: 'EXO-1',
  personId: 'P-1001',
  status: 'active',
  startedAt: iso(NOW - 5 * 3_600_000),
  expectedEndAt: iso(NOW - 3_600_000),
  actualEndAt: null,
  endedBy: null,
  reason: null,
};

const SHORT_ACTIVE = {
  sessionId: 'S-SHORT',
  exoId: 'EXO-2',
  personId: 'P-1002',
  status: 'active',
  startedAt: iso(NOW - 30 * 60_000),
  actualEndAt: null,
};

const ENDED = {
  sessionId: 'S-ENDED',
  exoId: 'EXO-3',
  personId: 'P-1003',
  status: 'ended',
  startedAt: iso(NOW - 8 * 3_600_000),
  actualEndAt: iso(NOW - 6 * 3_600_000),
  endedBy: 'worker.li',
  // NO-36b：没记录预计结束时间 → 偏差必须显示"无法比较"，绝不冒充准时。
};

/** NO-43a：由"佩戴人更正"产生的会话——行内必须能看到链路（谁交接来的）。 */
const CORRECTED = {
  sessionId: 'S-CORRECTED',
  exoId: 'EXO-5',
  personId: 'P-1005',
  status: 'ended',
  startedAt: iso(NOW - 40 * 60_000),
  actualEndAt: iso(NOW - 10 * 60_000),
  endedBy: 'lead.chen',
  correctedFrom: 'S-CORRECT-OLD',
  reason: '现场核实：实际佩戴人是 P-1005（交接）',
};

/** NO-36b：有预计结束时间且超时收工（1 小时预计，实际 3 小时 → 超时 2 小时）。 */
const ENDED_OVER = {
  sessionId: 'S-OVER',
  exoId: 'EXO-4',
  personId: 'P-1004',
  status: 'ended',
  startedAt: iso(NOW - 4 * 3_600_000),
  expectedEndAt: iso(NOW - 3 * 3_600_000),
  actualEndAt: iso(NOW - 3_600_000),
  endedBy: 'worker.wang',
};

const EXO_DEVICES = [
  { deviceId: 'EXO-1', workerName: '张三', deviceModel: 'NyExo-A1', deviceCategory: 'exoskeleton', online: true, batteryPct: 80, lastTelemetryAt: iso(NOW), sourceType: 'simulated' },
  { deviceId: 'EXO-2', workerName: '李四', deviceModel: 'NyExo-A1', deviceCategory: 'exoskeleton', online: true, batteryPct: 60, lastTelemetryAt: iso(NOW), sourceType: 'simulated' },
];

const PERSONNEL = [
  { personId: 'P-1001', name: '张三' },
  { personId: 'P-1002', name: '李四' },
];

/** NO-38a：偏差复盘（预计 vs 实际）——一个"有超时"组 + 一个"样本不足"组。 */
const DEVIATION_SUMMARY = {
  generatedAt: iso(NOW),
  windowDays: 30,
  groupBy: 'device',
  minSample: 3,
  scanned: 5,
  plannedCoverageRate: 3 / 5,
  truncated: false,
  totals: {
    key: 'ALL',
    sessions: 5,
    completed: 5,
    comparable: 3,
    onTime: 1,
    early: 0,
    over: 2,
    notComparable: 2,
    onTimeRate: 1 / 3,
    meanDeviationMs: 40 * 60_000,
    medianDeviationMs: 30 * 60_000,
    worstOverMs: 90 * 60_000,
    bestEarlyMs: null,
    insufficientSample: false,
    notes: ['另有 2 条不可比（缺预计结束或缺实际结束），未计入比率'],
  },
  groups: [
    {
      key: 'EXO-1',
      sessions: 3,
      completed: 3,
      comparable: 3,
      onTime: 1,
      early: 0,
      over: 2,
      notComparable: 0,
      onTimeRate: 1 / 3,
      meanDeviationMs: 40 * 60_000,
      medianDeviationMs: 30 * 60_000,
      worstOverMs: 90 * 60_000,
      bestEarlyMs: null,
      insufficientSample: false,
      notes: [],
    },
    {
      key: 'EXO-9',
      sessions: 1,
      completed: 1,
      comparable: 1,
      onTime: 1,
      early: 0,
      over: 0,
      notComparable: 0,
      onTimeRate: null,
      meanDeviationMs: null,
      medianDeviationMs: null,
      worstOverMs: null,
      bestEarlyMs: null,
      insufficientSample: true,
      notes: ['可比样本仅 1 条（少于 3 条）：只给计数，不给准时率结论'],
    },
  ],
  notes: [
    '口径：只有同时记录了"预计结束"与"实际结束"的会话才可比；缺任一时间戳的会话计入不可比，不参与比率。',
    '形成结论的最少可比样本：3 条（低于该门槛只给计数，不给比率）。',
  ],
};

/** NO-40a：设备上下文——一台设备 + 一张在飞任务（受派人 = 待选人员）+ 可继承计划结束。 */
const DEVICE_CONTEXT = {
  exoId: `device:${EXO_DEVICES[0].deviceId}`,
  deviceUuid: '11111111-1111-4111-8111-111111111111',
  registered: true,
  online: true,
  activeSession: null,
  inFlightTasks: [
    {
      taskId: '22222222-2222-4222-8222-222222222222',
      title: '装配任务 A',
      status: 'dispatched',
      assigneeId: 'P-1001',
      planEnd: iso(NOW + 2 * 3_600_000),
    },
  ],
  suggestion: {
    taskId: '22222222-2222-4222-8222-222222222222',
    expectedEndAt: iso(NOW + 2 * 3_600_000),
    assigneeMatches: true,
    reason: '唯一在飞任务：装配任务 A（dispatched）；受派人就是本次佩戴人员（人机同体，可开始会话）；可继承任务计划结束时间作为预计结束（提升偏差可比性）',
  },
  generatedAt: iso(NOW),
};

/** NO-41a：佩戴事实双源校验——一条"与遥测一致"，一条"佩戴人不符（需核实）"。 */
const TELEMETRY_CONSISTENCY = {
  generatedAt: iso(NOW),
  freshWindowMs: 5 * 60_000,
  scanned: 2,
  summary: { consistent: 1, wearer_mismatch: 1 },
  sessions: [
    {
      sessionId: 'S-LONG',
      exoId: 'device:EXO-1',
      personId: 'P-1001',
      startedAt: LONG_ACTIVE.startedAt,
      expectedEndAt: LONG_ACTIVE.expectedEndAt,
      taskId: null,
      verdict: 'consistent',
      reason: '遥测上报的佩戴人与会话一致（P-1001），最近一帧 12 秒前',
      needsHumanCheck: false,
      sessionPersonRef: 'P-1001',
      telemetryWorkerRef: 'P-1001',
      evidenceAgeMs: 12_000,
      evidence: { ts: iso(NOW - 12_000), workerId: 'P-1001', loadScore: 0.4, assistLevel: null, angularVelocityDps: 3, sourceType: 'simulated', dataQuality: 'good' },
    },
    {
      sessionId: 'S-SHORT',
      exoId: 'device:EXO-2',
      personId: 'P-1002',
      startedAt: SHORT_ACTIVE.startedAt,
      expectedEndAt: null,
      taskId: null,
      verdict: 'wearer_mismatch',
      reason: '遥测上报的佩戴人是 P-9999，而会话记录的是 P-1002：两源不一致，请现场核实（平台不替任何一方下结论）',
      needsHumanCheck: true,
      sessionPersonRef: 'P-1002',
      telemetryWorkerRef: 'P-9999',
      evidenceAgeMs: 8_000,
      evidence: { ts: iso(NOW - 8_000), workerId: 'P-9999', loadScore: 0.2, assistLevel: null, angularVelocityDps: 1, sourceType: 'simulated', dataQuality: 'good' },
    },
  ],
  notes: [
    '会话是人工声明，遥测是设备证据：两源不一致必须由人核实，平台不替任何一方下结论。',
    '缺遥测 = 无佐证（不是"没有佩戴"）；遥测帧未上报佩戴人时，只能证明"有人在用"（或疑似无人使用）。',
  ],
};

function exoMock(overrides = {}) {
  return {
    'GET /api/exo/sessions': { sessions: [LONG_ACTIVE, SHORT_ACTIVE, ENDED, ENDED_OVER, CORRECTED] },
    'GET /api/exo/sessions/consistency': TELEMETRY_CONSISTENCY,
    'GET /api/exo/sessions/deviation-summary': DEVIATION_SUMMARY,
    'GET /api/exo/sessions/device-context': DEVICE_CONTEXT,
    'GET /api/dashboard/devices': EXO_DEVICES,
    // 真实路径是 /api/personnel（返回数组）；此前 mock 的是不存在的
    // /api/organization/personnel，页面拿不到人员——新的"选人员"用例把它暴露了出来。
    'GET /api/personnel': PERSONNEL,
    ...overrides,
  };
}

test.describe('外骨骼作业台', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('进行中会话按时长优先展示，长时间未收工明确提示核实', async ({ page }) => {
    await mockApi(page, exoMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');

    await expect(page.getByRole('heading', { name: '外骨骼作业台' })).toBeVisible();
    await expect(page.getByTestId('exo-summary')).toContainText('进行中 2');
    await expect(page.getByTestId('exo-summary')).toContainText('需核实未收工 1 台');

    // 5 小时的进行中会话排在 30 分钟的前面，并给出"请核实是否忘记收工"
    await expect(page.getByTestId('exo-attention-S-LONG')).toContainText('超过 4 小时');
    await expect(page.getByTestId('exo-attention-S-LONG')).toContainText('忘记收工');
    await expect(page.getByTestId('exo-session-S-SHORT')).toContainText('已进行 30 分钟');
    await expect(page.getByTestId('exo-session-S-LONG')).toContainText('已进行 5 小时');
    // 终态会话不告警（已经收工）
    await expect(page.getByTestId('exo-session-S-ENDED')).toContainText('已结束');
    await expect(page.getByTestId('exo-session-S-ENDED')).toContainText('worker.li');
    await expect(page.getByTestId('exo-attention-S-ENDED')).toHaveCount(0);

    // 排序：进行中（长→短）在前，终态按开始时间倒序在后
    // （S-CORRECTED = NO-43a 的更正产物，开始于 40 分钟前，因此排在两条更早的终态会话之前）
    const ids = await page.locator('[data-testid^="exo-session-"]').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-testid')),
    );
    expect(ids).toEqual([
      'exo-session-S-LONG',
      'exo-session-S-SHORT',
      'exo-session-S-CORRECTED',
      'exo-session-S-OVER',
      'exo-session-S-ENDED',
    ]);
  });

  test('结束会话：调用真实端点并刷新列表', async ({ page }) => {
    const calls = [];
    await mockApi(
      page,
      exoMock({
        'POST /api/exo/sessions/S-SHORT/end': ({ body }) => {
          calls.push(body);
          return { ...SHORT_ACTIVE, status: 'ended', actualEndAt: iso(NOW), endedBy: 'lead.chen' };
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');
    await page.getByTestId('exo-end-S-SHORT').click();
    await expect.poll(() => calls.length).toBe(1);
  });

  test('中止必须写理由：理由为空时提交禁用并给出原因', async ({ page }) => {
    const aborts = [];
    await mockApi(
      page,
      exoMock({
        'POST /api/exo/sessions/S-LONG/abort': ({ body }) => {
          aborts.push(body);
          return { ...LONG_ACTIVE, status: 'aborted', actualEndAt: iso(NOW), reason: body.reason };
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');

    await page.getByTestId('exo-abort-S-LONG').click();
    const dialog = page.getByTestId('exo-abort-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('exo-abort-error')).toContainText('必须填写理由');
    await expect(page.getByTestId('exo-abort-submit')).toBeDisabled();

    await page.getByTestId('exo-abort-reason').fill('人员提前离岗，未走正常收工流程');
    await expect(page.getByTestId('exo-abort-submit')).toBeEnabled();
    await page.getByTestId('exo-abort-submit').click();
    await expect.poll(() => aborts.length).toBe(1);
    expect(aborts[0].reason).toBe('人员提前离岗，未走正常收工流程');
  });

  test('没有会话记录 + 没有外骨骼设备 → 两处都说清楚（不留白、不造设备）', async ({ page }) => {
    await mockApi(
      page,
      exoMock({
        'GET /api/exo/sessions': { sessions: [] },
        'GET /api/dashboard/devices': [],
      }),
    );
    await openSession(page, server.baseUrl, ROLES.worker, '/exo');
    await expect(page.getByTestId('exo-empty')).toContainText('当前没有外骨骼会话记录');
    await expect(page.getByTestId('exo-no-devices')).toContainText('不会凭空造设备');
    await expect(page.getByTestId('exo-start-submit')).toBeDisabled();
  });

  /* ── NO-36b：预计 vs 实际（运行记忆必须是用户看得懂的事实）───────────── */
  test('预计 vs 实际：进行中显示剩余/已超时，终态显示偏差，没记录预计就说无法比较', async ({ page }) => {
    await mockApi(page, exoMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');
    await expect(page.getByRole('heading', { name: '外骨骼作业台' })).toBeVisible();

    // S-LONG：预计结束时间已过（1 小时前）→ 明确指出"已超时"，而不是只写已进行时长
    await expect(page.getByTestId('exo-deviation-S-LONG')).toContainText('已超时 1 小时');
    await expect(page.getByTestId('exo-deviation-S-LONG')).toContainText('核实是否需要收工');
    // S-SHORT：没填预计结束 → 进行中也不编造剩余时间
    await expect(page.getByTestId('exo-deviation-S-SHORT')).toContainText('未记录预计结束时间');
    // S-OVER：预计 1 小时、实际 3 小时 → 超时 2 小时
    await expect(page.getByTestId('exo-deviation-S-OVER')).toContainText('超时 2 小时');
    // S-ENDED：没填预计 → 明确"无法比较"，不冒充准时
    await expect(page.getByTestId('exo-deviation-S-ENDED')).toContainText('未记录预计结束时间（无法比较预计与实际）');
  });

  /* ── NO-38a：偏差复盘卡片必须"能判定且不撒谎"────────────────────── */
  test('偏差复盘：给出准时率与偏差，样本不足的组明说"证据不足"而不是 0%', async ({ page }) => {
    await mockApi(page, exoMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');
    await expect(page.getByRole('heading', { name: '外骨骼作业台' })).toBeVisible();

    const card = page.getByTestId('exo-deviation-review');
    await expect(card).toBeVisible();
    // 口径与截断状态可见（扫描量 + 门槛）
    await expect(page.getByTestId('exo-deviation-scope')).toContainText('最近 30 天');
    await expect(page.getByTestId('exo-deviation-scope')).toContainText('口径门槛 3 条可比样本');
    // NO-42a：可比样本率必须可见（衡量"预计 vs 实际"有多可信）
    await expect(page.getByTestId('exo-deviation-scope')).toContainText('可比样本率 60%');

    // 合计行：比率来自服务端（33%），并列出不可比条数
    const totalsRow = page.getByTestId('exo-deviation-row-ALL');
    await expect(totalsRow).toContainText('合计');
    await expect(totalsRow).toContainText('可比 3 / 共 5 条（2 条不可比）');
    await expect(totalsRow).toContainText('准时率 33%（1/3）');
    await expect(totalsRow).toContainText('有超时');

    // 有超时的设备组排在前，且给出平均/中位/最差超时
    const groupRow = page.getByTestId('exo-deviation-row-EXO-1');
    await expect(groupRow).toContainText('平均 +40 分钟');
    await expect(groupRow).toContainText('最差超时 1 小时 30 分');

    // 样本不足的组：明说证据不足，绝不出现 "0%"
    const insufficientRow = page.getByTestId('exo-deviation-row-EXO-9');
    await expect(insufficientRow).toContainText('证据不足');
    await expect(insufficientRow).not.toContainText('0%');
    await expect(insufficientRow).toContainText('只给计数，不给准时率结论');

    // 全局口径说明必须展示（避免把"不可比"读成"准时"）
    await expect(page.getByTestId('exo-deviation-notes')).toContainText('只有同时记录了');
  });

  /* ── NO-40a：设备上下文与任务绑定（现场要知道"这次佩戴算哪张任务"）────── */
  test('设备上下文：展示在飞任务与可继承的计划结束时间，开始会话携带 taskId', async ({ page }) => {
    const starts = [];
    await mockApi(
      page,
      exoMock({
        'POST /api/exo/sessions': ({ body }) => {
          starts.push(body);
          return { ...SHORT_ACTIVE, sessionId: 'S-NEW', taskId: body.taskId };
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');

    await page.getByTestId('exo-device-select').selectOption(EXO_DEVICES[0].deviceId);
    await page.getByTestId('exo-person-select').selectOption('P-1001');

    const context = page.getByTestId('exo-device-context');
    await expect(context).toBeVisible();
    await expect(page.getByTestId('exo-device-context-tasks')).toContainText('在飞任务 1 张');
    await expect(page.getByTestId('exo-device-context-tasks')).toContainText('装配任务 A');
    await expect(page.getByTestId('exo-device-context-tasks')).toContainText('受派人 P-1001');
    // 建议理由（含人机同体与可继承说明）必须对人可见，而不是只给一个默认勾选
    await expect(page.getByTestId('exo-device-context-suggestion')).toContainText('人机同体');
    await expect(page.getByTestId('exo-device-context-suggestion')).toContainText('可继承任务计划结束时间');

    // 默认勾选"绑定在飞任务并继承计划结束时间"
    const bind = page.getByTestId('exo-bind-task');
    await expect(bind).toBeChecked();
    await expect(page.getByTestId('exo-device-context')).toContainText('继承计划结束时间');

    await page.getByTestId('exo-start-submit').click();
    await expect.poll(() => starts.length).toBe(1);
    // 关键断言：页面上的**裸 id** 必须被客户端规范化成契约身份再发出——
    // 否则服务端会 fail-closed 拒绝（2026-09-11 实测：这个按钮此前从未被点过）。
    expect(starts[0]).toMatchObject({
      exoId: `device:${EXO_DEVICES[0].deviceId}`,
      personId: 'person:P-1001',
      taskId: DEVICE_CONTEXT.suggestion.taskId,
    });
  });

  /* ── NO-41a：佩戴事实双源校验（会话声明 × 遥测）──────────────────────── */
  test('遥测校验：一致与"佩戴人不符"分别展示，冲突标红并给出理由', async ({ page }) => {
    await mockApi(page, exoMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');
    await expect(page.getByRole('heading', { name: '外骨骼作业台' })).toBeVisible();

    // 一致：灰字，说明理由（含"最近一帧"）
    const consistent = page.getByTestId('exo-consistency-S-LONG');
    await expect(consistent).toContainText('与遥测一致');
    await expect(consistent).toContainText('P-1001');

    // 不一致：必须显式展示"佩戴人与遥测不符（需核实）"+ 两个身份 + 平台立场
    const mismatch = page.getByTestId('exo-consistency-S-SHORT');
    await expect(mismatch).toContainText('佩戴人与遥测不符（需核实）');
    await expect(mismatch).toContainText('P-9999');
    await expect(mismatch).toContainText('P-1002');
    await expect(mismatch).toContainText('不替任何一方下结论');
    // 终态会话不显示校验（会话已收工，一致性不再有意义）
    await expect(page.getByTestId('exo-consistency-S-ENDED')).toHaveCount(0);
  });

  /* ── NO-42a：遥测冲突的处置动作（带证据理由收工）────────────────────── */
  test('冲突会话提供"核实并收工"：结束请求带上遥测校验判定与依据', async ({ page }) => {
    const ends = [];
    await mockApi(
      page,
      exoMock({
        'POST /api/exo/sessions/S-SHORT/end': ({ body }) => {
          ends.push(body);
          return { ...SHORT_ACTIVE, status: 'ended', actualEndAt: iso(NOW), endedBy: 'lead.chen' };
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');

    // 只有"需人核实"的那条会话才有这个动作（S-LONG 一致 → 没有）
    await expect(page.getByTestId('exo-verify-end-S-SHORT')).toBeVisible();
    await expect(page.getByTestId('exo-verify-end-S-LONG')).toHaveCount(0);

    await page.getByTestId('exo-verify-end-S-SHORT').click();
    await expect.poll(() => ends.length).toBe(1);
    expect(String(ends[0]?.reason ?? '')).toContain('遥测校验（wearer_mismatch）');
    expect(String(ends[0]?.reason ?? '')).toContain('P-9999');
  });

  /* ── NO-43a：按实际佩戴人更正（交接语义，先摆证据再让人决定）────────── */
  test('遥测指名"别人在戴"时可更正：确认前展示证据/影响面/风险，提交规范化人员 id', async ({ page }) => {
    const corrections = [];
    await mockApi(
      page,
      exoMock({
        'POST /api/exo/sessions/S-SHORT/correct-wearer': ({ body }) => {
          corrections.push(body);
          return {
            corrected: true,
            fromPersonId: 'P-1002',
            toPersonId: body.personId,
            reason: body.reason ?? '',
            ended: {
              ...SHORT_ACTIVE,
              status: 'ended',
              actualEndAt: iso(NOW),
              endedBy: 'lead.chen',
              correctedTo: 'S-CORRECTED',
            },
            started: {
              sessionId: 'S-CORRECTED',
              exoId: 'EXO-2',
              personId: body.personId,
              status: 'active',
              startedAt: iso(NOW),
              correctedFrom: 'S-SHORT',
            },
          };
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');
    await expect(page.getByRole('heading', { name: '外骨骼作业台' })).toBeVisible();

    // 只有"遥测指名了别人"的会话才有这个动作；判定一致的那条没有
    await expect(page.getByTestId('exo-correct-S-SHORT')).toBeVisible();
    await expect(page.getByTestId('exo-correct-S-LONG')).toHaveCount(0);

    await page.getByTestId('exo-correct-S-SHORT').click();
    const dialog = page.getByTestId('exo-correct-dialog');
    await expect(dialog).toBeVisible();
    // 决策原则：来源/时间/影响面/约束与风险必须先摆出来，再让人点确认
    await expect(page.getByTestId('exo-correct-evidence')).toContainText('P-9999');
    await expect(page.getByTestId('exo-correct-evidence')).toContainText('1 分钟内');
    await expect(page.getByTestId('exo-correct-impact')).toContainText('保留在台账');
    await expect(page.getByTestId('exo-correct-impact')).toContainText('设备仍被占用');
    await expect(page.getByTestId('exo-correct-risk')).toContainText('可能失真或滞后');
    await expect(page.getByTestId('exo-correct-target')).toContainText('P-9999');
    // 不是"改字段"：文案必须说清旧的收工、新的开始
    await expect(dialog).toContainText('佩戴人交接');

    // 更正链路在会话行里可见（否则事后只有两条互不相关的会话）
    await expect(page.getByTestId('exo-session-S-CORRECTED')).toContainText('由 S-CORRECT-OLD 更正而来');

    await page.getByTestId('exo-correct-note').fill('现场确认是 P-9999 在戴');
    await page.getByTestId('exo-correct-submit').click();
    await expect.poll(() => corrections.length).toBe(1);
    // 裸 id 必须被规范化成契约身份（与开始会话同一条规则）
    expect(corrections[0]).toMatchObject({ personId: 'person:P-9999' });
    expect(String(corrections[0]?.reason ?? '')).toContain('现场确认是 P-9999 在戴');
    // 提交成功后对话框关闭，避免同一次更正被重复提交
    await expect(page.getByTestId('exo-correct-dialog')).toHaveCount(0);
  });

  test('无障碍：作业台无 serious/critical 级违规（axe）', async ({ page }) => {
    await mockApi(page, exoMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/exo');
    await expect(page.getByRole('heading', { name: '外骨骼作业台' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withRules(['color-contrast', 'aria-required-attr', 'button-name', 'label', 'link-name']).analyze();
    const blocking = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(
      blocking.map((v) => `${v.id}(${v.impact})×${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
    ).toEqual([]);
  });
});
