/* 实时风险（观测推导）浏览器验收 —— NO-25a。
 *
 * 为什么单列：这是"感知 → 理解/预测"的交互面，必须同时说清三件事，
 * 否则现场会误信或误弃：
 *   1. 命中了什么风险（哪条规则、作用对象、严重度、解释）；
 *   2. **依据**是什么（数值/阈值/单位/观测时间/数据质量/来源）；
 *   3. 哪些数据**没被采用、为什么**（过期/低置信/未声明能力……）。
 *
 * 用 mock 数据层（无需真实后端）；真实链路（摄入 → 实时评估 → 台账）由
 * `test/e2e/observation-reasoning-live.mjs` 覆盖。
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { ROLES, mockApi, openSession, startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const EVIDENCE = [
  {
    evidenceId: 'sensor:ENV-1-1789078616859',
    subjectId: 'device:ENV-1',
    capability: 'observe.vibration',
    field: 'vibration',
    value: 9.2,
    threshold: 7.1,
    unit: 'mm/s',
    observedAt: '2026-09-12T10:00:00.000Z',
    ageMs: 60000,
    dataQuality: 'FRESH',
    dataConfidence: 1,
    sourceType: 'simulated',
  },
];

const SKIPPED = [
  {
    sensorId: 'ENV-2',
    subjectId: 'ENV-2',
    field: 'vibration',
    reason: 'low_confidence',
    detail: 'data_confidence=0.2 低于下限 0.5',
  },
  {
    sensorId: 'ENV-3',
    subjectId: 'ENV-3',
    field: 'vibration',
    reason: 'stale_reading',
    detail: '读数已过期 30 分钟（窗口 15 分钟）',
  },
];

const LIVE_FACTS = {
  facts: [{ subjectId: 'device:ENV-1', kind: 'machine', values: { vibration: 9.2, vibrationExceeded: true }, evidenceIds: ['sensor:ENV-1-1789078616859'] }],
  evidence: EVIDENCE,
  skipped: SKIPPED,
  limits: { vibrationMmPerSec: 7.1, freshnessMs: 900000, minDataConfidence: 0.5 },
  snapshotVersion: 42,
  readingsConsidered: 3,
  generatedAt: '2026-09-12T10:01:00.000Z',
};

const EVALUATE_LIVE = {
  ...LIVE_FACTS,
  trace: {
    traceId: 'rt-live-1789078860',
    engineVersion: '1.0.0',
    conclusions: [
      {
        conclusionId: 'decision:rtlive1-vibration-risk-deviceENV1',
        ruleId: 'rule:machine-vibration-risk',
        subjectId: 'device:ENV-1',
        severity: 'critical',
        explanation: '设备 device:ENV-1 振动超过阈值',
        evidenceIds: ['sensor:ENV-1-1789078616859'],
      },
    ],
  },
  inferenceIds: [
    { conclusionId: 'decision:rtlive1-vibration-risk-deviceENV1', inferenceId: 'inf-abc123' },
  ],
};

function consoleMock(overrides = {}) {
  return {
    'GET /api/reasoning/live-facts': LIVE_FACTS,
    'POST /api/reasoning/evaluate-live': EVALUATE_LIVE,
    ...overrides,
  };
}

test.describe('实时风险（观测推导）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('立即评估：命中结论 + 依据 + 未采用数据 + 台账 id 全部可见', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/reasoning');

    await expect(page.getByRole('heading', { name: '实时风险（观测推导）' })).toBeVisible();
    await page.getByTestId('reasoning-evaluate').click();

    // 1) 命中结论：规则名 + 对象 + 严重度 + 解释
    const risk = page.getByTestId('reasoning-risk-rule:machine-vibration-risk-device:ENV-1');
    await expect(risk).toBeVisible();
    await expect(risk).toContainText('设备振动风险');
    await expect(risk).toContainText('device:ENV-1');
    await expect(risk).toContainText('critical');
    await expect(risk).toContainText('振动超过阈值');
    await expect(risk).toContainText('台账 inf-abc123');

    // 2) 依据：数值/阈值/数据质量/来源（现场据此判断可信度）
    await expect(page.getByTestId('reasoning-evidence-decision:rtlive1-vibration-risk-deviceENV1')).toContainText(
      'vibration=9.2mm/s',
    );
    await expect(page.getByTestId('reasoning-evidence-decision:rtlive1-vibration-risk-deviceENV1')).toContainText(
      '阈值 7.1mm/s',
    );

    // 3) 未采用数据：原因可读（不是静默丢弃）
    await expect(page.getByTestId('reasoning-skipped').first()).toContainText('数据置信度不足');
    await expect(page.getByTestId('reasoning-skipped').first()).toContainText('读数已过期');

    // 4) 来源与新鲜度：世界模型版本 / 生成时间 / 参与读数 / 是否落账
    await expect(page.getByTestId('reasoning-provenance')).toContainText('世界模型版本 42');
    await expect(page.getByTestId('reasoning-provenance')).toContainText('本次已落 L4 台账');
    await expect(page.getByTestId('reasoning-summary')).toContainText('实时风险 1 条');
  });

  test('感知门控禁止强建议：结论显式标"仅提示（原因）"（NO-58b）', async ({ page }) => {
    await mockApi(page, consoleMock({
      'POST /api/reasoning/evaluate-live': {
        ...EVALUATE_LIVE,
        trace: {
          ...EVALUATE_LIVE.trace,
          conclusions: [
            {
              ...EVALUATE_LIVE.trace.conclusions[0],
              explanation: '设备 device:ENV-1 振动超过阈值（**仅提示**：感知融合不许强建议：一致性 conflict / 置信度 low）',
              advisoryOnly: true,
              advisoryReason: '感知融合不许强建议：一致性 conflict / 置信度 low / 冲突 2 条',
            },
          ],
        },
      },
    }));
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/reasoning');
    await page.getByTestId('reasoning-evaluate').click();

    const key = 'decision:rtlive1-vibration-risk-deviceENV1';
    const advisory = page.getByTestId(`reasoning-advisory-${key}`);
    await expect(advisory).toBeVisible();
    await expect(advisory).toContainText('仅提示');
    await expect(advisory).toContainText('不许强建议');
    // 依据仍然可见（"仅提示"不等于"没有依据"）
    await expect(page.getByTestId(`reasoning-evidence-${key}`)).toBeVisible();
  });

  test('无门控字段（平台未评估）→ 不显示"仅提示"，也不显示成"可信"', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/reasoning');
    await page.getByTestId('reasoning-evaluate').click();

    const key = 'decision:rtlive1-vibration-risk-deviceENV1';
    await expect(page.getByTestId(`reasoning-risk-rule:machine-vibration-risk-device:ENV-1`)).toBeVisible();
    await expect(page.getByTestId(`reasoning-advisory-${key}`)).toHaveCount(0);
  });

  test('查看事实：只读视图不评估、不落账（标题明说），未采用的读数仍可见', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/reasoning');

    await page.getByTestId('reasoning-view-facts').click();
    await expect(page.getByTestId('reasoning-provenance')).toContainText('只读视图（未评估、未落账）');
    // 只读视图没有结论（不拿旧评估冒充当前风险），但依据与未采用数据照旧可见
    await expect(page.getByTestId('reasoning-empty')).toContainText('当前没有规则命中');
    await expect(page.getByTestId('reasoning-skipped').first()).toContainText('数据置信度不足');
  });

  test('无命中且无未采用数据 → 两处都说清楚（不留白）', async ({ page }) => {
    await mockApi(
      page,
      consoleMock({
        'POST /api/reasoning/evaluate-live': {
          ...EVALUATE_LIVE,
          evidence: [],
          skipped: [],
          trace: { ...EVALUATE_LIVE.trace, conclusions: [] },
          inferenceIds: [],
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/reasoning');
    await page.getByTestId('reasoning-evaluate').click();
    await expect(page.getByTestId('reasoning-empty')).toContainText('当前没有规则命中');
    await expect(page.getByTestId('reasoning-skipped')).toContainText('没有需要说明的未采用数据');
    await expect(page.getByTestId('reasoning-summary')).toContainText('当前没有规则命中');
  });

  /**
   * 无障碍回归（axe，serious/critical 零违规）。
   *
   * 为什么把这些页面也纳入：UX-009 只扫指挥地图族；`/exo`、`/materials`、`/reasoning`、
   * 审批台是 2026-09 新增的产品面，此前只有行为断言、没有对比度/语义/命名的机器门。
   */
  test('无障碍：实时风险页（含评估结果态）无 serious/critical 级违规（axe）', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/reasoning');
    await expect(page.getByRole('heading', { name: '实时风险（观测推导）' })).toBeVisible();
    await page.getByTestId('reasoning-evaluate').click();
    await expect(page.getByTestId('reasoning-summary')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(
      blocking.map((v) => `${v.id}(${v.impact})×${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
    ).toEqual([]);
  });
});
