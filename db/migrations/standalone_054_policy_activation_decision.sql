-- ewoh_scheduling_policy decision_json 列（standalone_054, ADR-064 / NO-13o / §8/§12/§18）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（ADR-064，Decision Catalog kind #8 policy_activation 接线——
-- 8 类 kind 全收敛收口）：策略版本激活（active 翻转/直接保存激活）是真实
-- 人审决策事实（approver+reason 强制门），必须以 ADR-047 契约形态
-- DecisionRecord 留痕（decision_json 列；active 翻转与决策记录同一 UPDATE
-- 原子写入）。§12 Decision History 自此覆盖策略激活决策；旧行 NULL =
-- 未投影（读回兼容，additive）。既有受管表原地加固：managed_count/
-- physical_create_count 不变（74/77）。投影缺口/契约门失败 → 服务层 log
-- 显式 + 留 NULL（§33 绝不静默丢弃、绝不伪造；绝不阻断激活主流程 §2）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy
  ADD COLUMN IF NOT EXISTS decision_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_policy.decision_json IS
  'Canonical DecisionRecord（ADR-047 契约形态 kind=policy_activation；ADR-064 active 翻转/直接保存激活与状态同写原子写入；决策历史单一事实源，§12/§18；NULL=存量未投影行）';
