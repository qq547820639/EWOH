-- EWOH Command Map 智能调度驾驶舱 — Solver Objective 8 权重版本化 verification (Phase 2 / P2-T2)
-- Returns a single row with:
--   policy_weights_json  — 1 if ewoh_scheduling_policy.weights_json exists
--   plan_weights_json    — 1 if ewoh_schedule_plan.weights_json exists
-- A result of (1,1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_scheduling_policy'
      AND c.column_name = 'weights_json'
  ) AS policy_weights_json,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_schedule_plan'
      AND c.column_name = 'weights_json'
  ) AS plan_weights_json;
