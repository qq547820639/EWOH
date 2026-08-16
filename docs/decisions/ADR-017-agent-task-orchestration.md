# ADR-017 — AgentTask 编排契约（intelligence-l5-agentic 立项，Phase 9）

- 状态：Accepted
- 日期：2026-08-16
- 决策者：long-cycle-agent
- 关联：ADR-016（Agent Runtime/Manifest）、ADR-009（Envelope）、§10 Level 5
  Agentic Workflow、§11（Agent 之间通过结构化任务和事件协作，不依赖自由文本聊天）

## 背景

Agent Runtime（ADR-016/NO-06b）、审批桥接（NO-06c）、领域命令执行器
（NO-06d）已落地：单 Agent 的注册、执行、审批、审计、回退语义完备。
§10 Level 5（Agentic Workflow）与 §11 的多 Agent 协作仍缺一个**结构化任务
编排面**——多个 Agent 之间如何以机器可判定的任务/消息协议协作（而不是自由
文本聊天）。本 ADR 立项 AgentTask 契约（契约层先行），编排引擎随后分轮落地。

## 决策

### 1. AgentTask 是 Command 之上的一层编排，不改变执行边界

- AgentTask = 一次结构化任务（analysis/suggestion/execution 三 kind），
  目标为一个 Agent（assigneeAgentId）或按角色分发（assignedRole）；
- 任务的**执行仍走 AgentRuntime.executeCommand**（审批门控/预算/超时/
  fallback 语义不变）；编排引擎只做创建/依赖/分发/状态推进，
  **绝不绕过** ADR-016 的执行边界与 §2 安全边界；
- Agent 间协作消息 = Catalog 信封事件（AgentTaskCreated/AgentTaskCompleted
  + 既有 AgentTaskProposed/AgentDecisionRecorded），复用 ADR-009 信封。

### 2. AgentTask 契约字段（contracts/agent-task/agent-task.schema.json）

| 字段 | 语义 |
|---|---|
| taskId | 规范身份 `task:<value>`（ADR-006） |
| name / version | 展示名 + 版本（≥1） |
| kind | analysis / suggestion / execution（封闭注册表） |
| assignedRole | ∈ agentRoleRegistry（与 agent-manifest 同源，门禁交叉核对） |
| assigneeAgentId | 可选规范身份 agent:...（缺省按角色分发） |
| dependencies | 规范身份数组（依赖任务；禁止自引用，机器规则） |
| inputContract / outputContract | { schemaRef } |
| priority | low/medium/high/critical（封闭） |
| dueTime | 可选 ISO（不得早于 createdAt 所在时刻的解析失败拒绝——时间语义与 ADR-009 同源） |
| budget | { maxSteps/maxTokens/maxDurationSec ≥ 1 } |
| status | created→dispatched→in_progress→completed/failed；cancelled 仅从非终态（状态机 contracts/state-machines/agent-task.yaml） |
| correlationId | 可选（§19 关联追踪） |
| auditTrail | 必须 true（与 ADR-016 同规则） |

### 3. 编排引擎（后续运行时，本 ADR 锁定边界）

- 任务图：dependencies 形成 DAG（环检测机器可判定）；依赖未 completed 不得
  dispatch（fail-closed）；
- 并发预算：按租户/角色聚合 budget（防止多 Agent 风暴）；
- 状态推进：编排引擎是 AgentTask 状态的唯一写者，转移经状态机契约；
- 事件：AgentTaskCreated（创建）/ AgentTaskCompleted（终态，含 outcome）；
  目录 +2 类型（51→53）。

### 4. 交付纪律

Python（contracts/agent_task.py）+ TypeScript（shared/agent-task.ts）双实现 +
共享向量 + audit-domain-contracts 新增 agent_task 域独立仲裁（含
agentRoleRegistry 与 agent-manifest 交叉核对）+ Golden 第 13 场景
agent_task_contract（双执行器）+ 状态机 yaml。

## 后果

- 正面：多 Agent 协作协议版本化、机器可判定、可审计；执行边界不变
  （编排≠绕过）；intelligence-l5-agentic 从 Missing 进入 Partial（契约层）。
- 代价：task 注册表为 v1 初始（kind 3 类/priority 4 级），演进走契约版本。
- 无迁移（契约层先行；编排引擎持久化随实现轮 lockstep）。

## Rejected Alternatives（否决方案）

1. **自由文本 Agent 间协议**：§11 明令禁止（不依赖自由文本聊天）。
2. **编排引擎直连 DB/绕过 executeCommand**：违反 ADR-016 执行边界。
3. **隐式任务状态**：状态机 yaml + 契约 status 封闭注册表双锁。
