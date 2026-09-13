-- 095 verify：列与部分索引就位；可空语义（NULL = 从未交付）+ 时间可写回读。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  has_column boolean := false;
  index_partial boolean := false;
  null_ok boolean := false;
  write_read_ok boolean := false;
  probe_org uuid := '00000000-0000-4000-8000-000000000001';
  probe_cmd constant varchar := 'att-verify-095-delivered';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_control_command'
       AND column_name = 'delivered_at'
  ) INTO has_column;
  IF NOT has_column THEN RAISE EXCEPTION '095 verify FAILED: delivered_at 列不存在'; END IF;

  SELECT (indexdef LIKE '%WHERE%delivered_at IS NOT NULL%') INTO index_partial
    FROM pg_indexes
   WHERE schemaname = current_schema() AND indexname = 'idx_ewoh_control_command_delivered';
  IF index_partial IS NULL THEN
    RAISE EXCEPTION '095 verify FAILED: idx_ewoh_control_command_delivered 不存在';
  END IF;

  -- 可空语义：未交付的行必须是 NULL（不许用 0/epoch 冒充"交付过"）
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status)
    VALUES
      (probe_org, probe_cmd || '-null', 'CR-verify-095', probe_cmd || '-null', 1, 'pause', 'sent');
    null_ok := EXISTS (
      SELECT 1 FROM ewoh_control_command
       WHERE org_id = probe_org AND command_id = probe_cmd || '-null' AND delivered_at IS NULL
    );
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd || '-null';
  EXCEPTION WHEN OTHERS THEN
    null_ok := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd || '-null';
  END;

  -- 写入/回读
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, delivered_at)
    VALUES
      (probe_org, probe_cmd, 'CR-verify-095', probe_cmd, 1, 'pause', 'sent', now());
    write_read_ok := EXISTS (
      SELECT 1 FROM ewoh_control_command
       WHERE org_id = probe_org AND command_id = probe_cmd AND delivered_at IS NOT NULL
    );
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  EXCEPTION WHEN OTHERS THEN
    write_read_ok := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  END;

  IF NOT index_partial OR NOT null_ok OR NOT write_read_ok THEN
    RAISE EXCEPTION '095 verify incomplete: index=% null=% write=%', index_partial, null_ok, write_read_ok;
  END IF;
  RAISE NOTICE '095 verify OK: delivered_at 列 + 部分索引 + NULL 语义 + 写入回读';
END $$;

SELECT 1 AS standalone_095_verified;
