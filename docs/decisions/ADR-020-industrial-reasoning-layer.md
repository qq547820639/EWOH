# ADR-020：Industrial Reasoning Layer（Level 4 独立工业推理层）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-013（Inference Result）/ ADR-014（Reasoning Result）/ ADR-019
  （云侧推理结果运行时）/ ADR-007（Risk 阶梯）/ ADR-006（Identity）
- 驱动：NO-08b（Round 40，Phase 8 Industrial Intelligence 深化；总提示词 §10
  Level 4 / §18 可解释性）

## 背景

EWOH 多层工业智能（§10）中 Level 4（Industrial Reasoning）要求：结构化事实 →
结论的确定性推理层。现状：
- L1 确定性规则（边缘 rule engine + 云侧 A2 规则基础，Round 39）与
  L2/L3 统计/优化已就绪；L5 Agentic Workflow 已收口（Phase 9）；
- 决策解释（DecisionTrace/约束违反/候选排除原因）存在于 scheduler 内部，
  但**没有独立的工业推理层**：结论、前提、规则、证据链不是一等资产；
- capability-matrix `intelligence-l4-reasoning` 因此保持 Partial。

## 决策

### 决策 1：推理层输出契约 = ReasoningTrace（新契约，contracts/reasoning/）

`reasoning-trace.schema.json`（v1.0.0，meta-contract 同风格）：
- **trace 记录**：traceId / engineVersion / factsRef（snapshotVersion +
  eventIds 规范身份）/ conclusions[] / auditTrail 必须 true；
- **conclusion**：conclusionId（decision:value 规范身份，ADR-006）/ ruleId ∈
  封闭规则注册表 / subjectId（规范身份）/ severity ∈ canonical risk 阶梯
  （critical>high>medium>low，ADR-007 同源）/ confidence ∈ [0,1] +
  confidenceBasis ∈ {deterministic, statistical} / premises（非空规范身份）/
  evidenceIds（非空规范身份，§3 可追溯）/ explanation（非空，来自事实模板
  渲染——**禁止自由编造**）；
- **事实 kind 注册表**：person/exo/machine/material/station/alert
  （v1 六类，全部命中 ADR-006 身份注册表）；
- conclusions 可为空数组 = "无规则触发"的显式语义（不是 unknown 冒充
  normal——§33）。

Python/TS 双实现 + 共享向量 + audit-domain-contracts 独立仲裁 + Golden 第 15
场景（与既有契约域同纪律，§31）。

### 决策 2：推理引擎 = 确定性规则评估器（非 LLM）

v1 内置规则注册表（六条，双运行时锁定语义一致——TS 生产引擎 +
Python 标准库独立实现供跨语言仲裁，同 Scheduler TCK 模式）：

| ruleId | 事实 kind | 触发条件 | severity |
|---|---|---|---|
| worker-overload | person | workload≥0.8 且 (fatigue≥0.7 或 ergonomicRisk≥0.7) | high |
| exo-low-battery | exo | batteryPct<20 | warning→high？见决策 3 |
| machine-vibration-risk | machine | vibrationExceeded=true | critical |
| material-shortage | material | inventory<minThreshold | high |
| station-quality-blocked | station | qualityBlocked=true | critical |
| andon-escalation | alert | andonRaised=true 且 unacknowledgedMinutes>15 | high |

- confidence=1、confidenceBasis=deterministic（规则为确定性谓词，如实声明，
  非伪装确定）；explanation 由事实值模板渲染（数字来自输入，机器可解释，
  §18：LLM 只允许后续翻译，不允许生成原因）；
- 规则按注册表顺序评估，结论确定性排序；未知 fact kind / 非规范身份 /
  事实缺 evidenceIds → fail-closed 拒绝整次评估；
- 规则版本 = engineVersion（语义版本），进入 inputVersion 追踪链。

### 决策 3：severity 词表 = canonical risk 阶梯

结论严重度使用 ADR-007 阶梯（critical/high/medium/low）。exo-low-battery
v1 定为 **high**（外骨骼低电量影响人员辅助能力与任务连续性，且现场换电
动作需人工执行——结论为建议型，人审执行）。

### 决策 4：审计落点 = InferenceResult 台账（standalone_040，不新建表）

每条结论以 L4 InferenceResult 落账（ADR-019 台账复用，§33 不重复造事实源）：
- level=L4_industrial_reasoning；modelId=`reasoning:${ruleId}`；
  modelVersion=engineVersion；inputVersion=`snapshot-v${n}`；
  label=explanation；confidence=结论 confidence；
  evidence={tsStart/tsEnd=评估窗口, isRule=true}；subjectId=结论 subjectId。
结论行 + 规则版本 + 快照版本 = 完整可重建审计链（trace 可由台账行重建，
不设独立 trace 表）。评估响应返回每条结论的 inferenceId（可追溯）。

### 决策 5：事件面 = 复用 InferenceResultRecorded（55 类，不新增类型）

推理结论落账即产生 InferenceResultRecorded 事件（ADR-019）。不新增
ReasoningTraceRecorded——trace 是评估响应工件，结论台账 + 事件已是事实层。

### 决策 6：生产调用链 = /api/reasoning/evaluate（唯一权威入口）

POST /api/reasoning/evaluate：契约校验（输入形状）→ 规则评估 → trace 契约
自检（validateReasoningTrace fail-closed，违规绝不返回）→ 结论逐条落账 →
返回 trace + inferenceIds。GET /api/reasoning/rules：规则注册表 + 语义
（可解释面）。所有读写带租户上下文 + RLS（台账表）。

## 后果

- 正面：Level 4 推理层成为一等资产（结论/前提/规则/证据链可审计可重放）；
  每条结论自动进入 L4 台账（Phase 12 Model Accuracy/决策效果评估输入）；
  intelligence-l4-reasoning 按 §36 升 Implemented（矩阵 39/16/0/1）。
- 代价：v1 六规则封闭注册表（扩展走契约小版本）；评估调用产生台账行。
- 无破坏性变更（新契约 + 新模块；台账表复用）。

## Rejected Alternatives（否决方案）

1. **LLM 直接生成推理结论**：违反 §18（解释必须来自真实约束/事实，LLM 可
   翻译不可编造）；结论不可确定性验证。
2. **推理层并入 scheduler DecisionTrace**：scheduler 解释是调度域内部资产；
   Level 4 是跨域（人员/设备/物料/质量/安灯）推理面，独立契约与引擎
   避免域耦合。
3. **为 trace 新建持久化表**：结论台账（040）+ 规则版本 + 快照版本已可
   重建审计链；trace 表会造成第二事实源（§33）。
4. **把推理结论写入 ReasoningResult 文本**：trace 是结构化事实（带
   confidence/basis），ReasoningResult 是 LLM 文本元数据（confidence 必须
   null）——语义错配。
