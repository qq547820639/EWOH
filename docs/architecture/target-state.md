# EWOH Target State（目标状态）

> 维护规范：本文件定义 EWOH 向 **Factory Embodied Intelligence OS** 收敛的目标架构。
> 它是总提示词长期目标在本仓库的结构化落点；每项能力给出目标定义、验收判据与
> 对应实施阶段（Phase 编号与 `docs/agent/project-state.yaml` current_phase 联动）。
> 安全边界（§二）为最高优先级不变量，任何目标不得与之冲突。
> 最后更新：2026-08-14。

## 0. 北极星

> 将 EWOH 建设为面向制造与物流场景的 Factory Embodied Intelligence OS，使工厂具备
> 感知自身、理解自身、协调自身、预测自身和持续优化自身的能力。

核心闭环（任何重大设计围绕它判断价值）：

```text
Physical Factory → Observation → Factory Events → Factory World State
→ Reasoning → Planning → Human Approval / Policy → Coordination → Execution
→ Feedback → Learning
```

## 1. 绝对安全边界（不变量，最高优先级）

- 实时安全闭环（急停/电机实时控制/关节控制/扭矩环/Safety PLC/外骨骼实时助力/
  硬件限位/功能安全最终执行）**永久留在确定性实时控制器**，EWOH 不得迁移、不得绕过。
- EWOH 仅：感知/分析/预测/推荐/调度/请求确认/下发高级任务/监控执行/升级异常。
- 所有关键动作满足：Policy Check → Authorization → State Revalidation →
  Resource Reservation → Dispatch → Audit。
- 高风险场景默认 Human-in-the-loop；自治等级必须显式定义（Autonomous Level），
  禁止隐式自动执行。

## 2. Factory Truth 与 Canonical Contracts（Phase 2）

目标：单一事实层，任何状态可回答"系统为什么认为工厂是这个状态"，可追溯
Observation → Source → Timestamp → Event → Transformation → State Change。

需收敛的 Canonical 模型（跨 Python/TS/DB/OpenAPI/前端/第三方接口）：

Identity / Entity / Event / Task / Resource / State / Location / Capability /
Risk / Decision / Execution / Evidence。

验收判据：
- 每个概念有唯一版本化 Contract（schema + 语义），Python/TS/DB/OpenAPI 由 Contract
  生成或经 Contract TCK 校验，无第三处手写定义。
- 状态投影可事件回放重建；第三方 ID 有显式 Mapping（不得以 MES ID/PLC Tag 为内部唯一 ID）。

## 3. Factory World Model（Phase 3，系统中枢）

目标：统一认知层（不等价于数据库表），至少覆盖：
Person / WorkerCapability / Skill / Certification / Fatigue / Workload / ErgonomicRisk /
Exoskeleton / Machine / Robot / AGV / Tool / Material / Container / Inventory /
Order / ProductionOrder / Operation / Task / WorkInstruction / Station / Zone / Route /
Factory / Warehouse / Sensor / Observation / Event / Alert / Incident / Risk /
QualityFinding / MaintenanceCondition / Reservation / Assignment / Plan / Decision /
Approval / Execution / Outcome / Policy / Constraint / Model / Agent / Knowledge。

实体通用要求：唯一 ID、类型、Tenant、Factory、时间语义、状态、来源、版本、置信度、
可追溯关系、事件历史、必要空间状态。

验收判据：
- 云侧 world 模块为权威投影；边缘 world_model 进入装配链；双侧消费同一 World State Contract。
- State Store / History / Replay / Projection 完整；模拟数据在 schema 级与生产隔离。

## 4. Event Backbone（Phase 4）

目标：Command → Event → State Projection → Query；事件语义表达真实工业事实
（如 `machine.vibration.threshold_exceeded`，而非 `machine.updated`）。

统一 Event Envelope 必含：event_id / event_type / schema_version / occurred_at /
observed_at / received_at / tenant_id / factory_id / actor / subject / source /
causation_id / correlation_id / confidence / payload / evidence。

