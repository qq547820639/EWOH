/* LearningSignalService 契约行为测试（NO-54a 学习回路接线）。
 *
 * 钉住的语义（每条都对应一条原则）：
 *   1. 扫描把"实测运行记忆"变成带证据的信号（原则 5：来源/时间/影响面/可信度）；
 *   2. **信号 ≠ 提案**：扫描只写信号；只有人点 promote 才创建提案（原则 4/6）；
 *   3. 重复扫描幂等，且**不覆盖人的决定**（已忽略/已转提案的原样保留）；
 *   4. 不可执行的信号拒绝提案（并给出理由）；样本不足不给可信度（原则 7）；
 *   5. 基线漂移 → 409（阈值已被改动 → 信号依据过期，必须重新扫描）；
 *   6. 忽略必须给理由；已决定的信号不可重复决定。
 *
 * DB 用 fake（按表路由 + 条件匹配 + 真聚合偏差分组），提案服务 mock。
 */
/// <reference types="jest" />
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  ewohEvent,
  ewohLearningSignal,
  ewohNotification,
  ewohSchedulingExecution,
} from '@server/database/schema';
import { LearningSignalService } from '../learning-signal.service';
import { makeConditionMatcher } from '../../../../test/helpers/drizzle-fake-matcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;
const NOW = new Date('2026-09-12T08:00:00.000Z');

const HOUR = 3_600_000;

interface Seed {
  signals?: Array<Record<string, unknown>>;
  notifications?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  executions?: Array<Record<string, unknown>>;
}

/**
 * 列名 → 行字段映射（**必须覆盖被测代码查询到的每一列**：漏映射的列会让条件恒 false，
 * 表现为"替身把行全过滤掉"，是最难查的一类测试自伤）。列名取自 schema 实际 db 名。
 */
const COLUMN_KEYS = {
  // ewoh_notification
  notification_id: 'notificationId',
  external_ref: 'externalRef',
  resolved_at: 'resolvedAt',
  read_at: 'readAt',
  _created_at: 'createdAt',
  resolution: 'resolution',
  // ewoh_event
  event_id: 'eventId',
  event_type: 'eventType',
  created_at: 'createdAt',
  // ewoh_scheduling_execution
  deviation_type: 'deviationType',
  device_id: 'deviceId',
  person_id: 'personId',
  plan_id: 'planId',
  // ewoh_learning_signal
  signal_id: 'signalId',
  subject_key: 'subjectKey',
  rule_id: 'ruleId',
  // 通用
  org_id: 'orgId',
  status: 'status',
  kind: 'kind',
};

function createSignalDb(seed: Seed = {}) {
  const signals = seed.signals ?? [];
  const notifications = seed.notifications ?? [];
  const events = seed.events ?? [];
  const executions = seed.executions ?? [];
  const matches = makeConditionMatcher(COLUMN_KEYS);
  const rowsFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === ewohLearningSignal) return signals;
    if (table === ewohNotification) return notifications;
    if (table === ewohEvent) return events;
    if (table === ewohSchedulingExecution) return executions;
    return [];
  };

  /** 真聚合：按 (deviceId, personId, deviationType) 分组（与 SQL 的 GROUP BY 同形）。 */
  function aggregateDeviations(rows: Array<Record<string, unknown>>) {
    const groups = new Map<string, { deviceId: unknown; personId: unknown; deviationType: unknown; count: number; lastAt: Date | null; planIds: string[] }>();
    for (const row of rows) {
      const key = `${row.deviceId ?? ''}|${row.personId ?? ''}|${row.deviationType ?? ''}`;
      const entry = groups.get(key) ?? {
        deviceId: row.deviceId ?? null,
        personId: row.personId ?? null,
        deviationType: row.deviationType ?? null,
        count: 0,
        lastAt: null as Date | null,
        planIds: [] as string[],
      };
      entry.count += 1;
      const created = row.createdAt instanceof Date ? (row.createdAt as Date) : null;
      if (created && (!entry.lastAt || created > entry.lastAt)) entry.lastAt = created;
      if (typeof row.planId === 'string' && !entry.planIds.includes(row.planId)) entry.planIds.push(row.planId);
      groups.set(key, entry);
    }
    return [...groups.values()]
      .filter((g) => g.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((g) => ({
        deviceId: g.deviceId,
        personId: g.personId,
        deviationType: g.deviationType,
        count: g.count,
        lastAt: g.lastAt ? g.lastAt.toISOString() : null,
        planIds: g.planIds.slice(0, 5),
      }));
  }

  function selectChain(table: unknown, projection?: unknown) {
    let filtered = rowsFor(table);
    // count(*) 聚合投影：真实 PG 返回 [{count:n}]，替身也必须返回"聚合结果"而不是原始行
    // （否则 `Number(row.count ?? 0)` 恒为 0，表现为"库里有数据但计数为 0"）。
    const shaped = (rows: Array<Record<string, unknown>>) =>
      projection && typeof projection === 'object' && 'count' in (projection as Record<string, unknown>)
        ? [{ count: rows.length }]
        : rows;
    const api = {
      where(condition: unknown) {
        filtered = rowsFor(table).filter((row) => matches(condition, row));
        return api;
      },
      orderBy() {
        return api;
      },
      limit(count: number) {
        return Promise.resolve(shaped(filtered.slice(0, count)));
      },
      groupBy() {
        const rows = filtered;
        return {
          having() {
            return {
              orderBy() {
                return { limit: (count: number) => Promise.resolve(aggregateDeviations(rows).slice(0, count)) };
              },
            };
          },
        };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(shaped(filtered)).then(resolve, reject);
      },
    };
    return api;
  }

  const db = {
    select: (projection?: unknown) => ({ from: (table: unknown) => selectChain(table, projection) }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        rowsFor(table).push({ ...row });
        return [row];
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (condition: unknown) => {
          const hit = rowsFor(table).filter((row) => matches(condition, row));
          for (const row of hit) Object.assign(row, patch);
          return hit.length;
        },
      }),
    }),
  };
  return { db, signals, notifications, executions };
}

