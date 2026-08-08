# ADR-005：Scheduler / Ingest Application Decomposition

- 状态：**PARTIALLY IMPLEMENTED**（Ingest 已完成第一阶段；Scheduler V1 保留，标记待淘汰）
- 日期：2026-08-08

## 决策

### IngestService（已实施）

将**非外骨骼传感器类 ingest** 从 `IngestService`（约 800 行）抽出到
`SensorIngestService`：

| 方法 | 归属（之前 → 之后） |
| ---- | -------------------- |
| ingestEnvironment | IngestService → **SensorIngestService**（委托） |
| ingestCamera | IngestService → **SensorIngestService**（委托） |
| ingestSpatialScan | IngestService → **SensorIngestService**（委托） |
| ingestLocation | IngestService → **SensorIngestService**（委托） |
| ingestExoskeleton / Batch / processOneFrame 私有链 | IngestService（保留，外骨骼核心链） |

理由：
- 四类传感器方法仅依赖 `db`/`logger`，无跨方法状态，拆分零算法改动；
- 外骨骼核心链（processOneFrame 私有链 + 幂等/质量/规则评估）保持单一归属；
- IngestController API 不变（委托透明）。

后续可选：`ingestMes` 已在 ADR-004 转发到 MesService；进一步可抽
`ExoskeletonIngestService`（外骨骼专用链），但当前 IngestService 已降到约 600 行，
非紧迫。

### SchedulerService（评估结论：V1 标记待淘汰，不强行拆）

`SchedulerService`（1975 行，29 个 public 方法）分为 6 个 use-case 域：

| 域 | 方法数 | 判定 |
| -- | ------ | ---- |
| V1-legacy（模板方案/weights/audit） | 9 | **待淘汰**（deprecated，controller 仍引用做兼容） |
| run/snapshot | 5 | 保留（V2 核心） |
| plan-lifecycle | 5 | 保留（V2 核心） |
| policy | 5 | 保留（V2 核心） |
| routing/candidates | 3 | 保留 |
| conflicts | 2 | 保留 |

**不强行拆 V1 的原因**：
1. V1 与 V2 共享 `mapPlan`/`mapAudit` 私有 mapper，抽取需迁移共享代码，回归风险高；
2. V1 端点已全部 deprecated，属"待淘汰"而非"活跃编排"，投入拆分成本不划算；
3. 用户原则"此阶段以移动编排职责为主"——V1 的职责是兼容，不是新编排。

**建议**：在 SchedulerService 稳定后（下一迭代），若需正式拆分，按 ADR-005 方案：
```text
scheduler/
├── domain/          priority/constraints/reservation/plan
├── application/     create-run / solve-run / approve-plan / override-plan /
                     dispatch-plan / replan use-cases
├── infrastructure/  repository/cpsat/routing
└── scheduler.controller.ts
```
并替换 `as unknown as SchedulingConstraint` 为显式 `mapLegacyConstraint()` + schema 校验。

## 影响面

- 新增 `SensorIngestService`（sensor-ingest.service.ts）+ 5 个单测；
- `IngestService` 减少约 200 行，委托透明；
- `IngestModule` 注册新 provider。

## 验证

- tsc server/client PASS；ingest 23 测试 PASS；client jest 640 PASS；
  scheduler 202 PASS；OpenAPI in sync。
