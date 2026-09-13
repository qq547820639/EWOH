#!/usr/bin/env node
'use strict';

/**
 * 恢复"漂移"的能力停用（NO-65c 配套维护工具）。
 *
 * 与 `scripts/capability-drift-check.js`（只读巡检）配套：巡检发现某能力大面积停用后，
 * **必须走产品路径恢复**——恢复高风险能力属"放宽执行边界"，需要**他人**审批
 * （自批 403），一次审批可覆盖整批设备。本脚本就是这个流程的可重复实现，
 * 供运维/交班处置"被中断的 e2e 或误操作留下的停用行"。
 *
 * 安全边界（重要）：
 *   1. **默认 dry-run**：只打印将恢复哪些设备，必须显式 `--yes` 才真的调用；
 *   2. **只恢复"设备仍然声明该能力"的行**（`ewoh_device.capabilities` 含该能力，
 *      或型号可派生该能力）：否则恢复等于**凭空授予**一个设备从未具备的能力；
 *   3. 逐台走 `POST /api/devices/:id/capabilities/:key/status`（带审批号），
 *      平台侧的角色/审批闸门一律照旧生效——本脚本不绕过任何闸门。
 *
 * 用法：
 *   EWOH_DATABASE_URL=<owner 串> node scripts/capability-restore.js \
 *     --capability exo-lift --org-id <uuid> \
 *     --admin-user admin --admin-pass "$EWOH_E2E_ADMIN_PASS" \
 *     --approver-user approver.li --approver-pass "$EWOH_E2E_APPROVER_PASS" \
 *     [--base-url http://127.0.0.1:3100] [--yes]
 *
 * 退出码：0 = 全部恢复成功（或 dry-run 完成）；1 = 有设备恢复失败；2 = 参数/环境错误。
 */
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const postgres = requireFromApp('postgres');

function parseArgs(argv) {
  const out = { yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') { out.yes = true; continue; }
    if (!arg.startsWith('--')) continue;
    out[arg.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

/** 与 shared/device-capability.ts 的型号白名单一致（用于判断"设备是否声明过该能力"）。 */
function deriveFromModel(model, capability) {
  const m = String(model ?? '').toLowerCase();
  if (!m) return false;
  if ((m.includes('exo') || m.includes('pro') || m.includes('外骨骼')) && capability === 'exo-lift') return true;
  if (m.includes('lite') && capability === 'exo-lite') return true;
  if ((m.includes('vacuum') || m.includes('吸')) && capability === 'vacuum') return true;
  if ((m.includes('crane') || m.includes('吊')) && capability === 'crane') return true;
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capability = String(args.capability ?? '').trim();
  const orgId = String(args['org-id'] ?? process.env.EWOH_ORG_ID ?? '').trim();
  const baseUrl = String(args['base-url'] ?? process.env.EWOH_E2E_BACKEND_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
  const adminUser = args['admin-user'] ?? process.env.EWOH_E2E_ADMIN_USER ?? 'admin';
  const adminPass = args['admin-pass'] ?? process.env.EWOH_E2E_ADMIN_PASS ?? '';
  const approverUser = args['approver-user'] ?? process.env.EWOH_E2E_APPROVER_USER ?? 'approver.li';
  const approverPass = args['approver-pass'] ?? process.env.EWOH_E2E_APPROVER_PASS ?? '';
  const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
  const schema = process.env.EWOH_SCHEMA || 'public';
  if (!capability || !url || !adminPass || !approverPass) {
    console.error('用法：EWOH_DATABASE_URL=... node scripts/capability-restore.js --capability <key> --org-id <uuid> --admin-pass ... --approver-pass ... [--yes]');
    return 2;
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const request = async (method, apiPath, body, token) => {
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  };
  const login = async (username, password) => {
    const res = await request('POST', '/api/auth/login', { username, password });
    return res.body?.accessToken ?? null;
  };

  try {
    const candidates = await sql.unsafe(
      `SELECT c.device_id, d.capabilities AS declared, d.device_model AS model
         FROM ${schema}.ewoh_device_capability c
         LEFT JOIN ${schema}.ewoh_device d ON d.device_id = c.device_id
        WHERE c.capability_key = $1 AND c.status <> 'active'
          AND ($2::text IS NULL OR c.org_id::text = $2)`,
      [capability, orgId || null],
    );
    const eligible = candidates.filter((row) => {
      const declared = Array.isArray(row.declared) ? row.declared : [];
      return declared.includes(capability) || deriveFromModel(row.model, capability);
    });
    const skipped = candidates.length - eligible.length;
    console.log(
      `[capability-restore] 能力=${capability} 停用行=${candidates.length} 可恢复（设备仍声明）=${eligible.length} 跳过（设备未声明，恢复等于凭空授予）=${skipped}`,
    );
    if (eligible.length === 0) return 0;
    if (!args.yes) {
      console.log('dry-run（未加 --yes）：将恢复以下设备：');
      for (const row of eligible.slice(0, 20)) console.log(`  - ${row.device_id}`);
      if (eligible.length > 20) console.log(`  … 其余 ${eligible.length - 20} 台`);
      return 0;
    }

    const adminToken = await login(adminUser, adminPass);
    const approverToken = await login(approverUser, approverPass);
    if (!adminToken || !approverToken) {
      console.error('登录失败：请检查 --admin-user/--admin-pass 与 --approver-user/--approver-pass');
      return 2;
    }
    const deviceIds = eligible.map((row) => String(row.device_id));
    const reason = '运维：恢复被中断运行遗留的能力停用（capability-restore.js）';
    const created = await request('POST', '/api/approvals', {
      entityType: 'device_capability_change',
      entityId: `capability:${capability}`,
      roles: ['safety_admin'],
      subject: {
        objectType: 'device_capability_change',
        objectId: `capability:${capability}`,
        title: `恢复能力：${capability}（${deviceIds.length} 台设备）`,
        summary: reason,
        metrics: { capabilityKey: capability, deviceIds: [...deviceIds].sort().join(',') },
      },
    }, approverToken);
    const approvalId = created.body?.id ?? null;
    const stepId = created.body?.steps?.[0]?.id ?? null;
    if (!approvalId || !stepId) {
      console.error(`创建审批失败：HTTP ${created.status} ${JSON.stringify(created.body)?.slice(0, 200)}`);
      return 2;
    }
    const approved = await request(
      'POST',
      `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`,
      { reason: '运维安全复核：确认为中断遗留的停用行' },
      adminToken,
    );
    if (approved.status !== 200) {
      console.error(`审批未通过：HTTP ${approved.status} ${JSON.stringify(approved.body)?.slice(0, 200)}`);
      return 2;
    }
    let failed = 0;
    for (const deviceId of deviceIds) {
      const res = await request(
        'POST',
        `/api/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(capability)}/status`,
        { status: 'active', reason, approvalId },
        adminToken,
      );
      if (res.status !== 200 || res.body?.changed !== true) {
        failed += 1;
        console.error(`  恢复失败 ${deviceId}：HTTP ${res.status} ${JSON.stringify(res.body)?.slice(0, 160)}`);
      }
    }
    console.log(
      `[capability-restore] 完成：恢复 ${deviceIds.length - failed}/${deviceIds.length}（approval=${approvalId}）`,
    );
    return failed === 0 ? 0 : 1;
  } finally {
    await sql.end({ catch: () => undefined });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[capability-restore] 执行失败：', error?.message ?? error);
    process.exit(2);
  });
