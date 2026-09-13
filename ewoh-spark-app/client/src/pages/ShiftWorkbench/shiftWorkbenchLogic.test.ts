import type { EventInfo } from '@shared/api.interface';
import {
  buildPerceptionFusionView,
  buildPlannedVsActualView,
  plannedVsActualMeanLabel,
  plannedVsActualReasonLabel,
  buildQualityVerificationView,
  perceptionAgreementLabel,
  perceptionConfidenceLabel,
  perceptionSweepLabel,
  buildResponsibilityReadinessView,
  buildAnomalyRows,
  buildShiftKpis,
  handoverSummary,
  pageCredibility,
  shiftBanner,
} from './shiftWorkbenchLogic';

function event(partial: Partial<EventInfo> & { eventId: string }): EventInfo {
  return {
    id: partial.eventId,
    deviceId: 'D1',
    eventCode: 'CODE',
    eventType: 'DeviceOffline',
    severity: 'L2',
    title: '设备离线',
    status: 'open',
    createdAt: '2026-09-11T08:00:00Z',
    handlerAction: null,
    ...partial,
  } as EventInfo;
}

describe('shiftBanner（当前班次横幅）', () => {
  it('有班次时显示名称与窗口', () => {
    const banner = shiftBanner(
      { shiftId: 'E', name: '早班', startTime: '08:00', endTime: '16:00', crossesMidnight: false, active: true },
      { shiftId: 'M', name: '中班', startTime: '16:00', endTime: '24:00', crossesMidnight: false, active: true },
      false,
    );
    expect(banner.tone).toBe('current');
    expect(banner.label).toContain('早班');
    expect(banner.detail).toContain('08:00–16:00');
    expect(banner.detail).toContain('中班');
  });

  it('无匹配班次显式未知（不猜默认班）', () => {
    const banner = shiftBanner(null, null, false);
    expect(banner.tone).toBe('gap');
    expect(banner.label).toContain('不在任何班次窗口');
    expect(banner.detail).toContain('无有效班次定义');
  });

  // FE-1：读失败（403/500）不得落回"不在任何班次窗口内"——那句会让人去重新登记班次定义。
  it('FE-1：班次查询读失败 → 说"读取失败"，不说"不在任何班次窗口"', () => {
    const banner = shiftBanner(null, null, false, true);
    expect(banner.tone).toBe('gap');
    expect(banner.label).toContain('班次信息读取失败');
    expect(banner.detail).toContain('无法判断当前班次');
    expect(banner.label).not.toContain('不在任何班次窗口');
    expect(banner.detail).not.toContain('无有效班次定义');
  });
});

describe('buildShiftKpis', () => {
  it('open 异常与 L3 计数、待审批/执行中方案、偏差、物料缺口', () => {
    const kpis = buildShiftKpis({
      events: [
        event({ eventId: 'a', severity: 'L3' }),
        event({ eventId: 'b', severity: 'L2' }),
        event({ eventId: 'c', status: 'closed' }),
      ],
      plans: [
        { planId: 'p1', status: 'draft', assignments: [] },
        { planId: 'p2', status: 'dispatched', assignments: [] },
        { planId: 'p3', status: 'completed', assignments: [] },
      ] as never,
      executions: {
        executions: [
          { deviationType: 'LATE' },
          { deviationType: null },
        ],
      } as never,
      materials: [{ materialId: 'm1', shortage: 10, belowThreshold: false }] as never,
    });
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.openAlerts.value).toBe('2');
    expect(byKey.openAlerts.detail).toContain('L3 1 条');
    expect(byKey.pendingPlans.value).toBe('1');
    expect(byKey.executingPlans.value).toBe('1');
    expect(byKey.deviations.value).toBe('1');
    expect(byKey.materialShortage.value).toBe('1');
  });

  it('无物料事实显示 —（不冒充 0 缺口）', () => {
    const kpis = buildShiftKpis({});
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.materialShortage.value).toBe('—');
  });

  // FE-1：方案/执行读失败 → 数组退化为空，绝不能显示 0（0 是有依据的结论，— 才是未知）。
  it('FE-1：方案读失败 → 待审批/执行中 KPI 显示 — 并说明读取失败', () => {
    const kpis = buildShiftKpis({ plansUnavailable: true });
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.pendingPlans.value).toBe('—');
    expect(byKey.pendingPlans.detail).toContain('读取失败');
    expect(byKey.executingPlans.value).toBe('—');
    expect(byKey.executingPlans.detail).toContain('读取失败');
    expect(byKey.pendingPlans.detail).not.toContain('无积压');
  });

  it('FE-1：执行记录读失败 → 执行偏差 KPI 显示 — 并说明读取失败', () => {
    const kpis = buildShiftKpis({ executionsUnavailable: true });
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.deviations.value).toBe('—');
    expect(byKey.deviations.detail).toContain('读取失败');
    expect(byKey.deviations.detail).not.toContain('暂无偏差记录');
  });

  // 2026-09-13 对抗自查补口：events / materials 两个读失败面此前没有 unavailable 标记。
  // events 读失败时 openAlerts KPI 渲染"0/positive（近 24h open 事件）"——与列表区的
  // "异常事件读取失败"同屏互相矛盾，KPI 这一侧把"没读到"说成了"没有异常"。
  it('FE-1：异常事件读失败 → 当班异常 KPI 显示 — 并说明读取失败（不渲染 0/positive）', () => {
    const kpis = buildShiftKpis({ eventsUnavailable: true });
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.openAlerts.value).toBe('—');
    expect(byKey.openAlerts.detail).toContain('读取失败');
    expect(byKey.openAlerts.detail).not.toContain('近 24h open 事件');
    expect(byKey.openAlerts.tone).not.toBe('positive');
  });

  // overview 读失败（workshop_lead 打开本页即 403，而这是班组长的默认落地页）时
  // materials 退化为 [] → 旧文案"无缺口行（未接入 ERP 时为空）"把读失败洗成"没接 ERP"。
  it('FE-1：物料数据读失败 → 物料缺口 KPI 显示 — 并说明读取失败（不说"未接入 ERP"）', () => {
    const kpis = buildShiftKpis({ materialsUnavailable: true });
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.materialShortage.value).toBe('—');
    expect(byKey.materialShortage.detail).toContain('读取失败');
    expect(byKey.materialShortage.detail).not.toContain('未接入 ERP');
    expect(byKey.materialShortage.tone).not.toBe('positive');
  });
});

