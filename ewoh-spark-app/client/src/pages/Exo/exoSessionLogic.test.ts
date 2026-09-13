/* 外骨骼会话工作台纯逻辑测试（NO-33a）。
 *
 * 钉死：时长口径（进行中=至今 / 终态=起止差 / 时间非法=未知）、长时间未收工告警、
 * 状态文案（未登记原样透出）、缺口如实标注、进行中长会话排序优先、中止必须写理由。
 */
/// <reference types="jest" />
import {
  LONG_SESSION_THRESHOLD_MS,
  abortReasonError,
  buildDeviationReviewRows,
  buildExoSessionRows,
  exoSessionStatusLabel,
  formatDeviation,
  formatDuration,
  formatEvidenceAge,
  formatSignedDeviation,
  isExoVerdictActionable,
  planWearerCorrection,
  summarizeExoSessions,
} from './exoSessionLogic';

const NOW = Date.parse('2026-09-12T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('exoSessionStatusLabel', () => {
  it('三种契约状态有中文标签，未登记状态原样透出，缺失说"未记录"', () => {
    expect(exoSessionStatusLabel('active')).toBe('进行中');
    expect(exoSessionStatusLabel('ended')).toBe('已结束');
    expect(exoSessionStatusLabel('aborted')).toBe('已中止');
    expect(exoSessionStatusLabel('paused')).toBe('paused');
    expect(exoSessionStatusLabel(null)).toContain('未记录');
  });
});

describe('任务绑定字段（NO-40a）', () => {
  it('透传关联任务与预计结束来源；缺省一律为 null（不猜）', () => {
    const rows = buildExoSessionRows(
      [
        {
          sessionId: 'S-BOUND',
          status: 'active',
          startedAt: iso(NOW - 60_000),
          expectedEndAt: iso(NOW + 3_600_000),
          expectedEndSource: 'task_plan_end',
          taskId: 'TASK-1',
        },
        { sessionId: 'S-PLAIN', status: 'active', startedAt: iso(NOW - 60_000) },
        // 非法来源值不得被当作已知来源（fail-closed 到"未记录"）
        { sessionId: 'S-BAD', status: 'active', startedAt: iso(NOW), expectedEndSource: 'guess' as never },
      ],
      { nowMs: NOW },
    );
    const bound = rows.find((r) => r.sessionId === 'S-BOUND')!;
    expect(bound.taskId).toBe('TASK-1');
    expect(bound.expectedEndSource).toBe('task_plan_end');
    const plain = rows.find((r) => r.sessionId === 'S-PLAIN')!;
    expect(plain.taskId).toBeNull();
    expect(plain.expectedEndSource).toBeNull();
    expect(rows.find((r) => r.sessionId === 'S-BAD')!.expectedEndSource).toBeNull();
  });
});

describe('formatDuration', () => {
  it('分钟/小时/天三档 + 不足 1 分钟 + 未知', () => {
    expect(formatDuration(30_000)).toBe('不足 1 分钟');
    expect(formatDuration(45 * 60_000)).toBe('45 分钟');
    expect(formatDuration(2 * 3_600_000 + 10 * 60_000)).toBe('2 小时 10 分');
    expect(formatDuration(3 * 3_600_000)).toBe('3 小时');
    expect(formatDuration(50 * 3_600_000)).toBe('2 天 2 小时');
    expect(formatDuration(null)).toBe('时长未知');
    expect(formatDuration(Number.NaN)).toBe('时长未知');
    expect(formatDuration(-1000)).toBe('时长未知');
  });
});

