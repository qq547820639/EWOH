-- 086: 有未处置数据质量告警的租户清单（供数据质量"待核实"提醒 worker 跨租户扫描）
--
-- 背景（NO-53a，2026-09-12）：
--
-- 摄入侧会自动分级数据质量并对可疑数据开 `DataQualityAlert`（status=open），
-- 人工在工作台可以确认/质疑——但**没有人被主动叫到**：告警安静地躺在事件表里，
-- 直到有人恰好打开页面。补救需要一个周期性扫描，而后台 worker 没有请求上下文 →
-- 没有 `app.current_org_id` GUC → `ewoh_event` 的 RLS 会把行全部挡住
-- （NO-37a/NO-48a 两次实测同样的坑）。
--
-- 因此需要一个受控的**只读**跨租户入口：以 ewoh_owner 执行，但**只返回 org_id**，
-- 告警标题、设备、时间等细节一律不出库；拿到租户后仍按租户开 GUC 事务再读明细。
--
-- 过滤：只关心 open 的 DataQualityAlert，且只看最近 `lookbackDays` 天。

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_open_quality_alert_orgs(p_lookback interval)
RETURNS TABLE (org_id varchar(255))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
  SELECT DISTINCT e.org_id
  FROM __EWOH_SCHEMA__.ewoh_event AS e
  WHERE e.event_type = 'DataQualityAlert'
    AND e.status = 'open'
    AND e.org_id IS NOT NULL
    AND e.created_at > now() - p_lookback;
$$;

COMMENT ON FUNCTION __EWOH_SCHEMA__.ewoh_open_quality_alert_orgs(interval) IS
  '有未处置（status=open）数据质量告警的租户清单（只返回 org_id；供数据质量待核实提醒 worker 逐租户开启 GUC 事务后再读明细）。';

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_open_quality_alert_orgs(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_open_quality_alert_orgs(interval) TO service_role;
