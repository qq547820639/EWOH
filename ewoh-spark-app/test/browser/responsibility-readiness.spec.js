/* 接班人核对（设备责任人覆盖率）浏览器验收 —— NO-52a。
 *
 * 交接班时最该回答的问题：**接班的那一班，哪些设备没人负责**。
 * 覆盖：
 *  1. 口径与结论逐条可见（按哪个班次核对、覆盖/缺口/未登记各有几台）；
 *  2. 缺口设备逐条列出，并说明"只有别的班次的责任人"（不是含糊的"无人负责"）；
 *  3. 班次未知（未匹配到班次定义）时显式说明，不猜默认班；
 *  4. 缺口可一键写进交接遗留事项（由人决定是否提交，平台不代填）；
 *  5. 读取失败显式报错，绝不显示成"无人负责"。
 *
 * mock 数据层；真实后端版本由 test/e2e/edge-multisource-uplink.mjs 的责任人段落覆盖。
 */
const { test, expect } = require('@playwright/test');
const { ROLES, mockApi, openSession, startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const NOW = '2026-09-12T10:00:00.000Z';

const SHIFTS = [
  { shiftId: 'SHIFT-DAY', name: '白班', code: 'A', startTime: '08:00', endTime: '20:00', crossesMidnight: false, active: true },
  { shiftId: 'SHIFT-NIGHT', name: '夜班', code: 'B', startTime: '20:00', endTime: '08:00', crossesMidnight: true, active: true },
];

const COVERAGE = {
  shiftId: 'SHIFT-NIGHT',
  shiftUnknown: false,
  total: 5,
  covered: 3,
  gaps: 2,
  uncovered: 4,
  devices: [
    {
      deviceId: 'EXO-3', covered: false, holders: [],
      outOfShift: [{ personId: 'person:P-1', responsibility: 'owner', shiftId: 'SHIFT-DAY' }],
    },
    { deviceId: 'EXO-4', covered: false, holders: [], outOfShift: [] },
    {
      deviceId: 'EXO-1', covered: true,
      holders: [{ personId: 'person:P-2', responsibility: 'owner', matchedBy: 'current_shift' }],
      outOfShift: [],
    },
  ],
  notes: ['口径：纳入核对的是已登记责任关系的设备；覆盖 = 存在本班或全天责任人（不要求已绑定登录账号）。'],
};

function baseMock(overrides = {}) {
  return {
    'GET /api/shifts/current': { current: SHIFTS[1], next: SHIFTS[0] },
    'GET /api/shifts': SHIFTS,
    'GET /api/device-responsibilities/coverage': COVERAGE,
    'GET /api/shifts/handovers': [],
    'GET /api/dashboard/events': { items: [], total: 0 },
    'GET /api/dashboard/overview': { deviceTotal: 0, deviceOnline: 0, eventOpen: 0, eventCritical: 0, avgLoad: 0, workerCount: 0 },
    'GET /api/scheduler/plans': { items: [], total: 0 },
    'GET /api/scheduler/executions': { items: [], total: 0 },
    'GET /api/data-quality/confirmations': { items: [], total: 0 },
    'GET /api/perception/fusion': [],
    ...overrides,
  };
}

async function openShiftWorkbench(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.workshop_lead, '/shift-workbench');
  await expect(page.getByTestId('shift-workbench')).toBeVisible();
}

