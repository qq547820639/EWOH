# ADR-016 — Agent Runtime 目标架构与 Agent Manifest 契约（Phase 9 立项）

- 状态：Accepted
- 日期：2026-08-16
- 决策者：long-cycle-agent
- 关联：总提示词 §11（Agent 架构）、§2（安全边界）、§28 Phase 9（Multi-Agent Factory）、
  ADR-006（Identity）、ADR-009（Envelope）、ADR-013/014（工业智能）

## 背景

Phase 4 事件骨干主体收口后，收敛主线转向 §11/Phase 9：Multi-Agent Factory。
当前仓库的 `ai` 模块仅为 Ark 视觉理解服务、边缘 `assistant.local_llm` 为白名单问答——
不存在 Agent Runtime、Agent Manifest、Agent Policy、Agent Audit 等任何基础。
按照既有交付纪律（ADR → 契约 → 双运行时实现 → 独立仲裁门禁 → Golden Scenario），
本 ADR 先锁定目标架构与跨运行时契约，运行时实现随后分轮落地。

## 决策

### 1. Agent 的定位（不可变边界）

- **Agent 不得成为绕过系统架构的万能入口**：Agent 必须通过正式能力接口
  （Tools）行动；对现实世界产生影响的动作必须转换为结构化 Command
  （propose_plan / reserve_resource / dispatch_task / create_work_order /
  notify_personnel / request_approval …），禁止 Agent 直连数据库或域表。
- **Agent 依赖 World Model 与正式 Tools**：读路径走 World Snapshot/Replay
  （ADR-008/ADR-015 契约）；写路径走 Domain Service（WorkOrder/调度/质量/
  维护等既有模块），绝不绕行。
- **安全边界永久生效（§2）**：Agent 的 Autonomous Level 上限不得覆盖
  safety-critical 闭环（急停/助力/限扭等永久在设备控制器）；高风险动作默认
  Human-in-the-loop。Agent Policy 不得授予任何 safety-critical 执行能力——
  该限制在 Tool 注册表层面 fail-closed（不允许注册此类 Tool）。
- **Agent 之间通过结构化任务和事件协作**：复用 Canonical Event Catalog 的
  信封（ADR-009）；不依赖自由文本聊天作为 Agent 间唯一协议。
- **Autonomous Level 显式阶梯**（不隐式自动执行）：
  - L0 advisory：只读分析/解释，不产生任何写建议；
  - L1 suggest：产生结构化建议，必须人工确认后执行；
  - L2 supervised：受限范围内自动执行，高风险动作仍需审批（approvalRequiredFor
    显式列出）；
  - L3 autonomous：受限自治（仅限低风险、可逆、可审计动作），
    **永不允许 L4**（全自治）进入注册表——L4 与 §2 冲突。

### 2. Agent Manifest 契约（contracts/agent/agent-manifest.schema.json）

每个 Agent 必须显式声明（§11 字段集）：

| 字段 | 语义 |
|---|---|
| agentId | 规范身份 `agent:<value>`（ADR-006 kindRegistry 已含 agent） |
| name / version | 展示名 + manifest 版本（≥1，单调治理） |
| role | 15 类封闭注册表（FactorySupervisor/Logistics/Production/Maintenance/Quality/Safety/Scheduling/Material/Energy/WorkerSupport/Exoskeleton/Incident/Knowledge/Simulation/Operations） |
| purpose | 非空目的声明（机器可审计，不依赖 prompt 约束行为——行为由 allowedTools+policy 决定） |
| allowedTools | 规范身份 `tool:<value>` 数组（Tool 注册表另行契约；未注册 Tool 拒绝） |
| readScope | 作用域 token 注册表子集（worldSnapshot/worldReplay/personnelData/equipmentData/materialData/schedulingData/maintenanceData/qualityData/incidentData/energyData/simulationData/knowledgeData） |
| writeScope | 作用域 token 子集 + allowedCommands（命令注册表子集）——写能力显式最小化 |
| approvalRequirement | { autonomousLevel: L0..L3, approvalRequiredFor: 命令数组 }；**L2/L3 必须显式非空 approvalRequiredFor**（高风险默认人审） |
| riskLevel | low/medium/high/critical（决定审计级别与审批强度） |
| inputContract / outputContract | { schemaRef } 契约引用（工具级 Schema 目录） |
| auditTrail | boolean（注册即强制 true；false 拒绝注册） |
| budget | { maxSteps ≥1, maxTokens ≥1, maxDurationSec ≥1 }（资源上限，fail-closed） |
| timeoutSec | ≥1（单步超时） |
| fallback | { onFailure: fail/retry/delegateHuman/safeIdle, fallbackAgentId? }——失败显式语义，无静默吞 |

**注册规则（契约层机器可判定）**：auditTrail 必须 true；L2/L3 必须有非空
approvalRequiredFor；budget/timeout 下界；riskLevel=critical 的 Agent 只允许
L0/L1（人审强度与自治等级挂钩）；Safety 角色只允许 L0/L1 且写范围为空
（supervisory 定位）。

### 3. 运行时边界（后续轮次实现，本 ADR 锁定）

- 云侧 NestJS 新模块 `server/modules/agent/`：Manifest 注册表（DB 持久化 +
  契约校验 fail-closed）、Tool 注册表（正式能力接口）、AgentExecutor
  （budget/timeout/fallback 强制）、AgentAudit（与既有 audit 链同源）、
  审批桥接（复用既有 approval 状态机，不新造审批系统）。
- 边缘侧：不做 Agent 运行时（边缘为感知/推理端点）；Agent 运行于云侧，
  通过既有上行通道消费边缘事实。
- Agent 产生的 Command 必须走既有 Domain Service（Policy→Authorization→
  State Revalidation→Reservation→Dispatch→Audit 六步链，§2）。
- 事件：Agent 决策/任务随运行时接线加入事件目录（AgentTaskProposed/
  AgentDecisionRecorded），本轮契约层不预埋空类型。

### 4. 交付纪律

Python（`src/edge_platform/contracts/agent.py`）+ TypeScript
（`ewoh-spark-app/shared/agent-manifest.ts`）双实现 + 共享向量 +
audit-domain-contracts 新增 agent 域独立仲裁（注册表/向量/双运行时一致）+
Golden Scenario 第 12 场景 `agent_manifest_contract`（双执行器）。

## 后果

- 正面：Agent 行为边界成为机器可判定契约；Manifest 是运行时注册的唯一入口
  （未过契约 = 无法注册）；§11 字段集版本化、可审计、可测试。
- 负面/代价：15 角色/命令/tool 注册表为 v1 初始清单，新增走契约版本演进
  （封闭注册表纪律）；运行时实现分轮落地（本轮先契约层）。
- 无迁移（契约层先行；运行时 DB 表随实现轮 lockstep）。

## Rejected Alternatives（否决方案）

1. **自由文本 Agent 定义（仅 prompt）**：§33 禁止依靠 Prompt 代替 Domain
   Constraint——行为必须由 allowedTools+policy+命令注册表机器约束。
2. **Agent 直连数据库**：违反 §11 与既有 Domain Service 权威写路径。
3. **隐式自治等级**：必须显式 Autonomous Level，且 L4 永不允许（§2）。
4. **新建独立审批系统**：复用既有 approval 状态机与六步链。
