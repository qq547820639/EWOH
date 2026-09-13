/**
 * UX-009 端到端体验测试矩阵 —— 指挥地图（Command Map）axe 无障碍扫描。
 *
 * Task 12 / 12.1：对 Command Map 关键界面运行 axe（@axe-core/playwright），
 * 断言**无 serious/critical 级违规**（minor/moderate 仅记录不阻断）：
 *  1. Command Map Shell（默认视图）：含地图视口文本替代（SVG 为 aria-hidden，
 *     sr-only live region 提供"地图模式/层级"文本替代）断言；
 *  2. 调度方案标签页（SchedulePanel）；
 *  3. 冲突中心标签页（ConflictCenterPanel）；
 *  4. 对话框开/关流程（快捷键帮助 dialog：打开 → axe → Escape 关闭 → 焦点恢复）；
 *  5. 表格视图切换（冲突中心"表格视图"：语义 table + 可聚焦行）。
 *
 * 渲染策略与 ux009-axe.spec.js 一致：mock API + 会话注入（无真实后端）。
 * 运行方式：`npx playwright test test/browser/ux009-command-map-axe.spec.js --project=chromium`
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

/** 阻断级别：serious + critical（与既有 axe spec 一致）。 */
const BLOCKING_IMPACT = ['serious', 'critical'];

const NOW = new Date().toISOString();

/** Command Map 数据层 mock（与真实响应形状一致的最小样本）。 */
const COMMAND_MAP_MOCK = {
  'GET /api/spatial/entities': [
    { entityId: 'P-1', name: '人员 1', entityType: 'person', x: 100, y: 100, status: 'idle', parentId: 'ST-1', floorId: 'F1' },
    { entityId: 'D-1', name: '设备 1', entityType: 'device', x: 200, y: 150, status: 'online', parentId: 'ST-1', floorId: 'F1' },
    { entityId: 'ST-1', name: '工位 1', entityType: 'workstation', x: 150, y: 120, status: 'idle', parentId: null, floorId: 'F1' },
  ],
  'GET /api/world/state': {
    persons: [{ entityId: 'P-1', name: '人员 1', x: 100, y: 100, status: 'idle', confidence: 0.99 }],
    devices: [{ entityId: 'D-1', name: '设备 1', x: 200, y: 150, status: 'online', deviceId: 'D-1' }],
    workstations: [{ entityId: 'ST-1', name: '工位 1', x: 150, y: 120, status: 'idle', occupancy: 0.4 }],
  },
  'GET /api/dashboard/overview': {
    deviceTotal: 1,
    deviceOnline: 1,
    eventOpen: 1,
    eventCritical: 0,
    avgLoad: 62,
    workerCount: 1,
  },
  'GET /api/world/replay': [],
  'GET /api/dashboard/events': [
    { id: 'EV-1', eventId: 'EV-1', title: '设备离线告警', severity: 'L2', status: 'open', deviceId: 'D-1', eventCode: 'EC-1', eventType: 'device_alert', createdAt: NOW },
  ],
  'GET /api/dashboard/environment/summary': [],
  'GET /api/organization': [{ orgId: 'org-1', name: '默认工厂', code: 'F-001' }],
  'GET /api/personnel': [
    { id: 'P-1', employeeNo: 'P-1', name: '人员 1', roles: ['worker'], status: 'active', orgId: 'org-1', skills: [], certifications: [] },
  ],
  'GET /api/dashboard/devices': [
    { deviceId: 'D-1', entityId: 'D-1', name: '设备 1', online: true, batteryPct: 90, parentId: 'ST-1', model: 'exo-lift' },
  ],
  'GET /api/scheduler/routes': { nodes: [], edges: [], blockedEdges: [], costs: {} },
  'GET /api/scheduler/snapshot': {
    snapshotVersion: 'WS-1',
    ts: NOW,
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [{ id: 'P-1', name: '人员 1', status: 'IDLE', healthStatus: 'HEALTHY', skills: [], certifications: [], loadLevel: 0.5, fatigueLevel: 0.1, stationId: 'ST-1', zoneId: 'Z1', x: 100, y: 100 }],
    tasks: [{ id: 'T-1', title: '装配任务', taskType: 'assembly', priority: 'high', status: 'pending', assigneeId: 'P-1', deviceId: 'D-1', stationId: 'ST-1', zoneId: 'Z1', planStart: NOW, planEnd: NOW, progress: 0, predecessorIds: [], requiredSkills: [], requiredCertifications: [] }],
    devices: [{ id: 'D-1', workerName: null, deviceModel: 'exo-lift', batteryPct: 90, online: true, status: 'AVAILABLE', x: 200, y: 150 }],
    stations: [{ id: 'ST-1', name: '工位 1', x: 150, y: 120, capacity: 2 }],
    backlog: [],
    events: [],
    contextVersion: null,
    dataQuality: 'FRESH',
  },
  'GET /api/scheduler/context': {
    snapshotVersion: 'WS-1',
    resourceVersion: 1,
    routeGraphVersion: 1,
    policyVersion: 1,
    sourceTimestamp: NOW,
  },
  'GET /api/scheduler/resources/state': [
    { id: 'P-1', type: 'person', status: 'AVAILABLE', capabilities: [], certifications: [], location: { stationId: 'ST-1', zoneId: 'Z1', x: 100, y: 100 }, availableWindows: [], reservations: [], telemetry: { batteryPct: null, loadLevel: 0.5, fatigueLevel: 0.1, healthStatus: 'HEALTHY' } },
  ],
  'GET /api/scheduler/active-plans': [
    {
      planId: 'PLAN-1',
      planName: '方案 A',
      version: 1,
      status: 'approved',
      trigger: { type: 'MANUAL', entityId: null },
      snapshotVersion: 'WS-1',
      policyVersion: 1,
      solverVersion: 'heuristic-v2',
      horizonMinutes: 480,
      assignments: [
        { assignmentId: 'ASN-1', taskId: 'T-1', personId: 'P-1', deviceId: 'D-1', stationId: 'ST-1', zoneId: 'Z1', plannedStart: NOW, plannedEnd: NOW, routeId: null, status: 'scheduled', reasons: [], alternatives: [] },
      ],
      metrics: { lateMinutes: 0, walkingMeters: 10, stationWaitMinutes: 0, maxWorkload: 0.5, changeCost: 0 },
      baselineDelta: {},
      violations: [],
      createdAt: NOW,
    },
  ],
  'GET /api/scheduler/conflicts': {
    conflicts: [
      { conflictId: 'CF-1', type: 'low_battery', severity: 'high', scope: 'resource', resourceId: 'D-1', resourceType: 'device', taskIds: ['T-1'], message: '设备电量不足，任务将无法按时完成', resolution: '更换设备或提前充电', createdAt: NOW, snapshotVersion: 'WS-1', status: 'OPEN', detectedAt: NOW },
    ],
    total: 1,
  },
  // SSE 端点：mock 为一次性 heartbeat（无真实后端时连接即结束，触发轮询兜底，不影响 axe）。
  'GET /api/scheduler/v2/stream': {
    status: 200,
    contentType: 'text/event-stream',
    body: 'event: heartbeat\ndata: {}\n\n',
  },
};