function thresholdService(effective: number | null = 0.7, source = 'engine_default') {
  return {
    getThresholdBaseline: jest.fn(async () => ({
      readAt: NOW.toISOString(),
      engineVersion: '1.0.0',
      entries: [
        {
          ruleId: 'rule:worker-overload',
          parameter: 'workloadThreshold',
          engineDefault: 0.7,
          effective,
          source,
          provenance: null,
        },
      ],
    })),
    propose: jest.fn(async (_input: unknown, _orgId: string, _by: string) => ({
      proposal: { proposalId: 'LP-NOTIFICATION_FATIGUE-andon-30d-high', kind: 'rule_threshold', status: 'proposed' },
      created: true,
    })),
  };
}

/** 提醒种子：6 条已处置（可算处置时长 → comparable=6）+ 20 条待处置 26h → 处置率低。 */
function fatigueNotifications(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({
      orgId: ORG,
      notificationId: `NTF-ANDON-ANDON-${i}-sla_breach_l1-role-workshop_lead-app`,
      status: 'resolved',
      channel: 'app',
      externalRef: `ANDON-${i}`,
      resolution: 'andon_cleared',
      createdAt: new Date(NOW.getTime() - 72 * HOUR),
      readAt: null,
      resolvedAt: new Date(NOW.getTime() - 48 * HOUR),
    });
  }
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      orgId: ORG,
      notificationId: `NTF-ANDON-ANDON-${100 + i}-sla_breach_l1-role-workshop_lead-app`,
      status: 'pending',
      channel: 'app',
      externalRef: `ANDON-${100 + i}`,
      resolution: null,
      createdAt: new Date(NOW.getTime() - 26 * HOUR),
      readAt: null,
      resolvedAt: null,
    });
  }
  return rows;
}

