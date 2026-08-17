-- EWOH 2026-08-18 审计整改 — R2-SDB-006：幂等键租户维度
-- (standalone_060, 审计 docs/audit/current/findings.jsonl R2-SDB-006)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 背景：ewoh_idempotency_keys 的 (scope, idempotency_key) 键空间跨租户共享——
-- 同 key 跨租户可回放他租户响应。收敛：org_id 维度 + (org_id, scope,
-- idempotency_key) 复合唯一 + RLS 租户隔离（HTTP 路径经 GUC 请求级连接生效；
-- 非 HTTP 管理面沿用 owner/service_role 通道）。
--
-- Re-entrant：ADD COLUMN IF NOT EXISTS / DROP+CREATE 索引与策略均幂等。

-- 1) org_id 列（DEFAULT 取请求 GUC；无 GUC 上下文回退默认 org，与 057 存量
--    回填口径一致——非 HTTP 管理面写入不因缺 GUC 而 fail）。
ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys
  ADD COLUMN IF NOT EXISTS org_id varchar(255);

UPDATE __EWOH_SCHEMA__.ewoh_idempotency_keys
   SET org_id = COALESCE(
        (SELECT min(org_id::text) FROM __EWOH_SCHEMA__.ewoh_organization WHERE org_id IS NOT NULL),
        '00000000-0000-4000-8000-000000000001')
 WHERE org_id IS NULL;

ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys
  ALTER COLUMN org_id SET DEFAULT COALESCE(
    NULLIF(current_setting('app.current_org_id', true), ''),
    '00000000-0000-4000-8000-000000000001');

ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys
  ALTER COLUMN org_id SET NOT NULL;

-- 2) 唯一键：(scope, key) → (org_id, scope, key)（跨租户同名 key 互不碰撞）。
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_idempotency_keys_scope_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_idempotency_keys_org_scope_key
  ON __EWOH_SCHEMA__.ewoh_idempotency_keys (org_id, scope, idempotency_key);

-- 3) RLS：org 匹配（app.current_org_id，回退 app.primary_org_id）或全局管理员；
--    无 NULL 放行（列已 NOT NULL，057 口径）。
ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_org_isolation ON __EWOH_SCHEMA__.ewoh_idempotency_keys;
CREATE POLICY idempotency_org_isolation ON __EWOH_SCHEMA__.ewoh_idempotency_keys
  FOR ALL
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

COMMENT ON POLICY idempotency_org_isolation ON __EWOH_SCHEMA__.ewoh_idempotency_keys IS
  '幂等键租户隔离（standalone_060，R2-SDB-006）：org_id 匹配当前 org 或全局管理员；无 NULL 放行（列 NOT NULL）';
