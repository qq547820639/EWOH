/* 设备台账（/devices）浏览器验收 —— 感知层入台账后的可信度行为。
 *
 * 覆盖：
 *  1. 外骨骼与感知层设备在同一台账里**类别可辨**（环境传感器/摄像头/定位标签）；
 *  2. **无电池设备显示"不适用"**，不渲染低电量红条、不显示 0%（把"没有电量概念"
 *     伪装成告警是不诚实的）；
 *  3. 未知/历史类别显示"未知类别"，绝不猜一个相近类别；
 *  4. 类别过滤真的驱动服务端查询（category 参数到达后端），而不是只在前端过滤；
 *  5. 基础无障碍不回归。
 *
 * 使用 mock 数据层（无需真实后端/数据库）；真实后端版本由
 * `test/e2e/edge-multisource-uplink.mjs` 的 /api/devices 断言覆盖。
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

const NOW = '2026-09-10T12:00:00.000Z';

const DEVICES = [
  {
    id: 'd-1', deviceId: 'EXO-1', workerName: '张三', deviceModel: 'NyExo-A1',
    deviceCategory: 'exoskeleton', batteryPct: 88, online: true, lastTelemetryAt: NOW,
    sourceType: 'simulated',
  },
  {
    id: 'd-2', deviceId: 'ENV-1', workerName: '', deviceModel: '',
    deviceCategory: 'environment_sensor', batteryPct: null, online: true, lastTelemetryAt: NOW,
    sourceType: 'simulated',
  },
  {
    id: 'd-3', deviceId: 'CAM-1', workerName: '', deviceModel: '',
    deviceCategory: 'camera', batteryPct: null, online: true, lastTelemetryAt: NOW,
    sourceType: 'simulated',
  },
  {
    id: 'd-4', deviceId: 'LEGACY-1', workerName: '', deviceModel: '',
    deviceCategory: null, batteryPct: 90, online: false, lastTelemetryAt: null,
    sourceType: 'real',
  },
];

/**
 * NO-50a：责任人 mock 数据。
 * EXO-1 有两位责任人（owner=P-1 / maintainer=P-2）；其余设备没有责任关系
 * （页面必须显示"未登记责任人"，而不是留白）。
 */
const RESPONSIBILITIES = [
  {
    deviceId: 'EXO-1', personId: 'person:P-1', responsibility: 'owner', active: true, shiftId: '',
    note: null, activatedAt: NOW, deactivatedAt: null,
  },
  {
    // NO-51a：这条是**夜班**责任人（页面必须显示班次，现场要知道这人是哪个班的）
    deviceId: 'EXO-1', personId: 'person:P-2', responsibility: 'maintainer', active: true,
    shiftId: 'SHIFT-NIGHT', note: '夜班维护', activatedAt: NOW, deactivatedAt: null,
  },
];

const SHIFTS = [
  { shiftId: 'SHIFT-DAY', name: '白班', code: 'A', startTime: '08:00', endTime: '20:00', crossesMidnight: false, active: true },
  { shiftId: 'SHIFT-NIGHT', name: '夜班', code: 'B', startTime: '20:00', endTime: '08:00', crossesMidnight: true, active: true },
];

const PERSONNEL = [
  { personId: 'P-1', name: '张三' },
  { personId: 'P-2', name: '李四' },
  { personId: 'P-3', name: '王五' },
];

