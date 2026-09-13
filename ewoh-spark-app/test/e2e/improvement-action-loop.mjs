/**
 * 改进行动项闭环 E2E（NO-55a）—— 复盘经验/缺口 → 有人负责、有期限、有完成证据。
 *
 * 补的缺口：复盘能产出结构化经验条目与缺口清单，但条目落进复盘记录后就
 * **没有人负责、没有期限、没有完成证据**（"运行记忆 → 经验"有，"经验 → 行动"断着）。
 *
 * 真实 PG 上验证的语义：
 *   1. 权限边界：未认证/现场工人不能触发扫描（401/403）；
 *   2. 只扫**已发布**复盘：草稿不产生行动项；info 级经验只作记忆保留（不建待办）；
 *   3. 行动项带来源（复盘号）+ 证据（复盘/条目/缺口）+ 建议类型；
 *   4. 扫描**只读复盘记录**（不修改 lessons/gaps），且幂等（第二次 refreshed）；
 *   5. 接受必须给负责人 + 期限 + 验收判据（平台不替现场承诺期限）；重复接受 409；
 *   6. 完成必须给结果说明；只有已接受可完成；完成后再改 409；
 *   7. 拒绝/放弃必须给理由；终态不可再转移；
 *   8. 重复扫描**不覆盖人的决定**（decisionsPreserved = 3，状态原样保留）；
 *   9. 逾期待办只包含"已接受 + 到期已过"的行。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_FIELD_PASS=... EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/improvement-action-loop.mjs
 */
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || process.env.EWOH_E2E_PG_URL || '';
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
    `改进行动项闭环（复盘经验→行动）: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
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
  const probe = await fetch(`${BASE}/api/learning/actions/scan`, { method: 'POST' }).catch(() => null);
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
    skip('2. 复盘运行记忆注入', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法核对落库事实）');
    return finish();
  }
  const sql = postgres(OWNER_DB, { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const retrospectiveId = `RTR-E2E-LEARN-${tag}`;
  const draftId = `RTR-E2E-DRAFT-${tag}`;
  const lessons = [
    { title: `E2E ${tag} 交接未核对备用设备`, detail: '交接清单缺备用设备状态，导致离线后无替代', severity: 'critical', evidenceIds: [`EVT-${tag}-1`] },
    { title: `E2E ${tag} 停机时长未记录`, detail: '回执里没有停机时长，复盘只能定性', severity: 'warning', evidenceIds: [`EVT-${tag}-2`] },
    { title: `E2E ${tag} 仅供参考的信息条目`, detail: 'info 级只作记忆保留', severity: 'info', evidenceIds: [] },
  ];
  const gaps = [`E2E ${tag} 缺少设备停机时长证据`];
  try {
    // ── 2. 注入：一篇已发布复盘（经验 + 缺口）+ 一篇草稿（不应产生行动项）──
    await sql`
      insert into ewoh_retrospective
        (org_id, retrospective_id, scope, target_id, title, status, assembled_json, lessons_json,
         narrative, narrative_source, published_at, _created_at, _updated_at)
      values (${INGEST_ORG}, ${retrospectiveId}, 'incident', ${`DEV-${tag}`}, ${`E2E ${tag} 设备离线复盘`}, 'published',
              ${sql.json({ gaps })}, ${sql.json(lessons)},
              ${'rule_fallback 总结'}, 'rule_fallback', now(), now(), now())
      on conflict (org_id, retrospective_id) do nothing`;
    await sql`
      insert into ewoh_retrospective
        (org_id, retrospective_id, scope, target_id, title, status, assembled_json, lessons_json, _created_at, _updated_at)
      values (${INGEST_ORG}, ${draftId}, 'incident', ${`DEV-${tag}-DRAFT`}, ${`E2E ${tag} 草稿复盘`}, 'draft',
              ${sql.json({ gaps: [`草稿缺口 ${tag}`] })},
              ${sql.json([{ title: `草稿条目 ${tag}`, detail: 'draft', severity: 'critical', evidenceIds: [] }])},
              now(), now())
      on conflict (org_id, retrospective_id) do nothing`;

    if (fieldToken) {
      const denied = await postJson('/api/learning/actions/scan', {}, fieldToken);
      step('2. 现场工人触发扫描被拒（403）', denied.status === 403, `status=${denied.status}`);
    } else {
      skip('2. 现场工人触发扫描被拒（403）', lastLoginError ?? '现场工人登录失败');
    }

    const beforeScan = await sql`
      select lessons_json, assembled_json from ewoh_retrospective
      where org_id = ${INGEST_ORG} and retrospective_id = ${retrospectiveId}`;

    // ── 3. 扫描 → 行动项候选 ─────────────────────────────────────
    // 聚焦扫描：本场景的复盘号带 tag，避免与开发库里其它已发布复盘抢 10 条上限
    const scan = await postJson('/api/learning/actions/scan', { retrospectiveIds: [retrospectiveId] }, leadToken);
    const body = scan.body ?? {};
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const lessonActions = actions.filter((a) => a.sourceRef === retrospectiveId);
    step(
      '3. 扫描派生行动项：critical 经验 + warning 经验 + 缺口各一条（info 不立项、草稿不扫）',
      (scan.status === 200 || scan.status === 201) && lessonActions.length === 3 && Number(body.derived ?? -1) === 3,
      `status=${scan.status} derived=${body.derived} 本复盘=${lessonActions.length} kinds=${lessonActions.map((a) => a.sourceType).join(',')}`,
    );
    const critical = lessonActions.find((a) => a.sourceType === 'retrospective_lesson' && a.priority === 'high');
    const warning = lessonActions.find((a) => a.sourceType === 'retrospective_lesson' && a.priority === 'medium');
    const gapAction = lessonActions.find((a) => a.sourceType === 'retrospective_gap');
    step(
      '4. 行动项带来源复盘号 + 证据（复盘/条目或缺口）+ 建议类型（待人确认）',
      Boolean(critical) && Boolean(warning) && Boolean(gapAction)
        && critical.evidenceRefs.length >= 2
        && critical.kindSource === 'suggested'
        && critical.status === 'proposed'
        && gapAction.kind === 'tooling',
      `critical=${critical?.actionId} evidence=${critical?.evidenceRefs?.length} kind=${critical?.kind}/${critical?.kindSource}`,
    );
    step(
      '5. 只扫已发布：草稿复盘的条目没有变成行动项',
      actions.every((a) => a.sourceRef !== draftId),
      `actions=${actions.length}`,
    );
    const afterScan = await sql`
      select lessons_json, assembled_json from ewoh_retrospective
      where org_id = ${INGEST_ORG} and retrospective_id = ${retrospectiveId}`;
    step(
      '6. 扫描只读复盘记录（lessons/gaps 未被改写）',
      JSON.stringify(beforeScan[0]?.lessons_json) === JSON.stringify(afterScan[0]?.lessons_json)
        && JSON.stringify(beforeScan[0]?.assembled_json) === JSON.stringify(afterScan[0]?.assembled_json),
      'lessons/gaps 未变',
    );

    const rescan = await postJson('/api/learning/actions/scan', { retrospectiveIds: [retrospectiveId] }, leadToken);
    step(
      '7. 重复扫描幂等（created=0 且本复盘 3 条均为 refreshed）',
      Number(rescan.body?.created ?? -1) === 0
        && Number(rescan.body?.refreshed ?? 0) >= 3,
      `created=${rescan.body?.created} refreshed=${rescan.body?.refreshed}`,
    );

    // ── 4. 接受（负责人/期限/验收判据必填）───────────────────────
    const missingOwner = await postJson(`/api/learning/actions/${encodeURIComponent(critical.actionId)}/accept`, {}, leadToken);
    step('8. 接受缺负责人/期限/判据 → 400（平台不替现场承诺期限）', missingOwner.status === 400, `status=${missingOwner.status}`);
    const accepted = await postJson(
      `/api/learning/actions/${encodeURIComponent(critical.actionId)}/accept`,
      { owner: 'P-63000000', dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), acceptanceCriteria: '交接清单新增备用设备状态并抽检 3 次', kind: 'training' },
      leadToken,
    );
    step(
      '9. 接受成功：责任/期限/判据/接受人入库，类型被人工纠正为 human',
      (accepted.status === 200 || accepted.status === 201)
        && accepted.body?.status === 'accepted'
        && accepted.body?.owner === 'P-63000000'
        && accepted.body?.kindSource === 'human'
        && accepted.body?.kind === 'training'
        && Boolean(accepted.body?.acceptedBy),
      `status=${accepted.body?.status} owner=${accepted.body?.owner} kind=${accepted.body?.kind}/${accepted.body?.kindSource}`,
    );
    const acceptAgain = await postJson(
      `/api/learning/actions/${encodeURIComponent(critical.actionId)}/accept`,
      { owner: 'P-1', dueAt: new Date().toISOString(), acceptanceCriteria: 'x' },
      leadToken,
    );
    step('10. 重复接受 → 409（不覆盖第一次的承诺）', acceptAgain.status === 409, `status=${acceptAgain.status}`);

    // ── 5. 完成（结果说明必填）─────────────────────────────────
    const noOutcome = await postJson(`/api/learning/actions/${encodeURIComponent(critical.actionId)}/complete`, {}, leadToken);
    step('11. 完成缺结果说明 → 400', noOutcome.status === 400, `status=${noOutcome.status}`);
    const completed = await postJson(
      `/api/learning/actions/${encodeURIComponent(critical.actionId)}/complete`,
      { outcomeNote: '交接清单模板已加入备用设备状态，抽检 3 次通过' },
      leadToken,
    );
    step(
      '12. 完成成功：完成人/时间/结果说明入库',
      (completed.status === 200 || completed.status === 201)
        && completed.body?.status === 'completed'
        && Boolean(completed.body?.completedBy)
        && String(completed.body?.outcomeNote ?? '').includes('抽检'),
      `status=${completed.body?.status} by=${completed.body?.completedBy}`,
    );
    const rebuild = await postJson(
      `/api/learning/actions/${encodeURIComponent(critical.actionId)}/decision`,
      { decision: 'dropped', reason: '已完成，不再放弃' },
      leadToken,
    );
    step('13. 终态不可再转移（completed → dropped 被拒 409）', rebuild.status === 409, `status=${rebuild.status}`);

    // ── 6. 拒绝必须给理由；逾期口径 ────────────────────────────
    const noReason = await postJson(
      `/api/learning/actions/${encodeURIComponent(gapAction.actionId)}/decision`,
      { decision: 'rejected' },
      leadToken,
    );
    step('14. 拒绝缺理由 → 400（§33 不静默作废）', noReason.status === 400, `status=${noReason.status}`);
    const rejected = await postJson(
      `/api/learning/actions/${encodeURIComponent(gapAction.actionId)}/decision`,
      { decision: 'rejected', reason: `E2E ${tag}：停机时长将随下一代边缘固件接入，暂不单独立项` },
      leadToken,
    );
    step(
      '15. 拒绝成功并留痕（决定人 + 理由）',
      (rejected.status === 200 || rejected.status === 201)
        && rejected.body?.status === 'rejected'
        && Boolean(rejected.body?.decidedBy)
        && String(rejected.body?.decidedReason ?? '').includes('固件'),
      `status=${rejected.body?.status} by=${rejected.body?.decidedBy}`,
    );
    // 第二条经验：接受 + 过期期限 → 进入逾期待办
    const overdueAccept = await postJson(
      `/api/learning/actions/${encodeURIComponent(warning.actionId)}/accept`,
      { owner: 'P-63000000', dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), acceptanceCriteria: '回执模板包含停机时长字段' },
      leadToken,
    );
    const overdue = await getJson('/api/learning/actions/overdue', leadToken);
    const overdueIds = Array.isArray(overdue.body) ? overdue.body.map((a) => a.actionId) : [];
    step(
      '16. 逾期待办：只包含"已接受 + 到期已过"（含刚接受的过期项，不含已完成/已拒绝）',
      (overdueAccept.status === 200 || overdueAccept.status === 201)
        && overdueIds.includes(warning.actionId)
        && !overdueIds.includes(critical.actionId)
        && !overdueIds.includes(gapAction.actionId),
      `overdue=${overdueIds.length} includesWarning=${overdueIds.includes(warning.actionId)}`,
    );

    // ── 6b. 逾期主动叫人（NO-56b：接进统一提醒契约）────────────
    const overdueSweep = await postJson('/api/learning/actions/overdue-sweep', {}, leadToken);
    const overdueNotifications = await sql`
      select notification_id, recipient_type, recipient_id, status, resolution, external_ref
      from ewoh_notification
      where org_id = ${INGEST_ORG} and external_ref = ${warning.actionId}
      order by notification_id`;
    const roleRow = overdueNotifications.find((r) => r.recipient_type === 'role' && r.recipient_id === 'workshop_lead');
    step(
      '16b. 逾期提醒点到班组长角色（通知号确定性 NTF-ACT-…-action_overdue-…）',
      (overdueSweep.status === 200 || overdueSweep.status === 201)
        && Number(overdueSweep.body?.scanned ?? 0) >= 1
        && Boolean(roleRow)
        && String(roleRow.notification_id).startsWith(`NTF-ACT-${warning.actionId}-action_overdue-`),
      `status=${overdueSweep.status} scanned=${overdueSweep.body?.scanned} created=${overdueSweep.body?.created} ids=${overdueNotifications.length}`,
    );
    const sweepAgain = await postJson('/api/learning/actions/overdue-sweep', {}, leadToken);
    step(
      '16c. 重复扫描幂等（created=0 且 duplicates≥1）',
      Number(sweepAgain.body?.created ?? -1) === 0 && Number(sweepAgain.body?.duplicates ?? 0) >= 1,
      `created=${sweepAgain.body?.created} duplicates=${sweepAgain.body?.duplicates}`,
    );

    // ── 7b. 完成即了结提醒（同事务：action_completed）────────────
    const completeOverdue = await postJson(
      `/api/learning/actions/${encodeURIComponent(warning.actionId)}/complete`,
      { outcomeNote: '回执模板已加停机时长字段并抽检' },
      leadToken,
    );
    const resolvedRows = await sql`
      select notification_id, status, resolution, resolved_by
      from ewoh_notification
      where org_id = ${INGEST_ORG} and external_ref = ${warning.actionId} and resolution is not null`;
    step(
      '17b. 完成后提醒落到 action_completed 终态（同事务，带处置人）',
      (completeOverdue.status === 200 || completeOverdue.status === 201)
        && resolvedRows.length >= 1
        && resolvedRows.every((r) => r.resolution === 'action_completed' && r.status === 'resolved')
        && resolvedRows.every((r) => String(r.resolved_by ?? '').length > 0),
      `resolved=${resolvedRows.length} resolution=${resolvedRows[0]?.resolution}`,
    );

    // ── 7. 人的决定不被扫描覆盖 ────────────────────────────────
    const finalScan = await postJson('/api/learning/actions/scan', { retrospectiveIds: [retrospectiveId] }, leadToken);
    const finalActions = (finalScan.body?.actions ?? []).filter((a) => a.sourceRef === retrospectiveId);
    const statuses = Object.fromEntries(finalActions.map((a) => [a.actionId, a.status]));
    step(
      '17. 重复扫描不覆盖人的决定（decisionsPreserved≥3 且三种终态/进行态原样保留）',
      Number(finalScan.body?.decisionsPreserved ?? 0) >= 3
        && statuses[critical.actionId] === 'completed'
        && statuses[warning.actionId] === 'completed'
        && statuses[gapAction.actionId] === 'rejected',
      `preserved=${finalScan.body?.decisionsPreserved} statuses=${JSON.stringify(statuses)}`,
    );
    const knowledgeRows = await sql`
      select entry_id, title, kind, scope, source_evidence_ids
      from ewoh_knowledge_entry
      where org_id = ${INGEST_ORG}::uuid and 'improvement_action' = ANY(
        select jsonb_array_elements_text(tags)
      )
      order by _created_at desc limit 5`;
    const actionRowsWithRef = await sql`
      select action_id, outcome_ref, outcome_kind from ewoh_improvement_action
      where org_id = ${INGEST_ORG} and source_ref = ${retrospectiveId} and outcome_ref is not null`;
    step(
      '17c. 完成即回流知识条目（NO-57c）：行动项带 outcomeRef，知识条目可检索到',
      actionRowsWithRef.length >= 1
        && String(actionRowsWithRef[0].outcome_kind) === 'knowledge_entry'
        && knowledgeRows.some((row) => String(row.entry_id) === String(actionRowsWithRef[0].outcome_ref)),
      `withRef=${actionRowsWithRef.length} entry=${actionRowsWithRef[0]?.outcome_ref} knowledge=${knowledgeRows.length}`,
    );

    const persisted = await sql`
      select action_id, status, owner, due_at, acceptance_criteria, outcome_note, decided_reason, outcome_ref
      from ewoh_improvement_action
      where org_id = ${INGEST_ORG} and source_ref = ${retrospectiveId}
      order by action_id`;
    step(
      '18. 落库事实与响应一致（责任/期限/判据/结果/理由都在库里）',
      persisted.length === 3
        && persisted.some((r) => r.status === 'completed' && r.outcome_note && r.acceptance_criteria && r.due_at)
        && persisted.some((r) => r.status === 'rejected' && r.decided_reason),
      `rows=${persisted.length}`,
    );

    // ── NO-58a：对象归属 + 复发度量（完成前后计数，只是事实）──────────
    const subjectRows = await sql`
      select action_id, subject_type, subject_id from ewoh_improvement_action
      where org_id = ${INGEST_ORG} and source_ref = ${retrospectiveId} order by action_id`;
    step(
      '19. 对象归属由 incident 复盘的 target_id 派生并落库（三条同对象，缺口类也带）',
      subjectRows.length === 3
        && subjectRows.every((r) => r.subject_type === 'device' && String(r.subject_id) === `DEV-${tag}`),
      `rows=${subjectRows.length} subjects=${subjectRows.map((r) => `${r.subject_type}:${r.subject_id}`).join(',')}`,
    );

    // 完成前的偏差事实（服务层只 count 事实、不改事实；这里注入 3 条历史偏差）
    const deviceForRecurrence = `DEV-${tag}`;
    for (let i = 0; i < 3; i += 1) {
      await sql`
        insert into ewoh_scheduling_execution
          (execution_id, org_id, plan_id, assignment_id, task_id, device_id, status, deviation_type,
           deviation_reason, source, _created_at, _updated_at)
        values (${`EXEC-E2E-${tag}-${i}`}, ${INGEST_ORG}, ${`PLAN-E2E-${tag}`}, ${`ASG-E2E-${tag}-${i}`},
                ${`TASK-E2E-${tag}-${i}`}, ${deviceForRecurrence}, 'COMPLETED', 'late_start',
                'E2E 复发度量注入', 'feedback', now() - interval '2 days', now())
        on conflict do nothing`;
    }
    const effect = await getJson(
      `/api/learning/actions/${encodeURIComponent(critical.actionId)}/effect`,
      leadToken,
    );
    step(
      '20. 复发度量：完成前 3 次 / 完成后 0 次 → 计数下降，并声明"不等于这条改进有效"',
      effect.status === 200
        && Number(effect.body?.before?.deviations ?? -1) === 3
        && Number(effect.body?.after?.deviations ?? -1) === 0
        && effect.body?.conclusion === 'recurrence_dropped'
        && String(effect.body?.reason ?? '').includes('不等于')
        && Number(effect.body?.windowDays ?? 0) === 30
        && effect.body?.subjectId === deviceForRecurrence,
      `status=${effect.status} before=${effect.body?.before?.deviations} after=${effect.body?.after?.deviations} conclusion=${effect.body?.conclusion}`,
    );

    // ── NO-58a（人员）：归属带规范前缀 `person:`，执行事实表存裸 id ──────────
    // 这条专门钉住"归一化"：不做归一 → count 永远 0 行（有偏差却显示 0 次）。
    const personId = process.env.EWOH_E2E_PERSON_ID || '63000000-0000-4000-8000-000000000001';
    const personRetrospectiveId = `RTR-E2E-LEARNPERSON-${tag}`;
    await sql`
      insert into ewoh_retrospective
        (org_id, retrospective_id, scope, target_id, title, status, assembled_json, lessons_json,
         narrative, narrative_source, published_at, _created_at, _updated_at)
      values (${INGEST_ORG}, ${personRetrospectiveId}, 'incident', ${`person:${personId}`}, ${`E2E ${tag} 人员复盘`}, 'published',
              ${sql.json({ gaps: [] })},
              ${sql.json([{ title: `E2E ${tag} 人员层经验`, detail: '人员作业偏差未闭环', severity: 'critical', evidenceIds: [] }])},
              ${'rule_fallback 总结'}, 'rule_fallback', now(), now(), now())
      on conflict (org_id, retrospective_id) do nothing`;
    for (let i = 0; i < 3; i += 1) {
      await sql`
        insert into ewoh_scheduling_execution
          (execution_id, org_id, plan_id, assignment_id, task_id, person_id, status, deviation_type,
           deviation_reason, source, _created_at, _updated_at)
        values (${`EXEC-E2E-P-${tag}-${i}`}, ${INGEST_ORG}, ${`PLAN-E2E-P-${tag}`}, ${`ASG-E2E-P-${tag}-${i}`},
                ${`TASK-E2E-P-${tag}-${i}`}, ${personId}, 'COMPLETED', 'late_start',
                'E2E 人员复发度量注入', 'feedback', now() - interval '2 days', now())
        on conflict do nothing`;
    }
    const personScan = await postJson('/api/learning/actions/scan', { retrospectiveIds: [personRetrospectiveId] }, leadToken);
    const personAction = (personScan.body?.actions ?? []).find((a) => a.sourceRef === personRetrospectiveId);
    let personEffect = { status: 0, body: null };
    if (personAction) {
      await postJson(
        `/api/learning/actions/${encodeURIComponent(personAction.actionId)}/accept`,
        { owner: 'P-63000000', dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), acceptanceCriteria: '人员作业偏差复盘到人到班次' },
        leadToken,
      );
      await postJson(
        `/api/learning/actions/${encodeURIComponent(personAction.actionId)}/complete`,
        { outcomeNote: '已把偏差归因写入班次交接模板' },
        leadToken,
      );
      personEffect = await getJson(`/api/learning/actions/${encodeURIComponent(personAction.actionId)}/effect`, leadToken);
    }
    step(
      '23. 人员归属（规范引用 `person:<uuid>`）→ 能查到裸 person_id 的偏差（不做归一就是静默 0 次）',
      Boolean(personAction)
        && personAction.subjectType === 'person'
        && personAction.subjectId === `person:${personId}`
        && Number(personEffect.body?.before?.deviations ?? -1) === 3
        && Number(personEffect.body?.after?.deviations ?? -1) === 0
        && personEffect.body?.conclusion === 'recurrence_dropped',
      `action=${personAction?.actionId} subject=${personAction?.subjectType}/${personAction?.subjectId} before=${personEffect.body?.before?.deviations} after=${personEffect.body?.after?.deviations}`,
    );

    // plan 复盘没有单一对象 → 不硬算成某台设备，复发度量显式"不可度量"
    const planRetrospectiveId = `RTR-E2E-LEARNPLAN-${tag}`;
    await sql`
      insert into ewoh_retrospective
        (org_id, retrospective_id, scope, target_id, title, status, assembled_json, lessons_json,
         narrative, narrative_source, published_at, _created_at, _updated_at)
      values (${INGEST_ORG}, ${planRetrospectiveId}, 'plan', ${`PLAN-${tag}`}, ${`E2E ${tag} 计划复盘`}, 'published',
              ${sql.json({ gaps: [] })},
              ${sql.json([{ title: `E2E ${tag} 计划层经验`, detail: '计划层经验没有单一对象', severity: 'critical', evidenceIds: [] }])},
              ${'rule_fallback 总结'}, 'rule_fallback', now(), now(), now())
      on conflict (org_id, retrospective_id) do nothing`;
    const planScan = await postJson('/api/learning/actions/scan', { retrospectiveIds: [planRetrospectiveId] }, leadToken);
    const planAction = (planScan.body?.actions ?? []).find((a) => a.sourceRef === planRetrospectiveId);
    const planEffect = planAction
      ? await getJson(`/api/learning/actions/${encodeURIComponent(planAction.actionId)}/effect`, leadToken)
      : { status: 0, body: null };
    step(
      '21. 无单一对象的复盘：归属为空 + 结论 no_subject（不硬算、也不显示成"没有复发"）',
      Boolean(planAction)
        && planAction.subjectType === null
        && planAction.subjectId === null
        && planEffect.status === 200
        && planEffect.body?.conclusion === 'no_subject'
        && Number(planEffect.body?.before?.deviations ?? -1) === 0
        && Number(planEffect.body?.after?.deviations ?? -1) === 0,
      `action=${planAction?.actionId} subject=${planAction?.subjectType}/${planAction?.subjectId} conclusion=${planEffect.body?.conclusion}`,
    );
    const storedPlan = await sql`
      select subject_type, subject_id from ewoh_improvement_action
      where org_id = ${INGEST_ORG} and source_ref = ${planRetrospectiveId}`;
    step(
      '22. 空归属成对落库（两列同为 NULL，不允许半成品）',
      storedPlan.length >= 1 && storedPlan.every((r) => r.subject_type === null && r.subject_id === null),
      `rows=${storedPlan.length}`,
    );
  } finally {
    try {
      await sql`delete from ewoh_scheduling_execution where org_id = ${INGEST_ORG} and execution_id like ${`EXEC-E2E-${tag}-%`}`;
      await sql`delete from ewoh_scheduling_execution where org_id = ${INGEST_ORG} and execution_id like ${`EXEC-E2E-P-${tag}-%`}`;
      await sql`delete from ewoh_notification where org_id = ${INGEST_ORG} and notification_id like 'NTF-ACT-%' and external_ref in (select action_id from ewoh_improvement_action where org_id = ${INGEST_ORG} and source_ref in (${retrospectiveId}, ${draftId}, ${`RTR-E2E-LEARNPLAN-${tag}`}, ${`RTR-E2E-LEARNPERSON-${tag}`}))`;
      await sql`delete from ewoh_knowledge_entry where org_id = ${INGEST_ORG}::uuid and tags @> '["improvement_action"]'::jsonb and related_entity_ids ?| array(select action_id from ewoh_improvement_action where org_id = ${INGEST_ORG} and source_ref in (${retrospectiveId}, ${draftId}, ${`RTR-E2E-LEARNPLAN-${tag}`}, ${`RTR-E2E-LEARNPERSON-${tag}`}))`;
      await sql`delete from ewoh_improvement_action where org_id = ${INGEST_ORG} and source_ref in (${retrospectiveId}, ${draftId}, ${`RTR-E2E-LEARNPLAN-${tag}`}, ${`RTR-E2E-LEARNPERSON-${tag}`})`;
      await sql`delete from ewoh_retrospective where org_id = ${INGEST_ORG} and retrospective_id in (${retrospectiveId}, ${draftId}, ${`RTR-E2E-LEARNPLAN-${tag}`}, ${`RTR-E2E-LEARNPERSON-${tag}`})`;
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
