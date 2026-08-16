#!/usr/bin/env node
/**
 * Identity legacy 存量 reconcile 任务（ADR-006 Migration 步骤 3 / NO-02d）。
 *
 * 目标：为 ewoh_device 存量设备登记 ewoh_identity_mapping 映射
 * （source.system=edge-device，source.id=设备原始 deviceId，
 * target.entityId = device:<UUIDv5>——内部 ID 由 EWOH 生成，第三方 ID 仅作 alias，
 * 绝不以 deviceId 直接作为内部身份）。
 *
 * 安全不变量（§33/§20）：
 *   - Append-only：只 INSERT ... ON CONFLICT DO NOTHING，绝不 UPDATE/DELETE 存量行；
 *   - 幂等：同 (org_id, source_system, source_id) 重复运行零新增；
 *   - 确定性：target UUID 由 RFC 4122 v5（SHA-1 命名空间）从 deviceId 推导，
 *     跨运行稳定、跨实例一致；
 *   - 显式租户：--org 必填（identity_mapping 为 TENANT_SCOPED，standalone_032）；
 *     dry-run 为默认，--apply 才写库；
 *   - BLOCKED_BY_ENVIRONMENT 诚实约定：连接串缺失/驱动缺失 → ::notice:: + exit 0。
 *
 * 用法：
 *   node scripts/reconcile-identity-legacy.mjs --org <orgId>              # dry-run
 *   node scripts/reconcile-identity-legacy.mjs --org <orgId> --apply      # 落库
 *   --limit N 限制单次处理行数（默认 1000）
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const APP_DIR = path.join(ROOT, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(APP_DIR, 'package.json'));

const EDGE_DEVICE_SYSTEM = 'edge-device';
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC 4122 DNS 命名空间（固定）。

/** RFC 4122 v5 UUID（SHA-1 命名空间哈希）——确定性推导设备规范身份。 */
function uuidV5(name) {
  const hash = createHash('sha1').update(Buffer.from(UUID_NAMESPACE.replace(/-/g, ''), 'hex')).update(Buffer.from(String(name), 'utf8')).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseArgs(argv) {
  const args = { org: null, apply: false, limit: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') args.org = argv[++i];
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function blocked(reason) {
  console.log(`::notice::BLOCKED_BY_ENVIRONMENT: ${reason}`);
  console.log('RESULT {"status":"BLOCKED_BY_ENVIRONMENT"}');
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.org || args.org.length === 0 || args.org.length > 255) {
    console.error('USAGE: node scripts/reconcile-identity-legacy.mjs --org <orgId> [--apply] [--limit N]');
    process.exit(2);
  }

  const url = process.env.EWOH_DATABASE_URL || process.env.EWOH_RUNTIME_DATABASE_URL;
  if (!url) blocked('EWOH_DATABASE_URL/EWOH_RUNTIME_DATABASE_URL 未配置');

  let postgres = null;
  try {
    postgres = requireFromApp('postgres');
  } catch {
    blocked('postgres driver unavailable (ewoh-spark-app node_modules not installed)');
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const devices = await sql`
      SELECT device_id FROM ewoh_device
      WHERE device_id IS NOT NULL AND device_id <> ''
      ORDER BY device_id
      LIMIT ${args.limit}
    `;
    const planned = [];
    for (const row of devices) {
      const deviceId = row.device_id;
      const target = `device:${uuidV5(deviceId)}`;
      const existing = await sql`
        SELECT 1 FROM ewoh_identity_mapping
        WHERE org_id = ${args.org}
          AND source_system = ${EDGE_DEVICE_SYSTEM}
          AND source_id = ${deviceId}
          AND status = 'active'
        LIMIT 1
      `;
      if (existing.length > 0) continue;
      planned.push({
        mappingId: `map:${uuidV5(`${args.org}:${EDGE_DEVICE_SYSTEM}:${deviceId}`)}`,
        sourceSystem: EDGE_DEVICE_SYSTEM,
        sourceId: deviceId,
        target,
      });
    }

    if (planned.length === 0) {
      console.log(`RECONCILE: 0 new mappings needed (org=${args.org}, scanned=${devices.length})`);
      console.log('RESULT {"status":"PASS","planned":0,"applied":0}');
      process.exit(0);
    }

    console.log(`RECONCILE ${args.apply ? 'APPLY' : 'DRY-RUN'}: ${planned.length} new identity mappings (org=${args.org}, scanned=${devices.length})`);
    for (const p of planned.slice(0, 10)) {
      console.log(`  plan: ${p.sourceSystem}:${p.sourceId} -> ${p.target}`);
    }
    if (planned.length > 10) console.log(`  ... and ${planned.length - 10} more`);

    if (!args.apply) {
      console.log('RESULT {"status":"DRY_RUN","planned":${planned.length},"applied":0}'.replace('${planned.length}', planned.length));
      process.exit(0);
    }

    // Append-only 落库：ON CONFLICT DO NOTHING（幂等；绝不改写存量行）。
    let applied = 0;
    for (const p of planned) {
      const inserted = await sql`
        INSERT INTO ewoh_identity_mapping
          (org_id, mapping_id, version, source_system, source_id, source_id_kind,
           target_entity_id, target_kind, authority, status, recorded_at, valid_from,
           valid_to, evidence_id)
        VALUES
          (${args.org}, ${p.mappingId}, 1, ${p.sourceSystem}, ${p.sourceId}, NULL,
           ${p.target}, 'device', 'adapter', 'active', now(), NULL, NULL,
           'legacy-reconcile')
        ON CONFLICT (org_id, source_system, source_id) DO NOTHING
        RETURNING id
      `;
      applied += inserted.length;
    }
    console.log(`RECONCILE APPLY: applied=${applied} (idempotent; re-runs add 0)`);
    console.log(`RESULT {"status":"PASS","planned":${planned.length},"applied":${applied}}`);
    process.exit(0);
  } catch (err) {
    console.error(`RECONCILE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.log('RESULT {"status":"FAIL"}');
    process.exit(1);
  } finally {
    await sql.end().catch(() => {});
  }
}

// 作为模块被 import 时不执行（供测试复用 uuidV5）；CLI 直跑才进入 main。
export { uuidV5 };

const isDirectRun =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main();
}
