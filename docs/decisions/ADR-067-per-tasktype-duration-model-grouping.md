# ADR-067：per-taskType 经验时长模型分组（NO-13r）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-056（经验时长模型 + 重训闭环；决策 3 后续——
  per-taskType 分组）、§10（L2/L7）、§21（时间语义）、§33

## 背景

ADR-056 决策 3 显式声明：全局时长分布为 v1 语义，per-taskType 分组
为后续立项。全局模型混淆不同任务类型的时长分布（搬运 vs 装配时长
差异大），分组训练可显著提升预测准确度与置信度的真实表达（§10
L2 统计模型深化 + L7 真实反馈闭环细分）。

## §29 十八问（实现前作答）

1. **Domain**：时长预测模型（§10 L2 + L7）。
2. **Canonical Contract**：PredictionProvider 接口 + PredictionResult
   （modelVersion/confidence/source 语义不变）；DurationModel 形状
   复用（§31 单一实现）。
3. **Authoritative Source**：真实执行反馈（ewoh_scheduling_feedback
   .actual_start/actual_end）+ 任务类型事实（ewoh_production_task
   .task_type，任务登记唯一权威源）——同一事实链，不新建事实源
   （§3）。
4. **如何改变 Factory World**：零改变（shadow-only 预测面；模型
   只是优化器输入，ADR-056 边界不变）。
5. **Event**：无。
6. **谁消费**：EmpiricalDurationPredictionProvider → 求解器预测
   （shadow-only）。
7. **失败会怎样**：分组样本不足（< MIN_SAMPLES）→ 该分组显式跳过
   （不落版不伪造，§33），预测回退全局模型 → 再回退确定性基线
   （显式两级回退，来源标注）。
8. **离线会怎样**：云侧重训/预测；无外部依赖。
9. **重复消息会怎样**：训练确定性（同反馈集 → 同模型）；注册表
   每 modelId 独立版本链（supersede + 递增）；幂等。
10. **权限边界**：重训端点权限不变（人工显式触发）。
11. **租户边界**：反馈/任务均租户作用域（既有 RLS）；模型注册表
    既有语义不变。
12. **安全风险**：无（shadow-only 预测）。
13. **Human Approval**：重训为显式人工端点（不变）。
14. **如何解释 Decision**：预测结果标注来源模型 id（全局 vs
    taskType 分组）+ 真实置信度；cardJson 记录 taskType 与样本量。
15. **如何测试**：provider spec +2（taskType 分组优先 / 未知
    taskType 回退全局）+ training service spec +2（分组训练 +
    注册表 modelId 链 + 不足分组显式跳过 / hydrate 重建分组映射）。
16. **如何审计**：注册表每分组独立落版（cardJson 含 taskType +
    trainedAt + 样本量）。
17. **如何迁移**：无 DB 变更（modelId 词表扩展 `task-duration-
    empirical:<taskType>`；旧全局模型语义不变）。
18. **如何回滚**：删除分组逻辑即回滚（全局模型路径不变）。

## 决策

### 决策 1：modelId 词表 + 两级回退

- 全局：`task-duration-empirical`（v1 语义不变）；
- 分组：`task-duration-empirical:<taskType>`（taskType 为任务登记
  事实，非猜测；无 taskType 的任务仅计入全局）；
- 预测：task.taskType 命中分组 → 分组模型（modelVersion 标注）；
  未命中 → 全局模型；全局未训练 → 确定性基线（显式两级回退，
  source 如实标注 §33）。

### 决策 2：训练 = 全局 + 分组独立落版

retrain()：同一次反馈集 → 全局模型 + 各 taskType 分组模型（分组
样本 < MIN_SAMPLES → 显式 skipped 不进注册表）；每个 modelId 独立
版本链（supersede + 递增）；provider 一次性刷新（全局 + 分组映射）。
RetrainSummary additive：perTaskType[]（taskType/ok/model/version/
notEnoughDataReason）。

### 决策 3：hydrate 全量回填（前缀过滤）

hydrateFromRegistry：读取注册表全量行，内存过滤 modelId 前缀
（全局 + 分组），按 modelId 取最新 active → 重建全局 + 分组映射
（冷启动即恢复分组训练态）。

## 后果

- 正：时长预测按任务类型细分（真实分布拟合 + 置信度真实表达）；
  shadow-only 边界不变；两级回退显式；注册表可审计（每分组独立
  版本链 + cardJson 事实）。
- 负：注册表行数增加（每 taskType 一链）；重训开销按分组数线性。
- 无破坏性变更（无 DB/OpenAPI/env 变更；接口 additive）。
