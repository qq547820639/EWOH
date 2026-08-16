-- ewoh_schedule_plan shadow 隔离纵深防御 (standalone_048, ADR-038 / §13)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT（幂等可重复执行）。
--
-- 背景（§13 生产/仿真隔离红线 + simulation-production-isolation 收口）：
--   Shadow Plan（is_shadow=true：CP-SAT 对比 / 影子策略评估）绝不进入
--   生产执行链。既有防线 = 服务端 hard guard（plan.service 的 approve/
--   dispatch/reserve 拒绝 is_shadow 行）+ is_shadow DB 标识；本迁移补
--   DB 级 CHECK 纵深防御：即使服务层 guard 被绕过，生产状态与确认事实
--   也无法落在 shadow 行上（数据库兜底拒绝）。
--
-- 状态词表 = V2（approved/dispatched/executing/completed）+ 遗留生产面
-- （confirmed/proposed）的并集——shadow 行只允许 shadow/draft/rejected/
-- superseded 等非生产状态，且不得携带确认事实（confirmed_by/confirmed_at）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP CONSTRAINT IF EXISTS chk_ewoh_schedule_plan_shadow_not_production;

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD CONSTRAINT chk_ewoh_schedule_plan_shadow_not_production
  CHECK (
    is_shadow = false
    OR (
      status NOT IN ('approved', 'dispatched', 'executing', 'completed', 'confirmed', 'proposed')
      AND confirmed_by IS NULL
      AND confirmed_at IS NULL
    )
  );

COMMENT ON CONSTRAINT chk_ewoh_schedule_plan_shadow_not_production
  ON __EWOH_SCHEMA__.ewoh_schedule_plan IS
  'Shadow Plan 隔离纵深防御（ADR-038/§13）：is_shadow=true 的行不得进入生产状态（V2 approved/dispatched/executing/completed + 遗留 confirmed/proposed）且不得携带确认事实（confirmed_by/confirmed_at）——服务层 guard 被绕过时由数据库兜底拒绝。';
