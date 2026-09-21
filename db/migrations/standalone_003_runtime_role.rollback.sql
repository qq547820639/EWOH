-- EWOH standalone runtime role rollback
-- DESTRUCTIVE: removes the ewoh_api role and its object ownership/grants.
-- 审计 SQL-039 修复（2026-08-17）：REASSIGN OWNED → DROP OWNED → DROP ROLE。
-- 2026-09-20 补口：DROP OWNED 不移除角色成员关系；先撤销 ewoh_api 的
-- granted_role 成员关系，否则 DROP ROLE 因共享角色依赖失败。
DO $$
DECLARE
  rec record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ewoh_api') THEN
    EXECUTE format('REASSIGN OWNED BY ewoh_api TO %I', current_user);
    EXECUTE 'DROP OWNED BY ewoh_api';
    FOR rec IN
      SELECT r.rolname AS granted_role
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      WHERE member.rolname = 'ewoh_api'
    LOOP
      EXECUTE format('REVOKE %I FROM ewoh_api', rec.granted_role);
    END LOOP;
    EXECUTE 'DROP ROLE ewoh_api';
  END IF;
END $$;
