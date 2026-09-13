-- 072 verify：账号↔人员绑定已就位，且身份函数确实返回 person_id。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  -- person_id 列存在且可空（NULL = 未绑定）
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_user'
      AND column_name = 'person_id'
      AND data_type = 'character varying'
      AND is_nullable = 'YES') = 1
  -- 同组织内人员唯一绑定（部分唯一索引，仅约束非 NULL）
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_ewoh_user_org_person'
      AND indexdef LIKE '%UNIQUE%'
      AND indexdef LIKE '%person_id IS NOT NULL%'
  )
  -- 身份函数返回 person_id 且仍是 SECURITY DEFINER（函数 OUT 参数不在
  -- information_schema.columns 里，必须查 pg_proc）。用"包含"而非精确计数：
  -- proargnames 同时包含入参 p_username，精确计数会在入参变化时误报。
  AND (SELECT count(*) FROM pg_proc
        WHERE proname = 'ewoh_find_active_user'
          AND pronamespace = current_schema()::regnamespace
          AND prosecdef = true
          AND 'person_id' = ANY(proargnames)
          AND pg_get_function_result(oid) LIKE '%roles jsonb%'
          AND pg_get_function_result(oid) LIKE '%is_global_admin boolean%'
          AND pg_get_function_result(oid) LIKE '%person_id%') = 1
  -- fail-closed 不变量未被本次改动破坏：ewoh_user 仍对业务角色全拒
  AND (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_user'::regclass) = true
  AND (SELECT count(*) FROM pg_policies
        WHERE schemaname = current_schema() AND tablename = 'ewoh_user') = 0
  THEN 1 ELSE 0 END AS standalone_072_verified;
