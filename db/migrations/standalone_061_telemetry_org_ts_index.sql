-- EWOH 2026-08-19 审计整改 — P1：telemetry (org_id, ts) 复合索引
-- (standalone_061, docs/audit-report-2026-08-19.md P1「telemetry 缺 (org_id, ts) 索引」)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 背景：仪表盘 / AI 上下文 / 游戏化（getBrainSuggestions LLM 增强）三处高频
-- 轮询均按 `where org_id = $1 and ts >= now() - interval '...'` 过滤，而现有
-- 索引仅有 idx_ewoh_telemetry_org(org_id)（单列，org 内仍需全量时间过滤）与
-- idx_ewoh_telemetry_entity_id(entity_id)。org 单租户行集大时 (org_id, ts)
-- 范围扫描退化为 Seq Scan，遥测表随轮询持续放大。
--
-- 收敛：复合索引 idx_ewoh_telemetry_org_ts(org_id, ts DESC)——等值 org +
-- 范围 ts 的最优序（ts DESC 与「最近 N 条/最近窗口」查询方向一致，可正向扫）。
-- Re-entrant：CREATE INDEX IF NOT EXISTS / DROP INDEX IF EXISTS 幂等。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE INDEX IF NOT EXISTS idx_ewoh_telemetry_org_ts
  ON __EWOH_SCHEMA__.ewoh_telemetry (org_id, ts DESC);

COMMENT ON INDEX __EWOH_SCHEMA__.idx_ewoh_telemetry_org_ts IS
  'telemetry 租户+时间范围扫描（仪表盘/AI 上下文/游戏化轮询 where org_id=? and ts>=? 专用；2026-08-19 审计 P1）';
