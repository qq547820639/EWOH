-- 107 rollback：移除控制请求状态词表约束，并把默认值改回 `draft`（不删除任何业务事实）。
-- 注意：回滚只解除"以后不能再写词表外值"这道闸；已经按契约词表写入的行保持不变。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_request
  DROP CONSTRAINT IF EXISTS ck_control_request_status_contract;

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_request
  ALTER COLUMN status SET DEFAULT 'draft';
