-- EWOH 2026-08-17 审计整改 — W3 NEST-425：控制命令 attempt_no 唯一约束
-- (standalone_058, 审计 docs/audit/2026-08-17-line-by-line-audit.md §6.11 NEST-425)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: 先清理历史重复行（每 (request_id, command_key, attempt_no) 保留
-- 最新一行），再 CREATE UNIQUE INDEX IF NOT EXISTS；可重复执行无副作用。
--
-- 背景：ControlService.sendCommand 以内存 filter.length + 1 计算 attemptNo，
-- 并发 send 同 commandKey 的两个请求可能生成相同 attempt_no（读-算-写竞态），
-- 聚合 latest_attempt 语义（root_command_id + attempt_no）被破坏。唯一约束 +
-- 应用层 SQL 子查询（max+1）使并发写冲突在 DB 层显式失败（23505）。

-- 1) 清理历史重复（幂等：保留每组最大 id 的一行）。
DELETE FROM __EWOH_SCHEMA__.ewoh_control_command a
USING __EWOH_SCHEMA__.ewoh_control_command b
WHERE a.request_id = b.request_id
  AND a.command_key = b.command_key
  AND a.attempt_no = b.attempt_no
  AND a.id < b.id;

-- 2) 复合唯一（同请求同命令的尝试序号唯一；跨请求/命令不约束）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_control_command_attempt
  ON __EWOH_SCHEMA__.ewoh_control_command (request_id, command_key, attempt_no);
