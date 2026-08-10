-- EWOH Command Map — standalone_031 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 031 为全新计数表（additive）：回滚直接 DROP TABLE（索引/约束随表级联删除），
-- 幂等可重复执行（IF EXISTS）。
--
-- 语义：ewoh_snapshot_version_counter 为纯计数器数据（可重建：应用下次分配自动
-- 重建该天行），无外键/触发器/RLS 依赖，删除无副作用；apply → rollback → re-apply
-- 循环安全（CREATE TABLE IF NOT EXISTS 跳过已存在表）。
-- 回滚后版本分配回退到旧 read-then-increment 逻辑（snapshot_version 唯一约束仍兜底防重）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_snapshot_version_counter;
