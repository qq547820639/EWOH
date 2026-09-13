-- 093 verify：命令级授权证据列就位 + 撤回原因 CHECK 真的会拦（半成品/未知原因）
-- + 投递部分索引就位（status='sent' 子集）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  cols integer;
  half_rejected boolean := false;
  reason_rejected boolean := false;
  orphan_rejected boolean := false;
  control_ok boolean := false;
  index_partial boolean := false;
  probe_org uuid := '00000000-0000-4000-8000-000000000001';
  probe_cmd constant varchar := 'att-verify-093-authorization';
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_control_command'
      AND column_name IN ('authorization_fingerprint', 'authorization_verified_at', 'revoked_reason', 'revoked_at');
  IF cols <> 4 THEN RAISE EXCEPTION '093 verify FAILED: columns=%', cols; END IF;

  -- 1) 有原因无时间 → 必须被拒
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, revoked_reason)
    VALUES
      (probe_org, probe_cmd || '-1', 'CR-verify-093', probe_cmd || '-1', 1, 'stop', 'sent', 'authorization_expired');
    RAISE EXCEPTION '093 verify: 有原因无时间的撤回未被拒绝';
  EXCEPTION WHEN check_violation THEN half_rejected := true;
  END;

  -- 2) 未知原因词表 → 必须被拒
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, revoked_reason, revoked_at)
    VALUES
      (probe_org, probe_cmd || '-2', 'CR-verify-093', probe_cmd || '-2', 1, 'stop', 'sent', 'because_i_said_so', now());
    RAISE EXCEPTION '093 verify: 未知撤回原因未被拒绝';
  EXCEPTION WHEN check_violation THEN reason_rejected := true;
  END;

  -- 3) 有时间无原因 → 必须被拒
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, revoked_at)
    VALUES
      (probe_org, probe_cmd || '-3', 'CR-verify-093', probe_cmd || '-3', 1, 'stop', 'sent', now());
    RAISE EXCEPTION '093 verify: 有时间无原因的撤回未被拒绝';
  EXCEPTION WHEN check_violation THEN orphan_rejected := true;
  END;

  -- 4) 控制组：合法撤回（原因 + 时间 + 指纹）必须能写入，并读回
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status,
       authorization_fingerprint, authorization_verified_at, revoked_reason, revoked_at)
    VALUES
      (probe_org, probe_cmd, 'CR-verify-093', probe_cmd, 1, 'dispatch_task', 'revoked',
       '3fee66ed288edc16', now(), 'authorization_expired', now());
    control_ok := EXISTS (
      SELECT 1 FROM ewoh_control_command
       WHERE org_id = probe_org AND command_id = probe_cmd
         AND authorization_fingerprint = '3fee66ed288edc16'
         AND revoked_reason = 'authorization_expired'
    );
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id LIKE probe_cmd || '%';
  END;

  -- 5) 投递索引必须是部分索引（只覆盖 status='sent'）
  SELECT (indexdef LIKE '%WHERE%status%sent%') INTO index_partial
    FROM pg_indexes
   WHERE schemaname = current_schema() AND indexname = 'idx_ewoh_control_command_pending';
  IF index_partial IS NULL THEN
    RAISE EXCEPTION '093 verify FAILED: idx_ewoh_control_command_pending 不存在';
  END IF;

  IF NOT half_rejected OR NOT reason_rejected OR NOT orphan_rejected OR NOT control_ok OR NOT index_partial THEN
    RAISE EXCEPTION '093 verify incomplete: half=% reason=% orphan=% control=% index=%',
      half_rejected, reason_rejected, orphan_rejected, control_ok, index_partial;
  END IF;
  RAISE NOTICE '093 verify OK: 授权指纹/复核时间/撤回原因列就位 + 半成品/未知原因被拒 + 投递部分索引就位';
END $$;

SELECT 1 AS standalone_093_verified;
