-- EWOH Command Map — standalone_029 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 029 为全新观测表（additive）：回滚直接 DROP TABLE（索引随表级联删除），
-- 幂等可重复执行（IF EXISTS）。
--
-- 语义：prediction_shadow_observation 为 advisory-only 观测数据，无生产引用
-- （无外键、无触发器、无 RLS 依赖），删除无副作用；apply → rollback → re-apply
-- 循环安全（CREATE TABLE IF NOT EXISTS 跳过已存在表，数据在 rollback 时随表删除）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.prediction_shadow_observation;
