-- 083 verify：设备责任人台账就位，且四条不变量成立。
--
-- 自证内容：
--   1. 表存在、org_id NOT NULL（租户作用域）；
--   2. 职责 CHECK 生效：写入非法职责被拒；
--   3. "同一设备同一职责同时只有一位 active"：第二条 active 写入被部分唯一索引拒绝；
--   4. 停用必须带时间：active=false 且 deactivated_at 为空被 CHECK 拒绝；
--   5. RLS 已启用且策略存在（租户隔离不被绕过）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
WITH
  tbl AS (
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_device_responsibility'
      AND column_name = 'org_id' AND is_nullable = 'NO'
  ),
  bad_kind AS (
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'ewoh_device_responsibility'
        AND constraint_name = 'chk_ewoh_device_responsibility_kind'
    ) THEN 1 ELSE 0 END AS n
  ),
  idx AS (
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'uq_ewoh_device_responsibility_active'
        AND indexdef LIKE '%WHERE%active%'
    ) THEN 1 ELSE 0 END AS n
  ),
  rls AS (
    SELECT CASE WHEN
      (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_device_responsibility'::regclass) = true
      AND (SELECT count(*) FROM pg_policies
            WHERE schemaname = current_schema() AND tablename = 'ewoh_device_responsibility') >= 1
    THEN 1 ELSE 0 END AS n
  ),
  -- 行为探测（非法职责被拒 / 重复 active 被拒）不放这里：verify 是只读自证，
  -- 真写探测由服务层单测与 e2e 覆盖（会实际尝试并断言被拒）。
  deactivated_check AS (
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'ewoh_device_responsibility'
        AND constraint_name = 'chk_ewoh_device_responsibility_deactivated'
    ) THEN 1 ELSE 0 END AS n
  )
SELECT CASE WHEN
  (SELECT n FROM tbl) = 1
  AND (SELECT n FROM bad_kind) = 1
  AND (SELECT n FROM idx) = 1
  AND (SELECT n FROM rls) = 1
  AND (SELECT n FROM deactivated_check) = 1
  THEN 1 ELSE 0 END AS standalone_083_verified;