describe('buildExoSessionRows', () => {
  it('进行中会话时长=至今；终态=起止之差', () => {
    const rows = buildExoSessionRows(
      [
        { sessionId: 'S-1', exoId: 'EXO-1', personId: 'P-1', status: 'active', startedAt: iso(NOW - 90 * 60_000) },
        {
          sessionId: 'S-2',
          exoId: 'EXO-2',
          personId: 'P-2',
          status: 'ended',
          startedAt: iso(NOW - 3 * 3_600_000),
          actualEndAt: iso(NOW - 2 * 3_600_000),
          endedBy: 'worker.li',
        },
      ],
      { nowMs: NOW },
    );
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    expect(byId.get('S-1')).toMatchObject({ durationLabel: '1 小时 30 分', isActive: true });
    expect(byId.get('S-2')).toMatchObject({ durationLabel: '1 小时', isActive: false });
    expect(byId.get('S-2')?.endedBy).toBe('worker.li');
  });

  it('超过阈值（默认 4 小时）的进行中会话 → 提示核实是否忘记收工', () => {
    const rows = buildExoSessionRows(
      [{ sessionId: 'S-1', exoId: 'EXO-1', personId: 'P-1', status: 'active', startedAt: iso(NOW - 5 * 3_600_000) }],
      { nowMs: NOW },
    );
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].attentionLabel).toContain('超过 4 小时');
    expect(rows[0].attentionLabel).toContain('忘记收工');
    expect(LONG_SESSION_THRESHOLD_MS).toBe(4 * 3_600_000);
  });

  it('终态会话即使超过 4 小时也不告警（已经收工，不需要核实）', () => {
    const rows = buildExoSessionRows(
      [
        {
          sessionId: 'S-1',
          status: 'ended',
          startedAt: iso(NOW - 8 * 3_600_000),
          actualEndAt: iso(NOW - 3 * 3_600_000),
        },
      ],
      { nowMs: NOW },
    );
    expect(rows[0].needsAttention).toBe(false);
    expect(rows[0].attentionLabel).toBeNull();
  });

  it('时间非法/缺失 → 时长未知（不猜），状态仍如实展示', () => {
    const rows = buildExoSessionRows([{ sessionId: 'S-1', status: 'active', startedAt: 'not-a-date' }], { nowMs: NOW });
    expect(rows[0]).toMatchObject({ durationMs: null, durationLabel: '时长未知', needsAttention: false });
  });

  it('缺口如实：缺设备/人员/结束人 → null（UI 显示"未记录"），不补默认值', () => {
    const rows = buildExoSessionRows([{ sessionId: 'S-1', status: 'active', startedAt: iso(NOW) }], { nowMs: NOW });
    expect(rows[0]).toMatchObject({ exoId: null, personId: null, endedBy: null, reason: null });
  });

  it('排序：进行中优先，且同进行中按时长最长优先，其余按开始时间倒序', () => {
    const rows = buildExoSessionRows(
      [
        { sessionId: 'A-old-ended', status: 'ended', startedAt: iso(NOW - 10 * 3_600_000), actualEndAt: iso(NOW - 9 * 3_600_000) },
        { sessionId: 'B-active-short', status: 'active', startedAt: iso(NOW - 10 * 60_000) },
        { sessionId: 'C-active-long', status: 'active', startedAt: iso(NOW - 5 * 3_600_000) },
        { sessionId: 'D-ended-recent', status: 'ended', startedAt: iso(NOW - 3_600_000), actualEndAt: iso(NOW - 1_800_000) },
      ],
      { nowMs: NOW },
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['C-active-long', 'B-active-short', 'D-ended-recent', 'A-old-ended']);
  });

  it('会话号缺失 → 明确占位（不显示空白行）', () => {
    expect(buildExoSessionRows([{ status: 'active' }], { nowMs: NOW })[0].sessionId).toContain('未记录');
  });
});

describe('summarizeExoSessions', () => {
  it('计数与"需核实未收工"提示', () => {
    const rows = buildExoSessionRows(
      [
        { sessionId: 'S-1', status: 'active', startedAt: iso(NOW - 5 * 3_600_000) },
        { sessionId: 'S-2', status: 'active', startedAt: iso(NOW - 60_000) },
        { sessionId: 'S-3', status: 'ended', startedAt: iso(NOW - 3_600_000), actualEndAt: iso(NOW - 60_000) },
        { sessionId: 'S-4', status: 'aborted', startedAt: iso(NOW - 3_600_000), actualEndAt: iso(NOW - 60_000) },
      ],
      { nowMs: NOW },
    );
    const summary = summarizeExoSessions(rows);
    expect(summary).toMatchObject({ total: 4, active: 2, ended: 1, aborted: 1, attention: 1 });
    expect(summary.label).toContain('进行中 2');
    expect(summary.label).toContain('需核实未收工 1 台');
  });

  it('没有会话记录也要说清楚（不留白）', () => {
    expect(summarizeExoSessions([]).label).toContain('当前没有外骨骼会话记录');
  });
});