function baseMock(overrides = {}) {
  return {
    'GET /api/dashboard/devices': DEVICES,
    'GET /api/device-responsibilities': RESPONSIBILITIES,
    'GET /api/personnel': PERSONNEL,
    'GET /api/shifts': SHIFTS,
    'GET /api/dashboard/overview': {
      deviceTotal: 4, deviceOnline: 3, eventOpen: 0, eventCritical: 0, avgLoad: 0.3, workerCount: 1,
    },
    'GET /api/dashboard/events': [],
    'GET /api/spatial/entities': [],
    // mock 必须与生产路由一致（详情在 /api/devices/:id，dashboard 无该路由）
    'GET /api/devices/ENV-1': {
      ...DEVICES[1],
      capabilities: [
        { name: 'observe.temperature', key: 'observe.temperature', kind: 'device_capability', providerType: 'device', mode: 'observation', capabilityId: 'cap:device:env-1:observe.temperature', label: '环境温度', status: 'active', fields: ['temperature'], grantedAt: NOW, registered: true },
        { name: 'observe.vibration', key: 'observe.vibration', kind: 'device_capability', providerType: 'device', mode: 'observation', capabilityId: 'cap:device:env-1:observe.vibration', label: '振动', status: 'retired', fields: [], grantedAt: NOW, registered: true },
        { name: 'observe.custom_flux', key: 'observe.custom_flux', kind: 'device_capability', providerType: 'device', mode: 'observation', capabilityId: 'cap:device:env-1:observe.custom_flux', label: 'observe.custom_flux', status: 'active', fields: [], grantedAt: NOW, registered: false },
      ],
    },
    'GET /api/dashboard/devices/ENV-1/bindings': {
      deviceId: 'ENV-1', spatialEntityId: null, boundPersonId: null, hierarchyPath: [],
    },
    ...overrides,
  };
}

async function openDevices(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.device_ops, '/devices');
  await expect(page.getByRole('heading', { name: '设备态势总览' })).toBeVisible();
}

