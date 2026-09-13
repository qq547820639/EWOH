-- 078: 系统后台读取函数（人员→账号反查 + 有活跃会话的租户清单）
--
-- 背景（NO-37a 会话主动提醒，2026-09-11 实测）：
--
-- 平台要把"外骨骼会话超过预计结束/长时间未收工"提醒到**佩戴者本人**。佩戴者在会话里是
-- 业务人员 id（`person:<uuid>`），而通知的点名到人（recipientType='user'）用的是登录账号
-- id（`ewoh_user.username`，见 auth.service 的 `userId: String(row.username)`）。
-- 于是需要一次 person → account 的反查。
--
-- 为什么不能直接 `SELECT ... FROM ewoh_user`：运行角色对 `ewoh_user` **没有任何直接授权**
-- （RLS 启用且无 policy + REVOKE ALL，见 002/072）。实测在 reminder-sweep 上直接查表得到
-- `permission denied for table ewoh_user`（接口 500）。身份面的读取必须经 SECURITY DEFINER
-- 函数——这是本仓库既有的收口方式（072 的 `ewoh_find_active_user` 同理），不能为了图省事
-- 给运行角色开一张身份表的 SELECT（那会把"账号/口令哈希"整表暴露给业务代码）。
--
-- 语义：
--   · 只返回 **active** 账号，且只返回 (username, person_id) 两列——不返回口令哈希/角色；
--   · 按 (org, person[] ) 批量查，供一次扫描里解析多条会话的佩戴者；
--   · 不做任何写入；STABLE + SECURITY DEFINER + 固定 search_path（与 072 一致）。
--
-- 注意：`ewoh_user` 对业务角色仍然全拒（本迁移**不**新增任何表/列级 GRANT），
-- fail-closed 不变量由 verify 脚本显式断言。

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_find_active_users_by_person(
  p_org_id uuid,
  p_person_ids text[]
)
RETURNS TABLE (
  username varchar(255),
  person_id varchar(255)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
  SELECT u.username, u.person_id
  FROM __EWOH_SCHEMA__.ewoh_user AS u
  WHERE u.org_id = p_org_id
    AND u.status = 'active'
    AND u.person_id = ANY (p_person_ids);
$$;

COMMENT ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_users_by_person(uuid, text[]) IS
  '人员 id → 活跃登录账号反查（只返回 username/person_id；供会话提醒点名到人；运行角色经此函数受控读取身份面）。';

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_users_by_person(uuid, text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_users_by_person(uuid, text[])
  TO service_role;

-- ---------------------------------------------------------------------------
-- 第二个函数：有活跃外骨骼会话的租户清单（供**后台 worker** 跨租户扫描）
--
-- 为什么需要：后台 worker 没有 HTTP 请求上下文 → `RequestDatabaseContext` 回落根句柄
-- → 没有 `app.current_org_id` GUC → `ewoh_exo_session` 的 RLS 策略把行全部挡住，
-- worker 扫到 0 个租户、0 条会话（2026-09-11 实测：端点上提醒正常、定时 worker 静默无提醒）。
-- 逐个租户扫描又必须先知道"哪些租户有活跃会话"，于是需要一个受控的**只读**跨租户入口。
--
-- 为什么安全：SECURITY DEFINER 以 ewoh_owner（表 owner，未开 FORCE RLS）执行，因此可读
-- 跨租户；但**只返回 org_id 列表**，不返回任何会话细节（设备/人员/时间都不出库），
-- 拿到租户后仍按租户开启 GUC 事务再读明细——租户隔离在真正读数据的那一步照旧生效。
-- 返回类型与列类型一致：ewoh_exo_session.org_id 是 varchar(255)（存量表的 org 列
-- 类型不统一，PRIMARY/身份域是 uuid、业务域多为 varchar），声明成 uuid 会直接报
-- "return type mismatch in function declared to return uuid"（实测）。
CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_active_exo_session_orgs()
RETURNS TABLE (org_id varchar(255))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
  SELECT DISTINCT s.org_id
  FROM __EWOH_SCHEMA__.ewoh_exo_session AS s
  WHERE s.status = 'active' AND s.org_id IS NOT NULL;
$$;

COMMENT ON FUNCTION __EWOH_SCHEMA__.ewoh_active_exo_session_orgs() IS
  '有活跃外骨骼会话的租户清单（只返回 org_id；供后台 worker 逐租户开启 GUC 事务后再读明细）。';

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_active_exo_session_orgs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_active_exo_session_orgs() TO service_role;
