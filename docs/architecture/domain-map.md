# EWOH Domain Map（领域地图）

> 维护规范：本文件是"领域 → 权威实现 → 契约 → 边界"的索引级地图。
> 权威实现以代码为证，契约以 contracts/openapi/db 为证；发现新领域或实现迁移时更新。
> 最后更新：2026-08-14。

## 1. 领域总览

```text
                        ┌─────────────────────────────┐
                        │  Command & Decision 面      │
                        │  scheduling / approval /    │
                        │  policy / workflow / work-  │
                        │  orchestration              │
                        └──────────┬──────────────────┘
                                   │ 命令/方案/审批
┌──────────────────────┐  ┌────────▼─────────┐  ┌──────────────────────┐
│  Physical 感知面      │  │  Factory World   │  │  Intelligence 面      │
│  edge/adapters       │─▶│  （统一认知层）    │◀─│  inference/rules/     │
│  connectors          │  │  world / spatial  │  │  ai/model/assistant   │
│  perception          │  │  / task / alert   │  └──────────────────────┘
└──────────────────────┘  └────────┬─────────┘
                                   │ 投影/事件/审计
                        ┌──────────▼─────────────────┐
                        │  Governance 面              │
                        │  auth/rbac/audit/org/RLS/  │
                        │  governance/scale(复制)    │
                        └────────────────────────────┘
```

## 2. 领域表（authoritative implementation 以代码为准）

| 领域 | 边缘权威实现 | 云侧权威实现 | 契约 | 现状 |
|---|---|---|---|---|
| 身份（Identity） | `contracts/identity.py`（KINDS 锁定注册表） | `shared/identity.ts` + `modules/identity`（注册/解析 API）+ ingest entity_id 落点 | `contracts/identity/*`（ADR-006）+ standalone_032 | Partial（生产接线完成；Golden Scenario/reconcile 待 NO-02d） |
| 采集/连接（Connectivity） | `edge/adapters/*`, `connectors/*` | `modules/ingest` | `catalog/connectors/*`, connector manifests, `contracts/mapping/*` | Implemented（SDK+TCK） |
| 遥测/推理（Perception→Inference） | `edge/bus.py`, `inference/pipeline.py` | `modules/ingest`, `modules/ai`(Ark) | event-catalog `TelemetryObserved` | Partial（真机链路刚修复，未真机验证） |
| 风险/告警（Risk & Alert） | `inference/events.py`（L1-L3）+ `contracts/risk.py` | `modules/alert` + `shared/risk.ts` | `contracts/risk/*`（ADR-007）+ 状态机 `alert.yaml` | Partial（契约落地；alert severity 接线待 NO-02c-b） |
| 人员/设备/工位资源（Resource） | `edge/storage.py` + `contracts/resource.py` | `modules/resource`, scheduler ResourceProjection SSOT + `shared/resource.ts` | `contracts/resource/*`（ADR-007） | Partial（契约落地；status 枚举锁定待 NO-02c-b） |
| 外骨骼（Exoskeleton 域） | `edge/adapters/ny_exo_a1`, `edge/exo_semantic` | 无独立模块（经 ingest/device 承接） | `contracts/mapping/examples/exoskeleton-telemetry.yaml` | Partial（无 Session 域模型） |
| 任务/派工（Task & Assignment） | `scheduler/*`（advisory） | `modules/task`, `modules/scheduler` | 状态机 `task.yaml`/`plan.yaml`/`approval.yaml` | Implemented（云侧）；边缘 execute 状态分叉遗留 |
| 调度决策（Scheduling） | `scheduler/*` + `cpsat/` | `modules/scheduler`（50+ 文件） | 状态机 `plan.yaml`, ADR-001..005 | Implemented（heuristic canonical；CP-SAT 实验） |
| 世界状态/回放（World & Replay） | `world_model/*` + `contracts/world.py` | `modules/world`, `modules/timeline` + `shared/world-contract.ts` | `contracts/world/*`（ADR-008） | Partial（契约落地；snapshot 校验/edge 装配接线待 NO-03b） |
| 空间（Spatial） | `spatial/*`（库级）+ `contracts/location.py` | `modules/spatial` + `shared/location.ts` | `contracts/location/*`（ADR-007） | Partial（契约落地；SpatialEntityType 收敛待 NO-02c-b） |
| 工厂复制/规模（Scale） | — | `modules/scale`, `modules/onboarding` | `contracts/factory/*`, 状态机 `fleet.yaml`, `catalog/factory-sites` | Implemented |
| 流程/工单（Workflow/MES/ERP） | `edge/adapters/mes` | `modules/mes`, `modules/erp`, `modules/workflow`, `modules/work-orchestration` | `contracts/workflow/*`, `catalog/connectors/erp|wms|mrp` | Partial（连接器面完善，执行面待闭环） |
| 治理（Auth/RBAC/Audit/Policy） | `auth/ rbac/ audit/ policy/ governance/` | `modules/auth`, `modules/audit`, `modules/policy`, `modules/organization`, org-context interceptor | `contracts/policy/*`, security 矩阵 | Implemented（RBAC 刚落地；边缘登录流遗留） |
| 治理门禁/事实源（Engineering Governance） | — | — | `feature-status.yaml`, `contracts/repository-facts/*`, `contracts/artifact-schemas/*` | Implemented |
| 智能体（Agent） | `assistant/local_llm.py`（白名单问答） | `modules/agent`（Manifest 注册/执行/审批桥接/编排引擎）+ `modules/ai` | `contracts/agent/*` + `contracts/agent_task/*`（ADR-016/017） | Implemented（契约 + 运行时 + 编排，Phase 9 收口） |
| 维护（Maintenance） | — | `modules/maintenance` + `modules/workorder`（委托建单） | `contracts/maintenance/*`（ADR-010） | Implemented（standalone_034 + 调度封锁投影） |
| 质量（Quality） | — | `modules/quality` + `modules/workorder`（委托建单） | `contracts/quality/*`（ADR-010/011） | Implemented（standalone_034 + 调度封锁投影） |
| 知识（Knowledge） | `contracts/knowledge.py`（契约） | `modules/knowledge`（注册/五层检索阶梯/转移）+ Knowledge Agent | `contracts/knowledge/*`（ADR-018 + Amendment 1） | Implemented（standalone_039 硬化 + RLS，Round 38 收口） |

## 3. 领域边界规则（防重复事实源）

1. 调度写权限：connected production 下唯一归 NestJS；边缘 scheduler 仅 advisory。
2. 数据库 schema 唯一权威源：`db/migrations/standalone_*`；`schema.ts` 反向生成。
3. API 契约唯一权威源：`openapi/ewoh.yaml` + `work-orchestration.yaml`（零漂移门禁）。
4. 事件类型唯一权威源：`contracts/events/event-catalog.yaml`（CloudEvents 1.0）。
5. 状态机唯一权威源：`contracts/state-machines/*.yaml`（Python 加载器 + TS 实现双消费）。
6. 部署参数唯一权威源：`deploy/.env.example`（audit-env-inventory --strict）。
7. 功能实现事实唯一权威源：`feature-status.yaml`（truth-feature-status 强制）。
8. 长期目标/阶段/风险视图：`docs/agent/project-state.yaml`（本治理体系新增）。

## 4. 领域缺口优先级（与 capability-matrix 联动）

P1（下轮起）：Canonical Identity / Risk / Location / Resource Contract。
P2：Exoskeleton Session 域模型、Maintenance + Quality 领域落地。
P3：Knowledge 域、Agent 域。
