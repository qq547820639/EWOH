-- 085: 交接班记录保存"责任人核对快照"（ewoh_shift_handover.responsibility_snapshot_json）
--
-- 背景（NO-52a，2026-09-12）：
--
-- NO-51a 之后，设备责任人有班次维度（本班优先/全天兜底），但**交接班时没人核对**：
-- 交班的人看不到"下一班哪些设备没人负责"，接班的人也不知道自己接手了什么缺口。
-- 结果班次维度的价值只在"提醒触发时"才体现——而那时人可能已经下班了。
--
-- 本迁移只加一列（不改既有语义）：
--   · `responsibility_snapshot_json`：**交接时刻**计算的责任人核对快照
--     （{shiftId, shiftUnknown, total, covered, gaps, uncovered, devices:[…]}）。
--     存快照而不是"每次回看时重算"：事后审计要回答的是"交接当时知不知道没人负责"，
--     同一个问题在事实变化后重算会得到不同答案（审计不能这样）。
--
-- 回滚语义：回滚 = 删列（交接记录本身与 open_items 不受影响）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_shift_handover
  ADD COLUMN IF NOT EXISTS responsibility_snapshot_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_shift_handover.responsibility_snapshot_json IS
  '交接时刻的设备责任人核对快照（NO-52a）：{shiftId, shiftUnknown, total, covered, gaps, uncovered, devices:[{deviceId, covered, holders, outOfShift}]}。存快照的意义是审计"交接当时的状态"，而不是事后按现状重算。';
