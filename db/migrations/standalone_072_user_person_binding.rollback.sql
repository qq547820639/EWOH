-- 072 rollback：移除账号↔人员绑定。
--
-- 注意：回滚会把 `person_id` 列整列删除，绑定数据**不可恢复**。这是有意的——
-- 回滚意味着"本版本不承认该身份事实"，保留一列半死不活的绑定比删掉更危险
-- （回执授权可能读到不一致的中间态）。需要保留绑定的场景不应回滚本迁移。

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_user_org_person;

-- 身份函数恢复为不含 person_id 的形态（与 standalone_002 的签名一致）。
-- 同样需要先 DROP：返回类型不同，CREATE OR REPLACE 会被拒绝；
-- DROP 会移除 service_role 的 EXECUTE，故重建后重新 GRANT。
DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_find_active_user(text);

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(p_username text)
RETURNS TABLE (
  username varchar(255),
  password_hash text,
  org_id uuid,
  roles jsonb,
  is_global_admin boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
ROWS 1
AS $$
  SELECT u.username, u.password_hash, u.org_id, u.roles, u.is_global_admin
  FROM __EWOH_SCHEMA__.ewoh_user AS u
  WHERE u.username = p_username AND u.status = 'active'
  LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(text)
  TO service_role;

ALTER TABLE __EWOH_SCHEMA__.ewoh_user
  DROP COLUMN IF EXISTS person_id;