describe('buildAnomalyRows（数据质量确认状态合并）', () => {
  it('open 事件附带确认状态；已确认事件不再显示按钮态', () => {
    const rows = buildAnomalyRows(
      [event({ eventId: 'a' }), event({ eventId: 'b', status: 'resolved' })],
      [{ eventId: 'a', verdict: 'confirmed' }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dqVerdict).toBe('confirmed');
  });
});

describe('handoverSummary', () => {
  it('遗留事项分级摘要', () => {
    expect(handoverSummary({ openItems: [] } as never)).toBe('无遗留事项');
    expect(
      handoverSummary({
        openItems: [
          { title: 'a', severity: 'critical' },
          { title: 'b', severity: 'warning' },
          { title: 'c' },
        ],
      } as never),
    ).toBe('3 项遗留 · 严重 1 · 注意 1');
  });
});

describe('pageCredibility（DataCredibility 接线输入）', () => {
  it('无数据时 completeness=0（不冒充完整）', () => {
    const info = pageCredibility({ eventsUpdatedAt: 0, plansUpdatedAt: 0, now: 1000 });
    expect(info.completeness).toBe(0);
  });
});

/* ── NO-52a：接班人核对（责任人覆盖率展示）────────────────────────────── */

describe('buildResponsibilityReadinessView', () => {
  const snapshot = {
    shiftId: 'SHIFT-NIGHT',
    shiftUnknown: false,
    total: 5,
    covered: 3,
    gaps: 2,
    uncovered: 4,
    devices: [
      { deviceId: 'EXO-3', covered: false, holders: [], outOfShift: [{ personId: 'person:p1', responsibility: 'owner', shiftId: 'SHIFT-DAY' }] },
      { deviceId: 'EXO-4', covered: false, holders: [], outOfShift: [] },
      { deviceId: 'EXO-1', covered: true, holders: [{ personId: 'person:p2', responsibility: 'owner', matchedBy: 'current_shift' }], outOfShift: [] },
    ],
    notes: ['口径：纳入核对的是已登记责任关系的设备。'],
  } as never;

  it('口径/结论/缺口逐条给出，缺口说明"只有别的班次责任人"', () => {
    const view = buildResponsibilityReadinessView(snapshot);
    expect(view.scopeLabel).toContain('班次 SHIFT-NIGHT');
    expect(view.scopeLabel).toContain('共 5 台');
    expect(view.summaryLabel).toContain('本班覆盖 3 台');
    expect(view.summaryLabel).toContain('本班缺口 2 台');
    expect(view.summaryLabel).toContain('未登记责任人 4 台');
    expect(view.gapRows.map((r) => r.deviceId)).toEqual(['EXO-3', 'EXO-4']);
    expect(view.gapRows[0]?.detail).toContain('班次 SHIFT-DAY');
    expect(view.gapRows[1]?.detail).toContain('没有本班或全天责任人');
    expect(view.needsAttention).toBe(true);
    expect(view.shiftUnknownNote).toBeNull();
  });

  it('班次未知 → 显式说明（不猜默认班），且不算"有覆盖"', () => {
    const view = buildResponsibilityReadinessView({ ...(snapshot as object), shiftUnknown: true, shiftId: null } as never);
    expect(view.shiftUnknownNote).toContain('当前班次未知');
    expect(view.scopeLabel).toContain('未匹配到班次定义');
  });

  it('没有缺口 → needsAttention=false（页面不提示"写进遗留事项"）', () => {
    const view = buildResponsibilityReadinessView({
      ...(snapshot as object),
      gaps: 0,
      uncovered: 0,
      devices: [],
    } as never);
    expect(view.needsAttention).toBe(false);
    expect(view.gapRows).toEqual([]);
  });

  it('没有数据 → 明确"尚未取到"，不显示 0', () => {
    const view = buildResponsibilityReadinessView(null);
    expect(view.scopeLabel).toContain('尚未取到');
    expect(view.summaryLabel).toBe('—');
    expect(view.needsAttention).toBe(false);
  });
});

/* ── NO-53a：数据质量待核实提醒的展示口径 ─────────────────────────────── */

function dqNotification(partial: Record<string, unknown> & { notificationId: string }) {
  return {
    recipientType: 'role',
    recipientId: 'workshop_lead',
    channel: 'app',
    title: '数据质量待核实',
    body: '编号 CLOCK_DRIFT 的告警需要人核实',
    severity: 'high',
    status: 'pending',
    externalRef: 'EVT-DQ-1',
    createdAt: '2026-09-12T08:00:00Z',
    errorMessage: null,
    resolution: null,
    ...partial,
  } as never;
}

describe('buildQualityVerificationView（待核实提醒是否叫到了人）', () => {
  const NOW = new Date('2026-09-12T09:30:00Z').getTime();

  it('同一告警的多个收件人合并成一行，并可回答"叫了谁/多久"', () => {
    const view = buildQualityVerificationView(
      [
        dqNotification({ notificationId: 'NTF-DQ-EVT-DQ-1-quality_alert-role-workshop_lead-app' }),
        dqNotification({
          notificationId: 'NTF-DQ-EVT-DQ-1-quality_alert-user-worker.zhangwei-app',
          recipientType: 'user',
          recipientId: 'worker.zhangwei',
          createdAt: '2026-09-12T09:00:00Z',
        }),
      ],
      { now: NOW },
    );
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].alertEventId).toBe('EVT-DQ-1');
    expect(view.rows[0].recipients).toEqual(['role:workshop_lead', 'user:worker.zhangwei']);
    expect(view.rows[0].pendingCount).toBe(2);
    expect(view.rows[0].waitingLabel).toBe('已等待 1 小时'); // 取最早一条
  });

  it('只看数据质量族：其它族提醒不进这张卡', () => {
    const view = buildQualityVerificationView(
      [
        dqNotification({ notificationId: 'NTF-DQ-EVT-DQ-1-quality_alert-role-workshop_lead-app' }),
        dqNotification({ notificationId: 'NTF-ANDON-ANDON-1-L1-role-workshop_lead-app' }),
        dqNotification({ notificationId: 'RANDOM-1' }),
      ],
      { now: NOW },
    );
    expect(view.rows).toHaveLength(1);
  });

  it('已处置（resolution 非空）不再出现 —— 已处置 ≠ 已读', () => {
    const view = buildQualityVerificationView(
      [
        dqNotification({ notificationId: 'NTF-DQ-A-quality_alert-role-workshop_lead-app', status: 'read' }),
        dqNotification({
          notificationId: 'NTF-DQ-B-quality_alert-role-workshop_lead-app',
          externalRef: 'EVT-DQ-2',
          resolution: 'data_quality_confirmed',
          status: 'resolved',
        }),
      ],
      { now: NOW },
    );
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].readCount).toBe(1);
    expect(view.rows[0].alertEventId).toBe('EVT-DQ-1');
  });

  it('投递失败显式提示"不能视为已叫到人"', () => {
    const view = buildQualityVerificationView(
      [
        dqNotification({
          notificationId: 'NTF-DQ-A-quality_alert-role-workshop_lead-feishu',
          channel: 'feishu',
          status: 'failed',
          errorMessage: 'webhook 超时',
        }),
      ],
      { now: NOW },
    );
    expect(view.failedDeliveryCount).toBe(1);
    expect(view.notes.join(' ')).toContain('投递失败');
    expect(view.notes.join(' ')).toContain('不能视为');
  });

  it('无源事件号的提醒显式说明无法回写判定（不假装能确认）', () => {
    const view = buildQualityVerificationView(
      [dqNotification({ notificationId: 'NTF-DQ-orphan-quality_alert-role-workshop_lead-app', externalRef: null })],
      { now: NOW },
    );
    expect(view.rows[0].alertEventId).toBeNull();
    expect(view.notes.join(' ')).toContain('无法回写核实判定');
  });

  it('缺时间不猜：显示"叫到时间未知"且排在有时间的之后', () => {
    const view = buildQualityVerificationView(
      [
        dqNotification({ notificationId: 'NTF-DQ-A-quality_alert-role-workshop_lead-app', createdAt: null }),
        dqNotification({ notificationId: 'NTF-DQ-B-quality_alert-role-workshop_lead-app', externalRef: 'EVT-DQ-2' }),
      ],
      { now: NOW },
    );
    expect(view.rows[0].alertEventId).toBe('EVT-DQ-2');
    expect(view.rows[1].waitingLabel).toBe('叫到时间未知');
  });

  it('无提醒 → 不需要注意（页面不制造噪音）', () => {
    const view = buildQualityVerificationView([], { now: NOW });
    expect(view.needsAttention).toBe(false);
    expect(view.rows).toEqual([]);
  });

  it('超出条数上限显式说明隐藏了多少条', () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      dqNotification({
        notificationId: `NTF-DQ-EVT-DQ-${i}-quality_alert-role-workshop_lead-app`,
        externalRef: `EVT-DQ-${i}`,
      }),
    );
    const view = buildQualityVerificationView(many, { now: NOW, limit: 2 });
    expect(view.rows).toHaveLength(2);
    expect(view.hiddenRows).toBe(2);
    expect(view.notes.join(' ')).toContain('另有 2 条');
  });
});


