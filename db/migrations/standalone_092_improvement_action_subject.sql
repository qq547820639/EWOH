-- EWOH 改进行动项的"对象归属"（NO-58a）——复发度量的前置条件
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / 幂等可重复执行。
--
-- 背景：行动项此前只有 `source_ref`（复盘号），**没有对象归属**，于是"这类改进是否降低了复发"
-- 无法计算——没有对象就没有可比的前后窗口。本迁移补上 `subject_type`/`subject_id`：
--   · 由复盘记录派生（`scope=incident` 的 `target_id` 即受影响对象；plan/shift 复盘没有单一对象 → 空）。
--   · CHECK：两列必须同时有或同时无；类型在封闭词表内（device/person/station）。
--   为空 = **未绑定对象**（页面必须显式显示"无法度量复发"，不许看起来像"没有复发"）。
--
-- 回滚语义：DROP COLUMN（additive）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
  ADD COLUMN IF NOT EXISTS subject_type varchar(32),
  ADD COLUMN IF NOT EXISTS subject_id varchar(255);

-- 注意（NO-62 审计）：CHECK 里**必须显式写 `subject_type IS NOT NULL`**。
-- 只写 `subject_type IN (...)` 时，`subject_type = NULL` 会让该子句求值为 NULL，
-- `false OR NULL = NULL` → CHECK 视为通过 —— "只有 id 没有类型"的半成品归属被静默放行
-- （SQL 三值逻辑；093 的同类缺陷由 verify 探针当场抓到，这里一并烧掉并补第三个探针）。
DO $$
BEGIN
  -- 契约收紧 → 先删后建（迁移仍可重复执行；存量行违反新契约时 ADD 显式失败）。
  ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
    DROP CONSTRAINT IF EXISTS chk_ewoh_improvement_action_subject_pair;
  ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
    ADD CONSTRAINT chk_ewoh_improvement_action_subject_pair
    CHECK (
      (subject_type IS NULL AND subject_id IS NULL)
      OR (subject_type IS NOT NULL
          AND subject_type IN ('device', 'person', 'station')
          AND subject_id IS NOT NULL AND length(btrim(subject_id)) > 0)
    );
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.subject_type IS
  '对象类型（device/person/station）；NULL = 未绑定对象 → 复发不可度量（页面必须显式说明）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.subject_id IS
  '对象 id（与 subject_type 成对；由复盘 target_id 派生）';
