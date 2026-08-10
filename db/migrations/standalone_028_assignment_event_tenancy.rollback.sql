-- EWOH Command Map — standalone_028 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 028 增量可回滚语义：
--   撤销派生机制三件套：DROP TRIGGER IF EXISTS + DROP FUNCTION IF EXISTS +
--   DROP INDEX IF EXISTS（均幂等可重复执行）。
--
-- org_id 列**保留**（additive safe，有意的设计选择）：
--   - 删列属破坏性变更，且列本身无副作用（非空 org_id 仅由显式写入或派生触发器产生；
--     触发器移除后列成为普通血缘列，行为与 025 之前的 ewoh_schedule_plan.org_id 相同）；
--   - 保留列使 028 可安全重放（ADD COLUMN IF NOT EXISTS 跳过），满足
--     apply → rollback → re-apply 循环；verify 与 E2E 仅在有触发器时断言派生行为。
--   - 若未来确需彻底移除，应走独立显式迁移（DROP COLUMN），不混入本 rollback。
--
-- 回滚后：ewoh_assignment_event 回到 025/006 状态（无 org_id 列之外的派生机制），
-- RLS 保持关闭（本迁移从未启用，与 ADR-004 的 DERIVED_TENANT_OWNERSHIP 一致）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) 撤销派生触发器
DROP TRIGGER IF EXISTS trg_assignment_event_derive_org
  ON __EWOH_SCHEMA__.ewoh_assignment_event;

-- 2) 撤销派生函数
DROP FUNCTION IF EXISTS derive_assignment_event_org();

-- 3) 撤销 org_id 索引（列保留，见上）
DROP INDEX IF EXISTS idx_ewoh_assignment_event_org;
