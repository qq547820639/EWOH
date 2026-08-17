-- EWOH standalone runtime role rollback
-- DESTRUCTIVE: removes the ewoh_api role and its object ownership/grants.
-- 审计 SQL-039 修复（2026-08-17）：原实现直接 DROP ROLE IF EXISTS ewoh_api——
-- 当 ewoh_api 仍持有对象（表/序列 owner）或对象授权时该语句失败（非幂等）。
-- 现改为：REASSIGN OWNED（ownership 转移给执行迁移的当前角色）→ DROP OWNED
-- （清除其在全部对象上的授权）→ DROP ROLE。三步均在 DO 块守卫内，幂等可重复。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ewoh_api') THEN
    EXECUTE format('REASSIGN OWNED BY ewoh_api TO %I', current_user);
    EXECUTE 'DROP OWNED BY ewoh_api';
    EXECUTE 'DROP ROLE ewoh_api';
  END IF;
END $$;