/* ── NO-56a：多源感知融合的展示口径 ───────────────────────────────────── */

function fusedFixture(overrides: Record<string, unknown> = {}) {
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
  } as never;
}

describe('buildPerceptionFusionView（感知融合展示口径）', () => {
  it('一致 + 高置信：工位/姿态/可信度/可用源逐条可见，且允许建议', () => {
    const view = buildPerceptionFusionView(fusedFixture());
    expect(view.agreementLabel).toContain('交叉验证');
    expect(view.agreementTone).toBe('positive');
    expect(view.stationLabel).toBe('工位 ST-1');
    expect(view.postureLabel).toContain('俯仰 12');
    expect(view.confidenceLabel).toContain('88%');
    expect(view.confidenceKnown).toBe(true);
    expect(view.sourceLabel).toContain('可用源：uwb');
    expect(view.adviceLabel).toContain('可据此生成建议');
  });

  it('无可用源 → "证据不足（不给分）"，不显示 0%', () => {
    const view = buildPerceptionFusionView(fusedFixture({
      agreement: 'insufficient',
      position: null,
      posture: null,
      station: null,
      confidence: {
        level: 'unknown', score: null, basis: '无可用源',
        usableSources: [], degraded: true, missingSources: ['uwb', 'exo_imu', 'vision'],
        excludedSources: [{ source: 'uwb', sourceId: 'TAG-1', dimension: 'position', status: 'stale', reason: '证据过期：3600s > TTL 60s（不参与融合）' }],
        unknownConfidenceSources: [],
      },
      strongAdviceAllowed: false,
      notes: ['缺失源：uwb、exo_imu、vision（本窗口没有任何观测）'],
    }));
    expect(view.confidenceKnown).toBe(false);
    expect(view.confidenceLabel).toBe('证据不足（不给分）');
    expect(view.confidenceLabel).not.toContain('0%');
    expect(view.stationLabel).toContain('无定位证据');
    expect(view.postureLabel).toContain('姿态未知');
    // 被排除的证据要带**原因**（这里是 TTL 过期），不是只写"已排除"
    expect(view.excludedLabels[0]).toContain('TTL');
    expect(view.adviceLabel).toContain('不得据此生成强建议');
  });

  it('冲突：逐条列出各源取值，并禁止强建议', () => {
    const view = buildPerceptionFusionView(fusedFixture({
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
    }));
    expect(view.agreementTone).toBe('critical');
    expect(view.conflictLabels[0]).toContain('[high]');
    expect(view.conflictLabels[0]).toContain('uwb=ST-1');
    expect(view.conflictLabels[0]).toContain('vision=ST-2');
    expect(view.adviceLabel).toContain('不得据此生成强建议');
  });

  it('降级：缺源/排除证据分别可见（不混为一谈）', () => {
    const view = buildPerceptionFusionView(fusedFixture({
      agreement: 'partial',
      confidence: {
        level: 'medium', score: 0.62, basis: 'x', usableSources: ['uwb', 'exo_imu'],
        degraded: true, missingSources: ['vision', 'task_context'],
        excludedSources: [{ source: 'station_semantics', sourceId: 'map', dimension: 'station_presence', status: 'untrusted', reason: '数据质量 invalid' }],
        unknownConfidenceSources: ['uwb'],
      },
    }));
    expect(view.degradedLabel).toContain('缺 2 个源');
    expect(view.degradedLabel).toContain('排除 1 条证据');
    expect(view.missingLabel).toContain('vision');
    expect(view.excludedLabels[0]).toContain('invalid');
  });

  it('文案与摘要：未知值原样透出；扫描摘要暴露冲突/降级/未匹配/工位未解析', () => {
    expect(perceptionAgreementLabel('partial')).toContain('部分一致');
    expect(perceptionAgreementLabel('magic')).toBe('magic');
    expect(perceptionConfidenceLabel('unknown', null)).toContain('证据不足');
    const label = perceptionSweepLabel({
      subjects: 3,
      persisted: 3,
      conflictSubjects: ['person:P-1'],
      degradedSubjects: ['person:P-1', 'person:P-2'],
      unmatchedVisionDetections: 2,
      stationUnresolved: 1,
      byAgreement: { consistent: 1, partial: 1, conflict: 1 },
      byConfidenceLevel: { high: 1, medium: 1, unknown: 1 },
    });
    expect(label).toContain('主体 3 个');
    expect(label).toContain('冲突主体 1 个');
    expect(label).toContain('视觉未匹配 2 条');
    expect(label).toContain('工位未解析 1 个');
  });
});


