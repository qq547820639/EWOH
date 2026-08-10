-- EWOH Command Map 智能调度 — 世界快照版本原子计数器 (standalone_031)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（原子快照版本分配）：WorldStateSnapshotService.buildSnapshot 原先在事务外
-- 先读 ewoh_world_state_snapshot 中最大的 WS-YYYYMMDD-NNNN 再 +1（read-then-increment），
-- 并发下多个请求会算出同一个版本号，第二个插入命中 snapshot_version 全局唯一约束
-- （standalone_006，ewoh_world_state_snapshot_snapshot_version_key）抛 23505 且无重试。
-- 本迁移引入按天计数表，把「分配」与「快照插入」放进同一事务：
-- INSERT ... ON CONFLICT (day) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq
-- 以行锁串行化同一天内的分配，保证并发下版本互异且无缺口；
-- ewoh_world_state_snapshot.snapshot_version 唯一约束保留为最终兜底。
--
-- 语义：
--   - day：YYYYMMDD（与 WS-YYYYMMDD-NNNN 前缀直接对应，字符串序 == 日期序）；
--   - last_seq：当天已分配的最大序号（每次分配 +1，事务回滚自动回退）；
--   - 旧数据（read-then-increment 时代）不迁移：应用层有界重试（23505 →
--     重新分配）保证与历史版本收敛一致；
--   - 无外键/触发器/RLS：纯计数器表，仅被 world-state 服务的 upsert 触碰。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_snapshot_version_counter (
  day varchar(8) PRIMARY KEY,
  last_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_snapshot_version_counter IS '世界快照版本原子分配计数器：按天（YYYYMMDD）维护 WS-YYYYMMDD-NNNN 的 last_seq，应用在同一事务内 upsert（ON CONFLICT (day) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq）实现并发原子分配；snapshot_version 唯一约束保留为兜底';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_snapshot_version_counter.day IS '自然日 YYYYMMDD（即 WS-YYYYMMDD-NNNN 前缀）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_snapshot_version_counter.last_seq IS '当天已分配的版本序号（分配即 +1；事务回滚自动回退，避免缺口）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_snapshot_version_counter.created_at IS '该天首次分配时间';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_snapshot_version_counter._updated_at IS '该天最近一次分配时间';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_snapshot_version_counter TO service_role;
