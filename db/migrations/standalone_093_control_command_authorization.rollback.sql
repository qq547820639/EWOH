-- 093 rollback：移除命令级授权证据列（additive；回滚前应先导出
-- authorization_fingerprint / authorization_verified_at / revoked_reason / revoked_at）。

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_control_command_pending;

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
  DROP CONSTRAINT IF EXISTS chk_ewoh_control_command_revocation,
  DROP COLUMN IF EXISTS authorization_fingerprint,
  DROP COLUMN IF EXISTS authorization_verified_at,
  DROP COLUMN IF EXISTS revoked_reason,
  DROP COLUMN IF EXISTS revoked_at;
