-- 106 verify：status='sent' 缺 sent_at 必须被拒；带时间可写回读；pending 仍允许 NULL。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  constraint_present boolean := false;
  missing_time_rejected boolean := false;
  valid_sent_ok boolean := false;
  pending_null_ok boolean := false;
  probe_org uuid := '00000000-0000-4000-8000-000000000001';
  probe_cmd constant varchar := 'att-verify-106-sent-pair';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ewoh_control_command'::regclass
       AND conname = 'chk_ewoh_control_command_sent_has_time'
  ) INTO constraint_present;
  IF NOT constraint_present THEN
    RAISE EXCEPTION '106 verify FAILED: chk_ewoh_control_command_sent_has_time 不存在';
  END IF;

  -- 1) status='sent' 且 sent_at=NULL 必须拒绝。
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status)
    VALUES
      (probe_org, probe_cmd || '-missing', 'CR-verify-106', probe_cmd || '-missing', 1,
       'pause', 'sent');
    RAISE EXCEPTION '106 verify: status=sent 缺 sent_at 未被拒绝';
  EXCEPTION WHEN check_violation THEN missing_time_rejected := true;
  END;

  -- 2) status='sent' + sent_at 是合法事实，并可读回。
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, sent_at)
    VALUES
      (probe_org, probe_cmd, 'CR-verify-106', probe_cmd, 1, 'pause', 'sent', now());
    valid_sent_ok := EXISTS (
      SELECT 1 FROM ewoh_control_command
       WHERE org_id = probe_org AND command_id = probe_cmd
         AND status = 'sent' AND sent_at IS NOT NULL
    );
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  EXCEPTION WHEN OTHERS THEN
    valid_sent_ok := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  END;

  -- 3) pending 未下发仍允许 sent_at=NULL。
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status)
    VALUES
      (probe_org, probe_cmd || '-pending', 'CR-verify-106', probe_cmd || '-pending', 1,
       'pause', 'pending');
    pending_null_ok := EXISTS (
      SELECT 1 FROM ewoh_control_command
       WHERE org_id = probe_org AND command_id = probe_cmd || '-pending'
         AND status = 'pending' AND sent_at IS NULL
    );
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd || '-pending';
  EXCEPTION WHEN OTHERS THEN
    pending_null_ok := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd || '-pending';
  END;

  IF NOT missing_time_rejected OR NOT valid_sent_ok OR NOT pending_null_ok THEN
    RAISE EXCEPTION '106 verify incomplete: rejected=% sent=% pending=%',
      missing_time_rejected, valid_sent_ok, pending_null_ok;
  END IF;
  RAISE NOTICE '106 verify OK: sent 状态强制携带 sent_at，pending NULL 语义保持';
END $$;

SELECT 1 AS standalone_106_verified;
