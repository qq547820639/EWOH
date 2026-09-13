-- 078 rollback：移除人员→账号反查函数。
--
-- 只删函数，不触碰任何表/列/索引：本迁移没有引入新的事实存储，删除后
-- 会话提醒会退化为"只发角色通知"（找不到佩戴者账号即如实列进 unresolvedWearers），
-- 不会造成数据丢失或状态不一致。

DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_find_active_users_by_person(uuid, text[]);
DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_active_exo_session_orgs();