describe('abortReasonError', () => {
  it('中止必须写理由（结束事实要完整）', () => {
    expect(abortReasonError('')).toContain('必须填写理由');
    expect(abortReasonError('   ')).toContain('必须填写理由');
    expect(abortReasonError('人员不适，提前收工')).toBeNull();
  });
});

/* ── NO-36b：预计 vs 实际（运行记忆在界面上的口径）────────────────────────── */
describe('预计 vs 实际（偏差）', () => {
  it('终态超时 → 偏差为正、状态 over、文案"超时 X 结束"', () => {
    const rows = buildExoSessionRows(
      [
        {
          sessionId: 'S-over',
          status: 'ended',
          startedAt: iso(NOW - 3 * 3_600_000),
          expectedEndAt: iso(NOW - 2 * 3_600_000),
          actualEndAt: iso(NOW - 30 * 60_000),
        },
      ],
      { nowMs: NOW },
    );
    expect(rows[0].deviationState).toBe('over');
    expect(rows[0].deviationMs).toBe(90 * 60_000);
    expect(rows[0].deviationLabel).toBe('超时 1 小时 30 分 结束');
  });

  it('终态提前 → early；容差内 → on_time（不把 3 分钟说成重大偏差）', () => {
    const rows = buildExoSessionRows(
      [
        {
          sessionId: 'S-early',
          status: 'ended',
          startedAt: iso(NOW - 3 * 3_600_000),
          expectedEndAt: iso(NOW),
          actualEndAt: iso(NOW - 40 * 60_000),
        },
        {
          sessionId: 'S-ontime',
          status: 'ended',
          startedAt: iso(NOW - 3 * 3_600_000),
          expectedEndAt: iso(NOW),
          actualEndAt: iso(NOW - 3 * 60_000),
        },
      ],
      { nowMs: NOW },
    );
    const early = rows.find((r) => r.sessionId === 'S-early')!;
    const onTime = rows.find((r) => r.sessionId === 'S-ontime')!;
    expect(early.deviationState).toBe('early');
    expect(early.deviationLabel).toContain('提前');
    expect(onTime.deviationState).toBe('on_time');
    expect(onTime.deviationLabel).toContain('在预计时间内');
  });

  it('没填预计结束时间 → 偏差 unknown 且文案明确"无法比较"（缺失 ≠ 准时）', () => {
    const rows = buildExoSessionRows(
      [
        {
          sessionId: 'S-no-plan',
          status: 'ended',
          startedAt: iso(NOW - 3_600_000),
          actualEndAt: iso(NOW - 60_000),
        },
      ],
      { nowMs: NOW },
    );
    expect(rows[0].deviationMs).toBeNull();
    expect(rows[0].deviationState).toBe('unknown');
    expect(rows[0].deviationLabel).toContain('未记录预计结束时间');
  });

  it('进行中：未到预计 → 显示剩余；已过预计 → overdue + 已超时（该催收工）', () => {
    const rows = buildExoSessionRows(
      [
        {
          sessionId: 'S-plan',
          status: 'active',
          startedAt: iso(NOW - 3_600_000),
          expectedEndAt: iso(NOW + 30 * 60_000),
        },
        {
          sessionId: 'S-late',
          status: 'active',
          startedAt: iso(NOW - 3 * 3_600_000),
          expectedEndAt: iso(NOW - 45 * 60_000),
        },
      ],
      { nowMs: NOW },
    );
    const remaining = rows.find((r) => r.sessionId === 'S-plan')!;
    const overdue = rows.find((r) => r.sessionId === 'S-late')!;
    expect(remaining.overdue).toBe(false);
    expect(remaining.remainingMs).toBe(30 * 60_000);
    expect(remaining.deviationState).toBe('unknown');
    expect(overdue.overdue).toBe(true);
    expect(overdue.overdueMs).toBe(45 * 60_000);
    expect(overdue.deviationMs).toBeNull();
  });
});

describe('formatDeviation', () => {
  it('unknown / 非法数值一律说"无法比较"，不冒充准时', () => {
    expect(formatDeviation(null, 'unknown')).toContain('未记录预计结束时间');
    expect(formatDeviation(Number.NaN, 'over')).toContain('未记录预计结束时间');
  });
});

