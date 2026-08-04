/**
 * UX-009 端到端体验测试矩阵 —— 移动工作台业务域。
 *
 * 覆盖：扫码、照片（异常上报附件）、E-SOP 签收、质量处置。
 * 断言验证最终用户可见状态（订单标题、SOP 文案、工序状态、质检结果鉴权后的可执行动作），
 * 而非仅 HTTP 状态码。
 *
 * 说明：E-SOP 签收在代码中体现为「工序卡片内的 SOP 说明文案 + 开工/报工等状态流转动作」，
 *       无独立 E-SOP 按钮；照片上传挂载在「异常上报」流程（在线上传 /api/files）。
 *
 * 运行方式：`npm run test:browser:ux009 -- --grep "UX-009/Mobile"`
 * 依赖：`dist/client` 构建产物已存在（否则可先 `npm run build:client:standalone`）。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const ORDER_ID = 'WO-1001';

const WORKBENCH_MOCK = {
  'GET /api/mobile/workbench': [
    {
      stepId: 'S1',
      scheduleTaskId: ORDER_ID,
      stepNo: 1,
      name: '装配',
      instruction: '按 SOP-A 手册完成装配并记录扭矩',
      status: 'pending',
      assignedPersonId: 'u-worker',
      assignedDeviceId: null,
      spatialEntityId: null,
      progress: 0,
      actualStart: null,
      resultJson: null,
    },
  ],
};

const ORDER_DETAIL_MOCK = {
  workOrder: {
    scheduleTaskId: ORDER_ID,
    title: '电机装配订单',
    status: 'in_progress',
    progress: 20,
  },
  steps: [
    {
      stepId: 'S1',
      scheduleTaskId: ORDER_ID,
      stepNo: 1,
      name: '装配',
      instruction: '按 SOP-A 手册完成装配并记录扭矩',
      status: 'pending',
      assignedPersonId: 'u-worker',
      assignedDeviceId: null,
      spatialEntityId: null,
      progress: 0,
      actualStart: null,
      resultJson: null,
    },
  ],
  materials: [],
};

test.describe('UX-009/Mobile', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('扫码：输入工单号并扫码，加载出订单与最终用户可见的工序卡片', async ({ page }) => {
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/scan': ORDER_DETAIL_MOCK,
      'GET /api/mobile/workbench/orders/WO-1001': ORDER_DETAIL_MOCK,
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');

    // 扫码枪 / 手动输入工单号
    await page.getByLabel('扫码或输入工单号').fill('WO-1001');
    await page.getByRole('button', { name: '扫码', exact: true }).click();

    // 扫码成功 → 已扫码工单区块展示订单标题（用户可见）
    await expect(page.locator('section[aria-label="已扫码工单"]')).toBeVisible();
    await expect(page.locator('section[aria-label="已扫码工单"]').getByText('电机装配订单')).toBeVisible();
    // 数据一致性：订单号来自 mock 数据
    await expect(page.locator('section[aria-label="已扫码工单"]').getByText('WO-1001')).toBeVisible();
  });

  test('E-SOP 签收：工序卡片可见 SOP 说明文案，扫码后加载工序并显示 E-SOP 指令', async ({ page }) => {
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/scan': ORDER_DETAIL_MOCK,
      'GET /api/mobile/workbench/orders/WO-1001': ORDER_DETAIL_MOCK,
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await page.getByLabel('扫码或输入工单号').fill('WO-1001');
    await page.getByRole('button', { name: '扫码', exact: true }).click();

    // E-SOP 说明文案（用户可见）
    const stepCard = page.locator('section[aria-label="已扫码工单"]').locator('div', { hasText: '装配' }).first();
    await expect(stepCard.getByText('SOP：')).toBeVisible();
    await expect(stepCard.getByText('按 SOP-A 手册完成装配并记录扭矩')).toBeVisible();
  });

  test('扫码后开工：对 pending 工序执行「开工」，状态流转为进行中（用户可见）', async ({ page }) => {
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/scan': ORDER_DETAIL_MOCK,
      'GET /api/mobile/workbench/orders/WO-1001': ORDER_DETAIL_MOCK,
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': {
        stepId: 'S1',
        name: '装配',
        status: 'in_progress',
      },
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await page.getByLabel('扫码或输入工单号').fill('WO-1001');
    await page.getByRole('button', { name: '扫码', exact: true }).click();

    // 开工动作（pending → in_progress 可执行）
    const stepCard = page.locator('section[aria-label="已扫码工单"]').locator('div', { hasText: '装配' }).first();
    await stepCard.getByRole('button', { name: '开工' }).click();
    // 状态流转为用户可见
    await expect(page.locator('text=工序 S1 已进行中')).toBeVisible();
  });

  test('质量处置：质检不合格提交，展示质检结果与反馈', async ({ page }) => {
    // 质检按钮仅在 in_progress 工序下可用；mock 订单/工序以 in_progress 状态呈现实质量处置场景。
    const inProgressOrder = {
      ...ORDER_DETAIL_MOCK,
      steps: ORDER_DETAIL_MOCK.steps.map((s) => ({ ...s, status: 'in_progress' })),
    };
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/scan': inProgressOrder,
      'GET /api/mobile/workbench/orders/WO-1001': inProgressOrder,
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/quality': () => ({
        stepId: 'S1',
        result: 'fail',
        note: '扭矩不达标',
      }),
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await page.getByLabel('扫码或输入工单号').fill('WO-1001');
    await page.getByRole('button', { name: '扫码', exact: true }).click();

    const stepCard = page.locator('section[aria-label="已扫码工单"]').locator('div', { hasText: '装配' }).first();
    // 打开质检面板
    await stepCard.getByRole('button', { name: '质检' }).click();
    await stepCard.getByLabel('结果').selectOption('fail');
    await stepCard.getByLabel('质检备注').fill('扭矩不达标');
    await stepCard.getByRole('button', { name: '提交质检' }).click();

    // 质检结果回显（用户可见）
    await expect(page.locator('text=质检 S1 已记录：fail')).toBeVisible();
  });

  test('照片上传：异常上报携带照片，提交后在线上传并展示异常记录', async ({ page }) => {
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/scan': ORDER_DETAIL_MOCK,
      'GET /api/mobile/workbench/orders/WO-1001': ORDER_DETAIL_MOCK,
      'POST /api/files': {
        id: 'file-1',
        filename: 'exception-photo.jpg',
        contentType: 'image/jpeg',
      },
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': {
        stepId: 'S1',
        name: '装配',
        status: 'paused',
      },
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await page.getByLabel('扫码或输入工单号').fill('WO-1001');
    await page.getByRole('button', { name: '扫码', exact: true }).click();

    const stepCard = page.locator('section[aria-label="已扫码工单"]').locator('div', { hasText: '装配' }).first();
    await stepCard.getByRole('button', { name: '异常上报' }).click();
    await stepCard.getByLabel('异常说明').fill('工位设备异响需维修');
    // 上传照片（需所属工序 in_progress 才可执行暂停；此处以 pending 工序验证异常 UI 与提交动作）
    await stepCard.getByLabel('异常照片').setInputFiles({
      name: 'exception-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('fake-jpeg-bytes'),
    });
    await stepCard.getByRole('button', { name: '提交异常' }).click();

    // 异常上报提交（用户可见，含照片上传走 /api/files）
    await expect(page.locator('text=工序 S1 已暂停')).toBeVisible();
  });
});