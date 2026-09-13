-- 回滚 standalone_100：恢复 notification_id 全局唯一（放弃 org 作用域收敛）。
-- 若恢复前已存在跨 org 同 id 行，全局唯一会建立失败——先把重复行 id 加 org 后缀
--（保留 _created_at 最早一行；幂等可重入）。
UPDATE __EWOH_SCHEMA__.ewoh_notification n
   SET notification_id = n.notification_id || '-' || COALESCE(n.org_id::text, 'null')
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY notification_id ORDER BY _created_at ASC, id ASC) AS rn
      FROM __EWOH_SCHEMA__.ewoh_notification
     WHERE notification_id IN (
       SELECT notification_id FROM __EWOH_SCHEMA__.ewoh_notification GROUP BY notification_id HAVING count(*) > 1
     )
  ) dup
 WHERE n.id = dup.id AND dup.rn > 1;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_notification_org_notification_id;

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification
  ADD CONSTRAINT ewoh_notification_notification_id_key UNIQUE (notification_id);
