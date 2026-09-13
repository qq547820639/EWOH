-- 094 verify：新原因可用 + 词表外原因仍被拒 + 与 revoked_at 成对仍被强制。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  new_reason_ok boolean := false;
  unknown_rejected boolean := false;
  half_rejected boolean := false;
  probe_org uuid := '00000000-0000-4000-8000-000000000001';
  probe_cmd constant varchar := 'att-verify-094-fingerprint-key';
BEGIN
  -- 1) 新原因（fingerprint_key_missing）必须能写入
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status,
       authorization_fingerprint, revoked_reason, revoked_at)
    VALUES
      (probe_org, probe_cmd, 'CR-verify-094', probe_cmd, 1, 'dispatch_task', 'revoked',
       'hmac-sha256:v2:0123456789abcdef0123456789abcdef', 'fingerprint_key_missing', now());
    new_reason_ok := EXISTS (
      SELECT 1 FROM ewoh_control_command
       WHERE org_id = probe_org AND command_id = probe_cmd
         AND revoked_reason = 'fingerprint_key_missing'
    );
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  EXCEPTION WHEN OTHERS THEN
    new_reason_ok := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  END;

  -- 2) 词表外原因仍必须被拒（词表是封闭的）
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status,
       revoked_reason, revoked_at)
    VALUES
      (probe_org, probe_cmd || '-x', 'CR-verify-094', probe_cmd || '-x', 1, 'stop', 'revoked',
       'because_i_said_so', now());
    RAISE EXCEPTION '094 verify: 词表外原因未被拒绝';
  EXCEPTION WHEN check_violation THEN unknown_rejected := true;
  END;

  -- 3) 有时间无原因（三值逻辑漏洞的反向探测）仍必须被拒
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, revoked_at)
    VALUES
      (probe_org, probe_cmd || '-y', 'CR-verify-094', probe_cmd || '-y', 1, 'stop', 'revoked', now());
    RAISE EXCEPTION '094 verify: 有时间无原因的撤回未被拒绝';
  EXCEPTION WHEN check_violation THEN half_rejected := true;
  END;

  IF NOT new_reason_ok OR NOT unknown_rejected OR NOT half_rejected THEN
    RAISE EXCEPTION '094 verify incomplete: new=% unknown=% half=%',
      new_reason_ok, unknown_rejected, half_rejected;
  END IF;
  RAISE NOTICE '094 verify OK: fingerprint_key_missing 可用 + 词表外原因被拒 + 原因/时间成对';
END $$;

SELECT 1 AS standalone_094_verified;
