-- 094 rollback：把撤回原因词表收回 NO-62a 的 7 项。
-- 若存量行使用了 fingerprint_key_missing，ADD CONSTRAINT 会显式失败（不静默改写事实）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
    DROP CONSTRAINT IF EXISTS chk_ewoh_control_command_revocation;
  ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
    ADD CONSTRAINT chk_ewoh_control_command_revocation
    CHECK (
      (revoked_reason IS NULL AND revoked_at IS NULL)
      OR (
        revoked_reason IS NOT NULL
        AND revoked_reason IN (
          'authorization_expired',
          'authorization_revoked',
          'approval_missing',
          'approval_not_granted',
          'fingerprint_mismatch',
          'request_terminal',
          'device_org_mismatch'
        )
        AND revoked_at IS NOT NULL
      )
    );
END $$;
