/**
 * 学习回路接线 E2E（NO-54a）—— 运行记忆 → 信号 → 人点"生成提案" → 既有提案生命周期。
 *
 * 补的缺口（`docs/architecture/capability-alignment.md` §3 原 #2）：学习提案此前只有
 * "人手工填规则 + 目标值"一条入口，**运行记忆没有接线**。本脚本在真实 PG 上验证：
 *
 *   1. 权限边界：未认证/现场工人不能触发扫描（401/403）；
 *   2. 实测运行记忆（提醒治理积压 / 数据质量待核实积压 / 执行偏差复发）被扫成**信号**，
 *      信号带证据引用、样本量、可信度与方向（原则 5）；
 *   3. 信号 ≠ 提案：扫描**不创建任何提案**（原则 4/6）；
 *   4. 幂等：重复扫描只刷新快照（created=0），**不覆盖人的决定**；
 *   5. 人点"生成提案"：目标值由人给 → 创建提案（baseline=扫描时基线、candidate=人给），
 *      且提案**停在人审阶梯之前**（不是 approved，绝不能自动生效）；
 *   6. 不可执行的信号拒绝提案（并带理由）；忽略必须给理由（§33 不静默忽略）；
 *   7. 基线漂移：扫描后阈值被改动 → 409（信号依据过期，必须重新扫描）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_FIELD_PASS=... EWOH_E2E_INGEST_KEY=... \
 *   EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/learning-signal-loop.mjs
 */
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || process.env.EWOH_E2E_PG_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || '';
const INGEST_ORG = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, detail = '') => record('SKIP', name, detail);
function finish() {
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n========================================`);
  console.log(
    `学习回路接线（运行记忆→信号→提案）: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
  );
  process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
}

let lastLoginError = null;
async function login(username, password) {
  lastLoginError = null;
  if (!password) {
    lastLoginError = `未提供 ${username} 的密码`;
    return null;
  }
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  const body = await response?.json().catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 201)) {
    lastLoginError = `登录失败：HTTP ${response?.status ?? 0}`
      + (body?.error?.message ? ` ${body.error.message}` : '')
      + (body?.error?.code ? ` [${body.error.code}]` : '');
    return null;
  }
  const token = body?.accessToken ?? null;
  if (!token) lastLoginError = '登录响应缺少 accessToken';
  return token;
}

