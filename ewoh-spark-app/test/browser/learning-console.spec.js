/* 学习控制台（/learning-console）浏览器验收。
 *
 * 只验证与"可信度 + 人审边界"直接相关的行为：
 *  1. 样本不足时说明**原因**，而不是只显示一个 0；
 *  2. 缺 outcome 标注的准确率显示"未标注"，绝不显示 0%；
 *  3. 批准/拒绝/回滚是人审写路径——非授权角色按钮禁用并说明；
 *  4. 终态提案不提供任何动作；
 *  5. 页面明确声明提案不会自动生效。
 *
 * 使用 mock 数据层（无需真实后端/数据库）。
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

const SAMPLES_NONE_TRAINABLE = {
  orgId: 'default-factory',
  sampleLimit: 2000,
  totalFeedbackRows: 7,
  flaggedEligible: 0,
  trainable: 0,
  minSamplesRequired: 5,
  fullyTrained: false,
  rejected: { not_real_source: 7 },
  rejectedLabels: { not_real_source: '非真实来源（人工上报或模拟回执）' },
  eligibilityPolicy: 'independent-device-receipt-required',
};

const SAMPLES_EVIDENCE_GAP = {
  ...SAMPLES_NONE_TRAINABLE,
  totalFeedbackRows: 9,
  flaggedEligible: 4,
  trainable: 0,
  rejected: { missing_independent_device_receipt: 4, not_real_source: 5 },
  rejectedLabels: {
    missing_independent_device_receipt: '缺少独立设备回执证据（人工上报不满足）',
    not_real_source: '非真实来源（人工上报或模拟回执）',
  },
};

const EVALUATION_NO_ACCURACY = {
  evalId: 'le:on_demand:2026-09-10T10:00:00.000Z',
  evaluationType: 'on_demand',
  modelAccuracy: null,
  metrics: { decisionAcceptanceRate: 0.5 },
};

const PROPOSAL_PENDING = {
  proposalId: 'LP-PENDING',
  kind: 'threshold_change',
  status: 'shadow_evaluated',
  change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.7, candidateValue: 0.8 },
  shadowEval: { accepted: true, reason: 'shadow window clean' },
  auditTrail: true,
};

const PROPOSAL_TERMINAL = {
  proposalId: 'LP-REJECTED',
  kind: 'threshold_change',
  status: 'rejected',
  change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.7, candidateValue: 0.6 },
  rejectedBy: 'u-lead',
  rejectedReason: '样本不足',
  auditTrail: true,
};

/** 阈值基线：无覆盖 → 引擎内置常量（来源必须如实标注）。 */
const THRESHOLDS_ENGINE_DEFAULT = {
  readAt: '2026-09-10T12:00:00.000Z',
  engineVersion: '1.0.0',
  entries: [{
    ruleId: 'rule:worker-overload',
    parameter: 'workloadThreshold',
    engineDefault: 0.8,
    effective: 0.8,
    source: 'engine_default',
    provenance: null,
    counts: { pending: 0, approved: 0, rejected: 0, rolledBack: 0 },
  }],
};

/** 阈值基线：已批准提案覆盖（含提案人/审批人/影子来源）。 */
const THRESHOLDS_APPROVED_OVERRIDE = {
  readAt: '2026-09-10T12:00:00.000Z',
  engineVersion: '1.0.0',
  entries: [{
    ruleId: 'rule:worker-overload',
    parameter: 'workloadThreshold',
    engineDefault: 0.8,
    effective: 0.75,
    source: 'approved_proposal',
    provenance: {
      proposalId: 'LP-ACTIVE',
      baselineValue: 0.8,
      candidateValue: 0.75,
      approvedBy: 'u-admin',
      approvedAt: '2026-09-01T02:00:00.000Z',
      proposedBy: 'u-worker',
      shadowFactsProvenance: { source: 'server:ewoh_telemetry' },
    },
    counts: { pending: 1, approved: 1, rejected: 0, rolledBack: 0 },
  }],
};

