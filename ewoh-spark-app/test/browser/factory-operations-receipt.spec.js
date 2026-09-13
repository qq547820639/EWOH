const { test, expect } = require('@playwright/test');
const {
  ROLES,
  collectA11yIssues,
  mockApi,
  openSession,
  startStaticServer,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const plannedExecution = {
  executionId: 'exec-1',
  runId: 'run-1',
  planId: 'plan-1',
  assignmentId: 'assignment-1',
  taskId: 'task-1',
  personId: 'person-1',
  deviceId: null,
  stationId: 'station-1',
  plannedStartAt: '2026-09-09T08:00:00.000Z',
  plannedEndAt: '2026-09-09T09:00:00.000Z',
  actualStartAt: null,
  actualEndAt: null,
  plannedTravelMs: null,
  actualTravelMs: null,
  plannedDistanceM: null,
  actualDistanceM: null,
  plannedWaitingMs: null,
  actualWaitingMs: null,
  status: 'PLANNED',
  deviationType: 'NONE',
  deviationReason: null,
  snapshotVersion: 'snapshot-1',
  policyVersion: 1,
  solverVersion: 'solver-1',
  createdAt: '2026-09-09T07:00:00.000Z',
  updatedAt: '2026-09-09T07:00:00.000Z',
};

const dashboardMock = {
  'GET /api/dashboard/overview': {
    deviceTotal: 1,
    deviceOnline: 1,
    eventOpen: 0,
    eventCritical: 0,
    avgLoad: 0.2,
    workerCount: 1,
  },
  'GET /api/dashboard/events': { items: [], total: 0 },
  'GET /api/scheduler/active-plans': [],
};

function executionMock(state, options = {}) {
  return {
    ...dashboardMock,
    'GET /api/scheduler/executions': () => {
      if (options.error) return { status: 503, body: { message: '执行记录服务暂不可用' } };
      return { executions: [state.execution], total: 1 };
    },
    'POST /api/scheduler/executions/assignment-1/update': ({ body }) => {
      state.posted.push(body);
      const actualStartAt = body.actualStartAt ?? state.execution.actualStartAt;
      state.execution = {
        ...state.execution,
        status: body.status,
        actualStartAt,
        actualEndAt: body.actualEndAt ?? state.execution.actualEndAt,
        updatedAt: new Date().toISOString(),
        receipt: {
          matchedRows: 1,
          advancedAssignments: 1,
          advancedTaskSteps: 1,
          skips: [],
          policy: 'receipt-provenance-v1',
          source: 'simulated',
          productionTrainingEligible: false,
          reason: 'non_production_persisted_source',
          evidence: { reportedSource: body.reportedSource, persisted: true },
        },
      };
      return state.execution;
    },
  };
}

async function openFactory(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.dispatcher, '/factory-operations');
  await expect(page.getByTestId('factory-operations')).toBeVisible();
  await expect(page.getByRole('heading', { name: '执行回执与结果' })).toBeVisible();
}

test.describe('FactoryOperations execution receipt', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('simulated receipt is keyboard reachable and its provenance is read back by GET', async ({ page }) => {
    const state = { execution: { ...plannedExecution }, posted: [] };
    await openFactory(page, server.baseUrl, executionMock(state));
    const row = page.getByTestId('execution-receipt-assignment-1');
    await expect(row).toBeVisible();
    await expect(row.getByText('来源未返回，待核验')).toBeVisible();

    const sourceRadios = row.locator('input[type="radio"]');
    await expect(sourceRadios).toHaveCount(2);
    expect(await sourceRadios.nth(0).getAttribute('name')).toBe(await sourceRadios.nth(1).getAttribute('name'));
    await sourceRadios.nth(1).check();
    await sourceRadios.nth(0).check();
    await expect(sourceRadios.nth(0)).toBeChecked();
    await expect(sourceRadios.nth(1)).not.toBeChecked();

    const plannedTime = Date.parse(plannedExecution.plannedStartAt);
    const startedBefore = Date.now();
    await row.getByRole('button', { name: '报告开始' }).click();
    await expect.poll(() => state.posted.length).toBe(1);
    const posted = state.posted[0];
    expect(posted.reportedSource).toBe('simulated');
    expect(posted.status).toBe('STARTED');
    expect(Date.parse(posted.actualStartAt)).toBeGreaterThanOrEqual(startedBefore - 2_000);
    expect(Date.parse(posted.actualStartAt)).toBeGreaterThan(plannedTime);
    await expect(row.getByText('服务端回执：执行中', { exact: false })).toBeVisible();
    await expect(row.getByText('模拟来源')).toBeVisible();
    await expect(row.getByText('服务端未将此回执认定为生产训练样本。')).toBeVisible();

    const issues = await collectA11yIssues(page);
    expect(issues).toEqual([]);
    await page.getByTestId('execution-refresh').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('id', 'execution-plan-filter');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveText('查看方案回执');
    await page.reload();
    await expect(row.getByText('模拟来源')).toBeVisible();
    await expect(row.getByText('执行中', { exact: true })).toBeVisible();
  });

  test('failed execution GET disables writes and surfaces retryable API failures', async ({ page }) => {
    const state = { execution: { ...plannedExecution }, posted: [] };
    await openFactory(page, server.baseUrl, executionMock(state, { error: true }));
    await expect(page.getByRole('alert')).toContainText('执行记录获取失败');
    await expect(page.getByRole('button', { name: '报告开始' })).toHaveCount(0);
    await expect(page.getByTestId('execution-refresh')).toBeEnabled();
  });

  test('stale executions become read-only and mobile receipt form has no horizontal overflow', async ({ page }) => {
    const state = { execution: { ...plannedExecution }, posted: [] };
    await page.clock.install();
    await openFactory(page, server.baseUrl, executionMock(state));
    await expect(page.getByRole('button', { name: '报告开始' })).toBeEnabled();
    let releaseRefresh;
    const pendingRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
    await page.route('**/api/scheduler/executions*', async (route) => {
      await pendingRefresh;
      await route.fulfill({ json: { executions: [state.execution], total: 1 } });
    });
    await page.clock.fastForward(61_000);
    await expect(page.getByText('执行状态已过期，请先刷新')).toHaveCount(0);
    await expect.poll(async () => page.getByRole('button', { name: '报告开始' }).isDisabled()).toBe(true);
    await expect(page.getByText(/时间异常或已超过60秒/).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    releaseRefresh();
    await expect(page.getByRole('button', { name: '报告开始' })).toBeEnabled();
  });
});