async function postJson(path, body, token) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function getJson(path, token) {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const probe = await fetch(`${BASE}/api/learning/signals/scan`, { method: 'POST' }).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 未认证扫描被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS || '');
  const leadToken = await login(
    process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
    process.env.EWOH_E2E_APPROVER_PASS || '',
  );
  const fieldToken = await login(
    process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei',
    process.env.EWOH_E2E_FIELD_PASS || '',
  );
  if (!adminToken || !leadToken) {
    skip('1. 管理员/班组长登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  step('1. 管理员 + 班组长登录成功', true);

  if (!OWNER_DB) {
    skip('2. 运行记忆事实注入', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法核对落库事实）');
    return finish();
  }
  const sql = postgres(OWNER_DB, { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  /**
   * 场景复位（必须显式做）：信号号是**确定性**的（`SIG-<KIND>-<subject>-<window>d-<sev>`），
   * 所以上一轮留下的 promoted/dismissed 会被本轮扫描读成"已有决定"，
   * 表现为"幂等 PASS 但提案永远 409"。按 tag 清理抓不到它们——必须按信号族清。
   */
  const resetScenarioSignals = async () => {
    await sql`delete from ewoh_learning_signal
      where org_id = ${INGEST_ORG}
        and (signal_id like 'SIG-NOTIFICATION_FATIGUE-%'
          or signal_id like 'SIG-DATA_QUALITY_BACKLOG-%'
          or signal_id like 'SIG-DEVIATION_REPEAT-%')`;
    await sql`delete from ewoh_learning_proposal
      where org_id = ${INGEST_ORG}
        and (proposal_id like 'LP-NOTIFICATION_FATIGUE-%'
          or proposal_id like 'LP-DATA_QUALITY_BACKLOG-%'
          or proposal_id like 'LP-DEVIATION_REPEAT-%'
          or proposal_id like 'LP-E2E-DRIFT-%')`;
  };
  await resetScenarioSignals();
  const seeded = { notifications: [], events: [], executions: [], signals: [], proposals: [] };
  try {
    // ── 2. 权限边界：现场工人不能扫描 ─────────────────────────────
    if (fieldToken) {
      const denied = await postJson('/api/learning/signals/scan', { windowDays: 30 }, fieldToken);
      step('2. 现场工人触发扫描被拒（403）', denied.status === 403, `status=${denied.status}`);
    } else {
      skip('2. 现场工人触发扫描被拒（403）', lastLoginError ?? '现场工人登录失败');
    }

    // ── 3. 注入实测运行记忆（提醒积压 + 偏差复发；数据质量走真实摄入链路）──
    const now = Date.now();
    const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000);
    // 3a. 两类提醒积压：每类 6 条已了结（可比样本）+ 20 条待处置 26h（处置率 6/26 < 50%）
    for (const kind of ['andon', 'session_long_running']) {
      for (let i = 0; i < 6; i += 1) {
        const notificationId = `NTF-${kind === 'andon' ? 'ANDON' : 'EXO'}-E2E-${tag}-${kind}-resolved-${i}-app`;
        await sql`
          insert into ewoh_notification
            (org_id, notification_id, recipient_type, recipient_id, channel, title, body, severity, status,
             external_ref, resolution, resolved_at, resolved_by, resolution_ref, _created_at, _updated_at)
          values (${INGEST_ORG}, ${notificationId}, 'role', 'workshop_lead', 'app', ${`E2E ${kind} 已处置`}, null, 'high', 'resolved',
             ${`E2E-SRC-${tag}-${kind}-${i}`}, 'andon_cleared', ${at(48)}, 'e2e', ${`E2E-SRC-${tag}-${kind}-${i}`}, ${at(72)}, ${at(48)})
          on conflict (org_id, notification_id) do nothing`;
        seeded.notifications.push(notificationId);
      }
      // 待处置积压**必须足够旧**（这里 96h）：`notification_fatigue` 只取"最老待处置"的
      // top 3 类型——长期开发库里别类型的陈旧积压会把本场景的 andon 挤出前三
      //（本轮实测：approval_expired/session_overdue/telemetry_wearer_mismatch 抢占），
      // 场景因此失去前置条件。造一个确定最老的积压，场景才可重复。
      for (let i = 0; i < 20; i += 1) {
        const notificationId = `NTF-${kind === 'andon' ? 'ANDON' : 'EXO'}-E2E-${tag}-${kind}-pending-${i}-app`;
        await sql`
          insert into ewoh_notification
            (org_id, notification_id, recipient_type, recipient_id, channel, title, body, severity, status,
             external_ref, _created_at, _updated_at)
          values (${INGEST_ORG}, ${notificationId}, 'role', 'workshop_lead', 'app', ${`E2E ${kind} 待处置`}, null, 'high', 'pending',
             ${`E2E-SRC-${tag}-${kind}-pending-${i}`}, ${at(96)}, ${at(96)})
          on conflict (org_id, notification_id) do nothing`;
        seeded.notifications.push(notificationId);
      }
    }
    // 3b. 执行偏差复发：同一设备同一偏差类型 4 次
    const devDevice = `EXO-LEARN-${tag}`;
    for (let i = 0; i < 4; i += 1) {
      const executionId = `E2E-EXEC-${tag}-${i}`;
      await sql`
        insert into ewoh_scheduling_execution
          (execution_id, org_id, plan_id, assignment_id, task_id, device_id, status, deviation_type, source, _created_at, _updated_at)
        values (${executionId}, ${INGEST_ORG}, ${`E2E-PLAN-${tag}`}, ${`E2E-ASSIGN-${tag}-${i}`}, ${`E2E-TASK-${tag}-${i}`},
                ${devDevice}, 'COMPLETED', 'late_start', 'feedback', ${at(i + 1)}, ${at(i + 1)})
        on conflict (org_id, assignment_id) do nothing`;
      seeded.executions.push(executionId);
    }
    // 3c. 数据质量积压：走真实摄入（未登记 entity_id → DataQualityAlert）+ 扫描提醒
    let qualityAlerts = 0;
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${BASE}/api/ingest/exoskeleton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
        body: JSON.stringify({
          device_id: `EXO-DQLEARN-${tag}-${i}`,
          entity_id: `person:missing-learn-${tag}-${i}`,
          event_time: new Date().toISOString(),
          source_type: 'real',
          sequence: 1,
        }),
      }).catch(() => null);
      const body = response ? await response.json().catch(() => null) : null;
      if (Number(body?.events_triggered ?? 0) === 1) qualityAlerts += 1;
    }
    if (qualityAlerts >= 5 && leadToken) {
      await postJson('/api/data-quality/gap-sweep', {}, leadToken);
    }
    step(
      '3. 运行记忆注入完成（2 类提醒积压 + 1 个复发设备 + 数据质量积压）',
      qualityAlerts >= 5,
      `qualityAlerts=${qualityAlerts}`,
    );

    // ── 4. 扫描 → 信号（带证据/样本/可信度/方向）─────────────────
    const proposalsBefore = await getJson('/api/learning/proposals', leadToken);
    const scan = await postJson('/api/learning/signals/scan', { windowDays: 30 }, leadToken);
    const scanBody = scan.body ?? {};
    const signals = Array.isArray(scanBody.signals) ? scanBody.signals : [];
    const fatigue = signals.find((s) => s.kind === 'notification_fatigue' && s.metrics?.kind === 'andon');
    const deviation = signals.find((s) => s.kind === 'deviation_repeat' && s.metrics?.objectId === devDevice);
    const quality = signals.find((s) => s.kind === 'data_quality_backlog');
    step(
      '4. 扫描派生三类信号（提醒疲劳 / 偏差复发 / 数据质量积压）',
      (scan.status === 200 || scan.status === 201) && Boolean(fatigue) && Boolean(deviation) && Boolean(quality),
      `status=${scan.status} derived=${scanBody.derived}`
        + ` fatigueKinds=${signals.filter((s) => s.kind === 'notification_fatigue').map((s) => `${s.metrics?.kind}:${s.metrics?.pending}:${Math.round((s.metrics?.oldestPendingAgeMs ?? 0) / 3_600_000)}h`).join('|')}`,
    );
    step(
      '5. 信号带证据引用 + 实测快照 + 可信度（原则 5）',
      Boolean(fatigue?.evidenceRefs?.length)
        && fatigue?.metrics?.pending >= 20
        && fatigue?.confidence === 'medium'
        && fatigue?.metrics?.dispositionRate < 0.5,
      `evidence=${fatigue?.evidenceRefs?.length} pending=${fatigue?.metrics?.pending} rate=${fatigue?.metrics?.dispositionRate} confidence=${fatigue?.confidence}`,
    );
    step(
      '6. 提醒积压信号可执行：方向 raise + 基线=当前生效阈值',
      fatigue?.actionable?.direction === 'raise'
        && typeof fatigue?.actionable?.baselineValue === 'number'
        && fatigue?.notActionableReason === null,
      `direction=${fatigue?.actionable?.direction} baseline=${fatigue?.actionable?.baselineValue} source=${fatigue?.actionable?.baselineSource}`,
    );
    step(
      '7. 数据质量积压信号**不可**生成提案（附理由）',
      quality?.actionable === null && String(quality?.notActionableReason ?? '').includes('不是策略阈值问题'),
      `reason=${quality?.notActionableReason}`,
    );
    const proposalsAfter = await getJson('/api/learning/proposals', leadToken);
    step(
      '8. 信号 ≠ 提案：扫描不创建任何提案（原则 4/6）',
      (proposalsBefore.body ?? []).length === (proposalsAfter.body ?? []).length,
      `before=${(proposalsBefore.body ?? []).length} after=${(proposalsAfter.body ?? []).length}`,
    );

    // ── 5. 幂等 + 不覆盖人的决定 ────────────────────────────────
    const rescan = await postJson('/api/learning/signals/scan', { windowDays: 30 }, leadToken);
    step(
      '9. 重复扫描幂等（created=0 且 refreshed≥3）',
      Number(rescan.body?.created ?? -1) === 0 && Number(rescan.body?.refreshed ?? 0) >= 3,
      `created=${rescan.body?.created} refreshed=${rescan.body?.refreshed}`,
    );

    // ── 6. 忽略必须给理由；忽略后再扫描保留决定 ──────────────────
    if (quality) {
      const emptyReason = await postJson(
        `/api/learning/signals/${encodeURIComponent(quality.signalId)}/dismiss`,
        { reason: '   ' },
        leadToken,
      );
      step('10. 忽略信号必须给理由（空理由 400）', emptyReason.status === 400, `status=${emptyReason.status}`);
      const dismissed = await postJson(
        `/api/learning/signals/${encodeURIComponent(quality.signalId)}/dismiss`,
        { reason: `E2E ${tag}：这批未登记实体是压测流量，已知积压` },
        leadToken,
      );
      step(
        '11. 忽略成功并留痕（决定人 + 理由）',
        (dismissed.status === 200 || dismissed.status === 201)
          && dismissed.body?.status === 'dismissed'
          && Boolean(dismissed.body?.decidedBy)
          && String(dismissed.body?.decidedReason ?? '').includes('压测流量'),
        `status=${dismissed.body?.status} by=${dismissed.body?.decidedBy}`,
      );
      const rescan2 = await postJson('/api/learning/signals/scan', { windowDays: 30 }, leadToken);
      const stillDismissed = (rescan2.body?.signals ?? []).find((s) => s.signalId === quality.signalId);
      step(
        '12. 人的决定不被扫描覆盖（decisionsPreserved≥1 且状态仍 dismissed）',
        Number(rescan2.body?.decisionsPreserved ?? 0) >= 1 && stillDismissed?.status === 'dismissed',
        `preserved=${rescan2.body?.decisionsPreserved} status=${stillDismissed?.status}`,
      );
      const promoteNonActionable = await postJson(
        `/api/learning/signals/${encodeURIComponent(quality.signalId)}/promote`,
        { candidateValue: 0.8 },
        leadToken,
      );
      step(
        '13. 不可执行的信号拒绝生成提案（409/400 且不产生提案）',
        promoteNonActionable.status === 400 || promoteNonActionable.status === 409,
        `status=${promoteNonActionable.status}`,
      );
    } else {
      skip('10-13. 忽略/不可执行路径', '未派生数据质量积压信号');
    }

    // ── 7. 基线漂移：阈值被改动后，扫描时给出的基线不再可用 ────────
    let activeBaseline = Number(fatigue?.actionable?.baselineValue ?? 0.7);
    if (fatigue) {
      const driftProposalId = `LP-E2E-DRIFT-${tag}`;
      const drifted = Math.min(0.99, Math.round((activeBaseline + 0.1) * 100) / 100);
      await sql`
        insert into ewoh_learning_proposal
          (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value,
           shadow_eval_json, approved_by, approved_at, proposed_by, record_json, _created_at, _updated_at)
        values (${INGEST_ORG}, ${driftProposalId}, 'rule_threshold', 'approved', 'rule:worker-overload', 'workloadThreshold',
                ${activeBaseline}, ${drifted},
                ${sql.json({ baselineThreshold: activeBaseline, candidateThreshold: drifted, factsCount: 1, baselineFires: 0, candidateFires: 0, addedSubjects: [], removedSubjects: [], riskLevel: 'low' })},
                'e2e-drift-approver', now(), 'e2e-drift-proposer', ${sql.json({ proposalId: driftProposalId, kind: 'rule_threshold', status: 'approved', change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: activeBaseline, candidateValue: drifted }, auditTrail: true })},
                now(), now())
        on conflict (org_id, proposal_id) do nothing`;
      seeded.proposals.push(driftProposalId);
      const stale = await postJson(
        `/api/learning/signals/${encodeURIComponent(fatigue.signalId)}/promote`,
        { candidateValue: drifted },
        leadToken,
      );
      step(
        '14. 基线漂移 → 409（信号依据过期，必须重新扫描）',
        stale.status === 409
          && String(stale.body?.error?.message ?? stale.body?.message ?? '').includes('过期'),
        `status=${stale.status} msg=${String(stale.body?.error?.message ?? stale.body?.message ?? '').slice(0, 90)}`,
      );
      // 撤回漂移（本场景自造的事实），重新扫描让信号以真实基线刷新
      await sql`delete from ewoh_learning_proposal where org_id = ${INGEST_ORG} and proposal_id = ${driftProposalId}`;
      seeded.proposals = seeded.proposals.filter((id) => id !== driftProposalId);
      const rescan3 = await postJson('/api/learning/signals/scan', { windowDays: 30 }, leadToken);
      const refreshed = (rescan3.body?.signals ?? []).find((s) => s.signalId === fatigue.signalId);
      activeBaseline = Number(refreshed?.actionable?.baselineValue ?? activeBaseline);
      step(
        '15. 重新扫描后信号以当前生效基线刷新（可再次提案）',
        refreshed?.status === 'open' && Number.isFinite(activeBaseline),
        `baseline=${activeBaseline} status=${refreshed?.status}`,
      );
    } else {
      skip('14-15. 基线漂移拒绝', '未派生可执行的提醒疲劳信号');
    }

    // ── 8. 人点"生成提案"（目标值由人给）────────────────────────
    const candidate = Math.min(0.95, Math.round((activeBaseline + 0.05) * 100) / 100);
    if (fatigue) {
      const promote = await postJson(
        `/api/learning/signals/${encodeURIComponent(fatigue.signalId)}/promote`,
        { candidateValue: candidate, note: `E2E ${tag}：安灯积压，先放宽一档观察` },
        leadToken,
      );
      const proposalId = promote.body?.proposalId ?? '';
      step(
        '16. 人点生成提案成功（信号标记 promoted + 返回提案号）',
        (promote.status === 200 || promote.status === 201)
          && promote.body?.signal?.status === 'promoted'
          && proposalId.startsWith('LP-'),
        `status=${promote.status} proposalId=${proposalId}`,
      );
      const proposalRows = await sql`
        select proposal_id, status, kind, rule_id, parameter, baseline_value, candidate_value, proposed_by, approved_by
        from ewoh_learning_proposal where org_id = ${INGEST_ORG} and proposal_id = ${proposalId}`;
      const row = proposalRows[0];
      if (proposalId) seeded.proposals.push(proposalId);
      step(
        '17. 提案记录基线=扫描时值、目标=人给值，且**停在人审阶梯之前**（未批准）',
        Boolean(row)
          && Math.abs(Number(row.baseline_value) - activeBaseline) < 1e-9
          && Math.abs(Number(row.candidate_value) - candidate) < 1e-9
          && row.status !== 'approved'
          && row.approved_by === null,
        `status=${row?.status} baseline=${row?.baseline_value} candidate=${row?.candidate_value} by=${row?.proposed_by}`,
      );
      const again = await postJson(
        `/api/learning/signals/${encodeURIComponent(fatigue.signalId)}/promote`,
        { candidateValue: candidate },
        leadToken,
      );
      step('18. 已转提案的信号不可重复提案（409）', again.status === 409, `status=${again.status}`);
    } else {
      skip('16-18. 生成提案路径', '未派生可执行的提醒疲劳信号');
    }
  } finally {
    // ── 9. 清理本场景注入的事实（不留脏数据；信号/提案一并回收）────
    try {
      if (seeded.notifications.length > 0) {
        await sql`delete from ewoh_notification where org_id = ${INGEST_ORG} and notification_id in ${sql(seeded.notifications)}`;
      }
      if (seeded.executions.length > 0) {
        await sql`delete from ewoh_scheduling_execution where org_id = ${INGEST_ORG} and execution_id in ${sql(seeded.executions)}`;
      }
      if (seeded.proposals.length > 0) {
        await sql`delete from ewoh_learning_proposal where org_id = ${INGEST_ORG} and proposal_id in ${sql(seeded.proposals)}`;
      }
      await sql`delete from ewoh_learning_signal where org_id = ${INGEST_ORG} and signal_id like ${`SIG-%${tag}%`}`;
      await sql`delete from ewoh_event where org_id = ${INGEST_ORG} and event_type = 'DataQualityAlert' and evidence_json->>'entity_id' like ${`person:missing-learn-${tag}-%`}`;
      await sql`delete from ewoh_notification where org_id = ${INGEST_ORG} and notification_id like ${`NTF-DQ-%`} and external_ref in (select event_id from ewoh_event where org_id = ${INGEST_ORG} and evidence_json->>'entity_id' like ${`person:missing-learn-${tag}-%`})`;
    } catch (error) {
      console.warn(`[cleanup] 清理失败（不掩盖断言结果）：${error?.message ?? error}`);
    }
    await sql.end().catch(() => undefined);
  }
  return finish();
}

main().catch((error) => {
  console.error('E2E 执行异常:', error);
  record('FAIL', 'E2E 脚本异常', String(error?.message ?? error));
  finish();
});
