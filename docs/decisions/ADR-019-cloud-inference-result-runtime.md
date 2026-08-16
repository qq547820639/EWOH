# ADR-019：Cloud Inference Result Runtime（云侧 L2 模型结果元数据统一）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-013（Inference Result 契约）/ ADR-014（Reasoning Result 契约）/
  ADR-016（Agent Runtime）/ ADR-009（Envelope）
- 驱动：NO-08a（Round 39，Phase 8 Industrial Intelligence 深化）

## 背景

ADR-013 已定义 Canonical Inference Result 契约（Level 1-7 / confidence /
OOD indicator / dataQuality / evidence，Python/TS 双实现 + 门禁 + Golden 第 9
场景）。现状：
- 边缘（NO-08b，Round 21）：`pipeline._infer` 已产出契约化结果（本地 store）；
- 云侧（Round 22/23）：Ark 文本结果已附着 ReasoningResult（ADR-014）；但
  **云侧没有任何 InferenceResult 运行时**——云侧模型结果元数据未统一
  （OOD/confidence/dataQuality 无落库、无审计、无事件）；
- Model Registry（NO-08b 已对齐 inputVersion）只治理模型本身，不治理结果。

capability-matrix `industrial-intelligence-l2` 的 Partial 判定即源于此缺口。

## 决策

### 决策 1：云侧推理结果台账 = standalone_040 `ewoh_inference_result`

TENANT_SCOPED RLS（inference_result_org_isolation，GUC idiom 与
standalone_025/032-039 一致）+ 唯一 (org_id, inference_id) + CHECK
（level ∈ 七级注册表 / confidence ∈ [0,1] / dataQuality ∈ 三态 / OOD 一致性：
flag=false ⇒ reasons 空、flag=true ⇒ reasons 非空——契约规则的数据库执行面）。
完整契约快照落 result_json（审计同源）；evidence 三要素（tsStart/tsEnd/isRule）
落列（Phase 12 Learning Loop 的时间窗口查询面）。
这是云侧模型结果历史的**单一事实源**：边缘本地 store 为边缘运行时认知，
云台账为跨运行时审计 + L7 学习回路的输入（两者分工显式，非双写同义数据）。

### 决策 2：云侧 `inference` 模块为唯一权威写路径

`InferenceResultService.recordInferenceResult`：validateInferenceResult
fail-closed → INSERT（唯一键冲突幂等回读，不重复发事件）→
InferenceResultRecorded 目录事件（信封 ADR-009）。list/get 租户作用域。
任何云侧模型结果要进入生产事实层必须走本服务（§33 禁止旁路直写）。

### 决策 3：首个真实生产接线 = A2 建议流（规则确定层）

`AiService.createSuggestion`（A2 人工触发，生产调用链）每次产出建议后，
把**确定性规则基础**记录为 L1 InferenceResult：
- level = L1_deterministic_rules；confidence = 1（确定性规则，如实声明，
  非伪装确定）；oodIndicator = {flag:false, reasons:[]}；
- modelId = 'rule-a2-suggestion'、modelVersion = 'v1'、
  inputVersion = `snapshot-v{version}`（与 Model Registry inputVersion 对齐）；
- subjectId = `decision:{suggestion.id}`（ADR-006 内部生成身份）；
- dataQuality = completeness ≥ 0.5 ? good : degraded（快照完备度事实）；
- evidence = {tsStart: snapshot.from, tsEnd: snapshot.to, isRule: true}。
LLM 文本增强路径继续由 ReasoningResult（ADR-014，confidence 必须 null）承载
——两契约分工不混用（统计确定 vs 文本生成）。

### 决策 4：事件目录 +InferenceResultRecorded

`com.ewoh.inference.result_recorded`，channel `inference.result_recorded`
（54→55 类），双运行时投影（shared/event-catalog.ts + contracts/event_catalog.py
lockstep）。幂等重放不重复发事件（与 standalone_035/039 同语义）。

### 决策 5：Level 4 独立推理层不并入本台账

L4 Industrial Reasoning（总提示词 §10：结构化事实→结论的确定性推理层）是
独立能力（NO-08b 立项）：它以 ReasoningResult 为输出契约、以规则/约束为
引擎，与 InferenceResult（模型结果元数据）分工显式。本轮不提前实现。

### 决策 6：写失败语义

接线处（AiService）对台账写入失败：logger.error 留痕 + 建议主流程不中断
（与 agent recordDecisionEvent 同模式——审计失败不伪造成功，但建议生成的
主契约不被审计旁路阻断）；recordInferenceResult 本身对契约违规 fail-closed
抛错（直接调用者必须处理）。

## 后果

- 正面：云侧模型结果首次获得统一元数据运行态（OOD/confidence/dataQuality/
  evidence 落库 + 事件 + 审计）；industrial-intelligence-l2 的 Partial 缺口
  （"云侧模型结果元数据未统一"）闭合，按 §36 评估升 Implemented；为 Phase 12
  Learning Loop（Model Accuracy / 决策效果评估）铺设事实层。
- 代价：新增一张受管表与一个模块；每次 A2 建议多写一行台账。
- 无破坏性变更（新表 additive；AiService 输出结构兼容——suggestion 原字段
  不变，新增 inference 元数据字段）。

## Rejected Alternatives（否决方案）

1. **云侧模型结果仅靠日志/内存**：不可审计、不可重放，违反 §3/§19。
2. **复用 ewoh_event 代替专门台账**：事件是发生事实流，推理结果是派生资产
   （需要按 level/confidence/dataQuality 查询与统计），混用会失去结构语义；
   台账 + 事件（InferenceResultRecorded 指向台账）职责分明。
3. **把 LLM 文本结果强行塞入 InferenceResult**：违反 ADR-013/014 分工
   （confidence 必须 null 的文本结果不是 InferenceResult）。
4. **本轮直接实现 L4 独立推理层**：目标正确但范围过大；先统一 L2 元数据
   运行态，L4 推理层 NO-08b 立项独立推进。
