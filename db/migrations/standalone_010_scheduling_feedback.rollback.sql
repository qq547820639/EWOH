-- EWOH Command Map 智能调度驾驶舱 — scheduling feedback table rollback (Task 7)
-- DESTRUCTIVE-optional: drops the ewoh_scheduling_feedback table added by
-- standalone_010_scheduling_feedback.sql. Guarded with IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_feedback;