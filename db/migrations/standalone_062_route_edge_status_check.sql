-- EWOH 2026-08-19 审计整改 — P1：route_edge.status CHECK 约束
-- (standalone_062, docs/audit-report-2026-08-19.md P1「route_edge.status 无 CHECK + 强制 cast 透传」)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 背景：ewoh_route_edge.status 为 varchar(50) 无 CHECK（006 注释口径
-- 'open|congested|blocked'，但种子/运维实际使用 'normal'——2026-08-19 已
-- 契约对齐为四值）。任何拼写错误（如 'nomol'）可直达路由计价与前端通道
-- 渲染（后端 as cast 透传），落入未知状态暗色兜底。
--
-- 收敛：
--   1) 存量归一：非法 status 统一回退 'open'（保守通行语义，避免 CHECK
--      落地时被存量脏行卡死）；
--   2) CHECK route_edge_status_valid：status IN ('open','normal','congested','blocked')；
--   3) 列注释更新为四值口径。
-- Re-entrant：先归一再 IF NOT EXISTS 加约束 / DROP IF EXISTS 回滚。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) 存量归一（幂等：合法值不受影响）
UPDATE __EWOH_SCHEMA__.ewoh_route_edge
  SET status = 'open'
  WHERE status NOT IN ('open', 'normal', 'congested', 'blocked');

-- 2) CHECK 约束（与 shared/scheduler.ts RouteGraphEdge.status 联合类型对齐）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'route_edge_status_valid'
      AND conrelid = '__EWOH_SCHEMA__.ewoh_route_edge'::regclass
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge
      ADD CONSTRAINT route_edge_status_valid
      CHECK (status IN ('open', 'normal', 'congested', 'blocked'));
  END IF;
END $$;

-- 3) 列注释口径更新（006 原注释缺 'normal'）
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_edge.status IS
  'open|normal|congested|blocked（standalone_062 CHECK 强制；2026-08-19 审计 P1 契约对齐）';