describe('LearningSignalService.scan（运行记忆 → 信号）', () => {
  it('实测记忆 → 可执行信号（方向 raise + 基线来自生效阈值 + 证据含来源）', async () => {
    const { db, signals } = createSignalDb({ notifications: fatigueNotifications() });
    const proposals = thresholdService();
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    const service = new LearningSignalService(db as never, audit as never, proposals as never);

    const result = await service.scan(ACTOR, { now: NOW, windowDays: 30 });

    expect(result.derived).toBe(1);
    expect(result.created).toBe(1);
    expect(result.memory.notificationScanned).toBe(26);
    const [signal] = result.signals;
    expect(signal.kind).toBe('notification_fatigue');
    expect(signal.severity).toBe('high');
    expect(signal.confidence).toBe('medium');
    expect(signal.actionable).toMatchObject({ direction: 'raise', baselineValue: 0.7 });
    expect(signal.evidenceRefs.some((e) => e.type === 'notification_kind')).toBe(true);
    expect(signal.metrics.pending).toBe(20);
    // 只写信号表，不碰提案表（原则 4/6：信号≠提案）
    expect(signals).toHaveLength(1);
    expect(proposals.propose).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'learning.signal_scan', orgId: ORG }),
    );
  });

  it('陈旧待处置积压不得因取数上限消失（NO-61b）：最近 2000 条之外的旧 pending 仍进信号', async () => {
    // 造一个"最近窗口被噪声占满"的库：2001 条近期待处置以外的已了结行 + 20 条**很旧**的 pending。
    // 旧实现只读"最近 N 条" → 旧 pending 完全不可见 → 提醒疲劳信号漏报（原则 7 禁止的静默缺口）。
    const recentNoise = Array.from({ length: 2001 }, (_, i) => ({
      orgId: ORG,
      notificationId: `NTF-ANDON-NOISE-${i}-app`,
      status: 'resolved',
      channel: 'app',
      externalRef: `SRC-${i}`,
      resolution: 'andon_cleared',
      createdAt: new Date(NOW.getTime() - 60_000),   // 都在最近窗口内
      readAt: new Date(NOW.getTime() - 60_000),
      resolvedAt: new Date(NOW.getTime() - 30_000),
    }));
    const oldPending = Array.from({ length: 20 }, (_, i) => ({
      orgId: ORG,
      notificationId: `NTF-ANDON-OLD-${i}-app`,
      status: 'pending',
      channel: 'app',
      externalRef: `SRC-OLD-${i}`,
      resolution: null,
      createdAt: new Date(NOW.getTime() - 96 * 3_600_000), // 96h 前的积压
      readAt: null,
      resolvedAt: null,
    }));
    const { db } = createSignalDb({ notifications: [...recentNoise, ...oldPending] });
    const service = new LearningSignalService(db as never, { appendAuditLog: jest.fn() } as never, thresholdService() as never);

    const result = await service.scan(ACTOR, { now: NOW, windowDays: 30 });

    const fatigue = result.signals.find((s) => s.kind === 'notification_fatigue');
    expect(fatigue).toBeTruthy();
    expect(fatigue?.metrics.pending).toBe(20);
    expect(result.memory.notificationTruncated).toBe(true);
  });

  it('重复扫描幂等：第二次是 refreshed 而不是重复创建', async () => {
    const { db, signals } = createSignalDb({ notifications: fatigueNotifications() });
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    const service = new LearningSignalService(db as never, audit as never, thresholdService() as never);
    await service.scan(ACTOR, { now: NOW });
    const second = await service.scan(ACTOR, { now: new Date(NOW.getTime() + 60_000) });
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(signals).toHaveLength(1);
  });

  it('不覆盖人的决定：已忽略的信号只刷新快照，状态与理由保留', async () => {
    const { db, signals } = createSignalDb({
      notifications: fatigueNotifications(),
      signals: [
        {
          orgId: ORG,
          signalId: 'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
          kind: 'notification_fatigue',
          severity: 'high',
          status: 'dismissed',
          subjectKey: 'andon',
          windowDays: 30,
          sampleSize: 20,
          confidence: 'medium',
          metricsJson: {},
          evidenceJson: [],
          narrativeJson: {},
          decidedBy: 'lead.chen',
          decidedAt: new Date(NOW.getTime() - HOUR),
          decidedReason: '现场已经在处理，属于已知积压',
          lastSeenAt: new Date(NOW.getTime() - HOUR),
        },
      ],
    });
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    const service = new LearningSignalService(db as never, audit as never, thresholdService() as never);
    const result = await service.scan(ACTOR, { now: NOW });
    expect(result.decisionsPreserved).toBe(1);
    expect(result.signals[0].status).toBe('dismissed');
    expect(signals[0].status).toBe('dismissed');
    expect(signals[0].decidedReason).toBe('现场已经在处理，属于已知积压');
  });

  it('样本不足 → 信号仍记录但不可执行（confidence=null + 理由）', async () => {
    const notifications = fatigueNotifications().filter((row) => row.status === 'pending').slice(0, 4);
    const { db } = createSignalDb({ notifications });
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    const result = await service.scan(ACTOR, { now: NOW });
    const [signal] = result.signals;
    expect(signal.confidence).toBeNull();
    expect(signal.actionable).toBeNull();
    expect(String(signal.notActionableReason)).toContain('证据不足');
  });

  it('数据质量积压 → 信号记录但永远不可提案（运营问题不是阈值问题）', async () => {
    const { db } = createSignalDb({
      events: Array.from({ length: 8 }, (_, i) => ({
        orgId: ORG,
        eventId: `EVT-DQ-${i}`,
        eventType: 'DataQualityAlert',
        status: 'open',
      })),
      notifications: [
        ...Array.from({ length: 4 }, (_, i) => ({
          orgId: ORG,
          notificationId: `NTF-DQ-EVT-DQ-${i}-quality_alert-role-workshop_lead-app`,
          status: 'pending',
          channel: 'app',
          externalRef: `EVT-DQ-${i}`,
          resolution: null,
          createdAt: new Date(NOW.getTime() - 2 * HOUR),
          readAt: null,
          resolvedAt: null,
        })),
      ],
    });
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    const result = await service.scan(ACTOR, { now: NOW });
    const quality = result.signals.find((s) => s.kind === 'data_quality_backlog');
    expect(quality).toBeDefined();
    expect(quality!.actionable).toBeNull();
    expect(String(quality!.notActionableReason)).toContain('不是策略阈值问题');
  });

  it('偏差复发 → 按对象聚合（次数进指标、证据带最后发生时间）', async () => {
    const { db } = createSignalDb({
      executions: Array.from({ length: 4 }, (_, i) => ({
        orgId: ORG,
        deviceId: 'EXO-9',
        personId: null,
        deviationType: 'late_start',
        planId: `PLAN-${i}`,
        createdAt: new Date(NOW.getTime() - (i + 1) * HOUR),
      })),
    });
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    const result = await service.scan(ACTOR, { now: NOW });
    expect(result.memory.deviationObjects).toBe(1);
    const signal = result.signals.find((s) => s.kind === 'deviation_repeat')!;
    expect(signal.metrics).toMatchObject({ objectId: 'EXO-9', deviationType: 'late_start', count: 4 });
    expect(signal.evidenceRefs[0].type).toBe('execution_deviation');
    expect(signal.evidenceRefs[0].at).toBe(new Date(NOW.getTime() - HOUR).toISOString());
  });

  it('缺 org/用户上下文 → 400（fail-closed）', async () => {
    const { db } = createSignalDb({});
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(service.scan(undefined)).rejects.toThrow(BadRequestException);
    await expect(service.scan({ userId: '', primaryOrgId: ORG } as never)).rejects.toThrow(BadRequestException);
  });
});

