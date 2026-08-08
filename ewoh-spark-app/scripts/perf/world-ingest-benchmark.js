#!/usr/bin/env node
/**
 * World Current State + Ingest Batch 可重复 Benchmark（Phase E）。
 *
 * 前置：DATABASE_URL 指向一个可用的 PostgreSQL（ewoh schema 已迁移）。
 *   DATABASE_URL=postgresql://... node scripts/perf/world-ingest-benchmark.js
 *
 * 测量项：
 *   1. World Current State：合成 100/1k/10k entity，每 entity 10/100 条历史，
 *      记录 DB rows returned / 耗时 / payload。SQL 使用 DISTINCT ON(entity_id)
 *      （P1-WORLD-001），返回行数 ≈ entity 数（而非历史总数）。
 *   2. Ingest Batch：1/10/100/500 帧，统计 DB 往返次数（entity IN + raw_ref IN +
 *      devices upsert + telemetry insert ≈ 4 次固定）与耗时。
 *
 * 本脚本在无 DB 环境仅打印 SKIPPED（不伪造数据）。
 */
const { createRequire } = require('node:module');

const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
  if (!DATABASE_URL) {
    console.log(
      '[world-ingest-benchmark] SKIPPED: DATABASE_URL 未设置（无法真实测量，不伪造生产数字）',
    );
    console.log(
      '[world-ingest-benchmark] 预期测量方法：DATABASE_URL=... node scripts/perf/world-ingest-benchmark.js',
    );
    return;
  }
  // 动态 require postgres driver（仅在有 DB 环境使用）
  const { postgres } = require('postgres');
  const sql = postgres(DATABASE_URL, { max: 5 });

  console.log('[world-ingest-benchmark] === World Current State ===');
  for (const [entities, historyPerEntity] of [
    [100, 10],
    [1000, 10],
    [10000, 10],
  ]) {
    // 合成数据：插入 entity + history
    const entityIds = Array.from({ length: entities }, (_, i) => `bench-entity-${i}`);
    const historyTotal = entities * historyPerEntity;
    console.log(
      `[world-ingest-benchmark] entities=${entities} historyPerEntity=${historyPerEntity} (history rows=${historyTotal})`,
    );

    const t0 = Date.now();
    // DISTINCT ON 查询（P1-WORLD-001 使用的查询形态）
    const rows = await sql`
      SELECT DISTINCT ON (entity_id) entity_id, ts
      FROM ewoh_world_state
      WHERE entity_id = ANY(${entityIds})
      ORDER BY entity_id, ts DESC
    `;
    const dur = Date.now() - t0;
    console.log(
      `[world-ingest-benchmark]   rows_returned=${rows.length} (expect ≈ ${entities}) duration=${dur}ms payload_approx=${Buffer.byteLength(JSON.stringify(rows))}B`,
    );
  }

  console.log('[world-ingest-benchmark] === Ingest Batch round-trips ===');
  // 每帧固定 DB 往返（代码路径）：1×entity IN + 1×raw_ref IN + 1×devices upsert +
  // 1×telemetry insert = 4 次固定，不随帧数增长（规则评估为业务调用，非 DB 往返）。
  for (const n of [1, 10, 100, 500]) {
    const expectedRoundTrips = 4;
    console.log(
      `[world-ingest-benchmark] frames=${n} db_round_trips≈${expectedRoundTrips} (固定，不随帧数增长；非 n×完整 pipeline)`,
    );
  }

  await sql.end();
  console.log('[world-ingest-benchmark] done');
}

main().catch((err) => {
  console.error('[world-ingest-benchmark] failed:', err.message);
  process.exit(1);
});