/* ── NO-38a：偏差复盘展示行（比率由服务端判定，前端不重算、不补 0）────────── */
describe('偏差复盘展示行', () => {
  const group = (overrides: Record<string, unknown> = {}) => ({
    key: 'EXO-1',
    sessions: 4,
    comparable: 3,
    onTime: 2,
    early: 0,
    over: 1,
    notComparable: 1,
    onTimeRate: 2 / 3,
    meanDeviationMs: 20 * 60_000,
    medianDeviationMs: 0,
    worstOverMs: 60 * 60_000,
    bestEarlyMs: null,
    insufficientSample: false,
    notes: [],
    ...overrides,
  });

  it('比率来自服务端；样本概览把不可比条数写清楚', () => {
    const [row] = buildDeviationReviewRows([group()]);
    expect(row.sampleLabel).toBe('可比 3 / 共 4 条（1 条不可比）');
    expect(row.onTimeRateLabel).toBe('准时率 67%（2/3）');
    expect(row.deviationLabel).toContain('平均 +20 分钟');
    expect(row.deviationLabel).toContain('中位 ±不足 1 分钟');
    expect(row.deviationLabel).toContain('最差超时 1 小时');
    expect(row.hasOver).toBe(true);
  });

  it('样本不足：明确"证据不足（不给比率）"，绝不显示 0%', () => {
    const [row] = buildDeviationReviewRows([
      group({ comparable: 1, onTimeRate: null, insufficientSample: true, notes: ['可比样本仅 1 条'] }),
    ]);
    expect(row.onTimeRateLabel).toContain('证据不足');
    expect(row.onTimeRateLabel).not.toContain('0%');
    expect(row.notes).toEqual(['可比样本仅 1 条']);
  });

  it('合计行标签为"合计"；排序把"有超时"排前面、样本不足排最后', () => {
    const rows = buildDeviationReviewRows([
      group({ key: 'EXO-2', over: 0, onTime: 3 }),
      group({ key: 'EXO-3', over: 0, onTimeRate: null, insufficientSample: true }),
      group({ key: 'ALL', over: 1 }),
      group({ key: 'EXO-1', over: 1 }),
    ]);
    const labels = rows.map((row) => row.label);
    // 有超时的两组必须在最前（组内按标签稳定排序：'ALL' < 'EXO-1'）
    expect(labels.slice(0, 2)).toEqual(['合计', 'EXO-1']);
    // 没有超时的正常组居中，样本不足的排最后（"证据不足"不该占据前排）
    expect(labels.slice(2)).toEqual(['EXO-2', 'EXO-3']);
  });

  it('没有任何可计算偏差时如实说"暂无可计算的偏差"', () => {
    const [row] = buildDeviationReviewRows([
      group({
        comparable: 0,
        onTimeRate: null,
        meanDeviationMs: null,
        medianDeviationMs: null,
        worstOverMs: null,
        bestEarlyMs: null,
        insufficientSample: true,
      }),
    ]);
    expect(row.deviationLabel).toBe('暂无可计算的偏差');
  });
});

describe('formatSignedDeviation', () => {
  it('正=超时、负=提前、0=±、null=无', () => {
    expect(formatSignedDeviation(90 * 60_000)).toBe('+1 小时 30 分');
    expect(formatSignedDeviation(-15 * 60_000)).toBe('−15 分钟');
    expect(formatSignedDeviation(0)).toBe('±不足 1 分钟');
    expect(formatSignedDeviation(null)).toBe('无');
    expect(formatSignedDeviation(Number.NaN)).toBe('无');
  });
});

/* ── NO-43a：按实际佩戴人更正（人核实 → 落成事实）──────────────────────── */

describe('isExoVerdictActionable', () => {
  it('"要人问一句"的结论都算 actionable，一致/无证据不算', () => {
    expect(isExoVerdictActionable('wearer_mismatch')).toBe(true);
    expect(isExoVerdictActionable('inactive_suspect')).toBe(true);
    // 证据过期同样是"结论不可信"，不能当正常灰字显示（实测踩过：只按 needsHumanCheck 上色）
    expect(isExoVerdictActionable('stale_telemetry')).toBe(true);
    expect(isExoVerdictActionable('activity_only')).toBe(false);
    expect(isExoVerdictActionable('no_telemetry')).toBe(false);
    expect(isExoVerdictActionable('consistent')).toBe(false);
    // 未知结论按 0 处理：不夸大、也不假装认识
    expect(isExoVerdictActionable('something_new')).toBe(false);
    expect(isExoVerdictActionable(null)).toBe(false);
  });
});

