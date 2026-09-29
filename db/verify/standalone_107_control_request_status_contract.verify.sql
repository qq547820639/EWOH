-- 107 verify：控制请求状态词表已收敛到契约，且词表外的默认值不再能把行写成状态机不认识的值。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  -- 1) 约束存在且已校验（NOT VALID 的半成品不算通过）
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_control_request'::regclass
      AND conname = 'ck_control_request_status_contract'
      AND convalidated
  )
  -- 2) 存量：DDL 默认值 `draft`（契约 control.yaml 10 态之外）已清零
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_control_request
        WHERE status = 'draft') = 0
  -- 3) 默认值本身已进词表：省略 status 的写入不再落进词表外
  AND (SELECT column_default FROM information_schema.columns
        WHERE table_schema = '__EWOH_SCHEMA__'
          AND table_name = 'ewoh_control_request'
          AND column_name = 'status') = '''created''::character varying'
  -- 4) 约束正文真的是那份词表（防空 CHECK／防只钉一个值）
  AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = '__EWOH_SCHEMA__.ewoh_control_request'::regclass
          AND conname = 'ck_control_request_status_contract')
      LIKE '%pending_approval%'
  AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = '__EWOH_SCHEMA__.ewoh_control_request'::regclass
          AND conname = 'ck_control_request_status_contract')
      LIKE '%partial_success%'
  THEN 1 ELSE 0 END AS standalone_107_verified;
