-- standalone_003_runtime_role verify（审计 SQL-103 补齐，2026-08-17）。
-- 断言 ewoh_api 运行时角色：存在、最小权限属性（NOSUPERUSER/NOBYPASSRLS 等）、
-- service_role 成员、search_path 固定为 public, pg_temp。
-- 形态：DO 块自证 + 单行 standalone_003_verified（--verify-standalone-runtime-role 断言 =1）。
DO $$
DECLARE
  v_missing boolean;
  v_super boolean;
  v_bypassrls boolean;
  v_createdb boolean;
  v_createrole boolean;
  v_member boolean;
  v_settings text;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ewoh_api') INTO v_missing;
  IF v_missing THEN
    RAISE EXCEPTION 'verify standalone_003_runtime_role: 角色 ewoh_api 不存在';
  END IF;

  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    INTO v_super, v_bypassrls, v_createdb, v_createrole
    FROM pg_roles WHERE rolname = 'ewoh_api';
  IF v_super OR v_bypassrls OR v_createdb OR v_createrole THEN
    RAISE EXCEPTION 'verify standalone_003_runtime_role: ewoh_api 权限属性超限（super=% bypassrls=% createdb=% createrole=%）', v_super, v_bypassrls, v_createdb, v_createrole;
  END IF;

  SELECT pg_has_role('ewoh_api', 'service_role', 'MEMBER') INTO v_member;
  IF NOT v_member THEN
    RAISE EXCEPTION 'verify standalone_003_runtime_role: ewoh_api 不是 service_role 成员';
  END IF;

  SELECT coalesce(array_to_string(s.setconfig, ';'), '') INTO v_settings
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
   WHERE r.rolname = 'ewoh_api' AND s.setdatabase = 0;
  IF v_settings NOT LIKE '%search_path=public, pg_temp%' THEN
    RAISE EXCEPTION 'verify standalone_003_runtime_role: ewoh_api search_path 未固定为 public, pg_temp（实际：%）', coalesce(v_settings, '<无>');
  END IF;
END $$;

SELECT 1 AS standalone_003_verified;