验收判据：
- 事件目录（contracts/events/event-catalog.yaml）扩展为完整 Event Catalog 并版本化；
- Envelope 全链路（Edge→Bridge→Ingest→Outbox→SSE）强制；支持 replay、dedup、Late Event；
- 重要状态可从事件或可审计事实重建。

## 5. Factory Connectivity（Phase 5）

目标：Edge Runtime = Connector Runtime + Local Event Bus + Local State + Inference +
Rules + Offline Queue + Local Scheduler + Policy Enforcement + Store-and-Forward。

Connector 体系：OPC UA / Modbus TCP / Modbus RTU / MQTT / Sparkplug B / REST /
Webhook / WebSocket / CSV/File / Serial / CAN / 厂商 SDK / MES / WMS / ERP。

每个 Connector 声明：Capabilities / Input Schema / Output Schema / Health /
Retry Semantics / Delivery Semantics / Timestamp Semantics / Identity Mapping /
Security / Configuration Schema；Connector SDK + Connector TCK 为交付门槛。

验收判据：新增协议 = manifest + SDK 实现 + TCK 通过，无业务代码分支侵入。

## 6. 外骨骼一等实体（Phase 3 内嵌）

Exoskeleton 域模型：Device Identity / Model / Firmware / Capabilities / Battery /
Health / Sensor Channels / Support Mode / Assist Profile / Fit / Assigned Worker /
Session / Usage / Workload / Ergonomic Metrics / Fault / Maintenance / Calibration /
Location / Connectivity。人员绑定必须是显式、临时、可审计的 Session。

## 7. Unified Scheduler（Phase 7，核心工业决策引擎）

目标：统一、可解释、可扩展的资源协调系统。输入覆盖 Tasks/Priority/Due Time/
Workers/Skills/Certifications/Fatigue/Ergonomic Risk/Exoskeleton Capability/
Machines/Vehicles/Materials/Inventory/Locations/Routes/Traffic/Equipment State/
Maintenance State/Quality State/Orders/Policies/Constraints/Reservations/World State。

调度过程：Request → Snapshot → Generate Candidates → Hard Constraint Filtering →
Optimization → Scoring → Explanation → Shadow Plan → Approval → Revalidate →
Reserve → Dispatch → Observe → Feedback → Replan。支持动态重排与
CP-SAT / MILP / heuristic / rule-based Solver 插拔；Hard Constraint 必须由可验证
逻辑执行，LLM 不得替代确定性约束求解器。

跨语言一致性（§九）：Cloud Planner / Edge Planner / Fallback Planner /
Simulation Planner 允许并存，但共享 Canonical Domain Contract / State Machine /
Constraints / Scoring / Event Schema / Test Vectors / TCK；无法一致处显式声明差异边界。

## 8. Industrial Intelligence（Phase 8，多层而非万能 AI）

| Level | 能力 | 现状→目标 |
|---|---|---|
| L1 | Deterministic Rules | Implemented → 维持 |
| L2 | Statistical / ML Models | Partial → 模型结果统一携带 model_id/model_version/input_version/confidence/OOD/data quality/evidence |
| L3 | Optimization | Implemented（heuristic canonical；CP-SAT 实验）→ CP-SAT 实证后议激活 |
| L4 | Industrial Reasoning | Partial → 独立结构化推理层（不靠 LLM 编造原因） |
| L5 | Agentic Workflow | Missing → Phase 9 |
| L6 | Simulation / Digital Twin | Partial → Phase 10 |
| L7 | Learning Loop | Partial → Phase 12 |

每层必须明确 Input/Output/Confidence/Fallback/Audit/权限/风险；Unknown 是合法结果，
禁止低置信度伪装确定答案。

## 9. Multi-Agent Factory（Phase 9）

Agent 清单（建议）：Factory Supervisor / Logistics / Production / Maintenance /
Quality / Safety / Scheduling / Material / Energy / Worker Support / Exoskeleton /
Incident / Knowledge / Simulation / Operations。

每个 Agent：Purpose / Allowed Tools / Read Scope / Write Scope / Approval Requirement /
Risk Level / Input Contract / Output Contract / Audit Trail / Budget / Timeout / Fallback。
Agent 之间用结构化任务与事件协作；对现实世界产生影响的动作必须转为结构化 Command；
禁止 Agent 绕过 Domain Service 直接修改生产 DB。