/* ── NO-57b：预计 vs 实际 对账口径 ─────────────────────────────────────── */

describe('buildPlannedVsActualView（预计 vs 实际）', () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({
    windowDays: 30,
    totalRows: 12,
    comparableRows: 9,
    coverage: 0.75,
    meanAbsPctError: 0.32,
    medianAbsPctError: 0.2,
    p90AbsPctError: 0.5,
    meanSignedMs: 720_000,
    overrunCount: 6,
    underrunCount: 2,
    onTimeCount: 1,
    byReason: { comparable: 9, not_finished: 2, missing_planned: 1 },
    byDeviationType: { late_finish: 6, early_finish: 2 },
    biasNote: '系统性超时倾向：平均实际比计划多 20%（样本 9 条）——先看偏差类型分布再谈排产口径',
    notes: [],
    ...overrides,
  });

  it('样本足够：覆盖率/中位/均值/P90/超时提前计数逐条可读', () => {
    const view = buildPlannedVsActualView(summary());
    expect(view.scopeLabel).toContain('可比 9 行');
    expect(view.scopeLabel).toContain('覆盖率 75%');
    expect(view.rateLabel).toContain('中位 20%');
    expect(view.rateLabel).toContain('P90 50%');
    expect(view.countLabel).toContain('超时 6');
    expect(view.hasEvidence).toBe(true);
    expect(view.biasNote).toContain('系统性超时倾向');
  });

  it('样本不足：明确"证据不足、不给比率"，不显示 0%', () => {
    const view = buildPlannedVsActualView(summary({
      comparableRows: 2, meanAbsPctError: null, medianAbsPctError: null, p90AbsPctError: null, biasNote: null,
    }));
    expect(view.hasEvidence).toBe(false);
    expect(view.rateLabel).toContain('证据不足');
    expect(view.rateLabel).toContain('门槛 5');
    expect(view.rateLabel).not.toContain('0%');
  });

  it('不可比分类逐类可读；未知原因原样透出', () => {
    const view = buildPlannedVsActualView(summary({ byReason: { comparable: 9, magic_reason: 1 } }));
    expect(view.reasonLabels).toContain('可比 9 行');
    expect(view.reasonLabels).toContain('magic_reason 1 行');
    expect(plannedVsActualReasonLabel('not_finished')).toContain('未完工');
  });

  it('未取到数据 → "尚未取到"且无证据（不显示成 0）', () => {
    const view = buildPlannedVsActualView(undefined);
    expect(view.scopeLabel).toContain('尚未取到');
    expect(view.hasEvidence).toBe(false);
    expect(plannedVsActualMeanLabel(null)).toBe('—');
    expect(plannedVsActualMeanLabel(1_800_000)).toBe('30 分钟');
  });
});
