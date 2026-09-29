-- EWOH 控制命令“已下发”状态/时间配对约束（NO-68a）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: 先删后建同名 CHECK；存量违例行会让 ADD CONSTRAINT 显式失败。
--
-- 边界：控制命令的“下发”不是界面意图，而是带 sent_at 的可审计事实。
-- 服务层写入 status='sent' 时始终设置 sent_at；本约束把这个契约收敛到数据库层，
-- 防止绕过服务的写入或未来回归把 status='sent' 伪造成已下发。
-- 该约束只收紧 sent 状态；pending/终态行的时间语义由各自状态契约管理。
--
-- 回滚语义：DROP CONSTRAINT（不修改任何现场事实）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
    DROP CONSTRAINT IF EXISTS chk_ewoh_control_command_sent_has_time;
  ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
    ADD CONSTRAINT chk_ewoh_control_command_sent_has_time
    CHECK (status <> 'sent' OR sent_at IS NOT NULL);
END $$;

COMMENT ON CONSTRAINT chk_ewoh_control_command_sent_has_time
  ON __EWOH_SCHEMA__.ewoh_control_command IS
  'status=sent 必须携带 sent_at；下发状态不得脱离投递时间证据单独存在';