test.describe('接班人核对（设备责任人）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('口径与结论逐条可见：按班次核对、覆盖/缺口/未登记各有几台', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock());

    const card = page.getByTestId('responsibility-readiness');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('responsibility-readiness-scope')).toContainText('班次 SHIFT-NIGHT');
    await expect(page.getByTestId('responsibility-readiness-scope')).toContainText('共 5 台');

    const summary = page.getByTestId('responsibility-readiness-summary');
    await expect(summary).toContainText('本班覆盖 3 台');
    await expect(summary).toContainText('本班缺口 2 台');
    await expect(summary).toContainText('未登记责任人 4 台');

    // 缺口逐条列出，并说明"只有别的班次责任人"（不含糊）
    const gaps = page.getByTestId('responsibility-readiness-gaps');
    await expect(gaps).toContainText('EXO-3');
    await expect(gaps).toContainText('班次 SHIFT-DAY');
    await expect(gaps).toContainText('EXO-4');
    await expect(gaps).toContainText('没有本班或全天责任人');

    // 口径说明必须展示
    await expect(page.getByTestId('responsibility-readiness-notes')).toContainText('不要求已绑定登录账号');
  });

  test('缺口可一键写进交接遗留事项（文案包含台数，仍由人提交）', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock());
    await page.getByTestId('responsibility-readiness-to-open-items').click();
    const input = page.getByPlaceholder('遗留事项（可选，如：3 号工位设备待复核）');
    await expect(input).toHaveValue(/接班人核对：2 台设备本班无人负责/);
    await expect(input).toHaveValue(/4 台未登记责任人/);
  });

  test('班次未知 → 显式说明（不猜默认班），并提示先登记班次定义', async ({ page }) => {
    await openShiftWorkbench(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/device-responsibilities/coverage': {
          ...COVERAGE,
          shiftId: null,
          shiftUnknown: true,
        },
      }),
    );
    await expect(page.getByTestId('responsibility-readiness-shift-unknown')).toContainText('当前班次未知');
    await expect(page.getByTestId('responsibility-readiness-shift-unknown')).toContainText('请先登记班次定义');
    await expect(page.getByTestId('responsibility-readiness-scope')).toContainText('未匹配到班次定义');
  });

  test('核对读取失败 → 显式报错（绝不显示成"无人负责"）', async ({ page }) => {
    await openShiftWorkbench(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/device-responsibilities/coverage': { status: 500, body: { error: { message: 'boom' } } },
      }),
    );
    const error = page.getByTestId('responsibility-readiness-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('读取失败');
    await expect(error).toContainText('不会显示成');
  });
});


/* ── NO-56a：多源感知融合卡片（班次工作台）────────────────────────────── */

function fusedFixture(overrides = {}) {
  return {
    subjectId: 'person:P-1',
    windowStart: '2026-09-12T07:55:00.000Z',
    windowEnd: '2026-09-12T08:00:00.000Z',
    fusedAt: '2026-09-12T08:00:00.000Z',
    agreement: 'consistent',
    position: { x: 10, y: 20, z: 0, stationId: 'ST-1', basis: ['uwb:TAG-1@…'] },
    posture: { pitchDeg: 12, action: 'standing', basis: ['exo_imu:EXO-1@…'] },
    station: { stationId: 'ST-1', basis: 'uwb:ST-1 · vision:ST-1', sources: ['uwb', 'vision'] },
    confidence: {
      level: 'high',
      score: 0.88,
      basis: '可用源 [uwb,exo_imu,vision,station_semantics,task_context] 权重和 0.88 / 应有 1',
      usableSources: ['uwb', 'exo_imu', 'vision', 'station_semantics', 'task_context'],
      degraded: false,
      missingSources: [],
      excludedSources: [],
      unknownConfidenceSources: [],
    },
    conflicts: [],
    ruleTrace: [{ rule: 'rule1_uwb_vision_same_station', fired: true, detail: '工位一致：ST-1' }],
    strongAdviceAllowed: true,
    notes: [],
    ...overrides,
  };
}

