-- 072: 账号↔业务人员绑定（ewoh_user.person_id）
--
-- 背景（2026-09-10 现场闭环审计，两个已证实缺陷）：
--
-- 1) 现场回执的"本人可报"分支结构性地不可达。
--    `execution-receipt-application.service.ts` 的非特权判定是
--      assignment.personId !== ctx.userId
--    其中 `assignment.personId` 是业务人员 ID（人员域），`ctx.userId` 是登录
--    账号 ID（身份域）——两个不同的标识空间。结果是 `worker` 角色永远无法
--    回执自己的任务，必须借用 dispatcher/workshop_lead 等特权角色才能完工，
--    现场闭环对真正的现场人员是断的。
--
-- 2) 现场作业台无法判断"我是谁的业务人员"，只能显示"未绑定"，或退回让前端
--    自报身份（把信任边界退给客户端，必须再自设计一套授权）。
--
-- 修法：让绑定成为**身份面的第一类事实**。`ewoh_user.person_id` 由管理员经
-- owner 通道（db/runner/create-operator.js --person-id）设置，随 JWT 签发，
-- 落到 OrgContext.personId，供回执授权与现场视角共同使用。JWT 有签名，
-- 客户端无法自报。
--
-- 可空设计说明：存量账号没有绑定，person_id 允许为 NULL。NULL 表示"未绑定"，
-- 语义上**不等于**"可以回执任意任务"——回执侧对未绑定的非特权账号保持
-- fail-closed（与原行为一致，不放宽）。
--
-- 唯一性：同一组织内一个业务人员不应被多个登录账号同时绑定（否则"本人"
-- 失去唯一性）。用部分唯一索引表达，且允许同一人员历史上换绑（唯一性只在
-- 非 NULL 时约束，换绑需先解除旧账号绑定）。

ALTER TABLE __EWOH_SCHEMA__.ewoh_user
  ADD COLUMN IF NOT EXISTS person_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_user.person_id IS
  '业务人员 ID（人员域）。NULL = 未绑定；由 owner 通道设置，随 JWT 签发。';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_user_org_person
  ON __EWOH_SCHEMA__.ewoh_user (org_id, person_id)
  WHERE person_id IS NOT NULL;

-- 身份读取函数必须一并返回 person_id：运行角色对 ewoh_user 无任何直接授权
-- （RLS + 无 policy + REVOKE ALL），登录/刷新只能经此 SECURITY DEFINER 函数。
--
-- 必须先 DROP 再 CREATE：PostgreSQL 不允许 `CREATE OR REPLACE FUNCTION` 改变
-- 返回类型（此处新增一列即改变 OUT 参数列表）。先前的 runtime-role 迁移给了
-- service_role EXECUTE，DROP 会一并移除该授权，所以重建后必须重新 GRANT
-- （下方即是）——漏掉会让登录在运行角色下直接失败。
DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_find_active_user(text);

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(p_username text)
RETURNS TABLE (
  username varchar(255),
  password_hash text,
  org_id uuid,
  roles jsonb,
  is_global_admin boolean,
  person_id varchar(255)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
ROWS 1
AS $$
  SELECT u.username, u.password_hash, u.org_id, u.roles, u.is_global_admin, u.person_id
  FROM __EWOH_SCHEMA__.ewoh_user AS u
  WHERE u.username = p_username AND u.status = 'active'
  LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(text)
  TO service_role;
