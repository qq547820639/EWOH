/**
 * 物料流动 → 库存投影 → 物料短缺推理 E2E（NO-27a）。
 *
 * 这条链路把"物料"接进统一世界模型与预测：
 *   ERP 出站（入库 / 领用）→ 库存投影（入库累加、领用累减）→ `rule:material-shortage`。
 *
 * 必须证明的语义（每条都对应一个真实的现场坑）：
 *   1. 合法物料载荷被契约接受并规范化落库；非法载荷 400（fail-closed）；
 *   2. 库存 = 入库 − 领用，且响应带**证据事件 id**（可追溯到单据）；
 *   3. 没声明再订货点（minThreshold）的物料**不判定短缺**（`no_threshold`），不编阈值；
 *   4. 历史自由格式载荷被显式列为 `unparsable`（缺口可见，不静默当 0）；
 *   5. 声明阈值且库存低于阈值 → 实时评估产出 `rule:material-shortage` 结论。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *     node test/e2e/material-inventory-loop.mjs
 */
const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';

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
  console.log(`物料库存闭环: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
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

async function main() {
  const probe = await fetch(`${BASE}/api/materials/inventory`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 平台可达且未认证库存查询被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const token = await login();
  if (!token) {
    skip('1. 管理员登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  step('1. 管理员登录', true);

  const tag = Date.now().toString(36);
  const shortMaterial = `MAT-SHORT-${tag}`;
  const noThresholdMaterial = `MAT-NOTH-${tag}`;

  // ── 2. 入库（含再订货点）───────────────────────────────────────────
  const receipt = await postJson('/api/erp/outbound', {
    outboundId: `E2E-MAT-IN-${tag}`,
    type: 'inventory_receipt',
    externalOrderId: `PO-${tag}`,
    payload: { materialId: shortMaterial, quantity: 100, unit: 'kg', minThreshold: 40 },
  }, token);
  step('2. 入库（含再订货点）被契约接受', receipt.status === 201 || receipt.status === 200, `status=${receipt.status}`);

  // ── 3. 领用（库存降到阈值以下）────────────────────────────────────
  const consume = await postJson('/api/erp/outbound', {
    outboundId: `E2E-MAT-OUT-${tag}`,
    type: 'material_consumption',
    externalOrderId: `WO-${tag}`,
    payload: { materialId: shortMaterial, quantity: 85, unit: 'kg' },
  }, token);
  step('3. 领用被契约接受', consume.status === 201 || consume.status === 200, `status=${consume.status}`);

  // ── 4. 无阈值的物料：有流动但不判定短缺 ───────────────────────────
  await postJson('/api/erp/outbound', {
    outboundId: `E2E-MAT-NOTH-${tag}`,
    type: 'inventory_receipt',
    externalOrderId: `PO-NOTH-${tag}`,
    payload: { materialId: noThresholdMaterial, quantity: 5, unit: '件' },
  }, token);

  // ── 5. 非法载荷 → 400（fail-closed）───────────────────────────────
  const invalid = await postJson('/api/erp/outbound', {
    outboundId: `E2E-MAT-BAD-${tag}`,
    type: 'material_consumption',
    externalOrderId: `WO-BAD-${tag}`,
    payload: { materialId: shortMaterial, quantity: -3 },
  }, token);
  step('4. 非法物料载荷被拒（400，且说明原因）',
    invalid.status === 400 && JSON.stringify(invalid.body).includes('物料流动载荷不符合契约'),
    `status=${invalid.status}`);

  // ── 6. 历史自由格式载荷 → 放行但列为 unparsable ────────────────────
  const legacy = await postJson('/api/erp/outbound', {
    outboundId: `E2E-MAT-LEGACY-${tag}`,
    type: 'material_consumption',
    externalOrderId: `WO-LEGACY-${tag}`,
    payload: { note: '历史集成：只报了个汇总，没有物料字段' },
  }, token);
  step('5. 历史自由格式载荷仍被接受（不破坏既有集成）', legacy.status === 201 || legacy.status === 200, `status=${legacy.status}`);

  // ── 7. 库存投影 ─────────────────────────────────────────────────
  const inventory = await getJson('/api/materials/inventory', token);
  const balances = Array.isArray(inventory.body?.balances) ? inventory.body.balances : [];
  const short = balances.find((b) => b.materialId === shortMaterial) ?? null;
  const noThreshold = balances.find((b) => b.materialId === noThresholdMaterial) ?? null;
  step('6. 库存 = 入库 − 领用（100 − 85 = 15）',
    inventory.status === 200 && short?.onHand === 15,
    `status=${inventory.status} onHand=${short?.onHand}`);
  step('6a. 库存带证据事件 id（可追溯到具体单据）',
    Array.isArray(short?.evidenceIds) && short.evidenceIds.length >= 2,
    `evidence=${(short?.evidenceIds ?? []).join('|')}`);
  step('6b. 再订货点取最近一次声明（40）',
    short?.minThreshold === 40,
    `minThreshold=${short?.minThreshold}`);
  step('6c. 无阈值物料仍出现在库存里（事实可见，但不判定短缺）',
    noThreshold !== null && noThreshold.minThreshold === null,
    `onHand=${noThreshold?.onHand} threshold=${noThreshold?.minThreshold}`);
  step('6e. 聚合精确：该物料 movements=2、入库 1、领用 1（不是窗口近似）',
    short?.movementCount === 2 && short?.receipts === 1 && short?.consumptions === 1,
    `movements=${short?.movementCount} receipts=${short?.receipts} consumptions=${short?.consumptions}`);
  step('6f. 响应声明库存来自全量精确聚合（不截断窗口）',
    inventory.body?.aggregationComplete === true && String(inventory.body?.aggregationNote ?? '').includes('全部历史'),
    `complete=${inventory.body?.aggregationComplete}`);
  const unparsable = Array.isArray(inventory.body?.unparsable) ? inventory.body.unparsable : [];
  step('6d. 历史自由格式载荷被显式列为 unparsable（缺口可见）',
    unparsable.some((row) => String(row.reason).includes('legacy')),
    `unparsable=${unparsable.length}`);

  // ── 7'. 订单需求（BOM 口径）与缺口影响面（NO-28a）────────────────
  const orderWithBom = await postJson('/api/erp/orders', {
    externalOrderId: `SO-MAT-${tag}`,
    productCode: 'P-MAT',
    quantity: 20,
    dueDate: new Date(Date.now() - 86_400_000).toISOString(), // 逾期未完工：必须标记
    bom: [{ materialId: shortMaterial, quantity: 3 }],
  }, token);
  step('7d. 订单（含 BOM，声明 per_unit 口径）被接受', orderWithBom.status === 201 || orderWithBom.status === 200, `status=${orderWithBom.status}`);

  const badBasis = await postJson('/api/erp/orders', {
    externalOrderId: `SO-BADBASIS-${tag}`,
    productCode: 'P-MAT',
    quantity: 1,
    bom: [{ materialId: shortMaterial, quantity: 1 }],
    bomBasis: 'per_kilo',
  }, token);
  step('7e. 非法 BOM 口径被拒（400：口径错会把需求算成几倍）',
    badBasis.status === 400 && JSON.stringify(badBasis.body).includes('bomBasis'),
    `status=${badBasis.status}`);

  const withDemand = await getJson('/api/materials/inventory', token);
  const impactA = (withDemand.body?.impact ?? []).find((row) => row.materialId === shortMaterial) ?? null;
  step('7f. 需求 = BOM 用量 × 订单数量（3 × 20 = 60），缺口 = 需求 − 库存（60 − 15 = 45）',
    impactA?.requiredQuantity === 60 && impactA?.demandGap === 45,
    `required=${impactA?.requiredQuantity} onHand=${impactA?.onHand} gap=${impactA?.demandGap}`);
  step('7g. 需求 > 库存 → 状态是"不足以覆盖未完工订单"（比低于再订货点更紧迫）并列出受影响订单',
    impactA?.status === 'below_demand'
      && (impactA?.affectedOrders ?? []).some((o) => o.externalOrderId === `SO-MAT-${tag}`),
    `status=${impactA?.status} orders=${(impactA?.affectedOrders ?? []).map((o) => o.externalOrderId).join('|')}`);
  step('7h. 逾期未完工订单被标记（逾期需求更要紧）',
    impactA?.hasOverdue === true,
    `hasOverdue=${impactA?.hasOverdue}`);

  // ── 7''. 单位对齐：库存 kg vs BOM 件 → 不比较（NO-29b）────────────
  await postJson('/api/erp/orders', {
    externalOrderId: `SO-UNIT-${tag}`,
    productCode: 'P-MAT',
    quantity: 10,
    bom: [{ materialId: shortMaterial, quantity: 5, unit: '件' }],
  }, token);
  const afterUnitMismatch = await getJson('/api/materials/inventory', token);
  const mismatchRow = (afterUnitMismatch.body?.impact ?? []).find((row) => row.materialId === shortMaterial) ?? null;
  step('7i. 库存单位（kg）与 BOM 单位（件）不一致 → unit_mismatch（不做比较、不编缺口）',
    mismatchRow?.status === 'unit_mismatch',
    `status=${mismatchRow?.status} onHand=${mismatchRow?.onHand} unit=${mismatchRow?.unit}`);
  const badUnit = await postJson('/api/erp/orders', {
    externalOrderId: `SO-BADUNIT-${tag}`,
    productCode: 'P-MAT',
    quantity: 1,
    bom: [{ materialId: shortMaterial, quantity: 1, unit: '   ' }],
  }, token);
  step('7j. BOM 行单位非法（空串）→ 400（入口就拒绝，不留到比较阶段）',
    badUnit.status === 400 && JSON.stringify(badUnit.body).includes('unit'),
    `status=${badUnit.status}`);

  // ── 8. 实时推理：物料短缺结论 ────────────────────────────────────
  const live = await postJson('/api/reasoning/evaluate-live', {}, token);
  const conclusions = Array.isArray(live.body?.trace?.conclusions) ? live.body.trace.conclusions : [];
  const shortage = conclusions.find(
    (c) => c.ruleId === 'rule:material-shortage' && String(c.subjectId).includes(shortMaterial),
  );
  step('7. 实时评估产出物料短缺结论（rule:material-shortage 真的活了）',
    (live.status === 201 || live.status === 200) && Boolean(shortage),
    `status=${live.status} conclusions=${conclusions.length} shortage=${Boolean(shortage)}`);
  step('7a. 结论带证据链（事件可追溯）',
    Array.isArray(shortage?.evidenceIds) && shortage.evidenceIds.length >= 2,
    `evidence=${(shortage?.evidenceIds ?? []).join('|')}`);
  const skipped = Array.isArray(live.body?.skipped) ? live.body.skipped : [];
  step('7b. 无阈值物料不判定短缺，原因写明（不编阈值）',
    skipped.some((s) => s.reason === 'no_threshold' && String(s.subjectId).includes(noThresholdMaterial)),
    `no_threshold items=${skipped.filter((s) => s.reason === 'no_threshold').length}`);
  step('7c. 不可解析的历史载荷在评估里同样可见',
    skipped.some((s) => s.reason === 'unparsable_material_movement'),
    `unparsable skips=${skipped.filter((s) => s.reason === 'unparsable_material_movement').length}`);

    // ── NO-57a：订单链（订单 → 任务/工序 → 物料）──
  {
    const chains = await getJson('/api/world/order-chains?limit=10', token);
    const summary = chains.body?.summary ?? null;
    const rows = Array.isArray(chains.body?.chains) ? chains.body.chains : [];
    const withGaps = rows.filter((row) => (row.gaps ?? []).length > 0);
    step(
      'NO-57a. 订单链可用：返回未完工订单及链路缺口（不把已有任务当缺口）',
      (chains.status === 200 || chains.status === 201)
        && summary !== null
        && typeof summary.orders === 'number'
        && rows.every((row) => Array.isArray(row.gaps) && Array.isArray(row.tasks) && Array.isArray(row.materials)),
      `status=${chains.status} orders=${summary?.orders} withGaps=${withGaps.length} openSteps=${summary?.openSteps}`,
    );
    // 缺口词表必须是封闭的四类（出现未知缺口说明契约漂移）
    const KNOWN_GAPS = new Set(['task_link_missing', 'steps_missing', 'material_link_missing', 'due_at_missing']);
    step(
      'NO-57a2. 断链缺口只用封闭词表（未知缺口如实暴露 → 契约漂移）',
      rows.every((row) => (row.gaps ?? []).every((gap) => KNOWN_GAPS.has(gap))),
      `gaps=${[...new Set(rows.flatMap((row) => row.gaps ?? []))].join(',') || 'none'}`,
    );
  }

  // ── NO-57b：预计 vs 实际 对账口径 ──
  {
    const pva = await getJson('/api/scheduler/planned-vs-actual?windowDays=30', token);
    const body = pva.body ?? {};
    const ratesAreNull = body.meanAbsPctError === null && body.medianAbsPctError === null;
    const sampleEnough = Number(body.comparableRows ?? 0) >= 5;
    step(
      'NO-57b. 预计 vs 实际对账：样本足够给比率、样本不足给 null（绝不给 0%）',
      (pva.status === 200 || pva.status === 201)
        && typeof body.totalRows === 'number'
        && (sampleEnough ? typeof body.meanAbsPctError === 'number' : ratesAreNull)
        && Array.isArray(body.notes),
      `total=${body.totalRows} comparable=${body.comparableRows} coverage=${body.coverage} mean=${body.meanAbsPctError} notes=${(body.notes ?? []).length}`,
    );
  }

  finish();
}

main().catch((error) => {
  record('FAIL', '脚本异常', String(error?.stack ?? error));
  finish();
});
