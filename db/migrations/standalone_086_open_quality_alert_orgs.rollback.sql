-- 086 rollback：移除数据质量告警租户清单函数（手动触发（带 org 上下文）的单租户扫描仍可用）。

DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_open_quality_alert_orgs(interval);