function baseMock(overrides = {}) {
  return {
    'GET /api/dashboard/overview': {
      deviceTotal: 1, deviceOnline: 1, eventOpen: 0, eventCritical: 0, avgLoad: 0.2, workerCount: 1,
    },
    'GET /api/dashboard/events': { items: [], total: 0 },
    'GET /api/scheduler/active-plans': [],
    'GET /api/exo/sessions': { sessions: [] },
    'GET /api/scheduler/predictions/task-duration/samples': SAMPLES_NONE_TRAINABLE,
    'GET /api/learning/proposals': [],
    'GET /api/learning/thresholds': THRESHOLDS_ENGINE_DEFAULT,
    'GET /api/learning/evaluations': [],
    'GET /api/learning/signals': [],
    'GET /api/learning/actions': [],
    ...overrides,
  };
}

async function openConsole(page, baseUrl, role, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, role, '/learning-console');
  await expect(page.getByRole('heading', { name: '学习控制台' })).toBeVisible();
}

test.describe('LearningConsole 学习控制台', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('无真实回执：说明"为什么不能训练"，而不是只显示 0', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock());

    await expect(page.getByTestId('trainable-count')).toHaveText('0');
    const verdict = page.getByTestId('eligibility-verdict');
    await expect(verdict).toContainText('独立设备回执');
    // 排除原因必须对人可见
    await expect(page.getByText('非真实来源（人工上报或模拟回执）：7 条')).toBeVisible();
    // 资格策略标识（只有独立设备回执可训练）
    await expect(page.getByText('independent-device-receipt-required')).toBeVisible();
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('行级标记通过但缺设备证据：显式区分并给出可执行结论', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/scheduler/predictions/task-duration/samples': SAMPLES_EVIDENCE_GAP,
    }));

    const verdict = page.getByTestId('eligibility-verdict');
    await expect(verdict).toContainText('有 4 条通过来源标记');
    await expect(verdict).toContainText('人工上报与模拟回执不计入');
    await expect(page.getByText('缺少独立设备回执证据（人工上报不满足）：4 条')).toBeVisible();
  });

  test('样本不足时重训被拒：翻译为可执行说明且强调未落版', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'POST /api/scheduler/predictions/task-duration/retrain': {
        status: 400,
        body: { error: { message: 'retrain_not_enough_data: no_finite_samples' } },
      },
    }));

    await page.getByRole('button', { name: '重训时长模型' }).click();
    const alert = page.getByRole('alert').filter({ hasText: '样本不足' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('未落版');
    await expect(alert).toContainText('no_finite_samples');
    // 失败时不得显示"已落版"成功块
    await expect(page.getByText('已落版', { exact: false })).toHaveCount(0);
  });

  test('缺 outcome 标注：准确率显示"未标注"而不是 0%', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/evaluations': [EVALUATION_NO_ACCURACY],
    }));

    const accuracy = page.getByTestId('model-accuracy');
    await expect(accuracy).toContainText('未标注');
    await expect(accuracy).not.toContainText('0.0%');
  });

  test('非人审角色：批准/拒绝被禁用并说明原因（服务端仍是权威）', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.device_ops, baseMock({
      'GET /api/learning/proposals': [PROPOSAL_PENDING],
    }));

    await expect(page.getByTestId('proposal-LP-PENDING')).toBeVisible();
    await expect(page.getByTestId('approval-blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: '批准生效' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '拒绝' })).toBeDisabled();
  });

  test('人审角色：可批准，且影子证据结论如实显示', async ({ page }) => {
    const calls = [];
    page.on('request', (req) => {
      if (req.url().includes('/approve')) calls.push(req.method());
    });
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/proposals': [PROPOSAL_PENDING],
      'POST /api/learning/proposals/LP-PENDING/approve': { ...PROPOSAL_PENDING, status: 'approved', approvedBy: 'u-lead' },
    }));

    await expect(page.getByTestId('proposal-shadow')).toContainText('影子评估接受');
    await expect(page.getByRole('button', { name: '批准生效' })).toBeEnabled();
    await page.getByRole('button', { name: '批准生效' }).click();
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe('POST');
  });

  test('终态提案不提供任何动作，但保留审计理由', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/proposals': [PROPOSAL_TERMINAL],
    }));

    const card = page.getByTestId('proposal-LP-REJECTED');
    await expect(card).toContainText('已拒绝');
    await expect(card).toContainText('样本不足');
    await expect(card).toContainText('无可用动作');
    await expect(page.getByRole('button', { name: '批准生效' })).toHaveCount(0);
  });

  test('影子评估缺事实窗口：翻译为业务状态说明，不是原始报错', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/proposals': [{
        proposalId: 'LP-PROPOSED', kind: 'rule_threshold', status: 'proposed',
        change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.7, candidateValue: 0.8 },
        auditTrail: true,
      }],
      'POST /api/learning/proposals/LP-PROPOSED/shadow': {
        status: 400,
        body: { error: { message: 'shadow_facts_window_empty：库内无可重建的事实窗口（R2-SBZ-004 fail-closed）' } },
      },
    }));

    await page.getByRole('button', { name: '运行影子评估' }).click();
    const alert = page.getByRole('alert').filter({ hasText: '可重建的事实窗口' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('客户端不能提供');
    // 状态未被伪造成"已评估"
    await expect(page.getByTestId('proposal-status')).toHaveText('待影子评估');
  });

  test('非法状态转移：说明状态机顺序（先影子评估再人审）', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/proposals': [{
        proposalId: 'LP-ILLEGAL', kind: 'rule_threshold', status: 'shadow_evaluated',
        change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.7, candidateValue: 0.8 },
        shadowEval: { accepted: true },
        auditTrail: true,
      }],
      'POST /api/learning/proposals/LP-ILLEGAL/approve': {
        status: 400,
        body: { error: { message: '非法提案转移：proposed → approved 不允许（ADR-026 状态机）' } },
      },
    }));

    await page.getByRole('button', { name: '批准生效' }).click();
    const alert = page.getByRole('alert').filter({ hasText: '状态机不允许' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('必须先完成影子评估');
  });

  test('明确声明提案不会自动生效（人审边界可见）', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock());
    await expect(page.getByText('学习边界')).toBeVisible();
    await expect(page.getByText('不会自动生效', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('独立设备回执', { exact: false }).first()).toBeVisible();
  });

  test('阈值基线：如实区分"引擎内置常量"与"已批准覆盖"，并声明未激活', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock());
    await expect(page.getByTestId('threshold-effective-workloadThreshold')).toContainText('0.8');
    const source = page.getByTestId('threshold-source-workloadThreshold');
    await expect(source).toContainText('引擎内置常量');
    await expect(source).toContainText('不是已生效策略');
    // 读取时间（新鲜度）必须可见
    await expect(page.getByText('读取时间', { exact: false })).toBeVisible();
  });

  test('阈值基线：有已批准覆盖时标注提案/提议人/审批人与在途计数', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/thresholds': THRESHOLDS_APPROVED_OVERRIDE,
    }));
    await expect(page.getByTestId('threshold-effective-workloadThreshold')).toContainText('0.75');
    const source = page.getByTestId('threshold-source-workloadThreshold');
    await expect(source).toContainText('LP-ACTIVE');
    await expect(source).toContainText('u-admin');
    await expect(source).toContainText('u-worker');
    await expect(page.getByText('在途 1 条（尚未生效）', { exact: false })).toBeVisible();
  });

  test('提出受控变更：基线值取服务端读面，结果如实说明不会自动生效', async ({ page }) => {
    const bodies = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/learning/proposals') && req.method() === 'POST') {
        bodies.push(req.postDataJSON());
      }
    });
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'POST /api/learning/proposals': {
        status: 201,
        body: {
          created: true,
          proposal: {
            proposalId: 'lp:new-1', kind: 'rule_threshold', status: 'shadow_evaluated',
            change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.8, candidateValue: 0.9 },
            proposedBy: 'u-lead', auditTrail: true,
          },
        },
      },
    }));

    await page.getByTestId('proposal-candidate').fill('0.9');
    await page.getByTestId('propose-submit').click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].change).toEqual({
      ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.8, candidateValue: 0.9,
    });
    // 客户端 facts 绝不上送（证据只能服务端重建）
    expect(bodies[0].facts).toBeUndefined();
    const result = page.getByTestId('propose-result');
    await expect(result).toContainText('提案已登记');
    await expect(result).toContainText('待人审');
    await expect(result).toContainText('不会自动生效');
    await expect(result).toContainText('不得审批自己的提案');
  });

  test('候选值与生效值相同：即时拒绝并禁用提交（no-op 提案不给服务端）', async ({ page }) => {
    const posts = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/learning/proposals') && req.method() === 'POST') posts.push(req.url());
    });
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock());
    await page.getByTestId('proposal-candidate').fill('0.8');
    await expect(page.getByTestId('candidate-error')).toContainText('no-op');
    await expect(page.getByTestId('propose-submit')).toBeDisabled();
    expect(posts).toEqual([]);
  });

  test('提议人自批回避：仅"批准"被拦下并说明需他人审批，拒绝（撤回）仍可用', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/proposals': [{ ...PROPOSAL_PENDING, proposedBy: ROLES.workshop_lead.userId }],
    }));

    await expect(page.getByTestId('self-approval-LP-PENDING')).toContainText('需他人审批');
    await expect(page.getByRole('button', { name: '批准生效' })).toBeDisabled();
    // 拒绝自己的提案 = 撤回，服务端允许，UI 不得凭空收紧。
    // （拒绝按钮本身要求填理由，故先填理由再断言它没有被治理规则拦下。）
    await page.getByLabel('理由（拒绝/回滚必填，写入审计）').fill('撤回提案');
    await expect(page.getByRole('button', { name: '拒绝' })).toBeEnabled();
  });

  test('自批被服务端拒绝：翻译为治理说明，而不是原始报文', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/proposals': [PROPOSAL_PENDING],
      'POST /api/learning/proposals/LP-PENDING/approve': {
        status: 403,
        body: { error: { message: 'SELF_APPROVAL_FORBIDDEN: proposal LP-PENDING was proposed by the requesting operator (B5 审批独立性)' } },
      },
    }));

    await page.getByRole('button', { name: '批准生效' }).click();
    const alert = page.getByRole('alert').filter({ hasText: '由你提出' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('策略未被改动');
    // 状态不得被伪造成"已批准生效"
    await expect(page.getByTestId('proposal-status')).toHaveText('已影子评估，待人审');
  });

  test('基线读取失败：明确"看不到基线不应凭猜提案"，且不提供提交入口', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/thresholds': { status: 500, body: { error: { message: 'db unavailable' } } },
    }));

    await expect(page.getByText('阈值基线获取失败', { exact: false })).toBeVisible();
    await expect(page.getByText('不应凭猜测提案')).toBeVisible();
    await expect(page.getByTestId('propose-submit')).toHaveCount(0);
  });
});

