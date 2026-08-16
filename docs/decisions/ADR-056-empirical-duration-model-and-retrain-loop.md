# ADR-056：经验时长统计模型 + 模型重训/激活闭环（NO-13g）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-013（Level 2 统计模型契约：model_id/model_version/
  input_version/confidence/OOD/data quality/evidence）、ADR-025/ADR-026
  （学习回路：策略阈值腿 + 评估器）、ADR-034（Outcome 标注真值面）、
  §10（Industrial Intelligence 分层）/§12（Decision History→Evidence）
  /§33（不造假/Unknown 合法）

## 背景

intelligence-l7-learning 矩阵缺口：决策→结果回流（七指标快照）✓、
策略（规则阈值）自动更新闭环 ✓（NO-12b/ADR-026）、Outcome 标注面 ✓
（NO-12j/ADR-034），剩余唯一缺口 = **模型重训/激活闭环**——需真实
可训练统计模型先落地（§33 不造假）。仓库现有预测层为纯确定性基线
（DeterministicPredictionProvider），无任何可训练模型。

本轮落地真实统计模型：**经验时长模型**（非参数经验分布——median/p90
从真实执行反馈推导），训练/激活闭环（注册表落版 + supersede + 内存
刷新）。非 LLM、非伪 ML：可复现、可审计、置信度真实。

## §29 十八问（实现前作答）

1. **Domain**：Industrial Intelligence Level 2（统计模型）+
   Level 7 学习回路的模型腿。
2. **Canonical Contract**：PredictionProvider 接口（shadow-only 既有
   约定）+ PredictionResult（modelVersion/confidence/source）+
   ewoh_model_registry（既有受管表，模型注册单一事实源）。
3. **Authoritative Source**：真实执行反馈
   （ewoh_scheduling_feedback.actual_start/actual_end，§21 时间语义）；
   模型参数 = 训练纯函数输出（确定性可重放）。
4. **如何改变 Factory World**：不改变——预测只是优化器输入（shadow
   only，既有边界）；模型注册表落版为可审计资产。
5. **Event**：无新事件类型（模型注册既有 audit 面）。
6. **谁消费**：调度优化器（时长输入）、shadow 评估。
7. **失败会怎样**：样本不足 → 显式 not_enough_data（不落版不伪造，
   §33）；训练异常 → retrain_failed 显式；预测面 OOD 回退确定性
   基线（source='deterministic' 显式标注，绝不静默）。
8. **离线会怎样**：训练/预测均为云侧（无边缘依赖）；冷启动
   hydrateFromRegistry 恢复训练态。
9. **重复消息会怎样**：训练幂等（同数据 → 同模型）；注册表版本
   递增（supersede 旧 active，单一 active）。
10. **权限边界**：retrain 端点沿用 scheduler API 鉴权面。
11. **租户边界**：训练数据 = 全量反馈（当前单租户语义）；跨租户
    训练政策随 §16 数据政策后续立项（显式边界）。
12. **安全风险**：无（预测不写生产调度、不替代 hard constraints）。
13. **Human Approval**：无需（shadow-only 输入参数）。
14. **如何解释 Decision**：value=median + confidence（样本量/离散度
    推导）——真实统计语义，可解释可审计。
15. **如何测试**：纯函数 4 例（median/p90/缺口/置信度/版本）+ 提供者
    4 例（未训练回退/模型路径/任务事实优先/其余维度基线）+ 训练
    服务 5 例（落版 supersede/版本解析递增/样本不足/空数据/hydrate
    回填与非法数值防护）。
16. **如何审计**：注册表 cardJson（n/median/p90/spread/trainedAt/
    dataSource）+ version 递增链。
17. **如何迁移**：无 DB 变更（ewoh_model_registry 既有）；新提供者
    替换 PREDICTION_PROVIDER 实现（shadow-only 语义不变）。
18. **如何回滚**：恢复 DeterministicPredictionProvider 注册 + 摘除
    新文件即回滚。

## 决策

### 决策 1：经验时长模型（非参数统计，§33 真实可训练）

empirical-duration-model.ts 纯函数：train（median/p90 最近秩百分位/
count/spread）→ DurationModel；durationConfidence（样本量+离散度
推导，0.1..0.95 裁剪）；样本 < MIN_SAMPLES(5) → not_enough_data
显式（OOD 语义）。确定性可重放（同样本 → 同模型）。

### 决策 2：提供者替换（shadow-only 边界不变）

EmpiricalDurationPredictionProvider 实现 PREDICTION_PROVIDER：
- 时长预测：任务自带 durationMs（任务级真实事实）→ 确定性路径
  （同既有语义）；否则已训练模型 → median + ml 来源 + 真实置信度；
  未训练 → 确定性基线（source='deterministic' 显式）；
- 其余维度（travel/battery/queue/risk/fatigue）→ 确定性基线。
语义边界与既有注释一致：预测只是优化器输入，绝不写生产调度。

### 决策 3：训练/激活闭环（唯一权威写路径）

DurationModelTrainingService.retrain()：真实反馈加载（actual_start/
actual_end 双非空，§21）→ 训练 → ewoh_model_registry 落版（版本 =
既有最大数字版本 + 1；旧 active supersede）→ provider.refresh；
hydrateFromRegistry() 冷启动回填。触发面：POST
/api/scheduler/predictions/task-duration/retrain（显式 API，无隐式
自动重训——重训时机政策后续立项）。

## 后果

- 正：intelligence-l7-learning 四腿闭环（决策→结果 / 策略阈值 /
  Outcome 标注 / 模型重训激活）全部落地，§36 升 Implemented
  （矩阵 53/2/0/1→54/1/0/1）；Level 2 统计模型有真实样本与真实
  不确定性。
- 负：模型为全局时长分布（per-taskType 分组与跨租户训练政策为
  后续立项，显式边界）。
- 无破坏性变更（additive；PREDICTION_PROVIDER 替换为 shadow-only
  语义兼容实现；无 DB/env 变更；OpenAPI +1 端点）。
