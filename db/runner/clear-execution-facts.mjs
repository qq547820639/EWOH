#!/usr/bin/env node
/**
 * 清空某租户的排产执行/反馈事实（golden-fresh 复验用，NO-87a）。
 *
 * 为什么 reset-scenario-data 不够：reset 只删 seed 任务派生的执行行
 * （join t.source='seed'）；场景自建任务（AGV/控制/perception...）的执行回执
 * 会残留，其迟到数据进入 KPI 24h 窗口 → golden 激活门禁持续"不达标"，
 * 全路径激活复验永远 SKIP。本脚本清的是派生事实（可重建），不碰配置种子。
 *
 * 用法（须在 ewoh-spark-app 下解析 postgres 依赖）：
 *   cd ewoh-spark-app && node ../db/runner/clear-execution-facts.mjs --org-id <uuid>
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ewoh-spark-app');
const requireApp = createRequire(path.join(appDir, 'package.json'));
const postgres = requireApp('postgres');

const args = process.argv.slice(2);
const orgIdx = args.indexOf('--org-id');
const orgId = orgIdx >= 0 ? args[orgIdx + 1] : '00000000-0000-4000-8000-000000000001';
const url = process.env.EWOH_DATABASE_URL || 'postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh';

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const exec = await sql`
    delete from ewoh_scheduling_execution where org_id = ${orgId}`;
  const feedback = await sql`
    delete from ewoh_scheduling_feedback where org_id = ${orgId}`;
  const kpi = await sql`
    delete from ewoh_scheduling_kpi where org_id = ${orgId}`;
  console.log(
    `fresh-clean: executions=${exec.count} feedback=${feedback.count} kpiSnapshots=${kpi.count}`,
  );
} catch (error) {
  console.error('清理失败：', error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