test.describe('设备台账 感知层入台账', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('外骨骼与感知层设备同表可辨（类别标签逐行显示）', async ({ page }) => {
    await openDevices(page, server.baseUrl, baseMock());

    await expect(page.getByTestId('device-category-EXO-1')).toHaveText('外骨骼');
    await expect(page.getByTestId('device-category-ENV-1')).toHaveText('环境传感器');
    await expect(page.getByTestId('device-category-CAM-1')).toHaveText('摄像头');
    // 历史行类别为 NULL → 显式"未知类别"，不落回"外骨骼"也不留空白
    await expect(page.getByTestId('device-category-LEGACY-1')).toHaveText('未知类别');
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('无电池设备显示"不适用"，不显示 0% 也不给低电量红条', async ({ page }) => {
    await openDevices(page, server.baseUrl, baseMock());

    // 页面同时渲染"电量分布"图表的文本替代表，用类别单元格精确定位主表行
    const envRow = page.locator('tr').filter({ has: page.getByTestId('device-category-ENV-1') });
    await expect(envRow).toContainText('不适用');
    await expect(envRow).not.toContainText('0%');
    // 有电池的外骨骼仍显示百分比（回归：不能把真实读数一起藏掉）
    const exoRow = page.locator('tr').filter({ has: page.getByTestId('device-category-EXO-1') });
    await expect(exoRow).toContainText('88%');
  });

  test('类别过滤驱动服务端查询（category 参数到达后端）', async ({ page }) => {
    const requests = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/dashboard/devices')) requests.push(url);
    });
    await openDevices(page, server.baseUrl, baseMock());

    await page.getByLabel('按设备类别过滤').click();
    await page.getByRole('option', { name: '环境传感器' }).click();

    await expect
      .poll(() => requests.some((url) => url.includes('category=environment_sensor')))
      .toBe(true);
  });

  test('设备能力：词表内/停用/词表外都在抽屉里如实展示（不隐藏、不猜）', async ({ page }) => {
    await openDevices(page, server.baseUrl, baseMock());
    // 打开第一台环境传感器的编辑抽屉（能力清单只在详情/编辑里取）
    await page
      .locator('tr')
      .filter({ has: page.getByTestId('device-category-ENV-1') })
      .getByRole('button', { name: '编辑' })
      .click();
    // 能力与空间状态在抽屉第 2 步（绑定关系）；先切页签再断言
    await page.getByRole('tab', { name: /绑定关系/ }).click();

    const list = page.getByTestId('device-capabilities');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('device-capability-observe.temperature')).toContainText('环境温度');
    // 停用能力不隐藏，状态显式标出
    await expect(page.getByTestId('device-capability-observe.vibration')).toContainText('retired');
    // 词表外能力原样展示 key 并标注未登记
    await expect(page.getByTestId('device-capability-observe.custom_flux')).toContainText('未登记能力名');
    // 权威 kind/mode 徽标（ADR-043）：设备能力 + 观测
    await expect(page.getByTestId('device-capability-observe.temperature')).toContainText('设备能力');
    await expect(page.getByTestId('device-capability-observe.temperature')).toContainText('观测');
    // 未绑定空间实体 → 明确"位置未登记"，不留白
    await expect(page.getByTestId('device-location-unregistered')).toContainText('位置未登记');
  });

  /* 人工能力生命周期（NO-15a）：能力决定派工资格，误声明必须能在界面上处置。
   * 断言链路：理由必填（空理由不可提交）→ 请求体带 status+reason →
   * 刷新后状态与"谁/何时/为什么"可见；且**自动声明不冒充人工确认**（无留痕=不显示）。 */
  test('设备能力停用：理由必填 → 变更生效 → 状态与人工留痕可见', async ({ page }) => {
    let capabilityStatus = 'active';
    let lifecycle = null;
    const posts = [];

    await openDevices(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/devices/ENV-1': () => ({
          ...DEVICES[1],
          capabilities: [
            {
              name: 'observe.temperature',
              key: 'observe.temperature',
              kind: 'device_capability',
              providerType: 'device',
              mode: 'observation',
              capabilityId: 'cap:device:ENV-1:observe.temperature',
              label: '环境温度',
              status: capabilityStatus,
              fields: ['temperature'],
              grantedAt: NOW,
              registered: true,
              lifecycle,
            },
          ],
        }),
        'POST /api/devices/ENV-1/capabilities/observe.temperature/status': ({ body }) => {
          posts.push(body);
          capabilityStatus = body.status;
          lifecycle = {
            action: body.status === 'disabled' ? 'disable' : 'restore',
            operator: 'device.ops',
            reason: body.reason,
            at: NOW,
            previousStatus: body.status === 'disabled' ? 'active' : 'disabled',
          };
          return {
            deviceId: 'ENV-1',
            capabilityId: 'cap:device:ENV-1:observe.temperature',
            capabilityName: 'observe.temperature',
            status: body.status,
            previousStatus: body.status === 'disabled' ? 'active' : 'disabled',
            changed: true,
            effectiveFrom: NOW,
            effectiveTo: body.status === 'disabled' ? NOW : null,
            updatedAt: NOW,
            contractValid: true,
            repairedFields: [],
          };
        },
      }),
    );

    await page
      .locator('tr')
      .filter({ has: page.getByTestId('device-category-ENV-1') })
      .getByRole('button', { name: '编辑' })
      .click();
    await page.getByRole('tab', { name: /绑定关系/ }).click();

    // 生效中的能力：状态标签 + "停用"入口
    await expect(page.getByTestId('device-capability-status-observe.temperature')).toHaveText('生效中');
    await page.getByTestId('device-capability-action-observe.temperature').click();

    const dialog = page.getByTestId('capability-status-dialog');
    await expect(dialog).toBeVisible();
    // 理由必填：空理由时确认按钮不可用（不产生"点了没反应"的假执行）
    const confirm = page.getByTestId('capability-status-confirm');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/变更理由/).fill('现场核对：该设备实际未安装温度传感器');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // 请求体带上状态与理由（理由不是前端摆设）
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ status: 'disabled', reason: '现场核对：该设备实际未安装温度传感器' });

    // 刷新后：状态变为已停用，且人工留痕可追溯
    await expect(page.getByTestId('device-capability-status-observe.temperature')).toHaveText('已停用');
    await expect(page.getByTestId('device-capability-lifecycle-observe.temperature')).toContainText(
      '该设备实际未安装温度传感器',
    );
    // 已停用 → 入口变为"恢复"
    await expect(page.getByTestId('device-capability-action-observe.temperature')).toHaveText('恢复');
  });

  /* NO-21b：高风险能力"恢复"= 设备重新具备高风险作业资格（执行边界变更）。
   * 现场只能**发起**审批，不能单方面放行；界面必须提前说明、并让审批号真的进入请求体。 */
  test('高风险能力恢复：提前告知需安全审批 → 发起审批 → 获批后带号恢复', async ({ page }) => {
    const approvalPosts = [];
    const restorePosts = [];
    let capabilityStatus = 'disabled';
    let approved = false;

    await openDevices(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/devices/ENV-1': () => ({
          ...DEVICES[1],
          capabilities: [
            {
              name: 'exo-lift',
              key: 'exo-lift',
              kind: 'device_capability',
              providerType: 'device',
              mode: 'execution',
              capabilityId: 'cap:device:ENV-1:exo-lift',
              label: '助力提升',
              status: capabilityStatus,
              fields: [],
              grantedAt: NOW,
              registered: true,
              lifecycle: {
                action: 'disable',
                operator: 'admin',
                reason: '助力模块待检修',
                at: NOW,
                previousStatus: 'active',
              },
            },
          ],
        }),
        'POST /api/approvals': ({ body }) => {
          approvalPosts.push(body);
          return {
            id: 'AP-HR-1',
            status: 'pending',
            steps: [{ id: 's1', role: 'safety_admin', status: 'pending' }],
            entityType: body.entityType,
            entityId: body.entityId,
          };
        },
        'GET /api/approvals/AP-HR-1': () => ({
          id: 'AP-HR-1',
          entityType: 'device_capability_change',
          entityId: 'capability:exo-lift',
          status: approved ? 'approved' : 'pending',
          // NO-22a：通过时间决定"还能不能用"（前端据此显示剩余有效期）
          ...(approved ? { approvedAt: new Date().toISOString() } : {}),
          steps: [{ id: 's1', role: 'safety_admin', status: approved ? 'approved' : 'pending' }],
        }),
        'POST /api/devices/ENV-1/capabilities/exo-lift/status': ({ body }) => {
          restorePosts.push(body);
          if (!body.approvalId) {
            // 与真实后端同码：无审批号一律拒绝（不静默放行）
            return {
              status: 409,
              body: {
                message:
                  'HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL：恢复高风险能力（exo-lift）需安全管理员审批',
              },
            };
          }
          capabilityStatus = body.status;
          return {
            deviceId: 'ENV-1',
            capabilityId: 'cap:device:ENV-1:exo-lift',
            capabilityName: 'exo-lift',
            status: body.status,
            previousStatus: 'disabled',
            changed: true,
            effectiveFrom: NOW,
            effectiveTo: null,
            updatedAt: NOW,
            contractValid: true,
            repairedFields: [],
            approvalId: body.approvalId,
          };
        },
      }),
    );

    await page
      .locator('tr')
      .filter({ has: page.getByTestId('device-category-ENV-1') })
      .getByRole('button', { name: '编辑' })
      .click();
    await page.getByRole('tab', { name: /绑定关系/ }).click();
    await page.getByTestId('device-capability-action-exo-lift').click();

    const dialog = page.getByTestId('capability-status-dialog');
    await expect(dialog).toBeVisible();

    // 1) 提前告知：不是等用户点了才被后端拒绝
    await expect(page.getByTestId('capability-restore-approval-hint')).toContainText(
      'HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL',
    );

    const confirm = page.getByTestId('capability-status-confirm');
    await dialog.getByLabel(/变更理由/).fill('助力模块已检修完成，申请恢复投运');
    // 2) 有理由但无审批号 → 仍然不可提交（现场不能自己放行）
    await expect(confirm).toBeDisabled();

    // 3) 发起安全审批：请求指向 device_capability_change，一次覆盖本台设备
    await page.getByTestId('capability-restore-request-approval').click();
    await expect.poll(() => approvalPosts.length).toBe(1);
    expect(approvalPosts[0].entityType).toBe('device_capability_change');
    expect(approvalPosts[0].entityId).toBe('capability:exo-lift');
    expect(approvalPosts[0].roles).toEqual(['safety_admin']);
    expect(approvalPosts[0].subject.metrics).toEqual({ capabilityKey: 'exo-lift', deviceIds: 'ENV-1' });
    await expect(page.getByTestId('capability-restore-approval-status')).toContainText('等待：安全管理员');

    // 4) 未获批就确认 → 页面此时仍禁用（状态未通过）
    await expect(confirm).toBeDisabled();

    // 5) 安全管理员批准后刷新状态 → 可提交，且审批号进入请求体
    approved = true;
    await page.getByTestId('capability-restore-check-approval').click();
    await expect(page.getByTestId('capability-restore-approval-status')).toContainText('审批已通过');
    // NO-22a：时效必须可见（"还有多久能用"决定现场是否需要重新申请）
    await expect(page.getByTestId('capability-restore-approval-freshness')).toContainText('剩余有效期约 24 小时');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(() => restorePosts.length).toBe(1);
    expect(restorePosts[0]).toEqual({
      status: 'active',
      reason: '助力模块已检修完成，申请恢复投运',
      approvalId: 'AP-HR-1',
    });
    await expect(page.getByTestId('device-capability-status-exo-lift')).toHaveText('生效中');
  });

  /* NO-23a：批量恢复能力——同一批设备检修完统一放行。
   * 断言链路：世界模型快照聚合被停用的能力 → 默认全选 → 一次审批覆盖选中名单
   * （deviceIds 指纹排序）→ 逐台带号恢复 → 结果区分全部成功/部分成功（含失败原因）。 */
  test('批量恢复：快照聚合停用能力 → 一张审批覆盖多台 → 逐台落地并如实报告部分成功', async ({ page }) => {
    const approvalPosts = [];
    const restorePosts = [];
    let approved = false;

    const snapshot = {
      snapshotVersion: 'WS-BATCH',
      ts: NOW,
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [],
      tasks: [],
      stations: [],
      backlog: [],
      events: [],
      contextVersion: null,
      dataQuality: 'FRESH',
      devices: [
        {
          id: 'u-1',
          deviceId: 'EXO-1',
          name: 'EXO-1',
          workerName: '张三',
          deviceModel: 'NyExo-A1',
          batteryPct: 88,
          online: true,
          status: 'AVAILABLE',
          x: null,
          y: null,
          dataQuality: 'FRESH',
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [
            { name: 'exo-lift', operator: 'admin', reason: '助力模块待检修', at: NOW },
          ],
        },
        {
          id: 'u-2',
          deviceId: 'EXO-2',
          name: 'EXO-2',
          workerName: '李四',
          deviceModel: 'NyExo-A1',
          batteryPct: 70,
          online: true,
          status: 'AVAILABLE',
          x: null,
          y: null,
          dataQuality: 'FRESH',
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [
            { name: 'exo-lift', operator: 'worker.li', reason: '电池鼓包', at: NOW },
          ],
        },
        {
          id: 'u-3',
          deviceId: 'ENV-1',
          name: 'ENV-1',
          workerName: null,
          deviceModel: '',
          batteryPct: null,
          online: true,
          status: 'AVAILABLE',
          x: null,
          y: null,
          dataQuality: 'FRESH',
          disabledCapabilities: ['observe.temperature'],
          disabledCapabilityLifecycle: [
            { name: 'observe.temperature', operator: 'admin', reason: '传感器待更换', at: NOW },
          ],
        },
      ],
    };

    await openDevices(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/scheduler/snapshot': snapshot,
        'POST /api/approvals': ({ body }) => {
          approvalPosts.push(body);
          return {
            id: 'AP-BATCH-1',
            status: 'pending',
            steps: [{ id: 's1', role: 'safety_admin', status: 'pending' }],
            entityType: body.entityType,
            entityId: body.entityId,
          };
        },
        'GET /api/approvals/AP-BATCH-1': () => ({
          id: 'AP-BATCH-1',
          status: approved ? 'approved' : 'pending',
          ...(approved ? { approvedAt: new Date().toISOString() } : {}),
          // 真实后端会返回对象描述符快照（含指纹）——批量恢复据此核对覆盖名单
          subject: {
            objectType: 'device_capability_change',
            objectId: 'capability:exo-lift',
            title: '恢复高风险能力：exo-lift（2 台设备）',
            summary: 'e2e：批量恢复',
            metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' },
          },
          steps: [{ id: 's1', role: 'safety_admin', status: approved ? 'approved' : 'pending' }],
        }),
        'POST /api/devices/EXO-1/capabilities/exo-lift/status': ({ body }) => {
          restorePosts.push({ deviceId: 'EXO-1', ...body });
          return {
            deviceId: 'EXO-1',
            capabilityName: 'exo-lift',
            status: 'active',
            changed: true,
            approvalId: body.approvalId,
          };
        },
        'POST /api/devices/EXO-2/capabilities/exo-lift/status': ({ body }) => {
          restorePosts.push({ deviceId: 'EXO-2', ...body });
          // 模拟"另一台还没修好"：服务端拒绝 → 界面必须如实报告部分成功
          return {
            status: 409,
            body: { message: '设备能力状态变更未生效（并发冲突），请重试并复核当前状态' },
          };
        },
      }),
    );

    await page.getByTestId('device-batch-restore-open').click();
    const dialog = page.getByTestId('batch-restore-dialog');
    await expect(dialog).toBeVisible();

    // 1) 快照聚合：高风险（exo-lift）排在低风险（observe.temperature）之前
    await expect(page.getByTestId('batch-restore-group-exo-lift')).toContainText('2 台');
    await expect(page.getByTestId('batch-restore-group-exo-lift')).toContainText('需安全审批');
    await expect(page.getByTestId('batch-restore-group-observe.temperature')).toContainText('1 台');

    // 2) 默认全选 + 停用留痕可见（谁/何时/为什么）
    await expect(page.getByTestId('batch-restore-device-EXO-1')).toBeChecked();
    await expect(page.getByTestId('batch-restore-device-EXO-2')).toBeChecked();
    await expect(dialog).toContainText('助力模块待检修');

    // 3) 取消全部勾选 → 不得悄悄回退成"全选"（明确说本次不会恢复任何设备）
    await page.getByTestId('batch-restore-device-EXO-1').click();
    await page.getByTestId('batch-restore-device-EXO-2').click();
    await expect(page.getByTestId('batch-restore-no-selection')).toContainText('不会恢复任何设备');
    await page.getByTestId('batch-restore-select-all').click();
    await expect(page.getByTestId('batch-restore-device-EXO-1')).toBeChecked();
    await expect(page.getByTestId('batch-restore-device-EXO-2')).toBeChecked();

    // 3c) 未填理由 → 不能进入下一步（理由要进审批单与台账）
    await expect(page.getByTestId('batch-restore-next')).toBeDisabled();
    await page.getByTestId('batch-restore-reason').fill('本批助力模块已检修并复检合格');
    await page.getByTestId('batch-restore-next').click();


    // 4) 未获批 → 执行按钮禁用（前端不代替后端放行）
    await expect(page.getByTestId('batch-restore-execute')).toBeDisabled();
    await page.getByTestId('batch-restore-request-approval').click();
    await expect.poll(() => approvalPosts.length).toBe(1);
    expect(approvalPosts[0].entityType).toBe('device_capability_change');
    expect(approvalPosts[0].entityId).toBe('capability:exo-lift');
    expect(approvalPosts[0].subject.metrics).toEqual({ capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' });

    // 5) 安全管理员批准后刷新 → 可执行；但选择变了就必须拦下（批 A 恢复 B 会逐台失败）
    approved = true;
    await page.getByTestId('batch-restore-check-approval').click();
    await expect(page.getByTestId('batch-restore-approval-status')).toContainText('approved');
    await expect(page.getByTestId('batch-restore-execute')).toBeEnabled();
    await page.getByRole('button', { name: '返回选择' }).click();
    await page.getByTestId('batch-restore-device-EXO-2').click();
    await expect(page.getByTestId('batch-restore-next')).toBeEnabled();
    await page.getByTestId('batch-restore-next').click();
    await expect(page.getByTestId('batch-restore-scope-warning')).toContainText('审批覆盖的设备名单');
    await expect(page.getByTestId('batch-restore-execute')).toBeDisabled();
    await page.getByRole('button', { name: '返回选择' }).click();
    await page.getByTestId('batch-restore-select-all').click();
    await page.getByTestId('batch-restore-next').click();
    await expect(page.getByTestId('batch-restore-execute')).toBeEnabled();
    await page.getByTestId('batch-restore-execute').click();

    await expect.poll(() => restorePosts.length).toBe(2);
    expect(restorePosts.map((p) => p.deviceId).sort()).toEqual(['EXO-1', 'EXO-2']);
    expect(restorePosts.every((p) => p.approvalId === 'AP-BATCH-1')).toBe(true);
    expect(restorePosts.every((p) => p.status === 'active')).toBe(true);

    // 6) 部分成功必须明说，并给出失败原因（不把 1 台失败说成"完成"）
    await expect(page.getByTestId('batch-restore-summary')).toContainText('部分成功：成功 1 台 / 失败 1 台');
    await expect(page.getByTestId('batch-restore-result-EXO-1')).toContainText('已恢复');
    await expect(page.getByTestId('batch-restore-result-EXO-2')).toContainText('失败');
    await expect(page.getByTestId('batch-restore-result-EXO-2')).toContainText('并发冲突');
    // 失败项可直接重试（未消耗审批额度）
    await expect(page.getByTestId('batch-restore-retry-failed')).toBeVisible();
  });

  /* ── NO-50a：设备责任人（安灯提醒"点名到人"的依据）──────────────────── */
  test('责任人列：已登记显示"姓名（职责）等 N 项"，未登记显式写"只能发到角色"', async ({ page }) => {
    await openDevices(page, server.baseUrl, baseMock());

    const exoRow = page.getByTestId('device-responsibility-EXO-1');
    await expect(exoRow).toContainText('等 2 项');
    await expect(exoRow).toContainText('设备责任人');
    await expect(exoRow).toContainText('张三');

    // 未登记：明说"未登记责任人（提醒只能发到角色）"，绝不留白
    const camRow = page.getByTestId('device-responsibility-CAM-1');
    await expect(camRow).toContainText('未登记责任人');
    await expect(camRow).toContainText('只能发到角色');

    // 顶部汇总：3 台设备没有责任关系
    await expect(page.getByTestId('device-responsibility-summary')).toContainText('未登记责任人的设备 3 台');
  });

  test('责任人面板：三职责固定展示（空位保留）、设置提交职责与人员、只对已登记职责给"收回"', async ({ page }) => {
    const writes = [];
    await openDevices(
      page,
      server.baseUrl,
      baseMock({
        'POST /api/devices/EXO-1/responsibilities': ({ body }) => {
          writes.push(body);
          return {
            deviceId: 'EXO-1', personId: body.personId, responsibility: body.responsibility,
            active: true, note: body.note ?? null, activatedAt: NOW, deactivatedAt: null,
          };
        },
        'DELETE /api/devices/EXO-1/responsibilities/owner': () => ({ cleared: true }),
      }),
    );

    await page.getByTestId('device-responsibility-set-EXO-1').click();
    const dialog = page.getByTestId('responsibility-dialog');
    await expect(dialog).toBeVisible();

    await expect(page.getByTestId('responsibility-slot-owner')).toContainText('张三');
    await expect(page.getByTestId('responsibility-slot-operator')).toContainText('未登记（提醒发不到人）');
    await expect(page.getByTestId('responsibility-slot-maintainer')).toContainText('李四');

    // 班次维度：夜班责任人在面板里显示班次；可切换为"全天"
    await expect(page.getByTestId('responsibility-slot-maintainer')).toContainText('班次 SHIFT-NIGHT');
    await expect(page.getByTestId('responsibility-slot-owner')).toContainText('全天');

    await page.getByTestId('responsibility-kind').selectOption('operator');
    await page.getByTestId('responsibility-shift').selectOption('SHIFT-DAY');
    await page.getByTestId('responsibility-person').selectOption('P-3');
    await page.getByTestId('responsibility-note').fill('负责操作培训');
    await page.getByTestId('responsibility-submit').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      responsibility: 'operator',
      personId: 'P-3',
      shiftId: 'SHIFT-DAY',
      note: '负责操作培训',
    });

    // 只对已登记职责提供"收回"（空位没有可收回的东西）
    await expect(page.getByTestId('responsibility-clear-owner')).toBeVisible();
    await expect(page.getByTestId('responsibility-clear-operator')).toHaveCount(0);
    await page.getByTestId('responsibility-clear-owner').click();
    await expect(dialog).toBeVisible();
  });

  test('责任人读取失败 → 面板显式报错（不伪装成"未登记责任人"）', async ({ page }) => {
    await openDevices(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/device-responsibilities': { status: 500, body: { error: { message: 'boom' } } },
      }),
    );
    await page.getByTestId('device-responsibility-set-EXO-1').click();
    await expect(page.getByTestId('responsibility-error')).toBeVisible();
    await expect(page.getByTestId('responsibility-error')).toContainText('读取失败');
  });
});
