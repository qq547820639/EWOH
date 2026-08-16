# ADR-023：统一工业指标注册表与导出面（§19 Observability 指标腿）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-022（trace 腿）/ §19 Observability / Phase 8 指标面
- 驱动：NO-10b（Round 43，observability 指标腿成体系——Scheduler/Agent/
  Connector 指标统一注册表 + 采集/导出面）

## 背景

§19 要求 Model/Scheduler/Agent/Connector/DataQuality 指标成体系。现状：
- MetricsService（http 请求/active/dbReady）+ SchedulerMetricsService
  （counter/gauge/histogram + Prometheus text）已存在，但**指标名是 ad-hoc
  字符串，无封闭注册表**——跨模块命名无契约，未知指标无法机器判定；
- Agent 指标无埋点；Connector 指标仅边缘侧 Prometheus（/metrics）存在，
  云端无统一面；
- trace 腿已贯通（NO-10a/ADR-022）；本 ADR 完成指标腿。

## 决策

### 决策 1：指标注册表 = 契约（contracts/observability/metrics-registry.schema.json）

meta-contract 同风格，v1.0.0：
- **metricRegistry**（封闭，name/type/labelKeys 对象数组）：
  - http 面：http_requests_total（counter）/ http_active_requests（gauge）；
  - db 面：db_ready_checks_total（counter）；
  - scheduler 面：scheduler_run_total（counter）/ scheduler_run_duration_ms
    （histogram）/ scheduler_feasible_ratio（gauge）；
  - agent 面：agent_manifest_registered_total / agent_command_proposed_total /
    agent_command_executed_total / agent_command_rejected_total /
    agent_command_delegated_total / agent_approval_resolved_total（均 counter）；
  - connector 面：connector_telemetry_samples_total（counter）/
    connector_active_total（gauge）/ connector_error_total（counter）。
- **metricTypeRegistry**：counter/gauge/histogram；
- **labelKeyRegistry**：route/method/status/solver_version/solver_status/
  feasible/le/role/command/outcome/connector_id/connector_type；
- **规则（机器可判定）**：metricName 必须命中注册表（未注册=violation，导出
  面显式列出，绝不静默并入正常）；metricType 必须与注册表一致；labelKey
  必须命中注册表；counter/gauge value 为有限数值（counter 非负）；histogram
  样本必须带 le 标签。
- Python/TS 双实现 + 共享向量 + audit-domain-contracts observability 域 +
  Golden 第 17 场景（同既有契约域纪律，§31）。

### 决策 2：云侧统一导出面 = GET /api/observability/metrics

ObservabilityMetricsService 组装统一快照（真实事实，不伪造）：
- http/db 面 ← MetricsService（既有）；
- scheduler 面 ← SchedulerMetricsService（既有，Prometheus text 兼容）；
- agent 面 ← 新 AgentMetricsService（注册表命名 counter，AgentService 真实
  调用点埋点：注册/提议/执行/拒绝/委托/审批解析）；
- connector 面 ← 云端零样本显式（无上行通道不伪造数值；connector 指标
  事实源=边缘 Prometheus /metrics——两端命名收敛于同一注册表）。
导出 = Prometheus text（兼容既有消费）+ JSON（registry-validated +
**registryViolations 显式列表**：任何未注册名/类型/标签以 violation 面
暴露，绝不静默丢弃——§33 unknown 不当 normal）。
角色：global_admin/safety_admin（与 traces 一致）。

### 决策 3：AgentMetricsService 埋点 = AgentService 真实调用点

注册表命名 counter，在 registerManifest/executeCommand（proposed/executed/
rejected/delegated 分支）/resolveApproval（approved/rejected）真实分支埋点；
labelKey ∈ {role, command, outcome}。指标服务失败绝不阻断主流程（观测
旁路语义，与 trace span 同）。

### 决策 4：Edge→Cloud 指标上行不新建通道（§33 无重复事实源）

Connector/边缘指标的事实源 = 边缘 /metrics（Prometheus 既有）；云侧统一
面注册 connector 家族（零样本显式）。上行通道与事件上行（ADR-019 台账）
分离评估——需要时按 §34 立项，本轮不提前造无消费方的通道。

## 后果

- 正面：指标命名收敛为契约（跨模块机器可判定）；统一导出面（JSON 契约
  校验 + Prometheus 兼容 + violations 显式）；Agent 指标成体系；observability
  按 §36 升 Implemented（矩阵 40/15/0/1）。
- 代价：指标注册表为 v1 封闭集合（新增指标=契约小版本变更，双实现 +
  门禁 lockstep）；AgentService 增加埋点调用。
- 无破坏性变更（新契约 + 新导出面；既有 /api/scheduler/metrics 保持）。

## Rejected Alternatives（否决方案）

1. **指标名继续 ad-hoc 字符串**：无法机器判定 unknown/violation，违反
   §3/§30（跨模块语义各自解释）。
2. **云侧伪造 connector 指标数值**：§33 禁止无来源数据；零样本显式 +
   边缘事实源是诚实面。
3. **立即新建 Edge→Cloud 指标上行通道**：无消费方先造通道违反问题驱动
   原则（§34）；与事件上行复用评估留后续。
4. **violation 静默丢弃**：unknown 不当 normal（§33）；violations 显式
   列表保留可审计面。
