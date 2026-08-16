-- standalone_039_knowledge_entry 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-018 Amendment 1 / NO-07b）：
--   1) 表存在且 relrowsecurity = true
--   2) RLS 策略 knowledge_entry_service_all 存在且读 app.current_org_id
--   3) 契约列（kind/scope/summary/body/source_evidence_ids/provenance/
--      valid_from/valid_to/audit_trail/legacy_without_evidence）存在
--   4) CHECK（kind/scope/status/scope_tenant/provenance/time/audit/evidence）
--      与 UNIQUE (org_id, entry_id) 存在
--   5) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 kind / 非法 scope / 非法 status 必须被 CHECK 拒绝
--      - 共享层条目落真实租户 org 必须被 scope_tenant CHECK 拒绝
--      - private_operational 带 provenance 必须被 CHECK 拒绝
--      - 合法租户层条目与合法共享层条目可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_cols integer := 0;
  at_kind_chk integer := 0;
  at_scope_chk integer := 0;
  at_status_chk integer := 0;
  at_scope_tenant_chk integer := 0;
  at_provenance_chk integer := 0;
  at_time_chk integer := 0;
  at_audit_chk integer := 0;
  at_evidence_chk integer := 0;
  at_unique integer := 0;
  bad_kind_rejected boolean := false;
  bad_scope_rejected boolean := false;
  bad_status_rejected boolean := false;
  shared_on_tenant_rejected boolean := false;
  private_provenance_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_knowledge_entry'
      AND policyname = 'knowledge_entry_service_all'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_cols FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.table_name = 'ewoh_knowledge_entry'
      AND c.column_name IN ('kind', 'scope', 'summary', 'body', 'source_evidence_ids',
        'related_entity_ids', 'provenance', 'verified_by', 'valid_from', 'valid_to',
        'audit_trail', 'legacy_without_evidence');
  IF at_cols <> 12 THEN
    missing := missing || format('cols at=%s ', at_cols);
  END IF;

  SELECT count(*) INTO at_kind_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_kind';
  SELECT count(*) INTO at_scope_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_scope';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_status';
  SELECT count(*) INTO at_scope_tenant_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_scope_tenant';
  SELECT count(*) INTO at_provenance_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_provenance';
  SELECT count(*) INTO at_time_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_time';
  SELECT count(*) INTO at_audit_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_audit';
  SELECT count(*) INTO at_evidence_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'chk_ewoh_knowledge_entry_evidence';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_knowledge_entry'
      AND con.conname = 'uq_ewoh_knowledge_entry' AND con.contype = 'u';
  IF at_kind_chk <> 1 OR at_scope_chk <> 1 OR at_status_chk <> 1 OR at_scope_tenant_chk <> 1
     OR at_provenance_chk <> 1 OR at_time_chk <> 1 OR at_audit_chk <> 1
     OR at_evidence_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints kind=%s scope=%s status=%s scope_tenant=%s provenance=%s time=%s audit=%s evidence=%s uq=%s ',
      at_kind_chk, at_scope_chk, at_status_chk, at_scope_tenant_chk, at_provenance_chk,
      at_time_chk, at_audit_chk, at_evidence_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_039 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 kind 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary, source_evidence_ids, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000039'::uuid, 'knowledge:verify-039-kind', 'kb-verify',
       'verify', 'verify body', '[]'::jsonb, 'draft', 1, 'gizmo', 'factory', 'verify summary',
       '["evidence:verify-039"]'::jsonb, true, now());
    RAISE EXCEPTION '__unexpected_accept_kind__';
  EXCEPTION
    WHEN check_violation THEN
      bad_kind_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_kind__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_kind_rejected THEN
    RAISE EXCEPTION 'standalone_039 selfcheck failed: illegal kind accepted';
  END IF;

  BEGIN
    -- 非法 scope 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary, source_evidence_ids, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000039'::uuid, 'knowledge:verify-039-scope', 'kb-verify',
       'verify', 'verify body', '[]'::jsonb, 'draft', 1, 'incident', 'galaxy', 'verify summary',
       '["evidence:verify-039"]'::jsonb, true, now());
    RAISE EXCEPTION '__unexpected_accept_scope__';
  EXCEPTION
    WHEN check_violation THEN
      bad_scope_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_scope__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_scope_rejected THEN
    RAISE EXCEPTION 'standalone_039 selfcheck failed: illegal scope accepted';
  END IF;

  BEGIN
    -- 非法 status 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary, source_evidence_ids, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000039'::uuid, 'knowledge:verify-039-status', 'kb-verify',
       'verify', 'verify body', '[]'::jsonb, 'teleported', 1, 'incident', 'factory', 'verify summary',
       '["evidence:verify-039"]'::jsonb, true, now());
    RAISE EXCEPTION '__unexpected_accept_status__';
  EXCEPTION
    WHEN check_violation THEN
      bad_status_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_status__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_status_rejected THEN
    RAISE EXCEPTION 'standalone_039 selfcheck failed: illegal status accepted';
  END IF;

  BEGIN
    -- 共享层（global）落真实租户 org 必须被 scope_tenant CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary,
       source_evidence_ids, provenance, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000039'::uuid, 'knowledge:verify-039-tenant', 'kb-verify',
       'verify', 'verify body', '[]'::jsonb, 'draft', 1, 'process_knowledge', 'global', 'verify summary',
       '["evidence:verify-039"]'::jsonb,
       '{"trainingDataSources":["t"],"anonymizationPolicy":"a","dataAuthorization":"d","modelVersion":"v"}'::jsonb,
       true, now());
    RAISE EXCEPTION '__unexpected_accept_scope_tenant__';
  EXCEPTION
    WHEN check_violation THEN
      shared_on_tenant_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_scope_tenant__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT shared_on_tenant_rejected THEN
    RAISE EXCEPTION 'standalone_039 selfcheck failed: shared scope on tenant org accepted';
  END IF;

  BEGIN
    -- private_operational 带 provenance 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary,
       source_evidence_ids, provenance, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000039'::uuid, 'knowledge:verify-039-provenance', 'kb-verify',
       'verify', 'verify body', '[]'::jsonb, 'draft', 1, 'process_knowledge', 'private_operational',
       'verify summary', '["evidence:verify-039"]'::jsonb,
       '{"trainingDataSources":["t"],"anonymizationPolicy":"a","dataAuthorization":"d","modelVersion":"v"}'::jsonb,
       true, now());
    RAISE EXCEPTION '__unexpected_accept_provenance__';
  EXCEPTION
    WHEN check_violation THEN
      private_provenance_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_provenance__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT private_provenance_rejected THEN
    RAISE EXCEPTION 'standalone_039 selfcheck failed: private_operational with provenance accepted';
  END IF;

  BEGIN
    -- 合法租户层条目可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary, source_evidence_ids, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000039'::uuid, 'knowledge:verify-039-ok', 'kb-verify',
       'verify ok', 'verify body', '[]'::jsonb, 'verified', 2, 'resolution', 'factory', 'verify summary',
       '["evidence:verify-039"]'::jsonb, true, now());
    DELETE FROM __EWOH_SCHEMA__.ewoh_knowledge_entry WHERE entry_id = 'knowledge:verify-039-ok';

    -- 合法共享层条目可写入（哨兵 org；随后删除）
    INSERT INTO __EWOH_SCHEMA__.ewoh_knowledge_entry
      (org_id, entry_id, base_id, title, body, tags, status, version, kind, scope, summary,
       source_evidence_ids, provenance, audit_trail, valid_from)
    VALUES
      ('00000000-0000-4000-8000-000000000000'::uuid, 'knowledge:verify-039-shared', 'kb-verify',
       'verify shared', 'verify body', '[]'::jsonb, 'draft', 1, 'process_knowledge', 'global', 'verify summary',
       '["evidence:verify-039"]'::jsonb,
       '{"trainingDataSources":["t"],"anonymizationPolicy":"a","dataAuthorization":"d","modelVersion":"v"}'::jsonb,
       true, now());
    DELETE FROM __EWOH_SCHEMA__.ewoh_knowledge_entry WHERE entry_id = 'knowledge:verify-039-shared';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_039 selfcheck failed: valid rows rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_039_verified;