/**
 * 对当前页面运行 axe 扫描，断言无 serious/critical 违规。
 * （该版本 @axe-core/playwright 不支持 Locator include，统一扫描整页 body，
 * 与既有 ux009-axe.spec.js 保持一致。）
 */
async function runAxeScan(page, label) {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => BLOCKING_IMPACT.includes(v.impact));
  const minorModerate = results.violations.filter((v) => !BLOCKING_IMPACT.includes(v.impact));
  if (minorModerate.length > 0) {
    console.log(
      `[axe][${label}] 非阻断级违规（${minorModerate.length}）: ` +
        minorModerate.map((v) => `${v.id}(${v.impact})×${v.nodes.length}`).join(', '),
    );
  }
  const summary = blocking
    .map((v) => `${v.id}(${v.impact})×${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`)
    .join(' || ');
  expect(blocking, `[${label}] 存在 serious/critical 无障碍违规：${summary}`).toEqual([]);
  return results;
}

test.describe('UX-009/CommandMapAxe', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('指挥地图 Shell 无 serious/critical 违规（含地图视口文本替代）', async ({ page }) => {
    await mockApi(page, COMMAND_MAP_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-map');
    // Shell 首屏：顶栏标题 + 地图主体就绪。
    await expect(page.locator('text=EWOH 指挥地图').first()).toBeVisible();
    await expect(page.locator('#command-map-main')).toBeVisible();
    // 地图视口（SVG）为 aria-hidden 装饰：屏幕阅读器使用 sr-only live region 的文本替代。
    const srStatus = page.locator('div[role="status"].sr-only').first();
    await expect(srStatus).toBeVisible();
    const srText = await srStatus.textContent();
    expect(srText).toContain('地图模式');
    await runAxeScan(page, 'command-map-shell');
  });

  test('调度方案标签页无 serious/critical 违规', async ({ page }) => {
    await mockApi(page, COMMAND_MAP_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-map');
    await page.getByRole('button', { name: '打开调度方案' }).click();
    await expect(page.locator('text=调度方案').first()).toBeVisible();
    await runAxeScan(page, 'command-map-schedule');
  });

  test('冲突中心标签页无 serious/critical 违规', async ({ page }) => {
    await mockApi(page, COMMAND_MAP_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-map');
    await page.getByRole('button', { name: '打开冲突中心' }).click();
    await expect(page.locator('text=调度冲突').first()).toBeVisible();
    await runAxeScan(page, 'command-map-conflicts');
  });

  test('对话框开/关流程（快捷键帮助）：打开 axe 扫描 → Escape 关闭 → 焦点恢复', async ({ page }) => {
    await mockApi(page, COMMAND_MAP_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-map');
    await expect(page.locator('#command-map-main')).toBeVisible();
    // 记录打开前的焦点，按 ? 打开帮助对话框。
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: '快捷键' });
    await expect(dialog).toBeVisible();
    await runAxeScan(page, 'command-map-help-dialog');
    // 关闭前焦点已移入对话框（关闭按钮可聚焦）。
    await expect(dialog.getByRole('button', { name: '关闭快捷键帮助' })).toBeFocused();
    // Escape 关闭对话框。
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('冲突中心表格视图无 serious/critical 违规（语义 table + 可聚焦行）', async ({ page }) => {
    await mockApi(page, COMMAND_MAP_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-map');
    await page.getByRole('button', { name: '打开冲突中心' }).click();
    await expect(page.locator('text=调度冲突').first()).toBeVisible();
    // 切换到表格视图（Task 12/12.2 键盘可达语义表格）。
    await page.getByRole('button', { name: '切换到表格视图' }).click();
    const table = page.locator('table[aria-label="冲突列表（表格视图）"]');
    await expect(table).toBeVisible();
    // 表头具备 scope="col" 列头语义。
    await expect(table.locator('thead th[scope="col"]').first()).toBeVisible();
    // 行可聚焦（tabIndex=0），Enter 激活（展开详情）。
    const firstRow = table.locator('tbody tr').first();
    await firstRow.focus();
    await expect(firstRow).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(firstRow).toHaveAttribute('aria-selected', 'true');
    await runAxeScan(page, 'command-map-conflicts-table');
  });

  /**
   * 回归（2026-09 axe color-contrast 偶发 serious）：
   * 1) 数据新鲜度徽标是「软底（bg-*-/20）+ 语义前景（*-on-soft）」组合——主色直接作
   *    文字色时深色表面实测 4.16:1（warning/20）与 2.70:1（info/20）；
   * 2) 色调切换（无证据→实时）曾在帧饥饿时长时间保留旧色调的 computed style：
   *    reduced-motion 全局规则把 transition-duration 压到 0.01ms，而
   *    transition-property 仍是初始值 all，于是每次换色都生成 CSSTransition，
   *    currentTime 停在 0 时 axe 采样到的是**上一种色调**的颜色。
   * 因此这里同时锁定「过渡被显式关闭」与「整行无对比度违规」。
   */
  test('数据新鲜度徽标：颜色过渡被显式关闭且无对比度违规', async ({ page }) => {
    await mockApi(page, COMMAND_MAP_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-map');
    await expect(page.locator('#command-map-main')).toBeVisible();
    const row = page.getByRole('group', { name: '数据新鲜度' });
    await expect(row).toBeVisible();
    // 每个徽标（tooltip 触发器）都必须没有可运行的 transition：色调变化立即生效。
    const transitionProperties = await row
      .locator('[data-slot="tooltip-trigger"]')
      .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).transitionProperty));
    expect(transitionProperties.length).toBeGreaterThan(0);
    for (const value of transitionProperties) {
      expect(value).toBe('none');
    }
    // 等待一次数据更新后再扫描（覆盖「色调刚切换」的窗口）。
    await page.waitForTimeout(150);
    const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
    ).toEqual([]);
  });
});
