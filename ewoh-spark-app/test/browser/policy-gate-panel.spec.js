/* 策略门禁指标看板浏览器验收（NO-87b/NO-88a）。
 *
 * 纪律（原则 5/6/7）：门禁每条检查的实际值 vs 阈值 + 三态结论
 *   （通过 / 缺数据（未验证 ≠ 通过）/ 不达标——ack 无法豁免）
 * 必须在真浏览器里渲染正确；汇总徽章三态不混淆；含 axe 无障碍扫描。
 *
 * 数据层 mock（无需真实后端）；面板数据源 = POST /api/scheduler/policy/2/gate（只读评估）。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  collectA11yIssues,
  mockApi,
  openSession,
  startStaticServer,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const NOW = '2026-09-16T12:00:00.000Z';

function baseHandlers(gateChecks, extra = {}) {
  return {
    'GET /api/dashboard/overview': {
      deviceTotal: 3, deviceOnline: 2, eventOpen: 0, eventCritical: 0, avgLoad: 0.2, workerCount: 1,
    },
    'GET /api/dashboard/events': { items: [], total: 0 },
    'GET /api/scheduler/active-plans': [],
    'GET /api/scheduler/executions': { items: [], total: 0 },
    'GET /api/workbench/now': { items: [], generatedAt: '2026-09-16T12:00:00.000Z' },
    'GET /api/control/delivery-backlog/status': {
      slaMs: 300000, escalationMultiplier: 3,
      totals: { devices: 0, commands: 0, undelivered: 0, receivedNotExecuted: 0, escalatedDevices: 0, oldestWaitingMs: null },
      devices: [],
      checkedAt: '2026-09-16T12:00:00.000Z',
    },
    'POST /api/scheduler/policy/2/gate': {
      passed: gateChecks.every((c) => c.skipped || c.ok),
      checks: gateChecks,
      replayId: null,
      insufficientEvidence: gateChecks.some((c) => c.skipped),
      evidence: {
        evaluated: gateChecks.filter((c) => !c.skipped).length,
        skipped: gateChecks.filter((c) => c.skipped).length,
        skippedChecks: gateChecks.filter((c) => c.skipped).map((c) => c.name),
        candidatePolicyExists: true,
      },
    },
    ...extra,
  };
}

const PASS = { name: 'on_time_rate', ok: true, actual: 0.92, threshold: 0.8, skipped: false };
const FAIL = { name: 'lateness_p95', ok: false, actual: 8575850, threshold: 1800000, skipped: false };
const SKIP = { name: 'conflict_rate', ok: true, actual: null, threshold: 0.05, skipped: true };

async function openFactory(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.dispatcher, '/factory-operations');
  await expect(page.getByTestId('factory-operations')).toBeVisible();
  await expect(page.getByTestId('policy-gate-panel')).toBeVisible();
}

test.describe('策略门禁指标看板（NO-88a）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('全通过 → "可激活（无需确认）"，检查行展示实际 vs 阈值 + axe', async ({ page }) => {
    await openFactory(page, server.baseUrl, baseHandlers([PASS]));

    await expect(page.getByTestId('policy-gate-panel').getByText('可激活（全部检查通过）')).toBeVisible();
    await expect(page.getByTestId('policy-gate-panel')).toContainText('on_time_rate');
    await expect(page.getByTestId('policy-gate-panel')).toContainText('0.92');
    await expect(page.getByTestId('policy-gate-panel')).toContainText('通过');
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('缺数据 → "需显式确认"徽章 + 检查行标注"缺数据（未验证 ≠ 通过）"', async ({ page }) => {
    await openFactory(page, server.baseUrl, baseHandlers([SKIP]));

    await expect(page.getByTestId('policy-gate-panel').getByText('需显式确认（部分检查缺数据）')).toBeVisible();
    await expect(page.getByTestId('policy-gate-panel').getByText('证据不足（激活需显式确认）')).toBeVisible();
    await expect(page.getByTestId('policy-gate-panel').getByText('缺数据（未验证）')).toBeVisible();
    await expect(page.getByTestId('policy-gate-panel').getByText('未验证 ≠ 通过')).toBeVisible();
  });

  test('不达标 → "已拒绝（指标不达标）"徽章 + 不达标行标红（ack 无法豁免）', async ({ page }) => {
    await openFactory(page, server.baseUrl, baseHandlers([FAIL]));

    const panel = page.getByTestId('policy-gate-panel');
    await expect(panel.getByText('已拒绝（指标不达标）')).toBeVisible();
    // "不达标"出现在徽章/表格行/图例三处 → 用 cell 角色精确断言检查行结论
    await expect(panel.getByRole('cell', { name: '不达标' })).toBeVisible();
    await expect(panel).toContainText('8575850');
    await expect(panel).toContainText('1800000');
  });

  test('混合态：失败优先于缺数据显示（严重度不倒挂）', async ({ page }) => {
    await openFactory(page, server.baseUrl, baseHandlers([FAIL, SKIP]));

    const panel = page.getByTestId('policy-gate-panel');
    await expect(panel.getByText('已拒绝（指标不达标）')).toBeVisible();
    await expect(panel.getByText('缺数据（未验证）')).toBeVisible();
    // 两种结论同屏（失败与缺数据分列各行，不互相吞并）
    await expect(panel.getByText('lateness_p95')).toBeVisible();
    await expect(panel.getByText('conflict_rate')).toBeVisible();
  });

  test('读面失败 → 显式报错（不显示"一切正常"）', async ({ page }) => {
    await mockApi(page, {
      'GET /api/dashboard/overview': {
        deviceTotal: 1, deviceOnline: 1, eventOpen: 0, eventCritical: 0, avgLoad: 0.1, workerCount: 0,
      },
      'GET /api/dashboard/events': { items: [], total: 0 },
      'GET /api/scheduler/active-plans': [],
      'GET /api/scheduler/executions': { items: [], total: 0 },
      'GET /api/workbench/now': { items: [], generatedAt: NOW },
      'GET /api/control/delivery-backlog/status': {
        slaMs: 300000, escalationMultiplier: 3,
        totals: { devices: 0, commands: 0, undelivered: 0, receivedNotExecuted: 0, escalatedDevices: 0, oldestWaitingMs: null },
        devices: [],
        checkedAt: NOW,
      },
      'POST /api/scheduler/policy/2/gate': () => ({ status: 500, body: { message: 'boom' } }),
    });
    await openSession(page, server.baseUrl ?? 'http://127.0.0.1:4173', ROLES.dispatcher, '/factory-operations');
    await expect(page.getByTestId('factory-operations')).toBeVisible();
    await expect(page.getByTestId('policy-gate-error')).toContainText('策略门禁读取失败');
  });
});
