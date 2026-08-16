-- EWOH Canonical Industrial Identity — 身份映射表 + 遥测规范身份列 (standalone_032, ADR-006 / NO-02b)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--            CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-006，Phase 2 NO-02b，契约见 contracts/identity/*）：
--   1) ewoh_identity_mapping：第三方系统 ID（MES 工单号/WMS 库位/PLC Tag/设备序列号等）
--      → EWOH 规范身份（kind:value）的映射记录表。解析规则由契约定义：
--      仅 status=='active' 且时间窗口有效者参与解析；(org_id, source_system, source_id)
--      精确匹配；≥2 条 active → ambiguous_identity（fail-closed）；0 条 → 未映射。
--      内部唯一 ID 的 value 必须由 EWOH 生成，第三方 ID 仅作 alias（不进入内部身份）。
--   2) ewoh_telemetry.entity_id：遥测行的规范身份落点（additive、可空）。ingest 批量解析
--      映射后写入；未映射时保持 NULL（legacy 行为不变，不阻断遥测入库）。
--   3) 租户边界：ewoh_identity_mapping 为 TENANT_SCOPED（org_id NOT NULL + RLS 策略
--      identity_mapping_org_isolation 读 app.current_org_id，与 standalone_025 同 idiom）；
--      业务键唯一约束在 (org_id, source_system, source_id) 上，跨租户同第三方 ID 不冲突。
--   4) 事件：注册成功由应用层写 ewoh_event（event_type='EntityIdentityMapped'，
--      目录契约 contracts/events/event-catalog.yaml）。
--
-- 回滚语义：表为全新（additive）；telemetry.entity_id 为可空新列。
--   回滚 = DROP TABLE + DROP COLUMN（索引随表级联）；不影响既有数据流。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_identity_mapping：身份映射记录表（TENANT_SCOPED，RLS 强制租户隔离）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_identity_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  mapping_id varchar(180) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  source_system varchar(64) NOT NULL,
  source_id varchar(255) NOT NULL,
  source_id_kind varchar(64),
  target_entity_id varchar(180) NOT NULL,
  target_kind varchar(32) NOT NULL,
  authority varchar(20) NOT NULL DEFAULT 'registration',
  status varchar(20) NOT NULL DEFAULT 'active',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  valid_from timestamptz,
  valid_to timestamptz,
  evidence_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_identity_mapping_status
    CHECK (status IN ('active', 'superseded', 'revoked')),
  CONSTRAINT chk_ewoh_identity_mapping_authority
    CHECK (authority IN ('registration', 'adapter', 'manual')),
  CONSTRAINT chk_ewoh_identity_mapping_version CHECK (version >= 1),
  CONSTRAINT uq_ewoh_identity_mapping_source UNIQUE (org_id, source_system, source_id),
  CONSTRAINT uq_ewoh_identity_mapping_id UNIQUE (org_id, mapping_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_identity_mapping IS
  '第三方系统 ID → EWOH 规范身份(kind:value) 映射记录（ADR-006/NO-02b）。TENANT_SCOPED（RLS 强制 org 隔离）。解析规则：仅 active 且时间窗口有效；精确匹配恰好 1 条返回；>=2 条 ambiguous_identity（fail-closed）；0 条未映射。内部身份 value 由 EWOH 生成，第三方 ID 仅 alias。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.org_id IS '租户归属（TENANT_SCOPED，RLS identity_mapping_org_isolation 强制）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.mapping_id IS '映射记录 ID（map:<token>，契约 identity-mapping.schema.json）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.version IS '记录版本（同一 (system,id) 重复登记时 +1，幂等更新）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.source_system IS '第三方系统标识（mes/wms/erp/plc-tag/vendor-sn…，契约 source.system）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.source_id IS '第三方系统内原始 ID（MES 工单号/WMS 库位/PLC Tag/序列号；仅 alias）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.source_id_kind IS '可选：第三方 ID 类型注解（仅语义提示，不参与匹配）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.target_entity_id IS 'EWOH 规范身份 kind:value（契约 identity.schema.json kindRegistry）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.target_kind IS '规范身份 kind（冗余落库，供按类型过滤与统计）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.authority IS '登记权威来源：registration/adapter/manual';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.status IS '仅 active 参与解析；superseded=被新记录取代；revoked=撤销';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.recorded_at IS '登记时间（契约 recordedAt）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.valid_from IS '生效起点（含）；NULL=无下限';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.valid_to IS '生效终点（不含）；NULL=无上限';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_identity_mapping.evidence_id IS '关联 Evidence（登记依据，可审计）';

CREATE INDEX IF NOT EXISTS idx_ewoh_identity_mapping_target
  ON __EWOH_SCHEMA__.ewoh_identity_mapping (target_entity_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_identity_mapping_status
  ON __EWOH_SCHEMA__.ewoh_identity_mapping (org_id, status);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退，两者皆空 → 仅放行 NULL org 行）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_identity_mapping ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS identity_mapping_org_isolation
  ON __EWOH_SCHEMA__.ewoh_identity_mapping;
CREATE POLICY identity_mapping_org_isolation
  ON __EWOH_SCHEMA__.ewoh_identity_mapping
  FOR ALL
  TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  );

-- ============================================================================
-- 3) ewoh_telemetry.entity_id：遥测行的规范身份落点（additive、可空、非破坏）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry
  ADD COLUMN IF NOT EXISTS entity_id varchar(180);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_telemetry.entity_id IS
  'EWOH 规范身份 kind:value（ADR-006，ingest 批量解析 ewoh_identity_mapping 后写入；未映射为 NULL，legacy 行为不变）';

CREATE INDEX IF NOT EXISTS idx_ewoh_telemetry_entity_id
  ON __EWOH_SCHEMA__.ewoh_telemetry (entity_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_identity_mapping TO service_role;