/* ── NO-54a：运行记忆信号卡片 ─────────────────────────────────────────── */

function signalFixture(overrides = {}) {
  return {
    signalId: 'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
    kind: 'notification_fatigue',
    severity: 'high',
    status: 'open',
    subjectKey: 'andon',
    windowDays: 30,
    sampleSize: 26,
    confidence: 'medium',
    metrics: {
      windowDays: 30,
      kind: 'andon',
      kindLabel: '安灯异常',
      pending: 20,
      resolved: 6,
      dispositionRate: 0.23,
      oldestPendingAgeHours: 26,
      comparable: 6,
    },
    narrative: {
      hypothesis: '安灯：20 条待处置、最老 26 小时没人了结 → 提醒疲劳',
      expectedEffect: '提高 workloadThreshold 可减少无人处理的提醒（方向：放宽）',
      risk: '放宽阈值会漏掉早期介入时机',
      missing: [],
    },
    evidenceRefs: [
      { type: 'notification_kind', id: 'andon', at: '2026-09-12T08:00:00.000Z' },
      { type: 'threshold_baseline', id: 'rule:worker-overload/workloadThreshold', at: null },
    ],
    actionable: {
      ruleId: 'rule:worker-overload',
      parameter: 'workloadThreshold',
      direction: 'raise',
      baselineValue: 0.8,
      baselineSource: 'engine_default',
    },
    notActionableReason: null,
    detectedAt: '2026-09-12T08:00:00.000Z',
    ...overrides,
  };
}

