-- standalone_022_reservation_capacity 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- P0-7 验证目标：
--   (a) ewoh_resource_reservation 表存在；
--   (b) 排他约束 ewoh_resource_reservation_no_overlap_person_device 存在，且
--       pg_get_constraintdef 的谓词仅覆盖 person/device
--       （含 resource_type IN ('person','device')，不含 'station' 字面量）；
--   (c) 过滤条件 status IN ('reserved','active') 保留；
--   (d) 旧的未过滤约束 ewoh_resource_reservation_no_overlap（standalone_009 全类型
--       二值 EXCLUDE）已被替换（不存在）——容量>1 工位的第二个重叠预占不再被
--       DB 层拒绝，交由应用层计数 + advisory lock。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  def text := NULL;
  table_ok boolean := false;
  guard_ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'ewoh_resource_reservation'
  ) INTO table_ok;
  IF NOT table_ok THEN missing := missing || 'ewoh_resource_reservation '; END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
   WHERE c.conname = 'ewoh_resource_reservation_no_overlap_person_device'
     AND c.conrelid = 'ewoh_resource_reservation'::regclass;

  IF def IS NULL THEN
    missing := missing || 'no_overlap_person_device constraint ';
  ELSE
    -- pg_get_constraintdef 会把 IN 谓词规范化为 `= ANY (ARRAY[...])`，如
    --   WHERE (((status)::text = ANY (ARRAY['reserved'::character varying, 'active'::character varying]))
    --      AND ((resource_type)::text = ANY (ARRAY['person'::character varying, 'device'::character varying])))
    -- 因此用子串判定：resource_type 谓词含 person/device、不含 station；status 谓词保留 reserved/active。
    guard_ok := def LIKE '%resource_type%'
      AND def LIKE '%person%'
      AND def LIKE '%device%'
      AND def NOT LIKE '%station%'
      AND def LIKE '%reserved%'
      AND def LIKE '%active%';
    IF NOT guard_ok THEN
      missing := missing || 'constraint predicate not scoped to person/device ';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'ewoh_resource_reservation_no_overlap'
       AND c.conrelid = 'ewoh_resource_reservation'::regclass
  ) THEN missing := missing || 'old unfiltered no_overlap constraint still present '; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '022 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '022 verify OK: person/device scoped exclusion present; station capacity left to app layer';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'ewoh_resource_reservation'
  ) AS reservation_table_exists,
  (SELECT count(*) FROM pg_constraint c
     WHERE c.conname = 'ewoh_resource_reservation_no_overlap_person_device'
       AND c.conrelid = 'ewoh_resource_reservation'::regclass
  ) AS person_device_guard,
  (SELECT count(*) FROM pg_constraint c
     WHERE c.conname = 'ewoh_resource_reservation_no_overlap'
       AND c.conrelid = 'ewoh_resource_reservation'::regclass
  ) AS old_binary_guard_dropped;
