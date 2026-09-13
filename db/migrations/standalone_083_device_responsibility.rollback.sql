-- 083 rollback：移除设备责任人台账。
--
-- 回滚即回到"提醒只发角色"的旧语义（安灯与升级提醒仍然可用，只是不再点名到责任人）。
-- 责任关系属于可重建的配置数据，回滚不涉及既有事实。

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_device_responsibility;
