/**
 * ERP/MES 能力主数据导入闭环 E2E（NO-26a）。
 *
 * 真实工厂的设备能力清单来自 ERP/MES 主数据；这条链路必须证明：
 *   1. dry-run 先看影响面（不写库），apply 才落台账，且台账行**带来源可追溯**；
 *   2. 同一批次重复导入 = unchanged（幂等，不重复写）；
 *   3. **人工停用优先**：设备能力被人为停用后，主数据再导一次也不会复活它
 *      （返回 skipped_human_disabled，并回报停用留痕）——这是安全语义，不是优化；
 *   4. 词表外能力名被拒并给出"疑似笔误"；未知设备被拒（外部系统不能凭空造设备）；
 *   5. 全过程审计（含 dry-run 预览）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_OWNER_DATABASE_URL=postgres://... node test/e2e/master-data-capability-import.mjs
 */
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const ORG_ID = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';

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
  console.log(`主数据能力导入: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
  process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
}

let lastLoginError = null;

async function login() {
  const username = process.env.EWOH_E2E_ADMIN_USER || 'admin';
  const password = process.env.EWOH_E2E_ADMIN_PASS || '';
  lastLoginError = null;
  if (!password) {
    lastLoginError = '未提供密码（env EWOH_E2E_ADMIN_PASS）';
    return null;
  }
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  const body = await response?.json().catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 201)) {
    // 如实报告失败原因：一律显示"缺少 EWOH_E2E_ADMIN_PASS"会把 503/401 误报成没设环境变量。
    lastLoginError = `登录失败：HTTP ${response?.status ?? 0}`
      + (body?.error?.message ? ` ${body.error.message}` : '')
      + (body?.error?.code ? ` [${body.error.code}]` : '');
    return null;
  }
  const token = body?.accessToken ?? null;
  if (!token) lastLoginError = '登录响应缺少 accessToken';
  return token;
}

async function importCapabilities(token, body, dryRun = false) {
  const response = await fetch(
    `${BASE}/api/master-data/capabilities/import${dryRun ? '?dryRun=1' : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
  ).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const probe = await fetch(`${BASE}/api/master-data/capabilities/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 平台可达且未认证导入被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const token = await login();
  if (!token) {
    skip('1. 管理员登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  step('1. 管理员登录', true);

  if (!OWNER_DB) {
    skip('2. 选择目标设备', '缺少 EWOH_E2E_OWNER_DATABASE_URL');
    return finish();
  }
  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const sourceRef = `e2e-md-${tag}`;
  let deviceId = null;
  try {
    const devices = await sql`
      select device_id from public.ewoh_device
      where org_id = ${ORG_ID}::uuid and device_id is not null
      order by device_id limit 1`;
    deviceId = devices[0]?.device_id ?? null;
    if (!deviceId) {
      skip('2. 选择目标设备', '本租户没有设备行（无法验证导入链路）');
      return finish();
    }
    step('2. 选择目标设备', true, `device=${deviceId}`);

    // ── 3. dry-run：先看影响面，不写库 ────────────────────────────────
    const declaration = { deviceId, capabilityKey: 'vacuum' };
    const preview = await importCapabilities(
      token,
      { source: 'erp', sourceRef: `${sourceRef}-dry`, declarations: [declaration] },
      true,
    );
    const before = await sql`
      select status, capability_value->'provenance'->>'sourceRef' as source_ref
      from public.ewoh_device_capability
      where org_id = ${ORG_ID}::uuid and device_id = ${deviceId} and capability_key = 'vacuum'`;
    step('3. dry-run 返回逐行结果且不写库',
      preview.status === 201 || preview.status === 200,
      `status=${preview.status} rows=${preview.body?.rows?.length ?? 0}`);
    step('3a. dry-run 明确标注 dryRun 且台账未被改动',
      preview.body?.dryRun === true
        && (before[0]?.source_ref ?? null) !== `${sourceRef}-dry`,
      `before=${JSON.stringify(before[0] ?? null)}`);
    step('3b. 预览给出逐行判定与来源批次（新增或刷新都如实回报）',
      (preview.body?.totals?.applied ?? 0) + (preview.body?.totals?.updated ?? 0) === 1
        && preview.body?.sourceRef === `${sourceRef}-dry`,
      `totals=${JSON.stringify(preview.body?.totals ?? null)}`);

    // ── 4. apply：落台账并带来源 ─────────────────────────────────────
    const applied = await importCapabilities(token, {
      source: 'erp',
      sourceRef,
      declarations: [
        declaration,
        { deviceId, capabilityKey: 'vaccum' }, // 笔误（字母调换）：应给出"是否指 vacuum"
        { deviceId: 'GHOST-E2E-1', capabilityKey: 'vacuum' }, // 未知设备
        { deviceId }, // 缺字段
      ],
    });
    step('4. apply 逐行结果与输入顺序一一对应（4 行）',
      (applied.status === 201 || applied.status === 200) && applied.body?.rows?.length === 4,
      `status=${applied.status} rows=${applied.body?.rows?.length ?? 0}`);
    const outcomes = (applied.body?.rows ?? []).map((r) => r.outcome);
    // 目标设备可能已有该能力（重复运行时）→ applied/updated 都算"正常写入"
    step('4a. 四种判定分别落到对应行（写入 / 笔误 / 未知设备 / 缺字段）',
      ['applied', 'updated'].includes(outcomes[0])
        && outcomes[1] === 'skipped_unknown_capability'
        && outcomes[2] === 'skipped_unknown_device'
        && outcomes[3] === 'skipped_missing_field',
      `outcomes=${outcomes.join('|')}`);
    step('4b. 词表外能力名给出疑似笔误建议',
      String(applied.body?.rows?.[1]?.detail ?? '').includes('vacuum'),
      String(applied.body?.rows?.[1]?.detail ?? ''));

    const afterApply = await sql`
      select status, capability_value->'provenance'->>'channel' as channel,
             capability_value->'provenance'->>'source' as source,
             capability_value->'provenance'->>'sourceRef' as source_ref,
             capability_value->'provenance'->>'importedBy' as imported_by
      from public.ewoh_device_capability
      where org_id = ${ORG_ID}::uuid and device_id = ${deviceId} and capability_key = 'vacuum'`;
    step('4c. 台账行带来源（master_data / erp / 批次 / 导入人），可回答"这行从哪来"',
      afterApply[0]?.channel === 'master_data'
        && afterApply[0]?.source === 'erp'
        && afterApply[0]?.source_ref === sourceRef
        && Boolean(afterApply[0]?.imported_by),
      JSON.stringify(afterApply[0] ?? null));

    // ── 5. 幂等：同批次再导 → unchanged ─────────────────────────────
    const again = await importCapabilities(token, {
      source: 'erp',
      sourceRef,
      declarations: [declaration],
    });
    step('5. 同一 source+sourceRef 重复导入 → unchanged（不重复写）',
      again.body?.rows?.[0]?.outcome === 'unchanged',
      `outcome=${again.body?.rows?.[0]?.outcome}`);

    // ── 6. 人工停用优先：导入不复活 ──────────────────────────────────
    const disabled = await fetch(
      `${BASE}/api/devices/${encodeURIComponent(deviceId)}/capabilities/vacuum/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'disabled', reason: 'e2e：主数据导入不得复活人工停用' }),
      },
    ).catch(() => null);
    const disabledStatus = disabled ? disabled.status : 0;
    const afterDisable = await importCapabilities(token, {
      source: 'mes',
      sourceRef: `${sourceRef}-2`,
      declarations: [declaration],
    });
    const row = afterDisable.body?.rows?.[0] ?? null;
    const ledgerAfter = await sql`
      select status, capability_value->'lifecycle'->>'reason' as reason
      from public.ewoh_device_capability
      where org_id = ${ORG_ID}::uuid and device_id = ${deviceId} and capability_key = 'vacuum'`;
    step('6. 人工停用后主数据导入 → skipped_human_disabled（不复活）',
      disabledStatus === 200
        && row?.outcome === 'skipped_human_disabled'
        && ledgerAfter[0]?.status === 'disabled',
      `disable=${disabledStatus} outcome=${row?.outcome} status=${ledgerAfter[0]?.status}`);
    step('6a. 跳过原因回报停用留痕（谁/何时/为何）',
      String(row?.detail ?? '').includes('e2e：主数据导入不得复活人工停用'),
      String(row?.detail ?? ''));
    step('6b. 汇总给出"主数据不得覆盖人工安全决定"的提示',
      (afterDisable.body?.warnings ?? []).join(' ').includes('人工安全决定'),
      `warnings=${(afterDisable.body?.warnings ?? []).join('|')}`);

    // ── 7. 审计留痕（含 dry-run 预览）───────────────────────────────
    const audits = await sql`
      select action, count(*)::int as n from public.ewoh_audit_log
      where org_id = ${ORG_ID}::uuid
        and action in ('master_data.capability.import', 'master_data.capability.import.preview')
      group by action`;
    const byAction = new Map(audits.map((a) => [a.action, a.n]));
    step('7. 导入与预览都在审计里（preview 也留痕）',
      Number(byAction.get('master_data.capability.import') ?? 0) >= 1
        && Number(byAction.get('master_data.capability.import.preview') ?? 0) >= 1,
      `audits=${JSON.stringify([...byAction.entries()])}`);

    // 收尾：恢复该能力（保持场景可重复运行）
    await fetch(
      `${BASE}/api/devices/${encodeURIComponent(deviceId)}/capabilities/vacuum/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'active', reason: 'e2e 收尾：恢复（vacuum 为中风险，无需审批）' }),
      },
    ).catch(() => null);
  } finally {
    await sql.end({ timeout: 5 });
  }
  finish();
}

main().catch((error) => {
  record('FAIL', '脚本异常', String(error?.stack ?? error));
  finish();
});