test.describe('LearningConsole 运行记忆信号（NO-54a）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('可执行信号：证据/快照/可信度/方向可见，且声明信号≠提案', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/signals': [signalFixture()],
    }));

    const card = page.getByTestId('learning-signals');
    await expect(card).toBeVisible();
    await expect(card).toContainText('安灯异常');
    await expect(card).toContainText('待处理 1');
    await expect(page.getByTestId('learning-signal-evidence')).toContainText('证据：2 条');
    await expect(page.getByTestId('learning-signal-metrics')).toContainText('待处置');
    await expect(page.getByTestId('learning-signal-metrics')).toContainText('23%');
    await expect(card).toContainText('可信度 medium');
    await expect(page.getByTestId('learning-signal-actionable')).toContainText('放宽');
    await expect(page.getByTestId('learning-signal-actionable')).toContainText('当前生效 0.8');
    // 边界必须写在页面上
    await expect(card).toContainText('信号≠提案');
    await expect(card).toContainText('目标阈值由人填写');
  });

  test('样本不足：显示"不给结论"，且不提供生成提案入口', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/signals': [
        signalFixture({
          signalId: 'SIG-DEVIATION_REPEAT-device:EXO-9:late_start-30d-medium',
          kind: 'deviation_repeat',
          severity: 'medium',
          sampleSize: 4,
          confidence: null,
          metrics: { windowDays: 30, objectType: 'device', objectId: 'EXO-9', deviationType: 'late_start', count: 4, lastAt: null },
          actionable: null,
          notActionableReason: '偏差复发需要人先定根因，平台不把次数直接换算成阈值调整',
        }),
      ],
    }));

    await expect(page.getByTestId('learning-signal-actionable')).toHaveCount(0);
    await expect(page.getByTestId('learning-signal-not-actionable')).toContainText('先定根因');
    await expect(page.getByText('样本不足（4 条），不给结论')).toBeVisible();
  });

  test('忽略必须给理由：空理由时按钮禁用（不产生静默忽略）', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/signals': [signalFixture()],
    }));

    const dismiss = page.getByTestId('learning-signal-dismiss');
    await expect(dismiss).toBeDisabled();
    await page.getByLabel('SIG-NOTIFICATION_FATIGUE-andon-30d-high 忽略理由').fill('已知积压');
    await expect(dismiss).toBeEnabled();
  });

  test('扫描：摘要如实给出读了什么 + 未达门槛不等于没问题', async ({ page }) => {
    const posts = [];
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/signals': [],
      'POST /api/learning/signals/scan': ({ body }) => {
        posts.push(body);
        return {
          orgId: 'org',
          windowDays: body?.windowDays ?? 30,
          generatedAt: '2026-09-12T08:00:00.000Z',
          derived: 0,
          created: 0,
          refreshed: 0,
          decisionsPreserved: 0,
          rejected: [],
          signals: [],
          memory: { notificationTruncated: false, notificationScanned: 12, openQualityAlerts: 1, pendingQualityReminders: 0, deviationObjects: 2 },
        };
      },
    }));

    await expect(page.getByTestId('learning-signals-empty')).toContainText('没有信号');
    await page.getByTestId('learning-signals-scan').click();
    const note = page.getByTestId('learning-signals-scan-note');
    await expect(note).toContainText('读提醒 12 条');
    await expect(note).toContainText('未达门槛 ≠ 现场没问题');
    expect(posts[0]).toMatchObject({ windowDays: 30 });
  });

  test('生成提案：人给目标值 → 调 promote 接口；非法值即时拒绝', async ({ page }) => {
    const posts = [];
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/signals': [signalFixture()],
      'POST /api/learning/signals/SIG-NOTIFICATION_FATIGUE-andon-30d-high/promote': ({ body }) => {
        posts.push(body);
        return {
          signal: signalFixture({ status: 'promoted', promotedProposalId: 'LP-NOTIFICATION_FATIGUE-andon-30d-high' }),
          proposalId: 'LP-NOTIFICATION_FATIGUE-andon-30d-high',
          created: true,
        };
      },
    }));

    const candidate = page.getByLabel('SIG-NOTIFICATION_FATIGUE-andon-30d-high 目标阈值');
    await candidate.fill('0.8');
    await expect(page.getByTestId('learning-signal-promote')).toBeDisabled();
    await expect(page.getByText('没有变化就没有提案')).toBeVisible();
    await candidate.fill('0.85');
    await page.getByTestId('learning-signal-promote').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ candidateValue: 0.85 });
  });

  test('信号读取失败：显式报错，不显示成"没有信号"', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/signals': { status: 500, body: { error: { message: 'db unavailable' } } },
    }));

    await expect(page.getByText('信号读取失败', { exact: false })).toBeVisible();
    await expect(page.getByTestId('learning-signals-empty')).toHaveCount(0);
  });
});

