# ADR-013：Industrial Intelligence 架构与模型结果元数据契约（Phase 8 启动）

- **状态**：Accepted
- **日期**：2026-08-16
- **阶段**：Phase 8 — Industrial Intelligence（NO-08a 契约层）
- **关联**：总提示词 §10（多层工业智能 + 模型结果元数据 + Unknown 合法）/§8（LLM
  不替代确定性求解器）/§18（可解释性）；ADR-006（Identity）/ADR-007（Risk）/
  ADR-009（Envelope）；capability-matrix industrial-intelligence-l2 /
  industrial-intelligence-l4-reasoning（Partial）。

## Context（现状证据，2026-08-16 实测）

- 边缘已有 Level 1/2 事实：`inference/pipeline.py`（规则降级路径 +
  unknown 六路：data_quality/low_confidence/ambiguous/firmware_unverified/
  out_of_distribution/sensor_channel_missing）、`model_card.py`（数据/特征/模型/
  阈值版本治理，input_version 概念已存在）、ModelRegistry；推理结果 dict 含
  model_id/model_version/confidence/data_quality/unknown_reason/key_features。
- 云侧 model/ai 模块存在（Model Registry CRUD + Ark 视觉），但**模型结果元数据
  无统一契约**：边缘用 "rules"/"rule-fallback" 裸串、数据质量词表 good/degraded/
  invalid 未进契约、OOD 指示与 unknown_reason 未归一，云侧 Ark 结果无
  model_version/input_version/OOD 元数据——§10 要求（model_id/model_version/
  input_version/confidence/OOD indicator/data quality/evidence）未系统化。
- 既有能力判定：industrial-intelligence-l2 / -l4-reasoning 均为 Partial。

## Decision（决策）

### 1. 分层架构（Level 1-7 显式登记，拒绝"一个万能 AI"）

| Level | 名称 | EWOH 现有载体 |
|---|---|---|
| L1 | Deterministic Rules | edge rule_registry/rules.py、云侧 rule-engine |
| L2 | Statistical/ML Models | edge ActionModel/疲劳模型、云侧 Ark 视觉 |
| L3 | Optimization | Scheduler（heuristic canonical + CP-SAT 阶梯） |
| L4 | Industrial Reasoning | DecisionTrace/约束违反/候选排除（结构化，非 LLM） |
| L5 | Agentic Workflow | 无（Phase 9 Agent Runtime 立项） |
| L6 | Simulation / Digital Twin | 回放/预测（Phase 10 体系化） |
| L7 | Learning Loop | 调度反馈 KPI（Phase 12 体系化） |

每层结果必须携带本 ADR 的 InferenceResult 元数据（L1 规则结果同受约束：
modelId="rules"、inputVersion=规则集版本）；LLM 只能做意图理解/解释/配置辅助，
不得替代 L1-L3 的确定性判定（§8）。

### 2. Canonical Inference Result 契约（contracts/intelligence/）

- **必填**：inferenceId、subjectId（规范身份，ADR-006）、level（L1-L7 注册表）、
  modelId、modelVersion、inputVersion（数据/特征版本，非空）、label、confidence、
  oodIndicator、dataQuality、evidence。
- **规则（机器可执行）**：
  - confidence ∈ [0,1]，越界拒绝；
  - oodIndicator.flag=true 必须携带 ≥1 个 reason（oodReasonRegistry 六路封闭
    注册表：data_quality/low_confidence/ambiguous/firmware_unverified/
    out_of_distribution/sensor_channel_missing）；flag=false 时 reasons 必须为空
    （禁止"无理由的 OOD"与"有理由却未标记"两种漂移）；
  - **Unknown 是合法结果**：label="unknown" 合法且必须携带 oodIndicator 理由
    （禁止低置信度伪装确定答案）；
  - dataQuality ∈ {good, degraded, invalid}（边缘既有词表入契约，收敛
    FRESH/DEGRADED 别名词表暂不引入——边缘语义为窗口质量而非新鲜度，显式区分）；
  - evidence 必带窗口时间戳（tsStart/tsEnd）与 isRule 标记（区分模型/规则路径，
    可审计）。
- **交付纪律**：Python/TS 双实现 + 共享向量 + audit-domain-contracts 扩展
  intelligence 域独立仲裁 + Golden Scenario 第 9 场景 inference_result_contract
  （双执行器）。

### 3. 后果（Consequences）

- 正面：边缘六路 OOD 与云侧模型结果向统一契约收敛；Model Registry 可审计字段
  齐备（§10/§36）；Unknown 语义显式化。
- 负面/代价：既有边缘 res dict 需在 NO-08b 接线时补 inputVersion/level/
  oodIndicator 归一化（兼容旧字段保留，不破坏存储/订阅方）。
- 无新表：契约层 + 门禁 + 场景先行（§30 先修契约再修实现）。

## Rejected Alternatives（否决方案）

1. **云侧单独定义结果 schema**：会造成云/边缘两种"模型结果"事实源（§3 违反）。
2. **OOD 理由开放字符串**：审计与统计需要封闭注册表（与 conditionType 等同纪律）；
   新理由走契约版本演进而非自由文本。
3. **confidence 允许越界/缺省**：越界必须拒绝（fail-closed），缺省不伪造——
   低置信度必须显式 unknown。