describe('LearningSignalService.promote（人点"生成提案"）', () => {
  function withSignal(overrides: Record<string, unknown> = {}) {
    const base = {
      orgId: ORG,
      signalId: 'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
      kind: 'notification_fatigue',
      severity: 'high',
      status: 'open',
      subjectKey: 'andon',
      windowDays: 30,
      sampleSize: 20,
      confidence: 'medium',
      direction: 'raise',
      ruleId: 'rule:worker-overload',
      parameter: 'workloadThreshold',
      baselineValue: 0.7,
      metricsJson: { pending: 20 },
      evidenceJson: [{ type: 'notification_kind', id: 'andon', at: null }],
      narrativeJson: { hypothesis: 'h', expectedEffect: 'e', risk: 'r', missing: [] },
      notActionableReason: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      recordJson: { detectedAt: NOW.toISOString(), actionable: { baselineSource: 'engine_default' } },
      ...overrides,
    };
    return createSignalDb({ signals: [base] });
  }

  it('可执行 + 基线未漂移 → 创建提案（目标值由人给）并标记信号已转提案', async () => {
    const { db, signals } = withSignal();
    const proposals = thresholdService(0.7);
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    const service = new LearningSignalService(db as never, audit as never, proposals as never);

    const result = await service.promote(
      'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
      { candidateValue: 0.78, note: '本周积压 20 条，先放宽一档观察' },
      ACTOR,
    );

    expect(proposals.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'LP-NOTIFICATION_FATIGUE-andon-30d-high',
        kind: 'rule_threshold',
        change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.7, candidateValue: 0.78 },
      }),
      ORG,
      'lead.chen',
    );
    expect(result.signal.status).toBe('promoted');
    expect(result.signal.promotedProposalId).toBe('LP-NOTIFICATION_FATIGUE-andon-30d-high');
    expect(signals[0].status).toBe('promoted');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'learning.signal_promoted', entityId: 'SIG-NOTIFICATION_FATIGUE-andon-30d-high' }),
    );
  });

  it('不可执行的信号 → 400 且带理由（不生成提案）', async () => {
    const { db } = withSignal({
      signalId: 'SIG-DATA_QUALITY_BACKLOG-quality-alerts-30d-medium',
      kind: 'data_quality_backlog',
      ruleId: null,
      parameter: null,
      baselineValue: null,
      direction: null,
      notActionableReason: '数据质量积压属于运营问题，不是策略阈值问题',
    });
    const proposals = thresholdService();
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      proposals as never,
    );
    await expect(
      service.promote('SIG-DATA_QUALITY_BACKLOG-quality-alerts-30d-medium', { candidateValue: 0.8 }, ACTOR),
    ).rejects.toThrow(BadRequestException);
    expect(proposals.propose).not.toHaveBeenCalled();
  });

  it('基线漂移（扫描后阈值被改） → 409，不拿过期依据生成提案', async () => {
    const { db } = withSignal();
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService(0.75) as never,
    );
    await expect(
      service.promote('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { candidateValue: 0.8 }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('生效阈值未知 → 409（不猜基线）', async () => {
    const { db } = withSignal();
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService(null, 'engine_default_unknown') as never,
    );
    await expect(
      service.promote('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { candidateValue: 0.8 }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('已转提案/已忽略的信号 → 409；候选值等于基线 → 400；越界 → 400', async () => {
    const promoted = withSignal({ status: 'promoted', promotedProposalId: 'LP-X' });
    const serviceA = new LearningSignalService(
      promoted.db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(
      serviceA.promote('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { candidateValue: 0.8 }, ACTOR),
    ).rejects.toThrow(ConflictException);

    const dismissed = withSignal({ status: 'dismissed', decidedReason: '已知积压' });
    const serviceB = new LearningSignalService(
      dismissed.db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(
      serviceB.promote('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { candidateValue: 0.8 }, ACTOR),
    ).rejects.toThrow(ConflictException);

    const open = withSignal();
    const serviceC = new LearningSignalService(
      open.db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(
      serviceC.promote('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { candidateValue: 0.7 }, ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      serviceC.promote('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { candidateValue: 1.4 }, ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('信号不存在 → 404（不静默创建）', async () => {
    const { db } = withSignal();
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(service.promote('SIG-NOPE', { candidateValue: 0.8 }, ACTOR)).rejects.toThrow(NotFoundException);
  });
});

describe('LearningSignalService.dismiss（人点"忽略"）', () => {
  function withSignal(overrides: Record<string, unknown> = {}) {
    return createSignalDb({
      signals: [
        {
          orgId: ORG,
          signalId: 'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
          kind: 'notification_fatigue',
          severity: 'high',
          status: 'open',
          subjectKey: 'andon',
          windowDays: 30,
          sampleSize: 20,
          confidence: 'medium',
          direction: 'raise',
          ruleId: 'rule:worker-overload',
          parameter: 'workloadThreshold',
          baselineValue: 0.7,
          metricsJson: {},
          evidenceJson: [],
          narrativeJson: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          recordJson: {},
          ...overrides,
        },
      ],
    });
  }

  it('必须给理由（否则 400）', async () => {
    const { db } = withSignal();
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(service.dismiss('SIG-NOTIFICATION_FATIGUE-andon-30d-high', {}, ACTOR)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.dismiss('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { reason: '   ' }, ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('忽略成功 → 落决定人/理由并审计', async () => {
    const { db, signals } = withSignal();
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    const service = new LearningSignalService(db as never, audit as never, thresholdService() as never);
    const result = await service.dismiss(
      'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
      { reason: '同一批安灯已在班次工作台处理' },
      ACTOR,
    );
    expect(result.status).toBe('dismissed');
    expect(signals[0].decidedBy).toBe('lead.chen');
    expect(signals[0].decidedReason).toBe('同一批安灯已在班次工作台处理');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'learning.signal_dismissed', reason: '同一批安灯已在班次工作台处理' }),
    );
  });

  it('已决定的信号不可重复决定 → 409（不覆盖第一次的人决定）', async () => {
    const { db } = withSignal({ status: 'promoted', promotedProposalId: 'LP-X' });
    const service = new LearningSignalService(
      db as never,
      { appendAuditLog: jest.fn(async () => undefined) } as never,
      thresholdService() as never,
    );
    await expect(
      service.dismiss('SIG-NOTIFICATION_FATIGUE-andon-30d-high', { reason: '不做了' }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });
});
