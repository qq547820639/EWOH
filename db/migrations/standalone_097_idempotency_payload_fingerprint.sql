-- EWOH 缺陷 D 整改 — 幂等 payload 指纹落库 (standalone_097)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS / ENABLE ROW LEVEL
--            SECURITY（幂等可重复执行）。
--
-- 背景（现场后果）：`IdempotencyService.executeWithPayload` 用"同 key 不同 payload
--   → 409"拦住被改过 body 的离线重放，而这条防线只依赖 `payloadStore.get(key)`
--   读回指纹。指纹此前**没有任何数据库支撑**：SharedModule 只注册了
--   IDEMPOTENCY_STORE，`@Optional() @Inject(IDEMPOTENCY_PAYLOAD_STORE)` 静默回落
--   进程内 InMemoryPayloadStore。于是进程重启 / 第二个实例接手同 key 重放时读回
--   undefined，代码里 `recordedFingerprint !== undefined` 的前置判断直接放行——
--   改过 body 的离线重放被当成正常重放，静默拿到旧结果（离线工单/质检重放、
--   高危危险动作确认都被绕过）。本表把指纹变成持久事实，读回的是数据库里的事实，
--   重启与多实例都不再放行。
--
-- 键空间与 ewoh_idempotency_keys 完全对齐：org_id（DEFAULT 取 app.current_org_id
--   GUC，无 GUC 上下文回退默认 org，口径同 standalone_060）+ scope + idempotency_key
--   复合唯一。指纹行必须与被守护的幂等行同键，否则跨 scope/跨 org 读回不到指纹，
--   防线又退化成放行。
--
-- 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS
--   idempotency_payload_fingerprint_org_isolation，与 ewoh_idempotency_keys 的
--   idempotency_org_isolation 同 idiom：HTTP 路径经 GUC 请求级连接生效；非 HTTP
--   管理面沿用 owner/service_role 通道，RLS 对表 owner 不生效）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（唯一约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_idempotency_payload_fingerprint：幂等键 → 请求 payload 指纹（TENANT_SCOPED）
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL DEFAULT COALESCE(
    NULLIF(current_setting('app.current_org_id', true), ''),
    '00000000-0000-4000-8000-000000000001'),
  scope varchar(100) NOT NULL DEFAULT 'default',
  idempotency_key varchar(500) NOT NULL,
  fingerprint text NOT NULL,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- ON CONFLICT (org_id, scope, idempotency_key) 的冲突目标（DbPayloadStore.set）。
  CONSTRAINT uq_ewoh_idempotency_payload_fingerprint
    UNIQUE (org_id, scope, idempotency_key),
  -- 空指纹会把"读回不到指纹"和"读回一个空指纹"混成同一种状态，409 判断就再也
  -- 不可信（空串在 SQL 里恒 != 真实指纹，反而会误报 409）。写入面只允许非空。
  CONSTRAINT chk_ewoh_idempotency_payload_fingerprint_not_blank
    CHECK (length(btrim(fingerprint)) > 0)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint IS
  '幂等键 → 请求 payload 指纹（缺陷 D 整改 standalone_097）：executeWithPayload 据此拒绝"同 key 不同 payload"的重放（409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH）。落库是为了跨进程重启/多实例仍可读回——指纹只在进程内 Map 时，读回 undefined 会让 409 判断被静默放行。TENANT_SCOPED（RLS idempotency_payload_fingerprint_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint.fingerprint IS
  'computeFingerprint(payload) 的稳定序列化结果（键序无关）；与幂等行同 (org_id, scope, idempotency_key) 键空间';

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 ewoh_idempotency_keys 的 idempotency_org_isolation
--    完全同形——同子系统同语义，避免两表口径分叉）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_payload_fingerprint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint;
CREATE POLICY idempotency_payload_fingerprint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint
  FOR ALL
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

COMMENT ON POLICY idempotency_payload_fingerprint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint IS
  'payload 指纹租户隔离（standalone_097，缺陷 D）：org_id 匹配当前 org 或全局管理员；列 NOT NULL，无 NULL 放行（与 standalone_060 口径一致）';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint TO service_role;
