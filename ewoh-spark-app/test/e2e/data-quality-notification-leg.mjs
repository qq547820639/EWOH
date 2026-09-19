/**
 * 数据质量"待核实提醒"闭环 E2E（NO-53a）。
 *
 * 补的缺口不是"告警有没有落库"（摄入侧早已落库），而是**有没有人真的被叫到**：
 * 摄入侧开 `DataQualityAlert` → 提醒扫描把该核实这件事叫到责任人/角色 →
 * 人工判定 → 提醒落处置终态（与判定**同事务**）。必须证明的语义：
 *
 *   1. 未登记 entity_id 的帧被 fail-closed 拒绝，且**告警事件确实落库**
 *      （`events_triggered=1`；否则"拒了但没人知道"）；
 *   2. 扫描把"待核实"叫到人：通知号确定性 `NTF-DQ-<告警号>-<桶>-<收件人>-<渠道>`，
 *      `external_ref` 指回告警事件（否则人无法从提醒回写判定）；
 *   3. 扫描幂等：重复扫描只累加 duplicates，不重复打扰；
 *   4. 扫描**只读业务事实**：不改告警状态、不写 evidence；
 *   5. 判定落账时提醒**同事务**落到 `data_quality_confirmed`（不是"已读"），
 *      且带处置人/处置引用；
 *   6. confirmed 联动 resolve 告警；contested 是"数据不可信"的处置码，
 *      提醒同样了结但**告警保持 open**（不可信数据必须继续可见）；
 *   7. 权限边界：现场工人不能触发扫描（403），班组长可以。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_FIELD_PASS=... \
 *   EWOH_E2E_INGEST_KEY=... EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/data-quality-notification-leg.mjs
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
    `数据质量待核实提醒闭环: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
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
    body: JSON.stringify(body),
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

/** 未登记 entity_id 的帧 → 摄入 fail-closed + 落 DataQualityAlert。 */
async function ingestUnregisteredFrame(tag, index) {
  const entityId = `person:missing-${tag}-${index}`;
  const response = await fetch(`${BASE}/api/ingest/exoskeleton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      device_id: `EXO-DQ-${tag}-${index}`,
      entity_id: entityId,
      event_time: new Date().toISOString(),
      source_type: 'real',
      sequence: 1,
    }),
  }).catch(() => null);
  const body = response ? await response.json().catch(() => null) : null;
  return { status: response?.status ?? 0, body, entityId };
}

async function main() {
  const probe = await fetch(`${BASE}/api/data-quality/gap-sweep`, { method: 'POST' }).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 未认证扫描被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS || '');
  if (!adminToken) {
    skip('1. 管理员登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  const leadToken = await login(
    process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
    process.env.EWOH_E2E_APPROVER_PASS || '',
  );
  if (!leadToken) {
    skip('1b. 班组长（workshop_lead）登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  const fieldToken = await login(
    process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei',
    process.env.EWOH_E2E_FIELD_PASS || '',
  );
  step('1. 管理员 + 班组长登录成功', Boolean(adminToken && leadToken));

  if (!INGEST_KEY) {
    skip('2. 数据质量告警产生', '未提供 EWOH_E2E_INGEST_KEY（无法走真实摄入通道）');
    return finish();
  }
  if (!OWNER_DB) {
    skip('2. 数据质量告警产生', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法核对落库事实）');
    return finish();
  }
  const sql = postgres(OWNER_DB, { max: 2, onnotice: () => {} });
  // NO-67d：清理自证的目标 id——**在 try 外声明**（早期失败跳过赋值时，
  // finally 里读它仍是 null 而不是 ReferenceError/TDZ；实测踩过一次）。
  let injectedAlertId = null;
  try {
    // ── 2. 权限边界：现场工人不能触发扫描 ─────────────────────────────
    if (fieldToken) {
      const denied = await postJson('/api/data-quality/gap-sweep', {}, fieldToken);
      step('2. 现场工人触发"待核实扫描"被拒（403）', denied.status === 403, `status=${denied.status}`);
    } else {
      skip('2. 现场工人触发"待核实扫描"被拒（403）', lastLoginError ?? '现场工人登录失败');
    }

    // ── 3. 未登记 entity_id → 摄入拒帧 + 落告警 ───────────────────────
    const tag = Date.now().toString(36);
    const first = await ingestUnregisteredFrame(tag, 1);
    // HTTP 201 + 帧级结果（accepted=false / data_quality=invalid）：单帧与批量同一契约，
    // 边缘端不会把"帧非法"当成传输失败去无限重试。
    step(
      '3. 未登记 entity_id 的帧被拒（accepted=false + data_quality=invalid + 落了告警）',
      (first.status === 201 || first.status === 200)
        && first.body?.accepted === false
        && first.body?.data_quality === 'invalid'
        && first.body?.events_triggered === 1,
      `status=${first.status} accepted=${first.body?.accepted} quality=${first.body?.data_quality} events=${first.body?.events_triggered}`,
    );

    const alertRows = await sql`
      select event_id, event_code, event_type, status, severity, evidence_json
      from ewoh_event
      where org_id = ${INGEST_ORG}
        and event_type = 'DataQualityAlert'
        and evidence_json->>'entity_id' = ${first.entityId}
      order by created_at desc
      limit 1`;
    const alert = alertRows[0];
    if (!alert) {
      step('4. 告警事件落库（可追溯 entity_id）', false, '未找到对应 DataQualityAlert 行');
      return finish();
    }
    step(
      '4. 告警事件落库且可追溯到原始 entity_id',
      alert.event_code === 'ENTITY_NOT_FOUND' && alert.status === 'open',
      `event=${alert.event_id} code=${alert.event_code} status=${alert.status}`,
    );
    const alertEventId = String(alert.event_id);

    // ── 5. 扫描把"该核实"叫到人 ─────────────────────────────────────
    const sweep = await postJson('/api/data-quality/gap-sweep', {}, leadToken);
    const sweepBody = sweep.body ?? {};
    const mine = (sweepBody.notifications ?? []).find((n) => n.alertEventId === alertEventId);
    step(
      '5. 扫描结果指回该告警（created≥1）',
      sweep.status === 200 || sweep.status === 201
        ? Number(sweepBody.created ?? 0) >= 1 && Boolean(mine)
        : false,
      `status=${sweep.status} scanned=${sweepBody.scanned} notifyRequired=${sweepBody.notifyRequired} created=${sweepBody.created}`,
    );

    const notificationRows = await sql`
      select notification_id, recipient_type, recipient_id, channel, status, external_ref, resolution, resolved_by
      from ewoh_notification
      where org_id = ${INGEST_ORG} and external_ref = ${alertEventId}
      order by notification_id`;
    const roleRow = notificationRows.find((r) => r.recipient_type === 'role' && r.recipient_id === 'workshop_lead');
    step(
      '6. 提醒确定性命中班组长角色（外部引用=告警事件号）',
      Boolean(roleRow) && String(roleRow.notification_id).startsWith(`NTF-DQ-${alertEventId}-`),
      roleRow ? `${roleRow.notification_id} channel=${roleRow.channel}` : `未找到角色提醒（共 ${notificationRows.length} 条）`,
    );

    // ── 6. 扫描幂等 + 只读 ──────────────────────────────────────────
    const again = await postJson('/api/data-quality/gap-sweep', {}, leadToken);
    const againBody = again.body ?? {};
    step(
      '7. 重复扫描幂等（created=0 且 duplicates≥1）',
      Number(againBody.created ?? -1) === 0 && Number(againBody.duplicates ?? 0) >= 1,
      `created=${againBody.created} duplicates=${againBody.duplicates}`,
    );
    const unchanged = await sql`
      select status, evidence_json->>'sourceEventId' as source_event_id
      from ewoh_event where event_id = ${alertEventId}`;
    step(
      '8. 扫描不改业务事实（告警仍 open、evidence 未被改写）',
      unchanged[0]?.status === 'open' && unchanged[0]?.source_event_id === null,
      `status=${unchanged[0]?.status} sourceEventId=${unchanged[0]?.source_event_id}`,
    );

    // ── 7. 人工判定 → 提醒同事务落终态 ───────────────────────────────
    const decidedAt = Date.now();
    const confirm = await postJson(
      '/api/data-quality/confirmations',
      { eventId: alertEventId, verdict: 'confirmed', note: `E2E ${tag} 现场核对` },
      leadToken,
    );
    step(
      '9. 判定返回"同事务处置了几条提醒"（resolvedNotificationCount≥1）',
      (confirm.status === 200 || confirm.status === 201) && Number(confirm.body?.resolvedNotificationCount ?? 0) >= 1,
      `status=${confirm.status} resolvedNotificationCount=${confirm.body?.resolvedNotificationCount}`,
    );
    const resolvedRows = await sql`
      select notification_id, status, resolution, resolved_by, resolution_ref, resolved_at
      from ewoh_notification
      where org_id = ${INGEST_ORG} and external_ref = ${alertEventId} and resolution is not null`;
    step(
      '10. 提醒落到 data_quality_confirmed 终态（带处置人/引用）',
      resolvedRows.length >= 1
        && resolvedRows.every((r) => r.resolution === 'data_quality_confirmed' && r.status === 'resolved')
        && resolvedRows.every((r) => String(r.resolved_by ?? '').length > 0 && r.resolution_ref === alertEventId)
        && resolvedRows.every((r) => new Date(r.resolved_at).getTime() >= decidedAt - 5000),
      `${resolvedRows.length} 条 resolution=${resolvedRows[0]?.resolution} by=${resolvedRows[0]?.resolved_by}`,
    );
    const alertAfter = await sql`select status from ewoh_event where event_id = ${alertEventId}`;
    step(
      '11. confirmed 按合法链了结告警（open→acknowledged→processing→closed）',
      alertAfter[0]?.status === 'closed',
      `status=${alertAfter[0]?.status}`,
    );

    // ── 8. contested：提醒了结但告警保持可见 ──────────────────────────
    const second = await ingestUnregisteredFrame(tag, 2);
    const secondRows = await sql`
      select event_id, status from ewoh_event
      where org_id = ${INGEST_ORG} and event_type = 'DataQualityAlert'
        and evidence_json->>'entity_id' = ${second.entityId}
      order by created_at desc limit 1`;
    const secondAlertId = secondRows[0]?.event_id ? String(secondRows[0].event_id) : '';
    await postJson('/api/data-quality/gap-sweep', {}, leadToken);
    const contested = await postJson(
      '/api/data-quality/confirmations',
      { eventId: secondAlertId, verdict: 'contested', note: `E2E ${tag} 读数明显异常` },
      leadToken,
    );
    const contestedRows = await sql`
      select resolution from ewoh_notification
      where org_id = ${INGEST_ORG} and external_ref = ${secondAlertId} and resolution is not null`;
    const secondAlert = await sql`select status from ewoh_event where event_id = ${secondAlertId}`;
    step(
      '12. contested = "数据不可信"：提醒了结但告警保持 open（不可信数据继续可见）',
      Number(contested.body?.resolvedNotificationCount ?? 0) >= 1
        && contestedRows.length >= 1
        && contestedRows.every((r) => r.resolution === 'data_quality_contested')
        && secondAlert[0]?.status === 'open',
      `resolved=${contested.body?.resolvedNotificationCount} resolution=${contestedRows[0]?.resolution} alertStatus=${secondAlert[0]?.status}`,
    );

    // ── 8b. 长时间未核实 → 再催一次（quality_aging，NO-56b）─────────
    // 用 SQL 造一条"30 小时前产生、仍未了结"的告警（时间旅行只能由事实注入完成）
    const oldAlertId = `EVT-DQ-OLD-${tag}`;
    injectedAlertId = oldAlertId;
    await sql`
      insert into ewoh_event
        (event_id, org_id, device_id, event_code, event_type, severity, title, status, source_type, evidence_json, created_at, occurred_at, received_at, observed_at, schema_version)
      values (${oldAlertId}, ${INGEST_ORG}, ${`EXO-DQ-OLD-${tag}`}, 'CLOCK_DRIFT', 'DataQualityAlert', 'L2',
              ${`E2E ${tag} 三十小时前的时钟漂移`}, 'open', 'real',
              ${sql.json({ device_id: `EXO-DQ-OLD-${tag}`, fired_at: new Date(Date.now() - 30 * 3_600_000).toISOString() })},
              ${new Date(Date.now() - 30 * 3_600_000)}, ${new Date(Date.now() - 30 * 3_600_000)},
              ${new Date(Date.now() - 30 * 3_600_000)}, ${new Date(Date.now() - 30 * 3_600_000)}, '1.0.0')`;
    const agingSweep = await postJson('/api/data-quality/gap-sweep', {}, leadToken);
    const agingRows = await sql`
      select notification_id from ewoh_notification
      where org_id = ${INGEST_ORG} and external_ref = ${oldAlertId} and notification_id like '%quality_aging%'`;
    step(
      '12b. 超过 24h 未核实 → 补发 aging 桶提醒（再催一次）',
      agingRows.length >= 1 && Number(agingSweep.body?.agingNudged ?? 0) >= 1,
      `agingNudged=${agingSweep.body?.agingNudged} agingRows=${agingRows.length}`,
    );

    // ── 9. 已处置的提醒不再挂在待办里 ────────────────────────────────
    const pending = await getJson('/api/notifications?status=pending', leadToken);
    const stillPending = Array.isArray(pending.body)
      ? pending.body.filter((n) => String(n.externalRef ?? '') === alertEventId)
      : [];
    step(
      '13. 已处置提醒不再出现在待办（pending 列表里查不到）',
      pending.status === 200 && stillPending.length === 0,
      `status=${pending.status} 残留=${stillPending.length}`,
    );
  } finally {
    // NO-67d：清理自证——本场景注入的 open 告警（时间旅行用的 old 事件）必须已被
    // worker 核实/了结；直查事实表计数，残留记 FAIL（不许只 warn）。
    if (OWNER_DB) {
      try {
        const sqlCheck = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
        try {
          if (injectedAlertId === null) {
            record('PASS', '15. 清理自证（早期失败：未注入告警，无需清理）', true);
          } else {
            // 先收尾**本场景注入**的告警（合成数据，场景拥有清理责任）
            await sqlCheck`
              update ewoh_event set status = 'resolved'
               where event_id = ${injectedAlertId} and status = 'open'`;
            // 再自证：本场景的告警不再处于 open
            const leftover = await sqlCheck`
              select count(*)::int as n from ewoh_event
               where event_id = ${injectedAlertId} and status = 'open'`;
            if ((leftover[0]?.n ?? 0) > 0) {
              record('FAIL', '15. 清理自证', `本场景注入的告警仍 open（${leftover[0].n} 条）`);
            } else {
              record('PASS', '15. 清理自证（注入的告警已全部核实/了结）', true);
            }
          }
        } finally {
          await sqlCheck.end({ timeout: 5 }).catch(() => {});
        }
      } catch (error) {
        record('FAIL', '15. 清理自证', `自查失败：${error?.message ?? error}`);
      }
    } else {
      record('SKIP', '15. 清理自证', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法直查事实表）');
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
