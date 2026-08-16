-- EWOH Knowledge Entry 运行时硬化 (standalone_039, ADR-018 Amendment 1 / NO-07b, Phase 12)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / 动态查找
--             DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-018 Amendment 1，contracts/knowledge/knowledge-entry.schema.json）：
--   ewoh_knowledge_entry 自原始受管表包（standalone_001）已物理存在，本迁移为
--   ALTER 硬化（不新建同义表，§33）：
--   1) 契约列落地：content→body（RENAME，单一事实源）、kind/scope/summary/
--      source_evidence_ids/related_entity_ids/provenance/verified_by/
--      valid_from/valid_to/audit_trail/legacy_without_evidence；
--   2) 五层 scope 语义数据库化（Amendment 1 决策 2/3）：
--      - 共享层（global/industry）org_id = 平台保留哨兵 UUID
--        00000000-0000-4000-8000-000000000000（既有先例：uq_ewoh_system_config_org_key）；
--      - 租户层（customer/factory/private_operational）org_id ≠ 哨兵；
--      - CHECK chk_ewoh_knowledge_entry_scope_tenant 强制该一致性；
--      - CHECK chk_ewoh_knowledge_entry_provenance：global/industry 必须 provenance、
--        private_operational 禁止 provenance（§15/§16 跨租户隔离机器执行面）；
--   3) RLS 策略替换（本表专用五层隔离）：knowledge_entry_service_all
--      （service_role FOR ALL：GUC org 匹配（租户层）或共享层哨兵行，与
--      standalone_025/032-038 同 idiom）；租户行仅本租户可见、共享行全租户可读；
--   4) entry_id 全局唯一 → UNIQUE (org_id, entry_id)（多租户同 knowledgeId
--      不再冲突，ADR-006 规范身份租户化）；
--   5) 遗留数据显式映射（Amendment 1 决策 5，非静默归一）：kind←
--      process_knowledge / scope←factory / status∉{verified,superseded}←draft /
--      summary←title（空时）/ valid_from←_created_at /
--      legacy_without_evidence=true（遗留无证据链，检索显式标记，绝不伪造证据）。
--
-- 回滚语义：结构性变更全部可逆（见 .rollback.sql：body→content 反向 RENAME、
--   删列/约束、恢复通用策略与 entry_id 全局唯一、base_id 置回 NOT NULL）；
--   status 归一化不可逆（值域收敛为契约三态，记录于回滚头注释）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) 契约列落地（additive）。
-- ============================================================================
DO $$
DECLARE
  has_content boolean;
  has_body boolean;
BEGIN
  SELECT count(*) > 0 INTO has_content FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_knowledge_entry'
      AND column_name = 'content';
  SELECT count(*) > 0 INTO has_body FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_knowledge_entry'
      AND column_name = 'body';
  IF has_content AND NOT has_body THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry RENAME COLUMN content TO body;
  END IF;
END $$;

ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  ADD COLUMN IF NOT EXISTS kind varchar(24) NOT NULL DEFAULT 'process_knowledge',
  ADD COLUMN IF NOT EXISTS scope varchar(24) NOT NULL DEFAULT 'factory',
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS related_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS provenance jsonb,
  ADD COLUMN IF NOT EXISTS verified_by varchar(180),
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_to timestamptz,
  ADD COLUMN IF NOT EXISTS audit_trail boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS legacy_without_evidence boolean NOT NULL DEFAULT false;

-- ============================================================================
-- 2) 遗留数据显式映射（Amendment 1 决策 5）。
-- ============================================================================
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry
   SET kind = 'process_knowledge'
 WHERE kind IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry
   SET scope = 'factory'
 WHERE scope IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry
   SET status = 'draft'
 WHERE status NOT IN ('verified', 'superseded');
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry
   SET summary = title
 WHERE btrim(coalesce(summary, '')) = '';
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry
   SET valid_from = _created_at
 WHERE valid_from IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry
   SET legacy_without_evidence = true,
       source_evidence_ids = '[]'::jsonb
 WHERE jsonb_array_length(source_evidence_ids) = 0;

ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ALTER COLUMN valid_from SET DEFAULT now();
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ALTER COLUMN valid_from SET NOT NULL;

-- 新契约条目无知识库归属约束（遗留 NOT NULL 解除，NULL 为诚实值）。
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ALTER COLUMN base_id DROP NOT NULL;

