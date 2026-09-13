-- standalone_037_agent_manifest 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-016 / NO-06b）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 agent_manifest_org_isolation 存在且读 app.current_org_id
--   3) CHECK 约束（status/risk_level/autonomous_level）存在
--   4) 业务键唯一约束 (org_id, agent_id) 存在
--   5) 契约形状自证（SAVEPOINT 包裹，验证不落脏数据）：
--      - L4 自治等级必须被 CHECK 拒绝（§2：L4 永不允许，DB 层兜底）
--      - 非法 status 必须被 CHECK 拒绝

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  am_tbl integer := 0;
  am_rls integer := 0;
  am_policy integer := 0;
  am_status_chk integer := 0;
  am_risk_chk integer := 0;
  am_level_chk integer := 0;
  am_unique integer := 0;
  l4_rejected boolean := false;
  bad_status_rejected boolean := false;
BEGIN
  SELECT count(*) INTO am_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_manifest';
  IF am_tbl <> 1 THEN
    missing := missing || format('table am=%s ', am_tbl);
  END IF;

  SELECT count(*) INTO am_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_manifest' AND c.relrowsecurity;
  IF am_rls <> 1 THEN
    missing := missing || format('rls am=%s ', am_rls);
  END IF;

  SELECT count(*) INTO am_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_agent_manifest'
      AND policyname = 'agent_manifest_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF am_policy <> 1 THEN
    missing := missing || format('policy am=%s ', am_policy);
  END IF;

  SELECT count(*) INTO am_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_manifest'
      AND con.conname = 'chk_ewoh_agent_manifest_status';
  SELECT count(*) INTO am_risk_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_manifest'
      AND con.conname = 'chk_ewoh_agent_manifest_risk';
  SELECT count(*) INTO am_level_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_manifest'
      AND con.conname = 'chk_ewoh_agent_manifest_level';
  SELECT count(*) INTO am_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_manifest'
      AND con.conname = 'uq_ewoh_agent_manifest' AND con.contype = 'u';
  IF am_status_chk <> 1 OR am_risk_chk <> 1 OR am_level_chk <> 1 OR am_unique <> 1 THEN
    missing := missing || format('constraints status=%s risk=%s level=%s uq=%s ', am_status_chk, am_risk_chk, am_level_chk, am_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_037 verify failed: %', missing;
  END IF;

  -- 5) 契约形状自证（SAVEPOINT 包裹回滚，不落脏数据）
  BEGIN
    -- L4 自治等级必须被 CHECK 拒绝（§2：L4 永不允许——DB 层兜底，契约层为第一道）
    INSERT INTO __EWOH_SCHEMA__.ewoh_agent_manifest
      (org_id, agent_id, name, version, role, purpose, autonomous_level, risk_level, manifest_json)
    VALUES
      ('verify-org-037', 'agent:verify-037', 'verify', 1, 'FactorySupervisor', 'verify', 'L4', 'low', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_l4__';
  EXCEPTION
    WHEN check_violation THEN
      l4_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_l4__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT l4_rejected THEN
    RAISE EXCEPTION 'standalone_037 selfcheck failed: L4 autonomous level accepted';
  END IF;

  BEGIN
    -- 非法 status 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_agent_manifest
      (org_id, agent_id, name, version, role, purpose, autonomous_level, risk_level, status, manifest_json)
    VALUES
      ('verify-org-037', 'agent:verify-037', 'verify', 1, 'FactorySupervisor', 'verify', 'L1', 'low', 'rogue', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_status__';
  EXCEPTION
    WHEN check_violation THEN
      bad_status_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_status__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_status_rejected THEN
    RAISE EXCEPTION 'standalone_037 selfcheck failed: illegal status accepted';
  END IF;
END $$;

SELECT 1 AS standalone_037_verified;
