-- standalone_060 回滚：恢复 (scope, idempotency_key) 全局键空间。
-- 注意：回滚后跨租户同名 key 将重新共享键空间（R2-SDB-006 缺陷态），
-- 仅用于迁移链验证，生产禁用。
ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys
  DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_org_isolation ON __EWOH_SCHEMA__.ewoh_idempotency_keys;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_idempotency_keys_org_scope_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_idempotency_keys_scope_key
  ON __EWOH_SCHEMA__.ewoh_idempotency_keys (scope, idempotency_key);

ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys
  ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys
  DROP COLUMN IF EXISTS org_id;