test.describe('感知融合（人在哪 · 姿态 · 可信吗）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('一致 + 高置信：工位/姿态/可用源/允许建议逐条可见', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({ 'GET /api/perception/fusion': [fusedFixture()] }));

    const card = page.getByTestId('perception-fusion');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('perception-fusion-state')).toContainText('工位 ST-1');
    await expect(page.getByTestId('perception-fusion-state')).toContainText('俯仰 12');
    await expect(page.getByTestId('perception-fusion-state')).toContainText('可信度 high');
    await expect(page.getByTestId('perception-fusion-sources')).toContainText('可用源：uwb');
    await expect(page.getByTestId('perception-fusion-advice')).toContainText('可据此生成建议');
  });

  test('冲突：逐条列出各源取值并声明"不得据此生成强建议"', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/perception/fusion': [fusedFixture({
        agreement: 'conflict',
        station: { stationId: null, basis: 'uwb:ST-1 · vision:ST-2', sources: ['uwb', 'vision'] },
        conflicts: [{
          dimension: 'station_presence',
          severity: 'high',
          participants: [
            { source: 'uwb', sourceId: 'TAG-1', value: 'ST-1' },
            { source: 'vision', sourceId: 'CAM-B', value: 'ST-2' },
          ],
          detail: '工位结论不一致（ST-1 vs ST-2）：各源都保留，不静默丢弃；请现场核实',
        }],
        strongAdviceAllowed: false,
      })],
    }));

    await expect(page.getByTestId('perception-fusion-conflicts')).toContainText('uwb=ST-1');
    await expect(page.getByTestId('perception-fusion-conflicts')).toContainText('vision=ST-2');
    await expect(page.getByTestId('perception-fusion-advice')).toContainText('不得据此生成强建议');
  });

  test('证据不足：显示"证据不足（不给分）"与已排除证据，不显示 0%', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/perception/fusion': [fusedFixture({
        agreement: 'insufficient',
        position: null,
        posture: null,
        station: null,
        confidence: {
          level: 'unknown', score: null, basis: '无可用源', usableSources: [],
          degraded: true, missingSources: ['uwb', 'exo_imu', 'vision'],
          excludedSources: [{ source: 'uwb', sourceId: 'TAG-1', dimension: 'position', status: 'stale', reason: '证据过期：3600s > TTL 60s（不参与融合）' }],
          unknownConfidenceSources: [],
        },
        strongAdviceAllowed: false,
        notes: ['缺失源：uwb、exo_imu、vision（本窗口没有任何观测）'],
      })],
    }));

    await expect(page.getByTestId('perception-fusion-state')).toContainText('证据不足（不给分）');
    await expect(page.getByTestId('perception-fusion-state')).not.toContainText('0%');
    await expect(page.getByTestId('perception-fusion-excluded')).toContainText('TTL');
    await expect(page.getByTestId('perception-fusion-notes')).toContainText('缺失源');
  });

  test('扫描：摘要暴露冲突/降级/未匹配/工位未解析', async ({ page }) => {
    const posts = [];
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/perception/fusion': [],
      'POST /api/perception/fusion/sweep': ({ body }) => {
        posts.push(body);
        return {
          orgId: 'org',
          windowStart: '2026-09-12T07:55:00.000Z',
          windowEnd: '2026-09-12T08:00:00.000Z',
          windowMinutes: 5,
          bucketMinutes: 5,
          subjects: 2,
          persisted: 2,
          created: 1,
          refreshed: 1,
          byAgreement: { consistent: 1, conflict: 1 },
          byConfidenceLevel: { high: 1, medium: 1 },
          conflictSubjects: ['person:P-2'],
          degradedSubjects: ['person:P-2'],
          unmatchedVisionDetections: 3,
          stationUnresolved: 1,
          rejected: [],
          notes: [],
          fused: [],
        };
      },
    }));

    await expect(page.getByTestId('perception-fusion-empty')).toContainText('没有快照 ≠ 现场没有异常');
    await page.getByTestId('perception-fusion-sweep').click();
    const note = page.getByTestId('perception-fusion-note');
    await expect(note).toContainText('冲突主体 1 个');
    await expect(note).toContainText('视觉未匹配 3 条');
    await expect(note).toContainText('工位未解析 1 个');
    expect(posts[0]).toMatchObject({ windowMinutes: 5 });
  });

  test('读取失败：显式报错，不显示成"现场没人"', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/perception/fusion': { status: 500, body: { error: { message: 'db unavailable' } } },
    }));

    await expect(page.getByTestId('perception-fusion-error')).toContainText('不会显示成');
    await expect(page.getByTestId('perception-fusion-empty')).toHaveCount(0);
  });
});