/* ── NO-55a：改进行动项卡片 ───────────────────────────────────────────── */

function actionFixture(overrides = {}) {
  return {
    actionId: 'ACT-lesson-RTR-1-check-backup-device-ab12cd',
    sourceType: 'retrospective_lesson',
    sourceRef: 'RTR-1',
    subjectType: 'device',
    subjectId: 'DEV-04',
    title: '交接时未核对备用设备',
    detail: '交接清单里没有备用设备状态，离线后无替代',
    kind: 'process_change',
    kindSource: 'suggested',
    priority: 'high',
    status: 'proposed',
    evidenceRefs: [
      { type: 'retrospective', id: 'RTR-1', at: '2026-09-11T08:00:00.000Z' },
      { type: 'lesson', id: 'RTR-1#交接时未核对备用设备', at: '2026-09-11T08:00:00.000Z' },
    ],
    detectedAt: '2026-09-12T08:00:00.000Z',
    ...overrides,
  };
}

test.describe('LearningConsole 改进行动项（NO-55a）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('待接受：来源/证据/优先级可见；负责人/期限/判据未填齐时不可提交', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [actionFixture()],
    }));

    const card = page.getByTestId('improvement-actions');
    await expect(card).toBeVisible();
    await expect(card).toContainText('交接时未核对备用设备');
    await expect(card).toContainText('未闭环 1');
    await expect(page.getByTestId('improvement-action-source')).toContainText('复盘经验 · RTR-1');
    await expect(page.getByTestId('improvement-action-source')).toContainText('证据 2 条');
    await expect(page.getByTestId('improvement-action-source')).toContainText('未指派负责人');

    const accept = page.getByTestId('improvement-action-accept');
    await expect(accept).toBeDisabled();
    await page.getByLabel(`${actionFixture().actionId} 负责人`).fill('P-63000000');
    await expect(accept).toBeDisabled();
    await page.getByLabel(`${actionFixture().actionId} 期限`).fill('2026-09-30');
    await expect(accept).toBeDisabled();
    await expect(card).toContainText('验收判据');
    await page.getByLabel(`${actionFixture().actionId} 验收判据`).fill('交接清单含备用设备状态');
    await expect(accept).toBeEnabled();
  });

  test('接受：提交负责人/期限/判据（平台不替现场承诺期限）', async ({ page }) => {
    const posts = [];
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [actionFixture()],
      'POST /api/learning/actions/ACT-lesson-RTR-1-check-backup-device-ab12cd/accept': ({ body }) => {
        posts.push(body);
        return actionFixture({ status: 'accepted', owner: body.owner, dueAt: body.dueAt, acceptanceCriteria: body.acceptanceCriteria });
      },
    }));

    await page.getByLabel('ACT-lesson-RTR-1-check-backup-device-ab12cd 负责人').fill('P-63000000');
    await page.getByLabel('ACT-lesson-RTR-1-check-backup-device-ab12cd 期限').fill('2026-09-30');
    await page.getByLabel('ACT-lesson-RTR-1-check-backup-device-ab12cd 验收判据').fill('交接清单含备用设备状态');
    await page.getByTestId('improvement-action-accept').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      owner: 'P-63000000',
      acceptanceCriteria: '交接清单含备用设备状态',
    });
  });

  test('已接受且逾期：显示逾期徽标；完成必须写结果说明', async ({ page }) => {
    const posts = [];
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [
        actionFixture({
          status: 'accepted',
          owner: 'P-63000000',
          dueAt: '2020-01-01T00:00:00.000Z',
          acceptanceCriteria: '交接清单含备用设备状态',
        }),
      ],
      'POST /api/learning/actions/ACT-lesson-RTR-1-check-backup-device-ab12cd/complete': ({ body }) => {
        posts.push(body);
        return actionFixture({ status: 'completed', outcomeNote: body.outcomeNote });
      },
    }));

    await expect(page.getByTestId('improvement-actions-overdue')).toContainText('逾期 1');
    await expect(page.getByTestId('improvement-action-status')).toContainText('已逾期');
    const complete = page.getByTestId('improvement-action-complete');
    await expect(complete).toBeDisabled();
    await page.getByLabel('ACT-lesson-RTR-1-check-backup-device-ab12cd 完成结果').fill('已写入交接模板并抽检 3 次');
    await complete.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].outcomeNote).toContain('抽检');
  });

  test('拒绝必须给理由（理由为空时按钮禁用）', async ({ page }) => {
    const posts = [];
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [actionFixture()],
      'POST /api/learning/actions/ACT-lesson-RTR-1-check-backup-device-ab12cd/decision': ({ body }) => {
        posts.push(body);
        return actionFixture({ status: 'rejected', decidedReason: body.reason });
      },
    }));

    const decide = page.getByTestId('improvement-action-decide');
    await expect(decide).toBeDisabled();
    await page.getByLabel('ACT-lesson-RTR-1-check-backup-device-ab12cd 决定理由').fill('与现有 SOP 重复');
    await expect(decide).toBeEnabled();
    await decide.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ decision: 'rejected', reason: '与现有 SOP 重复' });
  });

  test('扫描：摘要说清读了什么、并声明 info 级不立项', async ({ page }) => {
    const posts = [];
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [],
      'POST /api/learning/actions/scan': ({ body }) => {
        posts.push(body);
        return {
          orgId: 'org',
          generatedAt: '2026-09-12T08:00:00.000Z',
          scannedRetrospectives: 2,
          derived: 0,
          created: 0,
          refreshed: 0,
          decisionsPreserved: 0,
          rejected: [],
          actions: [],
          memory: { publishedRetrospectives: 2, lessons: 5, gaps: 0 },
        };
      },
    }));

    await expect(page.getByTestId('improvement-actions-empty')).toContainText('暂无行动项');
    await page.getByTestId('improvement-actions-scan').click();
    const note = page.getByTestId('improvement-actions-scan-note');
    await expect(note).toContainText('读已发布复盘 2 篇');
    await expect(note).toContainText('没有需要行动的经验或缺口');
    expect(posts).toHaveLength(1);
  });

  test('行动项读取失败：显式报错，不显示成"没有待办"', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': { status: 500, body: { error: { message: 'db unavailable' } } },
    }));

    await expect(page.getByText('行动项读取失败', { exact: false })).toBeVisible();
    await expect(page.getByTestId('improvement-actions-empty')).toHaveCount(0);
  });

  test('对象归属：绑定对象显示设备号；未绑定必须显式写"复发不可度量"', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [
        actionFixture(),
        actionFixture({ actionId: 'ACT-gap-RTR-2-x-ab12cd', subjectType: null, subjectId: null, title: '缺口行动项' }),
      ],
    }));

    const subjects = page.getByTestId('improvement-action-subject');
    await expect(subjects).toHaveCount(2);
    await expect(subjects.first()).toContainText('设备 DEV-04');
    await expect(subjects.first()).toHaveAttribute('data-measurable', 'yes');
    await expect(subjects.nth(1)).toContainText('未绑定（复发不可度量）');
    await expect(subjects.nth(1)).toHaveAttribute('data-measurable', 'no');
  });

  test('复发度量：点开才取数；计数下降只描述事实并附"不等于改进有效"', async ({ page }) => {
    let effectCalls = 0;
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [actionFixture({ status: 'completed', completedAt: '2026-09-18T00:00:00.000Z', outcomeNote: '已写入交接模板' })],
      'GET /api/learning/actions/ACT-lesson-RTR-1-check-backup-device-ab12cd/effect': () => {
        effectCalls += 1;
        return {
          actionId: 'ACT-lesson-RTR-1-check-backup-device-ab12cd',
          subjectType: 'device',
          subjectId: 'DEV-04',
          status: 'completed',
          completedAt: '2026-09-18T00:00:00.000Z',
          windowDays: 30,
          before: { from: '2026-08-19T00:00:00.000Z', to: '2026-09-18T00:00:00.000Z', deviations: 3 },
          after: { from: '2026-09-18T00:00:00.000Z', to: '2026-09-19T00:00:00.000Z', deviations: 0 },
          conclusion: 'recurrence_dropped',
          reason: '完成前 3 次 / 完成后 0 次：复发计数下降',
          notes: ['观察期未结束（完成后 1 天）——结论会随后续数据变化'],
          generatedAt: '2026-09-19T00:00:00.000Z',
        };
      },
    }));

    // 未点开前不取数（不预取每个行动项的计数）
    expect(effectCalls).toBe(0);
    await expect(page.getByTestId('improvement-action-effect')).toHaveCount(0);

    await page.getByTestId('improvement-action-effect-toggle').click();
    await expect(page.getByTestId('improvement-action-effect-conclusion')).toContainText('复发计数下降');
    await expect(page.getByTestId('improvement-action-effect-counts')).toContainText('3 次');
    await expect(page.getByTestId('improvement-action-effect-counts')).toContainText('0 次');
    await expect(page.getByTestId('improvement-action-effect-note')).toContainText('观察期未结束');
    await expect(page.getByTestId('improvement-action-effect-disclaimer')).toContainText('不等于');
    expect(effectCalls).toBe(1);

    // 收起不重复取数（React Query 缓存）
    await page.getByTestId('improvement-action-effect-toggle').click();
    await expect(page.getByTestId('improvement-action-effect')).toHaveCount(0);
    await page.getByTestId('improvement-action-effect-toggle').click();
    await expect(page.getByTestId('improvement-action-effect-conclusion')).toBeVisible();
    expect(effectCalls).toBe(1);
  });

  test('复发度量读取失败：显式报错，不显示成"没有复发"', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [actionFixture({ status: 'completed', completedAt: '2026-09-18T00:00:00.000Z' })],
      'GET /api/learning/actions/ACT-lesson-RTR-1-check-backup-device-ab12cd/effect': {
        status: 500,
        body: { error: { message: 'count unavailable' } },
      },
    }));

    await page.getByTestId('improvement-action-effect-toggle').click();
    const panel = page.getByTestId('improvement-action-effect');
    await expect(panel).toContainText('复发度量读取失败');
    await expect(panel).toContainText('不会显示成"没有复发"');
    await expect(page.getByTestId('improvement-action-effect-conclusion')).toHaveCount(0);
  });

  test('未绑定对象：复发面板显示"不可度量"，且不出现任何计数结论', async ({ page }) => {
    await openConsole(page, server.baseUrl, ROLES.workshop_lead, baseMock({
      'GET /api/learning/actions': [actionFixture({ status: 'completed', subjectType: null, subjectId: null, completedAt: '2026-09-18T00:00:00.000Z' })],
      'GET /api/learning/actions/ACT-lesson-RTR-1-check-backup-device-ab12cd/effect': {
        actionId: 'ACT-lesson-RTR-1-check-backup-device-ab12cd',
        subjectType: null,
        subjectId: null,
        status: 'completed',
        completedAt: '2026-09-18T00:00:00.000Z',
        windowDays: 30,
        before: { from: '', to: '', deviations: 0 },
        after: { from: '', to: '', deviations: 0 },
        conclusion: 'no_subject',
        reason: '这条行动项没有对象归属 → 复发不可度量（不硬算）',
        notes: [],
        generatedAt: '2026-09-19T00:00:00.000Z',
      },
    }));

    await page.getByTestId('improvement-action-effect-toggle').click();
    const panel = page.getByTestId('improvement-action-effect');
    await expect(page.getByTestId('improvement-action-effect-conclusion')).toContainText('不可度量');
    await expect(panel).toContainText('不可度量');
    await expect(page.getByTestId('improvement-action-effect-disclaimer')).toHaveCount(0);
  });
});
