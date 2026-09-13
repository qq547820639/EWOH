-- EWOH 设备责任人台账 (standalone_083, NO-49a 提醒找对人)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（本轮审计：提醒"叫到角色"，但没人负责这台设备）：
--   安灯/升级提醒一直发到**固定角色**（dispatcher / workshop_lead / safety_admin）。
--   现实里"这台设备是谁的"是车间的基本事实：设备责任人最清楚现场情况，
--   也最该第一时间被叫到。缺这张表时，平台只能广播给角色——噪音大、还常常叫不到人。
--
-- 语义：
--   · 责任是 **(设备, 职责, 人)** 三元组：同一设备可有多位责任人（owner/operator/maintainer
--     三种职责各一位），**同一职责同时只允许一位 active**（部分唯一索引），
--     换人 = 旧行置 active=false（历史保留，审计可回答"当时是谁负责的"）；
--   · `device_id` 用**业务设备号**（与安灯/遥测/告警同一 id 空间），不是台账主键；
--   · `person_id` 用规范人员身份（`person:<uuid>` 或裸 uuid，读取侧归一）；
--   · 通知侧的"点名到人"需要账号：person → 登录账号的反查走既有受控函数
--     `ewoh_find_active_users_by_person`（078），**没有绑定账号时如实报缺口**
--     （不假装通知到了）。
--
-- 回滚语义：全新（additive）；回滚 = DROP TABLE（责任关系是配置数据，可重建）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_device_responsibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  device_id varchar(255) NOT NULL,
  person_id varchar(255) NOT NULL,
  responsibility varchar(50) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  note text,
  activated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by varchar(255),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  -- 审计主体是**登录账号 id**（username，如 approver.li），不是 uuid：
  -- 本仓库的身份面用 varchar（与 standalone_069 的 created_by 同约定）。
  -- 实测教训：写成 uuid 会让写入直接失败（invalid input syntax for type uuid）。
  _created_by varchar(255),
  _updated_by varchar(255),
  CONSTRAINT chk_ewoh_device_responsibility_kind
    CHECK (responsibility IN ('owner', 'operator', 'maintainer')),
  -- 停用必须带停用时间（"谁在何时把人换掉了"要可追溯）
  CONSTRAINT chk_ewoh_device_responsibility_deactivated
    CHECK (active OR deactivated_at IS NOT NULL)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_device_responsibility IS
  '设备责任人台账（NO-49a）：(设备, 职责, 人) 三元组，职责 ∈ owner/operator/maintainer；同一设备同一职责同时只允许一位 active 责任人（部分唯一索引），换人=旧行置 active=false 保留历史。device_id 为业务设备号（与安灯/遥测同一 id 空间）。用途：把安灯（含 SLA 升级）提醒**点名到责任人本人**，而不是只广播给角色。TENANT_SCOPED（RLS device_responsibility_org_isolation）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device_responsibility.person_id IS
  '规范人员 id（person:<uuid> 或裸 uuid，读取侧归一）。与登录账号的绑定走受控函数 ewoh_find_active_users_by_person；无绑定账号时提醒侧如实报缺口。';

-- 同一设备同一职责同时只有一位 active 责任人（历史行保留）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_device_responsibility_active
  ON __EWOH_SCHEMA__.ewoh_device_responsibility (org_id, device_id, responsibility)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_ewoh_device_responsibility_device
  ON __EWOH_SCHEMA__.ewoh_device_responsibility (org_id, device_id, active);
-- 反向查询："这个人负责哪些设备"（现场人员看自己要盯哪些设备）。
CREATE INDEX IF NOT EXISTS idx_ewoh_device_responsibility_person
  ON __EWOH_SCHEMA__.ewoh_device_responsibility (org_id, person_id)
  WHERE active;

ALTER TABLE __EWOH_SCHEMA__.ewoh_device_responsibility ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_responsibility_org_isolation ON __EWOH_SCHEMA__.ewoh_device_responsibility;
CREATE POLICY device_responsibility_org_isolation
  ON __EWOH_SCHEMA__.ewoh_device_responsibility
  FOR ALL
  TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_device_responsibility TO service_role;
