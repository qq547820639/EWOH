-- EWOH 命令级授权证据与投递前复核（NO-62a）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / 幂等可重复执行。
--
-- 背景（真实缺陷，不是"缺个字段"）：平台只在**人工下发**那一步校验审批
-- （`ensureApprovedForSend`：审批必须 approved 且在有效期内）。命令一旦落成
-- `sent`，边缘网关后续 `GET /api/control/commands/pending` **只看请求行是否终态**
-- ——于是在"审批通过 → 下发 → 网关投递"之间如果审批被撤销/过期，
-- 命令照样会投到 AGV 上执行：授权链在投递路径上是 fail-open 的。
--
-- 本迁移提供三样东西：
--   1. `authorization_fingerprint`：授权范围指纹（请求/设备/命令/审批实例/参数），
--      审批之后任何一项被改写都会指纹不符 → 投递与回执两侧 fail-closed；
--   2. `authorization_verified_at`：最近一次**投递前复核**通过的时间
--      （复核结论是事实，必须可追溯，不许"看起来验过"）；
--   3. `revoked_reason` / `revoked_at`：命令被复核拒绝而**撤回**的封闭原因词表
--      （`NULL` = 未撤回；两列必须同时有或同时无）。
--
-- 为什么原因要封闭词表：页面要能区分"审批过期""审批被撤销""授权范围被改写"
-- "审批实例缺失"——都叫"投递失败"现场就无法处置（原则 5/6/7）。
--
-- 回滚语义：DROP COLUMN（additive）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
  ADD COLUMN IF NOT EXISTS authorization_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS authorization_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_reason varchar(64),
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- 注意（本轮 verify 实测抓到的真缺陷）：CHECK 里**必须显式写 `revoked_reason IS NOT NULL`**。
-- 只写 `revoked_reason IN (...)` 时，`revoked_reason = NULL` 会让该子句求值为 NULL，
-- `false OR NULL = NULL` → CHECK 视为通过 —— "有时间无原因"的半成品撤回被静默放行
-- （SQL 三值逻辑，不是理论问题，是 verify 探针当场抓到的）。
DO $$
BEGIN
  -- 同一轮内契约收紧 → 先删后建（迁移仍可重复执行；若存量行违反新契约，ADD 会显式失败）。
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

-- 投递扫描索引：按设备 + 状态取待投递命令（sent 子集很小，部分索引避免全表顺序扫描）。
CREATE INDEX IF NOT EXISTS idx_ewoh_control_command_pending
  ON __EWOH_SCHEMA__.ewoh_control_command (org_id, status, sent_at)
  WHERE status = 'sent';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_control_command.authorization_fingerprint IS
  '授权范围指纹（fnv1a64:v1；请求/设备/命令/审批实例/参数）——审批后被改写即不符 → 拒绝投递（NO-62a）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_control_command.authorization_verified_at IS
  '最近一次投递前授权复核通过时间；NULL = 尚未复核（旧存量行，投递时补验）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_control_command.revoked_reason IS
  '投递前复核拒绝而撤回的封闭原因；NULL = 未撤回（必须与 revoked_at 同时有/同时无）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_control_command.revoked_at IS
  '撤回时间（与 revoked_reason 成对）';
