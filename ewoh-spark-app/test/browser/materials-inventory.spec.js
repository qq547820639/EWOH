/* 物料与库存浏览器验收 —— NO-27a / NO-28a。
 *
 * 这一页要让现场一眼分清四件事（原则 5/6/7）：
 *   1. 需求 > 库存 → "差多少"（比"低于再订货点"更紧迫）并列出受影响订单号；
 *   2. 需求可覆盖但低于再订货点 → 提示补料但不谎报缺料；
 *   3. 无法判定的情形（未声明阈值 / 单位不一致 / 只有需求没出入库）如实标注，
 *      而不是显示 0 或缺省成"正常"；
 *   4. 来源可见：生成时间、扫描量、历史不可解析载荷清单。
 *
 * 用 mock 数据层；真实链路（ERP → 库存 → 需求 → 推理）由 `e2e:materials` 覆盖。
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { ROLES, mockApi, openSession, startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const INVENTORY = {
  balances: [
    {
      materialId: 'MAT-A',
      onHand: 15,
      unit: 'kg',
      minThreshold: 40,
      thresholdDeclaredAt: '2026-09-12T09:00:00.000Z',
      receipts: 1,
      consumptions: 1,
      movementCount: 2,
      lastMovementAt: '2026-09-12T09:30:00.000Z',
      negative: false,
      mixedUnits: false,
      evidenceIds: ['event:ERP-X-1', 'event:ERP-X-2'],
    },
    {
      materialId: 'MAT-B',
      onHand: 500,
      unit: '件',
      minThreshold: 100,
      thresholdDeclaredAt: '2026-09-12T08:00:00.000Z',
      receipts: 2,
      consumptions: 0,
      movementCount: 2,
      lastMovementAt: '2026-09-12T08:10:00.000Z',
      negative: false,
      mixedUnits: false,
      evidenceIds: ['event:ERP-X-3'],
    },
    {
      materialId: 'MAT-C',
      onHand: 8,
      unit: null,
      minThreshold: null,
      thresholdDeclaredAt: null,
      receipts: 2,
      consumptions: 0,
      movementCount: 2,
      lastMovementAt: '2026-09-12T08:20:00.000Z',
      negative: false,
      mixedUnits: true,
      evidenceIds: ['event:ERP-X-4'],
    },
  ],
  unparsable: [
    { eventId: 'ERP-X-LEGACY', type: 'material_consumption', reason: 'legacy_untyped_payload（历史自由格式：没有物料字段，无法参与库存投影）' },
  ],
  generatedAt: '2026-09-12T10:00:00.000Z',
  scannedEvents: 12,
  movementEvents: 7,
  scannedOrders: 4,
  demand: {
    demands: [
      {
        materialId: 'MAT-A',
        requiredQuantity: 60,
        unit: null,
        orders: [
          { externalOrderId: 'SO-1001', eventId: 'ERP-O-1', requiredQuantity: 40, orderQuantity: 20, dueAt: '2026-09-20T00:00:00.000Z' },
          { externalOrderId: 'SO-1002', eventId: 'ERP-O-2', requiredQuantity: 20, orderQuantity: 10, dueAt: '2026-09-01T00:00:00.000Z' },
        ],
        evidenceIds: ['ERP-O-1', 'ERP-O-2'],
        hasOverdue: true,
      },
    ],
    unknownBasisOrders: [
      { eventId: 'ERP-O-3', externalOrderId: 'SO-1003', reason: 'bom_basis_undeclared（未声明每件用量还是整单用量：不按猜测计算需求）' },
    ],
    invalidOrders: [
      { eventId: 'ERP-O-4', externalOrderId: 'SO-1004', reason: '订单数量非法（-1）' },
    ],
    generatedAt: '2026-09-12T10:00:00.000Z',
  },
  impact: [
    {
      materialId: 'MAT-A',
      onHand: 15,
      unit: 'kg',
      minThreshold: 40,
      requiredQuantity: 60,
      thresholdGap: 25,
      demandGap: 45,
      status: 'below_demand',
      statusLabel: '不足以覆盖未完工订单',
      affectedOrders: [
        { externalOrderId: 'SO-1001', requiredQuantity: 40, dueAt: '2026-09-20T00:00:00.000Z' },
        { externalOrderId: 'SO-1002', requiredQuantity: 20, dueAt: '2026-09-01T00:00:00.000Z' },
      ],
      hasOverdue: true,
      evidenceIds: ['event:ERP-X-1', 'ERP-O-1'],
    },
    {
      materialId: 'MAT-B',
      onHand: 500,
      unit: '件',
      minThreshold: 100,
      requiredQuantity: null,
      thresholdGap: -400,
      demandGap: null,
      status: 'ok',
      statusLabel: '正常',
      affectedOrders: [],
      hasOverdue: false,
      evidenceIds: ['event:ERP-X-3'],
    },
    {
      materialId: 'MAT-C',
      onHand: 8,
      unit: null,
      minThreshold: null,
      requiredQuantity: null,
      thresholdGap: null,
      demandGap: null,
      status: 'mixed_units',
      statusLabel: '计量单位不一致（无法合并）',
      affectedOrders: [],
      hasOverdue: false,
      evidenceIds: ['event:ERP-X-4'],
    },
    {
      materialId: 'MAT-D',
      onHand: null,
      unit: null,
      minThreshold: null,
      requiredQuantity: 12,
      thresholdGap: null,
      demandGap: null,
      status: 'no_movements',
      statusLabel: '只有需求、没有出入库记录（库存未知）',
      affectedOrders: [{ externalOrderId: 'SO-1005', requiredQuantity: 12, dueAt: null }],
      hasOverdue: false,
      evidenceIds: ['ERP-O-5'],
    },
  ],
};

test.describe('物料与库存', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('缺口、影响面与无法判定项都如实展示（不把未知显示成 0/正常）', async ({ page }) => {
    await mockApi(page, { 'GET /api/materials/inventory': INVENTORY });
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/materials');

    await expect(page.getByRole('heading', { name: '物料与库存' })).toBeVisible();
    await expect(page.getByTestId('materials-summary')).toContainText('需要处置 1 项');
    await expect(page.getByTestId('materials-summary')).toContainText('无法判定 2 项');

    // 1) 需求 > 库存：状态、缺口、受影响订单号与逾期标记
    const rowA = page.getByTestId('material-row-MAT-A');
    await expect(rowA).toContainText('不足以覆盖未完工订单');
    await expect(rowA).toContainText('差 45');
    await expect(rowA).toContainText('SO-1001');
    await expect(rowA).toContainText('SO-1002');
    await expect(page.getByTestId('material-overdue-MAT-A')).toBeVisible();

    // 2) 正常项不误报
    await expect(page.getByTestId('material-status-MAT-B')).toContainText('正常');

    // 3) 无法判定：显示原因而不是 0/正常
    await expect(page.getByTestId('material-status-MAT-C')).toContainText('计量单位不一致');
    await expect(page.getByTestId('material-status-MAT-D')).toContainText('库存未知');
    await expect(page.getByTestId('material-row-MAT-D')).toContainText('未知');

    // 4) 未纳入需求计算的订单（口径未声明 / 数据非法）单独列出
    await expect(page.getByTestId('materials-demand-gaps')).toContainText('SO-1003');
    await expect(page.getByTestId('materials-demand-gaps')).toContainText('BOM 口径未声明');
    await expect(page.getByTestId('materials-demand-gaps')).toContainText('SO-1004');

    // 5) 来源与不可解析载荷
    await expect(page.getByTestId('materials-provenance')).toContainText('扫描出站事件 12 条');
    await expect(page.getByTestId('materials-unparsable')).toContainText('ERP-X-LEGACY');
  });

  test('没有物料记录 → 说明不会凭空生成物料（不留白）', async ({ page }) => {
    await mockApi(page, {
      'GET /api/materials/inventory': {
        balances: [],
        impact: [],
        unparsable: [],
        demand: { demands: [], unknownBasisOrders: [], invalidOrders: [], generatedAt: '2026-09-12T10:00:00.000Z' },
        generatedAt: '2026-09-12T10:00:00.000Z',
        scannedEvents: 0,
        movementEvents: 0,
        scannedOrders: 0,
      },
    });
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/materials');
    await expect(page.getByTestId('materials-empty')).toContainText('不会凭空生成物料');
  });

  test('库存读取失败 → 显式报错（不显示成"没有物料"）', async ({ page }) => {
    await mockApi(page, {
      'GET /api/materials/inventory': { status: 500, body: { message: 'boom' } },
    });
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/materials');
    await expect(page.getByTestId('materials-error-banner')).toContainText('库存读取失败');
    // 失败不能被显示成"没有物料"，也不能停在"加载中…"
    await expect(page.getByTestId('materials-error')).toContainText('不是"没有物料"');
    await expect(page.getByTestId('materials-empty')).toHaveCount(0);
  });

  /**
   * 无障碍回归（axe，serious/critical 零违规）。
   *
   * 为什么把这些页面也纳入：UX-009 只扫指挥地图族；`/exo`、`/materials`、`/reasoning`、
   * 审批台是 2026-09 新增的产品面，此前只有行为断言、没有对比度/语义/命名的机器门。
   */
  test('无障碍：物料与库存页无 serious/critical 级违规（axe）', async ({ page }) => {
    await mockApi(page, INVENTORY);
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/materials');
    await expect(page.getByRole('heading', { name: '物料与库存' })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(
      blocking.map((v) => `${v.id}(${v.impact})×${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
    ).toEqual([]);
  });
});
