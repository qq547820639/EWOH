# ADR-028：Edge→Cloud 指标上行 —— connector 面观测腿补全

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-023（统一指标注册表）、§19（Observability）、§3、§33

## 背景

ADR-023（NO-10b）建立了统一指标注册表与云侧导出面，但 connector 面
明确"云端零样本显式"：边缘事实源（Prometheus /metrics 的 ewoh_* 家族）
从未进入云端——观测腿在 Edge→Cloud 方向断裂，§19"从设备追踪到边缘"的
指标面缺上行通道。本 ADR 补全该通道。

## 决策

### 决策 1：边缘 ewoh_* 家族入规范注册表（命名收敛，不重命名）

边缘 Prometheus exporter 的 18 个 ewoh_* 家族（系统/设备/推理/业务四级）
加入 contracts/observability/metrics-registry.schema.json metricRegistry
（15→33 家族）；labelKeyRegistry += `table`（ewoh_db_count）、`edge_id`
（上行传输标签）；connector_active_total labelKeys += connector_id
（per-edge active gauge）。边缘本地命名与云端规范命名同一词表——
**单一事实源，不重命名边缘导出名**（重命名会破坏本地 Prometheus 消费方）。

### 决策 2：上行 = 周期快照 latest-wins，不建磁盘队列

与事件上行（事实不可丢，断点续传）不同，指标是**周期快照**：丢失一个
周期只损失观测值，下一周期自然覆盖。因此 MetricsUplink 不建持久化队列
（内存批量 + 指数退避 + 失败显式 logging/stats），与 EventUplink 的
持久化语义显式区分（ADR 明示差异边界，§31）。

### 决策 3：接收面契约 fail-closed + per-org 隔离

- 云侧 EdgeMetricsService：逐条 validateMetricSample 契约校验——未注册
  名/类型失配/未知标签/负 counter = violation 显式列出（§33 unknown 不当
  normal），有效样本正常并入；
- per-org 快照注册表（他租户样本绝不可见，§15）+ TTL 5 分钟过期 +
  每 org 样本上限（周期快照语义，过期即不可信）；
- 鉴权复用 IngestGuard 机器通道（X-Ingest-Key + X-Org-Id，与事件上行同
  通道同语义），@Public + guard。

### 决策 4：上行健康经 connector_* 家族计数，无新事件类型

上行健康（每 edge：samples_total/error_total/active）以既有 connector_*
家族样本暴露（connector_id=edge_id、connector_type=metrics_uplink），
汇入统一导出面；**不新增目录事件**——指标批次是观测旁路而非工业事实，
逐批事件=噪音（§5 事件表达真实工业事实）。

### 决策 5：导出面 org 作用域

GET /api/observability/metrics 增加 orgId 作用域（global_admin 无 org =
全节点视图；safety_admin 有 org 上下文 = 仅本租户边缘样本）。

## 后果

- 正：§19 观测腿 Edge→Cloud 打通——边缘设备/推理/业务指标以规范命名
  进入云侧统一导出面（JSON + Prometheus），connector 面零样本显式
  消除；命名单一事实源。
- 负/边界：快照丢失语义（不保证每周期必达）；TTL 过期样本消失；
  指标不落库（进程内注册表）——云重启即清空，随下一周期重建
  （与 metrics 快照语义一致，不新增持久化事实源）。
