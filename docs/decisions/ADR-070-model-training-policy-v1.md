# ADR-070：Model Training Policy v1（租户隔离强制，NO-13u）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-056/067（经验时长模型与重训闭环；遗留边界"跨租户
  训练政策"）、§15（多租户）/§16（客户数据原则）/§33

## 背景

ADR-056/067 显式遗留边界：跨租户训练政策。仓库事实复核发现真实
泄漏风险：DurationModelTrainingService.retrain() 读取
ewoh_scheduling_feedback 全部行（无 org 过滤）训练全局模型——
不同租户的执行事实被混合进同一统计模型，违反 §15/§16（Factory
Data belongs to Customer；训练/聚合必须遵守显式政策）。

## 仓库事实

- ewoh_scheduling_feedback 已有 org_id 列（recordBaseline 经 ctx
  写入 orgId）；actual_start/actual_end 由 recordActuals 回填；
- ewoh_model_registry：modelId 全局唯一，无 org 列——org 隔离经
  modelId 词表承载（无 schema 变更）；
- retrain 端点无租户上下文（全局训练路径）；
- 预测 provider 无 org 键控（模型全局共享）。

## §29 十八问（实现前作答）

1. **Domain**：模型训练治理（§15/§16/§24 Model Catalog）。
2. **Canonical Contract**：PredictionProvider 接口 +
   PredictionResult 语义不变；modelId 词表扩展（org 命名空间）。
3. **Authoritative Source**：训练事实 = ewoh_scheduling_feedback
   .org_id（基线写入时 ctx 注入）；训练只读本租户行（§3 单一事实）。
4. **如何改变 Factory World**：零改变（训练/预测 shadow-only）。
5. **Event**：无。
6. **谁消费**：EmpiricalDurationPredictionProvider（本租户求解
   预测）。
7. **失败会怎样**：retrain 缺 orgId → 400 显式拒绝（§15 不静默
   全局训练）；预测缺 orgId → 确定性基线显式回退（§33）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：训练确定性；每 (org, modelId) 版本链独立
   幂等。
10. **权限边界**：retrain 端点权限不变（人工显式触发）+ 租户
    上下文强制。
11. **租户边界**：训练数据 org_id 过滤；模型注册表经 modelId
    词表 org 命名空间隔离；hydrate 按 org 前缀过滤——机器强制。
12. **安全风险**：训练数据跨租户泄漏风险消除（v1 政策）。
13. **Human Approval**：retrain 人工端点（不变）。
14. **如何解释 Decision**：cardJson 携带 orgId + 样本数（训练
    事实可审计）；预测 modelVersion 标注 org 模型链。
15. **如何测试**：training spec（org 过滤跨租户隔离 / 缺 org 400 /
    modelId 命名空间 / hydrate org 前缀）+ provider spec（org 键控
    查找 / 缺 org 确定性回退）。
16. **如何审计**：注册表 cardJson orgId 判定事实；版本链可审计。
17. **如何迁移**：无 DB 变更；旧全局模型行（org 命名空间外）不再
    用于预测（显式弃用边界——历史模型留档不回填）。
18. **如何回滚**：还原 org 过滤即回滚（modelId 词表兼容）。

## 决策

### 决策 1：v1 政策 = 租户作用域训练（跨租户聚合显式 OFF）

- 训练只读本租户反馈（org_id 过滤）；
- 跨租户聚合/联邦/匿名化共享：v1 一律 OFF（无授权/匿名化机制前
  禁止，§16）；
- 旧全局模型行（`task-duration-empirical` 与 `task-duration-
  empirical:<taskType>` 历史词表）不再进入预测路径（显式弃用，
  留档不回填）。

### 决策 2：modelId org 命名空间（无 schema 变更）

- 全局：`task-duration-empirical:<orgId>`；
- 分组：`task-duration-empirical:<orgId>:<taskType>`；
- isEmpiricalModelId 前缀保持 `task-duration-empirical:`；
- hydrate(orgId) 按前缀 + orgId 段过滤。

### 决策 3：预测 org 键控 + 缺上下文显式回退

provider 以 orgId 键控模型映射（预测必须携带任务租户上下文——
PredictionTask.orgId）；缺 orgId → 确定性基线（显式，§33 不静默
跨租户共享）。

### 决策 4：retrain(orgId) 强制

服务与端点强制 orgId（缺失 → 400）；训练/落版/hydrate 全部
org 作用域。

## 后果

- 正：§15/§16 机器强制（训练数据租户隔离 + 模型 org 命名空间 +
  预测 org 键控）；跨租户泄漏风险消除；无 schema 变更。
- 负：旧全局模型弃用（历史留档不回填）；每租户独立模型链（注册表
  行数按租户×taskType 增长）。
- 无破坏性变更（无 DB/OpenAPI/env 变更；端点行为收紧 + 400 语义
  显式）。