describe('formatEvidenceAge', () => {
  it('不足 1 分钟说"1 分钟内"；有时长走 formatDuration；缺时间不编造', () => {
    expect(formatEvidenceAge(8_000)).toBe('1 分钟内');
    expect(formatEvidenceAge(5 * 60_000)).toBe('5 分钟前');
    expect(formatEvidenceAge(null)).toBe('时间未记录');
    expect(formatEvidenceAge(undefined)).toBe('时间未记录');
    expect(formatEvidenceAge(Number.NaN)).toBe('时间未记录');
    expect(formatEvidenceAge(-1)).toBe('时间未记录');
  });
});

describe('planWearerCorrection', () => {
  const activeSession = { sessionId: 'S-1', personId: 'person:P-1002', status: 'active' };
  const mismatch = {
    verdict: 'wearer_mismatch',
    reason: '两源不一致',
    sessionPersonRef: 'P-1002',
    telemetryWorkerRef: 'P-9999',
    evidenceAgeMs: 8_000,
    evidence: { ts: '2026-09-12T09:59:52.000Z' },
  };

  it('遥测指名了别人 → 给出规范化的更正对象，并把来源/时间/影响面/风险都写清', () => {
    const plan = planWearerCorrection(mismatch, activeSession);
    expect(plan.targetPersonId).toBe('person:P-9999');
    expect(plan.blockedReason).toBeNull();
    // 证据：哪一帧、多久以前、上报了谁（决策原则：建议必须显示来源与时间）
    expect(plan.evidenceLabel).toContain('P-9999');
    expect(plan.evidenceLabel).toContain('1 分钟内');
    expect(plan.evidenceLabel).toContain('2026-09-12T09:59:52.000Z');
    // 影响面：旧的收工留痕、新的开始、设备不自动交回
    expect(plan.impactLabel).toContain('P-1002');
    expect(plan.impactLabel).toContain('保留在台账');
    expect(plan.impactLabel).toContain('设备仍被占用');
    // 风险：证据可能失真，且要留审计；反向判断请用别的动作
    expect(plan.riskLabel).toContain('可能失真或滞后');
    expect(plan.riskLabel).toContain('结束会话');
  });

  it('已有 person: 前缀的会话佩戴人与裸 id 的遥测佩戴人等价 → 一致就不给更正动作', () => {
    const plan = planWearerCorrection(
      { ...mismatch, telemetryWorkerRef: 'P-1002' },
      activeSession,
    );
    expect(plan.targetPersonId).toBeNull();
    expect(plan.blockedReason).toContain('无需更正');
  });

  it('帧里没有佩戴人字段 → 不给更正对象（缺证据不能替人指认）', () => {
    const plan = planWearerCorrection(
      { ...mismatch, telemetryWorkerRef: null, evidence: { ts: null } },
      activeSession,
    );
    expect(plan.targetPersonId).toBeNull();
    expect(plan.blockedReason).toContain('无法确定更正对象');
  });

  it('结论不是"佩戴人不符" → 一律不可更正，且逐字说明原因', () => {
    for (const verdict of ['consistent', 'activity_only', 'inactive_suspect', 'stale_telemetry', 'no_telemetry']) {
      const plan = planWearerCorrection({ ...mismatch, verdict }, activeSession);
      expect(plan.targetPersonId).toBeNull();
      expect(plan.blockedReason).not.toBeNull();
      expect(plan.blockedReason).toContain(verdict);
    }
  });

  it('没有校验结论 / 会话已非进行中 → 明确拒绝而不是默默允许', () => {
    const noEvidence = planWearerCorrection(null, activeSession);
    expect(noEvidence.targetPersonId).toBeNull();
    expect(noEvidence.blockedReason).toContain('没有证据就不能更正');

    const ended = planWearerCorrection(mismatch, { ...activeSession, status: 'ended' });
    expect(ended.targetPersonId).toBeNull();
    expect(ended.blockedReason).toContain('只有进行中的会话');
  });

  it('missing status/缺少会话 → 不可更正（不猜会话状态）', () => {
    expect(planWearerCorrection(mismatch, null).targetPersonId).toBeNull();
    expect(planWearerCorrection(mismatch, { sessionId: 'S-1' }).targetPersonId).toBeNull();
  });
});
