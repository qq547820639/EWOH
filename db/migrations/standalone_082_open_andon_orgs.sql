-- 082: 有未关闭安灯的租户清单（供安灯 SLA 扫描 worker 跨租户扫描）
--
-- 背景（NO-48a，2026-09-12）：
--
-- 安灯"超时未接手"需要一个**周期性**扫描（红灯亮了没人接手是必须主动叫人的场景），
-- 而后台 worker 没有 HTTP 请求上下文 → `RequestDatabaseContext` 回落根句柄 →
-- 没有 `app.current_org_id` GUC → `ewoh_event` 的 RLS 策略把行全部挡住，
-- worker 会静默扫到 0 个租户（NO-37a 在 `ewoh_exo_session` 上实测过同样的坑，
-- 见 production-runbook「后台 Worker」）。
--
-- 因此需要一个受控的**只读**跨租户入口：以 ewoh_owner（表 owner）执行，
-- 但**只返回 org_id 列表**——安灯标题、设备、时间等细节一律不出库；
-- 拿到租户后仍按租户开启 GUC 事务再读明细，租户隔离在真正读数据的那一步照旧生效。
--
-- 过滤条件与扫描语义一致：
--   · 只关心 `AndonRaised` / `andon` 事件（ADR-031 canonical + 历史兼容）；
--   · 只要 status = 'open'（**没人接手**）——已接手/已关闭不参与升级；
--   · 只看最近 `lookbackDays` 天创建的行（参数化），避免全历史扫描。

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_open_andon_orgs(p_lookback interval)
RETURNS TABLE (org_id varchar(255))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
  SELECT DISTINCT e.org_id
  FROM __EWOH_SCHEMA__.ewoh_event AS e
  WHERE e.event_type IN ('AndonRaised', 'andon')
    AND e.status = 'open'
    AND e.org_id IS NOT NULL
    AND e.created_at > now() - p_lookback;
$$;

COMMENT ON FUNCTION __EWOH_SCHEMA__.ewoh_open_andon_orgs(interval) IS
  '有"未接手"（status=open）安灯的租户清单（只返回 org_id；供安灯 SLA 扫描 worker 逐租户开启 GUC 事务后再读明细）。';

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_open_andon_orgs(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_open_andon_orgs(interval) TO service_role;