-- ============================================================================
-- 3) 业务键：entry_id 全局唯一 → UNIQUE (org_id, entry_id)（租户化）。
-- ============================================================================
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT con.conname INTO con_name
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
    AND con.contype = 'u'
    AND con.conname <> 'uq_ewoh_knowledge_entry';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',
                   current_schema(), 'ewoh_knowledge_entry', con_name);
  END IF;
END $$;

ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  DROP CONSTRAINT IF EXISTS uq_ewoh_knowledge_entry;
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  ADD CONSTRAINT uq_ewoh_knowledge_entry UNIQUE (org_id, entry_id);

-- ============================================================================
-- 4) CHECK 守护（契约枚举 + scope-tenant 一致性 + provenance + 时态 + 审计）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_kind,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_scope,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_status,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_version,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_summary,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_body,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_evidence,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_scope_tenant,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_provenance,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_time,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_audit;

ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  ADD CONSTRAINT chk_ewoh_knowledge_entry_kind
    CHECK (kind IN ('incident', 'resolution', 'failure_pattern', 'process_knowledge', 'decision_history', 'evidence')),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_scope
    CHECK (scope IN ('global', 'industry', 'customer', 'factory', 'private_operational')),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_status
    CHECK (status IN ('draft', 'verified', 'superseded')),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_version
    CHECK (version >= 1),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_summary
    CHECK (length(btrim(summary)) > 0),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_body
    CHECK (length(btrim(body)) > 0),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_evidence
    CHECK (jsonb_typeof(source_evidence_ids) = 'array'
           AND (legacy_without_evidence OR jsonb_array_length(source_evidence_ids) > 0)),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_scope_tenant
    CHECK (
      (scope IN ('global', 'industry')
         AND org_id = '00000000-0000-4000-8000-000000000000'::uuid)
      OR
      (scope IN ('customer', 'factory', 'private_operational')
         AND org_id <> '00000000-0000-4000-8000-000000000000'::uuid)
    ),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_provenance
    CHECK (
      (scope IN ('global', 'industry') AND provenance IS NOT NULL)
      OR (scope IN ('customer', 'factory'))
      OR (scope = 'private_operational' AND provenance IS NULL)
    ),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_time
    CHECK (valid_to IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT chk_ewoh_knowledge_entry_audit
    CHECK (audit_trail = true);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry IS
  'Factory Knowledge System 知识条目（ADR-018 Amendment 1 / NO-07b，standalone_039 硬化）。五层 scope（global/industry=共享层归哨兵 org；customer/factory/private_operational=租户层）由 chk_ewoh_knowledge_entry_scope_tenant + RLS knowledge_entry_service_all 双强制；契约校验（validateKnowledgeEntry）为写入唯一入口；创建幂等（org_id, entry_id）；KnowledgeEntryCreated 目录事件随创建落库。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_knowledge_entry.scope IS '五层知识分类：global/industry/customer/factory/private_operational（共享层=哨兵 org，租户层=真实 org；CHECK 强制）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_knowledge_entry.source_evidence_ids IS '可追溯证据链（规范身份数组；新条目非空，遗留条目 legacy_without_evidence=true 显式标记，绝不伪造证据）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_knowledge_entry.provenance IS '共享层必填（trainingDataSources/anonymizationPolicy/dataAuthorization/modelVersion，§15/§16）；private_operational 禁止（CHECK 强制）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_knowledge_entry.valid_from IS '知识条目生效时刻（双时态，与 ADR-008 同源；valid_to ≥ valid_from CHECK）';

CREATE INDEX IF NOT EXISTS idx_ewoh_knowledge_entry_scope_org
  ON __EWOH_SCHEMA__.ewoh_knowledge_entry (scope, org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_knowledge_entry_kind
  ON __EWOH_SCHEMA__.ewoh_knowledge_entry (org_id, kind, status);

-- ============================================================================
-- 5) RLS：替换遗留通用策略为本表专用五层隔离策略（Amendment 1 决策 3）。
--    共享层行（scope ∈ {global, industry} 且 org = 哨兵）全租户可读；
--    租户层行仅 GUC 当前租户可读写。数据库级强制，非应用纪律。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_knowledge_entry;
DROP POLICY IF EXISTS knowledge_entry_service_all ON __EWOH_SCHEMA__.ewoh_knowledge_entry;

CREATE POLICY knowledge_entry_service_all
  ON __EWOH_SCHEMA__.ewoh_knowledge_entry
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR (scope IN ('global', 'industry') AND org_id::text = '00000000-0000-4000-8000-000000000000')
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR (scope IN ('global', 'industry') AND org_id::text = '00000000-0000-4000-8000-000000000000')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry TO service_role;
