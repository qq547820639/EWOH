-- EWOH Command Map 智能调度 — Prediction Shadow Learning 持久化观察表 (Task 7, standalone_029)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（Incremental Replan V2 / M05，08 §11）：ShadowEvaluatorService 的 shadow 样本
-- 此前仅存于进程内环形缓冲（有界 1000/org），进程重启即丢失，无法做离线评估与跨进程
-- 窗口聚合。本迁移建立 durable observation 模型：每次 shadow 预测（模型预测 vs 确定性
-- baseline）落库一行，actual 回填时更新同一行（含误差列）。
--
-- 语义（advisory-only，观测型）：
--   - 本表只记录预测/基线/实际，**绝不回喂生产调度**、不改变 dispatch、不替代
--     hard constraints（与 PredictionShadowSample 契约一致）；
--   - 无物理外键：任务/执行删除不影响观察历史，观察行是独立快照；
--   - correlation_id 提供稳定回填键（同一执行上下文多次预测可共享）；回填匹配优先级：
--     correlation_id → (task_id, prediction_type) → (prediction_type, created_at)；
--   - 保留策略：应用层按需清理（ShadowEvaluatorService.pruneObservations），默认建议
--     保留 30 天；本表无触发器、无级联负担，生产可改由定时任务 DELETE。
--
-- 列说明：
--   prediction_type：预测方法（task_duration / travel_time / battery_consumption /
--                     station_queue / execution_risk / fatigue_risk）
--   prediction / baseline：模型预测值 vs 确定性基线值（单位随方法语义）
--   actual / absolute_error / relative_error：回填后写入（未回填为 NULL）
--   actual_at：actual 回填时间戳
--   entity_id：预测目标实体（任务/工位/人员），可空
--   task_id / execution_id / correlation_id：任务/执行/关联键，均可空
--   model_version / policy_version / snapshot_version：模型/策略/世界快照版本，可空

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.prediction_shadow_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255),
  prediction_type varchar(100) NOT NULL,
  entity_id varchar(255),
  task_id varchar(255),
  correlation_id varchar(255),
  execution_id varchar(255),
  prediction double precision NOT NULL,
  baseline double precision,
  actual double precision,
  confidence double precision,
  model_version varchar(100),
  policy_version integer,
  snapshot_version varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  actual_at timestamptz,
  absolute_error double precision,
  relative_error double precision
);

CREATE INDEX IF NOT EXISTS idx_prediction_shadow_observation_org_created
  ON __EWOH_SCHEMA__.prediction_shadow_observation (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prediction_shadow_observation_correlation
  ON __EWOH_SCHEMA__.prediction_shadow_observation (correlation_id);
CREATE INDEX IF NOT EXISTS idx_prediction_shadow_observation_task
  ON __EWOH_SCHEMA__.prediction_shadow_observation (task_id);

COMMENT ON TABLE __EWOH_SCHEMA__.prediction_shadow_observation IS 'Prediction Shadow Learning 持久化观察（advisory-only）：预测 vs 确定性基线，actual 回填后计算误差，供离线评估与跨进程窗口聚合；绝不回喂生产调度。保留建议 30 天，超期行由应用层 pruneObservations 清理';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.org_id IS '租户归属（null=全局/ALL 采样，应用层 org 键）';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.prediction_type IS '预测方法：task_duration/travel_time/battery_consumption/station_queue/execution_risk/fatigue_risk';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.correlation_id IS '稳定回填关联键：同一执行上下文多次预测共享，回填匹配优先级最高';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.prediction IS '模型预测值（advisory-only，绝不替代生产调度决策）';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.baseline IS '确定性基线值（同一输入恒同一输出）';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.actual IS '实际值（ExecutionService/SchedulingFeedback 回填前为 NULL）';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.absolute_error IS '绝对误差 |prediction − actual|（未回填为 NULL）';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.relative_error IS '相对误差 |prediction − actual| / |actual|（未回填或 actual=0 时为 NULL）';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.actual_at IS 'actual 回填时间戳';
COMMENT ON COLUMN __EWOH_SCHEMA__.prediction_shadow_observation.created_at IS '预测产生时间（采样/持久化时间戳；聚合窗口与保留清理的基准）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.prediction_shadow_observation TO service_role;
