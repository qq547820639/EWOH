-- EWOH Command Map 智能调度驾驶舱 — Conflict Lifecycle 持久化 rollback (Phase 3 / P3-T1)
-- DESTRUCTIVE-optional: 移除 ewoh_scheduling_conflict 表。
-- Guarded with DROP TABLE IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_conflict;
