# ADR-014：Level 4/5 文本结果元数据契约（ReasoningResult，无置信度显式声明）

- **状态**：Accepted
- **日期**：2026-08-16
- **阶段**：Phase 8 — Industrial Intelligence（NO-08c 契约层）
- **关联**：总提示词 §10（模型结果元数据/禁止低置信度伪装确定答案/Unknown 合法）/
  §8（LLM 不得替代确定性求解器，仅可解释/辅助）/§18（可解释性不得编造）；
  ADR-013（InferenceResult 统计推理契约——本文本契约与之互补）。

## Context（现状证据，2026-08-16 实测）

- 云侧 LLM 结果：`ai.service.ts`（AiSuggestion：LLM 生成的调度建议/plan 内容）与
  `ark.service.ts`（ArkChatResult：{ok, text, model, error}）——只有 model 名，
  **无 model_version、无 input_version、无置信度**；错误路径仅有 error 字符串。
- 调度解释链：DecisionTrace 为结构化原因（非 LLM，已可审计）。
- ADR-013 的 InferenceResult 契约要求 confidence∈[0,1] 必填——LLM 文本结果
  **没有标定置信度**，套用该契约必然失败；伪造置信度违反 §33。
- 因此 Level 4/5 文本结果需要一个**独立契约**：显式声明"无置信度"，
  而不是缺字段或伪造。

## Decision（决策）

### 1. ReasoningResult 契约（contracts/reasoning/reasoning-result.schema.json）

- **字段**：reasoningId、level ∈ {L4_industrial_reasoning, L5_agentic_workflow}、
  kind ∈ {suggestion, explanation, analysis, chat}、modelId/modelVersion/
  inputVersion（非空；inputVersion=提示词/输入 schema 版本）、subjectId
  （null 合法——无主体的通用分析/聊天；非 null 必须是规范身份 ADR-006）、
  content（非空）、ok（生成成功标志）、error（可选）、confidence、
  confidenceBasis、evidence {generatedAt}。
- **规则（机器可执行）**：
  - **confidence 必须为 null**——LLM 无标定置信度，禁止伪造；出现数值即拒绝
    （confidence_forbidden）；
  - confidenceBasis 必须为 "uncalibrated"（显式声明，拒绝缺省）；
  - ok=false 必须带非空 error（失败原因可审计）；ok=true 时 error 必须为 null；
  - content 非空；level/kind 封闭注册表；subjectId null 或规范身份；
  - evidence.generatedAt 必填 ISO 时间戳（时间语义可审计）。
- **与 InferenceResult 的边界（显式）**：统计模型（L1-L3 数值判定）→
  InferenceResult（confidence 必填）；LLM 文本（L4/L5 生成）→ ReasoningResult
  （confidence 禁填）。两者不混用。

### 2. 交付纪律

Python/TS 双实现 + 共享向量 + audit-domain-contracts 增 reasoning 域独立仲裁 +
Golden Scenario 第 10 场景（双执行器）。NO-08d 接线：ai.suggestion/ark.chat
结果包裹为 ReasoningResult（model_version 取配置/响应中可用值，缺省
unversioned 如实标注——与 ADR-013 同纪律）。

### 3. 后果

- 正面：LLM 结果可审计（模型/输入版本/时间/失败原因），无置信度事实显式化，
  杜绝"文本结果冒充标定判定"的路径（§10/§33）。
- 负面/代价：现有 ai/ark 返回形状需在接线时包裹（NO-08d，向后兼容保留旧字段）。
- 无新表（契约层先行，§30）。

## Rejected Alternatives（否决方案）

1. **复用 InferenceResult 并缺省 confidence=0**：0 是伪造值（LLM 并非"零置信"），
   且会把文本结果混入统计判定管道。
2. **confidence 字段可选（缺省即无）**：缺省与显式 null 语义混淆，审计无法区分
   "遗漏"与"无标定"——必须显式。
3. **开放 reason 字段**：与 ADR-013 同纪律，封闭注册表保证统计与审计稳定。
