-- standalone_068_dashboard_org_composite_indexes：dashboard overview 复合索引（审计 T6，2026-08-28）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant：CREATE INDEX IF NOT EXISTS / DROP INDEX IF EXISTS（幂等可重复执行）。
--
-- 背景（全量代码深度审计 2026-08-28 / T6 / P0-3）：
--   GET /api/dashboard/overview 的 4 个并行聚合查询此前仅有单列 org_id 索引
--   （001 迁移 :1384/:1396/:1426），未命中缓存路径必须按 org 拉全量行再过滤：
--     - ewoh_event     29,405 行/org/次（status/severity 的 FILTER 聚合）
--     - ewoh_telemetry 写入量最高表（1h 窗口 avg(load_score)）
--     - ewoh_device    online FILTER 计数
--   历史实测：缓存未命中 0.799s、冷启动 6.444s；连接池 10→20 仅改善 5.4%，
--   证明瓶颈在扫描量而非等连接。本迁移以 covering 复合索引把三查询压到
--   index-only scan。
--
--   ⚠ 审计建议修正（相对路线图 T6 的差异）：原建议「把 status='open' 从
--   FILTER 移入 WHERE」经复核不可采纳——同一查询内还有 critical 的
--   count(*) FILTER (WHERE severity IN ...)，WHERE 前置过滤会错误裁剪
--   critical 计数（status≠'open' 的 critical 行丢失）。故本迁移仅建索引、
--   不改查询语义，靠 (org_id, status, severity) 覆盖索引达成 index-only。
--
-- CREATE INDEX 并发策略：跟随仓库现状（001 起全部为事务内普通 CREATE
-- INDEX IF NOT EXISTS，部署窗口由发布流程保证）；不引入 CONCURRENTLY
-- 破坏 runner 的事务执行模型（postgres.js sql.begin 单事务）。
--
-- 索引列序设计：
--   ewoh_event     (org_id, status, severity)   —— 等值 org → 两个 FILTER 列全覆盖
--   ewoh_telemetry (org_id, ts) INCLUDE (load_score) —— ts 范围扫描 + covering avg
--   ewoh_device    (org_id, online)             —— 等值 org + boolean FILTER

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE INDEX IF NOT EXISTS idx_ewoh_event_org_status_severity
  ON __EWOH_SCHEMA__.ewoh_event (org_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_ewoh_telemetry_org_ts_load
  ON __EWOH_SCHEMA__.ewoh_telemetry (org_id, ts) INCLUDE (load_score);

CREATE INDEX IF NOT EXISTS idx_ewoh_device_org_online
  ON __EWOH_SCHEMA__.ewoh_device (org_id, online);
