-- 082 rollback：移除"有未接手安灯的租户清单"函数。
--
-- 回滚即失去安灯 SLA 扫描 worker 的跨租户入口（手动触发（带 org 上下文）的
-- 单租户扫描仍然可用；安灯本身的业务事实与已发出的提醒不受影响）。

DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_open_andon_orgs(interval);