## 10. Knowledge System（Phase 12 前置资产）

异常/诊断/人工判断/决策/调度/维修/质量处置/恢复/失败 → Evidence，逐步形成
Industrial Knowledge Graph / Incident Library / Resolution Library / Decision History /
Failure Pattern Library / Process Knowledge。知识分级：Global / Industry / Customer /
Factory / Private Operational Data；跨工厂知识不得直接泄露客户数据。

## 11. Digital Twin & Simulation（Phase 10）

承担 State Reconstruction / Replay / What-if / Scheduling Simulation / Capacity /
Layout / Material Flow / Risk / Maintenance Scenario / Production Scenario /
Agent Sandbox。与生产 World State 同 Contract、schema 级隔离、模拟数据显式标记。

## 12. 数据架构（跨 Phase）

按用途分类（不做技术统一强迫）：Operational DB / Event Store / Time-series /
Object Storage / Search Index / Knowledge Graph / Analytics Warehouse /
Feature Store / Model Registry / Audit Store。统一 Identity 与 Contract；
数据资产声明 Owner/Retention/Residency/Classification/Purpose/Lineage/
Access Policy/Deletion Policy。

## 13. 多租户多工厂（Phase 11）

Tenant → Organization → Factory → Area → Line → Station；RLS 或等价机制为数据库级
强制（已有，维持）；Cross-Tenant TCK 为常驻门禁。跨工厂共享模型显式声明训练来源/
匿名化/授权/版本/客户隔离。Factory Data belongs to Customer。

## 14. 前端 = Factory Operating Console（跨 Phase）

视角：Command Center / Factory World / Logistics / Production / Workers / Exoskeleton /
Machines / Material / Tasks / Scheduling / Incidents / Andon / Quality / Maintenance /
AI Decisions / Simulation / Knowledge / Operations。高价值页面必须支持 Action，
回答：现在发生什么？为什么？影响什么？应该做什么？谁来执行？是否批准？
执行到哪里？结果如何？

## 15. 可解释性 / 可观测性 / 可靠性 / 时间语义（横切目标）

- Explanation 必须来自真实 Constraint/Score/World State/Policy（已有 DecisionTrace 基础）。
- Correlation ID 贯通 UI→API→Domain Command→Event→Scheduler→Agent→DB→Edge→Device。
- 明确 Idempotency/Retry/Timeout/Dead Letter/Ordering/Dedup/Offline Queue/
  Reconciliation/Conflict Resolution/Backfill。
- 区分 Occurred/Observed/Device/Edge Receive/Cloud Receive/Process Time；
  处理 Clock Drift 与 Late Event。

## 16. 治理与测试（横切目标）

- ADR 决策日志、版本化 Contract、Breaking Change 迁移、兼容策略；
- 目录体系：Architecture/Capability/Domain/Dependency/Data Flow/Event/API/Connector/
  Schema/Model/Agent/Decision Catalog（本文件体系即其骨架）。
- 测试体系：Unit/Integration/Contract/Schema/Migration/Replay/Scenario/Simulation/
  E2E/Security/Performance/Chaos/Offline/Recovery/Cross-Tenant/Connector TCK/
  Scheduler TCK/Agent TCK/Policy TCK/Deployment TCK/DR；Golden Scenarios 常驻重跑。

## 17. 成熟判据（总提示词 §37）

系统能实时回答：工厂正在发生什么 / 人员·设备·物料在哪里 / 任务进行到哪里 /
谁能执行什么 / 谁负荷过高 / 哪台设备有风险 / 哪个订单可能延期 / 哪里即将拥堵 /
哪些物料即将短缺 / 当前最优资源组合与理由 / 设备故障·人员缺席·紧急插单会怎样 /
下一步最值得的动作与风险 / 是否需人工审批 / 执行是否达到预期 / 长期是否改善
安全·质量·效率·交付 —— 即 Sense → Understand → Decide → Coordinate → Execute →
Observe → Learn 完整闭环。
