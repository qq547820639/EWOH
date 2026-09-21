-- standalone_104_event_confidence_range 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  constraint_count integer := 0;
  invalid_rejected boolean := false;
BEGIN
  SELECT count(*) INTO constraint_count
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
   WHERE nsp.nspname = current_schema()
     AND cls.relname = 'ewoh_event'
     AND con.conname = 'chk_ewoh_event_confidence_range'
     AND con.contype = 'c'
     AND con.convalidated;
  IF constraint_count <> 1 THEN
    RAISE EXCEPTION 'standalone_104 verify failed: expected 1 validated confidence CHECK, got %', constraint_count;
  END IF;

  -- 契约形状自证：越界值必须被数据库拒绝。PL/pgSQL EXCEPTION 块建立隐式
  -- 子事务，验证插入不会留下脏数据。
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_event(
      event_id, event_code, event_type, title, status, org_id, confidence
    ) VALUES (
      'EVT-VERIFY-104', 'CONTRACT', 'EntityStateObserved',
      'confidence range self-check', 'closed', '00000000-0000-4000-8000-000000000104', 1.0001
    );
    RAISE EXCEPTION '__unexpected_accept_bad_confidence__';
  EXCEPTION
    WHEN check_violation THEN
      invalid_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_bad_confidence__' THEN NULL; ELSE RAISE; END IF;
  END;

  IF NOT invalid_rejected THEN
    RAISE EXCEPTION 'standalone_104 selfcheck failed: out-of-range confidence accepted';
  END IF;

  RAISE NOTICE '104 verify OK: confidence CHECK validated and rejects out-of-range values';
END $$;

SELECT 1 AS standalone_104_verified;
