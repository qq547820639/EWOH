#!/usr/bin/env node
'use strict';

/**
 * 能力停用状态巡检（NO-65c）。
 *
 * 为什么需要它：`e2e:capability-explain` 会**真的**停用一批设备的高风险能力（这是它要验证的
 * 语义），但**被中断或失败的运行**只恢复了"它这一轮停用的那批"——历史上失败运行留下的
 * `status='disabled'` 行会累积。实测：`exo-lift` 一度有 116 台设备处于停用状态，直接后果是
 * `e2e:exo-session` 报"台账里没有具备 exo-lift 的外骨骼设备"——**环境漂移被伪装成产品缺陷**。
 *
 * 本工具只做两件事，且都不改业务数据（除非显式 `--restore`）：
 *   1. **巡检（默认）**：列出停用/非 active 的能力台账行，按能力聚合 + 标出最老的停用时间；
 *      发现"高风险能力大面积停用"时以非零退出码报告（可接 CI / 交接班检查）。
 *   2. **恢复提示**：打印**产品路径**的恢复方法（审批 + `POST /devices/:id/capabilities/:key/status`），
 *      绝不手改库——恢复高风险能力属"放宽"，必须由**他人**审批（现场纪律，见 runbook）。
 *
 * 用法：
 *   EWOH_DATABASE_URL=<owner 串> node scripts/capability-drift-check.js \
 *     [--org-id <uuid>] [--json] [--fail-threshold <n>]
 *
 * 退出码：0 = 无异常；1 = 超过阈值（默认：任一高风险能力停用设备数 ≥ 5）。
 */
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const postgres = requireFromApp('postgres');

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const orgArg = args.indexOf('--org-id');
const orgId = orgArg >= 0 ? args[orgArg + 1] : process.env.EWOH_ORG_ID || null;
const thresholdArg = args.indexOf('--fail-threshold');
const threshold = thresholdArg >= 0 ? Number(args[thresholdArg + 1]) : 5;

const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
if (!url) {
  console.error('缺少 EWOH_DATABASE_URL（owner 连接串；本工具只读，除非显式 --restore）');
  process.exit(2);
}
const schema = process.env.EWOH_SCHEMA || 'public';

/** 高风险执行能力（与 shared/device-capability.ts 的 risk='high' 对齐；用于阈值判定）。 */
const HIGH_RISK_CAPABILITIES = ['exo-lift', 'interact.assist', 'transport.move', 'crane', 'emergency_stop'];

async function main() {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.unsafe(
      `SELECT capability_key,
              count(*)::int AS disabled_count,
              min(_updated_at) AS oldest_disabled_at,
              max(_updated_at) AS newest_disabled_at
         FROM ${schema}.ewoh_device_capability
        WHERE status <> 'active'
          AND ($1::text IS NULL OR org_id::text = $1)
        GROUP BY capability_key
        ORDER BY disabled_count DESC`,
      [orgId],
    );
    const lifecycleRows = await sql.unsafe(
      `SELECT capability_key,
              count(*) FILTER (WHERE capability_value->'lifecycle'->>'reason' IS NULL)::int AS without_reason,
              count(*) FILTER (WHERE capability_value->'lifecycle'->>'operator' IS NULL)::int AS without_operator
         FROM ${schema}.ewoh_device_capability
        WHERE status <> 'active'
          AND ($1::text IS NULL OR org_id::text = $1)
        GROUP BY capability_key`,
      [orgId],
    );
    const lifecycleByKey = new Map(lifecycleRows.map((r) => [String(r.capability_key), r]));
    const drift = rows.map((row) => {
      const key = String(row.capability_key);
      const lifecycle = lifecycleByKey.get(key);
      return {
        capability: key,
        disabledCount: Number(row.disabled_count),
        highRisk: HIGH_RISK_CAPABILITIES.includes(key),
        oldestDisabledAt: row.oldest_disabled_at ? new Date(row.oldest_disabled_at).toISOString() : null,
        newestDisabledAt: row.newest_disabled_at ? new Date(row.newest_disabled_at).toISOString() : null,
        // 缺留痕 ≠ 无关紧要：没有 operator/reason 的停用行现场无法追溯（原则 5）。
        withoutReason: Number(lifecycle?.without_reason ?? 0),
        withoutOperator: Number(lifecycle?.without_operator ?? 0),
      };
    });
    const offenders = drift.filter((d) => d.highRisk && d.disabledCount >= threshold);

    if (jsonOut) {
      console.log(JSON.stringify({ orgId, threshold, drift, offenders }, null, 2));
    } else {
      console.log(`[capability-drift] org=${orgId ?? '(全部)'} schema=${schema} 阈值=${threshold}`);
      if (drift.length === 0) {
        console.log('  ✅ 没有非 active 的能力台账行（无漂移）');
      }
      for (const d of drift) {
        const flag = d.highRisk ? '高风险' : '普通';
        console.log(
          `  ${d.highRisk && d.disabledCount >= threshold ? '⚠️ ' : '   '}${d.capability}（${flag}）：`
            + `${d.disabledCount} 台停用；最老 ${d.oldestDisabledAt ?? '-'}；最新 ${d.newestDisabledAt ?? '-'}`
            + `${d.withoutReason > 0 ? `；${d.withoutReason} 行缺理由` : ''}`
            + `${d.withoutOperator > 0 ? `；${d.withoutOperator} 行缺操作者` : ''}`,
        );
      }
      if (offenders.length > 0) {
        console.log('\n处置（必须走产品路径，不要手改库）：');
        console.log('  1) 核对是否真的该停用：查 lifecycle 的 operator/reason（上面的"缺理由/缺操作者"列）；');
        console.log('  2) 需要恢复 → 走审批：POST /api/approvals（entityType=capability_relaxation）'
          + ' → 他人批准 → POST /api/devices/{deviceId}/capabilities/{capabilityKey}/status'
          + '（status=active + approvalId，一次审批可覆盖整批设备）；');
        console.log('  3) 被中断的 e2e 运行留下的停用行按同一路径恢复——'
          + '恢复后本巡检应清零（见 docs/operations/production-runbook.md）。');
      }
      console.log(
        `\n结论：${offenders.length === 0 ? '无超出阈值的高风险能力漂移' : `${offenders.length} 项高风险能力超过阈值（${threshold} 台）`}`,
      );
    }
    process.exit(offenders.length === 0 ? 0 : 1);
  } finally {
    await sql.end({ catch: () => undefined });
  }
}

main().catch((error) => {
  console.error('[capability-drift] 执行失败：', error?.message ?? error);
  process.exit(2);
});
