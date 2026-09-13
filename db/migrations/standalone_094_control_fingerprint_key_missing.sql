-- EWOH 撤回原因词表扩展：签名指纹缺密钥（NO-65a）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: 先删后建（同一 CHECK 名），存量行违反新契约时 ADD 会显式失败。
--
-- 背景：NO-62a 的撤回原因词表是封闭的；NO-65a 引入 **HMAC 签名指纹（hmac-sha256:v2）**后
-- 出现一个新的、现场必须能区分的情形：**命令带签名指纹，但本实例没有配置密钥**
-- （例如密钥轮换/漏配）。此时既不能"当作指纹不符"（那是另一件事：内容被改写），
-- 也不能退回无密钥的一致性校验（那是静默降级）。因此把 `fingerprint_key_missing`
-- 加进封闭词表，让页面/运维能照着处置。
--
-- 回滚语义：把 CHECK 收回原词表；若存量行已使用新原因，回滚会**显式失败**
-- （不静默改写现场事实），需先按处置流程处理这些命令。

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
          'fingerprint_key_missing',
          'request_terminal',
          'device_org_mismatch'
        )
        AND revoked_at IS NOT NULL
      )
    );
END $$;

COMMENT ON CONSTRAINT chk_ewoh_control_command_revocation ON __EWOH_SCHEMA__.ewoh_control_command IS
  '投递前复核撤回原因（封闭词表，含 NO-65a 的 fingerprint_key_missing；NULL 表示未撤回，必须与 revoked_at 成对）';
