# 指挥地图 → 智能调度升级方案

> 评估日期：2026-08-08 | 版本基线：0.6.0-rc4
> 评估范围：CommandMap 前端（client/src/pages/CommandMap）、Scheduler V2 后端（server/modules/scheduler）、world/spatial/resource 模块、历史原型（ui/command_map）、边缘调度（src/edge_platform/scheduler）

---

## 一、现状梳理

### 1.1 指挥地图核心文件地图

**前端（client/src/pages/CommandMap，8 个页面 + 9 个面板，约 8,150 行）**

| 文件 | 职责 | 规模 |
|------|------|------|
| `CommandMap.tsx` | 页面骨架：模式联动、轮询调度、planOverlay 数据装配 | 902 行 |
| `FactoryMap.tsx` | 手写 SVG 地图：分层渲染、缩放、选中、调度覆盖层 | 1,328 行 |
| `panels/SchedulePanel.tsx` | 方案列表/KPI/审批/下发/调整指派 | 969 行 |
| `panels/ResourcePoolPanel.tsx` | 资源池（person/device/station） | 610 行 |
| `panels/TaskOrchestrationPanel.tsx` | 任务编排（含硬编码默认产品） | 670 行 |
| `panels/IntelligenceLayers.tsx` | 智能图层（冲突层/预测位置/执行偏差） | 484 行 |
| `hooks/useSchedulerStream.ts` | SSE 订阅（sequence 去重/缺口 resync/轮询兜底） | 288 行 |
| `hooks/usePlanOverrides.ts` / `useSchedulerConflicts.ts` | 覆盖/冲突 hook（**无 UI 消费，孤儿代码**） | 32/38 行 |

**后端（server/modules/，Scheduler V2 为核心）**

| 模块 | 关键文件 | 职责 |
|------|----------|------|
| `scheduler/` | `scheduler.service.ts`（2,019 行）、`world-state.service.ts`、`solver.service.ts`、`heuristic-scheduling-solver.ts`（849 行）、`cp-sat-scheduling-solver.ts`、`priority-engine.ts`、`constraints.ts`、`trigger.service.ts`、`eligibility.service.ts`、`routing.service.ts`、`resource-projection.service.ts`、`scheduler-stream.service.ts`、`outbox.service.ts`、`scheduling-policy.service.ts`、`scheduling-feedback.service.ts`、`impact-analyzer.ts`、`dispatch-coordinator.service.ts` | 调度闭环全流程 |
| `world/` | `world.service.ts` | 世界状态聚合 + 回放 |
| `spatial/` | `spatial.service.ts` | 空间实体/拓扑/路由（RouteGraph 有真实路径距离） |
| `resource/` | `resource.service.ts` | 资源注册/状态 |
| `task/` | task 模块 | 任务 CRUD + 状态机 |

**契约与历史**

- `contracts/state-machines/task.yaml`：draft → pending_confirm → … → dispatched → executing → completed/cancelled（11 状态 14 转换，`any_non_terminal→cancelled` 兜底）
- `contracts/state-machines/plan.yaml`：shadow → simulating → pending_review → approved → dispatched / expired / archived
- `ui/command_map/`：历史静态原型（UX 参考），含 Plan Diff / Explain Panel / Manual Override / STALE 降级等概念
- `src/edge_platform/scheduler/`：Python 边缘调度（**与云侧 V2 双轨并存，云侧权威**，边缘为离线降级 + CP-SAT worker）

### 1.2 当前调度闭环（已实现，工程质量高）

```
任务创建 → TriggerService.evaluate（30s 冷却去抖 + 幂等）
  → WorldStateSnapshotService.buildSnapshot（并行查 9 表，WS-YYYYMMDD-NNNN 版本化）
  → SolverService.solveVariants（A/B/C 三变体）
      → CP-SAT（HTTP 127.0.0.1:8000，8s 超时；不可用回退 heuristic，solverStatus=FALLBACK/UNAVAILABLE 不冒充）
  → PlanService.persistPlan（plan + assignment + decisionTrace）
  → 人工审批（assertFreshForApprove → PLAN_STALE 守卫，version+snapshotVersion 双校验）
  → DispatchCoordinatorService.dispatch（CAS approved→dispatched + ResourceReservationService.reserve 排他预约）
  → TaskService.transitionTaskState + AssignmentEvent + OutboxService.enqueue
  → SchedulerStreamService（2s 轮询 outbox → SSE /api/scheduler/v2/stream，sequence 去重 + 缺口 resync + 轮询兜底）
```

### 1.3 关键数据模型（现状）

| 实体 | 关键字段 | 智能化缺口 |
|------|----------|-----------|
| Task | id/taskType/priority/status/assigneeId/deviceId/stationId/zoneId/planStart/planEnd/predecessorIds/requiredSkills/Certifications/requiredDeviceCapabilities/**productionImpact(缺省0)**/safetyCritical/preemptible/skillMatchMode | productionImpact 恒为 0（world-state.service.ts 不填充），safetyCritical/preemptible 硬编码 false |
| Person | id/status/skills/certifications/loadLevel/fatigueLevel/x/y/stationId/availableFromMs/dataQuality | 无技能-任务显式匹配评分 |
| Device | id/batteryPct/online/status/capabilities/x/y/locationStationId/dataQuality | batteryPct 参与约束但无能耗建模 |
| Station | id/name/x/y/capacity(spatial extra) | capacity 来源不统一 |
| RouteGraph | ewohRouteNode（x/y/floor/zoneId）、ewohRouteEdge（**distanceMeters/expectedTimeSeconds**/riskLevel/status/capacity） | 有真实路径距离，但前端用 `Math.hypot/1000` 欧氏估算（CommandMap.tsx:334） |
| SchedulingPlanV2 | assignments/metrics/baselineDelta/violations/decisionTrace | baselineDelta 为 `Record<string,unknown>` 弱类型 |
| ResourceState | person/device/station 权威投影（SSOT，含 freshness） | 已就绪，前端轮询消费 |

### 1.4 制约智能化的关键瓶颈（按影响排序）

| # | 瓶颈 | 证据 | 影响 |
|---|------|------|------|
| B1 | **优先级空转：生产影响未建模** | `world-state.service.ts:214-238` 任务映射不填充 productionImpact；safetyCritical/preemptible 硬编码 false | PriorityEngine 的 productionImpact/downstream_blocking 因子永远为 0，优先级退化为纯 rank+deadline |
| B2 | **权重双轨 + 硬编码** | legacy `ScheduleWeights`（scheduler.service.ts:100）；`buildPolicy`（scheduling-policy.service.ts:270-285）仅 deadlineRisk/euc 可配，workload=1/stationWait=1/changeCost=0.5/energy=minBatteryPct/30 硬编码 | 调参只能改代码，无法按工厂/班次/场景差异化 |
| B3 | **触发断线：13 类事件只有 MANUAL 走真实链路** | `trigger.service.ts:18` 定义 13 种 trigger；`ReplanCoordinatorService.handleTrigger`（impact-analyzer.ts:139）已实现但**未注入业务调用**（仅测试） | 设备离线/路线阻塞/新任务到达不会自动触发重排，调度是"按下才转" |
| B4 | **无位置匹配：candidateStationIds 不填充** | world-state.service.ts 快照不填 candidateStationIds；任务 zoneId 缺失时资格匹配受限 | 资源-位置就近分配无法智能完成 |
| B5 | **反馈闭环半残：actuals 无调用方** | `scheduling-feedback.service.ts:194 recordActuals` 零调用；执行偏差不回填 | planned-vs-actual KPI 无学习输入，无法自优化 |
| B6 | **冲突可视化缺失（前端）** | `/scheduler/conflicts` API + `useSchedulerConflicts` hook 就绪但**无 UI 消费**；冲突只能经 IntelligenceLayers 的 violations 本地聚合间接展示 | 调度冲突对值班员不可见/不可操作 |
| B7 | **人工覆盖未接入 UI** | `usePlanOverrides` 孤儿代码；SchedulePanel 的"调整指派"仅以 LOCKED_PERSON 约束 replan 间接表达，无 Lock/Exclude/Boost/Adjust 完整覆盖面板 | 人工干预能力被浪费 |
| B8 | **实时性依赖 2s 轮询** | CommandMap.tsx:152-212 worldState 2s/overview 5s/entities 30s 多档轮询；SSE 仅覆盖方案 | 地图实体位置非实时，执行偏差（actualStart）常空（IntelligenceLayers.tsx:227-241） |
| B9 | **欧氏距离冒充路由** | CommandMap.tsx:333-334 `Math.hypot/1000` | 图上显示的距离/时间与实际 RouteGraph 不符 |
| B10 | **硬编码演示数据** | SchedulePanel.tsx:120 `buildDemoPlan`、TaskOrchestrationPanel.tsx:101-102 默认产品 P-A001/数量 100 | 无数据时展示假方案，易误导 |
| B11 | **超大组件 + 弱类型** | CommandMap 902 / FactoryMap 1328 / SchedulePanel 969 行；baselineDelta 弱类型；`as unknown as` 双重强转（IntelligenceLayers.tsx:229/457） | 迭代成本高、易引入回归 |
| B12 | **metrics 未埋点** | `SchedulerMetricsService.recordRun/recordFallback` 零业务调用；CP-SAT 双重计算（先跑启发式再叠加，cp-sat:394） | 无调度质量观测，无法度量改进效果 |

---

## 二、改造方案：指挥地图 → 智能调度

### 2.1 智能调度能力框架（六维能力模型）

```
┌──────────────────────────── 智能调度能力层 ────────────────────────────┐
│                                                                        │
│  C1 任务智能建模     C2 资源智能匹配     C3 实时状态同步                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │
│  │ 优先级计算    │   │ 位置匹配      │   │ 世界快照      │                │
│  │ 生产影响建模  │   │ 技能-任务匹配 │   │ freshness     │                │
│  │ 依赖约束      │   │ 负荷/能耗     │   │ SSE 实时      │                │
│  └──────────────┘   └──────────────┘   └──────────────┘                │
│                                                                        │
│  C4 异常与冲突处理  C5 调度可视化       C6 人工干预闭环                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │
│  │ 事件触发重排  │   │ 冲突图层      │   │ Override 面板 │                │
│  │ 自动熔断      │   │ Plan Diff    │   │ 审批/驳回     │                │
│  │ 异常回退      │   │ 执行偏差      │   │ 覆盖→约束→重排 │                │
│  └──────────────┘   └──────────────┘   └──────────────┘                │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块划分与接口设计（新增/改造）

#### 后端（NestJS）

**A. 任务智能建模（C1）——改造 `world-state.service.ts` + `priority-engine.ts`**

- `world-state.service.ts`：任务映射补充 productionImpact（从 `ewohProductionTask.productionImpact` 读取，缺省 0 但不再硬编码）、safetyCritical/preemptible 从任务字段透传、candidateStationIds 从 `spatialEntityId` 解析填充
- `priority-engine.ts`：保留现有公式（score 越小越紧急），新增 `ProductionImpactAdapter` 接口——`production_impact` 因子由策略配置开关控制权重
- 新增 `scheduling-policy.service.ts` 扩展：`buildPolicy` 从"硬编码 5 项"改为"全量可配权重 + 策略版本化 + shadow 对比"（已有 comparePolicyVersion 基础设施，补齐权重项）

**B. 资源智能匹配（C2）——改造 `eligibility.service.ts` + `routing.service.ts`**

- `eligibility.service.ts`：candidateStationIds 填充后启用"位置就近 + 技能匹配（skillMatchMode ALL/ANY）"双维资格过滤
- `routing.service.ts`：RouteGraph 真实路径距离已就绪，新增 `estimateTravel(zoneId→stationId)` 封装，供 eligibility 与前端共用
- 新增 `candidate-scoring.service.ts`：候选资源按 距离/技能/负荷/电池 综合打分（供 `/tasks/{id}/candidates` 返回排序结果）

**C. 实时状态同步（C3）——改造 `scheduler-stream.service.ts` + `world.service.ts`**

- `scheduler-stream.service.ts`：SSE 事件类型从"仅方案"扩展为 `plan_updated | conflict_detected | resource_state_changed | execution_deviation` 四类
- 新增 `WorldSnapshotSubscriber`：世界状态变更（entity 上线/离线/位置更新）经 outbox 进 SSE 通道，前端不再 2s 轮询
- `world.service.ts`：`GET /api/scheduler/snapshot` 增加 `version/freshness/entityVersions` 透出，前端据此做增量更新

**D. 异常与冲突处理（C4）——接通 `ReplanCoordinatorService` + 冲突服务**

- `replan-coordinator.service.ts`（已有实现，补接线）：13 类 trigger 的 `ROUTE_BLOCKED/CONGESTED/RESERVATION_CONFLICT/DEVICE_OFFLINE/TASK_CREATED` 接入 ingest 事件流与任务写路径；`handleTrigger` 补 try/catch + 熔断（同一 trigger 3 次失败自动降级 MANUAL）
- `SAFETY_EVENT`：新增自动熔断策略（safetyCritical 任务触发后自动阻止同区域派工，需人工解除）
- `buildConflicts`（已有，scheduler.service.ts:1587）：补充 `reservation_expiring`（预约即将过期）冲突类型，并接入 SSE conflict_detected 推送

**E. 调度反馈闭环（复用现有能力）**

- `scheduling-feedback.service.ts recordActuals`：接入派工执行事件（assignment started/completed/cancelled），回填 actualStart/actualEnd → 计算 planned-vs-actual 偏差 → 写入 feedback KPI
- `SchedulerMetricsService.recordRun/recordFallback`：在 createRun/persistPlan/fallback 处埋点，暴露调度成功率/回退率/求解耗时到 Prometheus

#### 前端（React）

**F. 统一调度状态层**

- 新增 `client/src/lib/scheduler-store.ts`：zustand store 收敛 activePlan/selectedTaskId/conflicts/overrides/streamStatus（消除 CommandMap.tsx:133 与 SchedulePanel.tsx:245 的双源维护）
- 新增 `client/src/hooks/useSchedulerEvents.ts`：统一消费 SSE 四类事件，按 `sequence` 去重写入 store

**G. 冲突中心与覆盖面板（C5/C6）**

- 新增 `panels/ConflictCenterPanel.tsx`：消费 `/scheduler/conflicts` + useSchedulerConflicts，冲突列表（12+ 类）→ 点击定位地图实体 + 一键"创建重排"
- 新增 `panels/OverridePanel.tsx`：消费 usePlanOverrides，提供 LOCK_PERSON/LOCK_DEVICE/LOCK_TIME/EXCLUDE_RESOURCE/PREFER_RESOURCE/BOOST 六个动作 → 调用 `/plans/{id}/overrides` → before/after diff 展示
- 改造 `SchedulePanel.tsx`：移除 `buildDemoPlan` 硬编码（改为空态组件），Plan Diff 复用原型 scheduling-enhance.js 的对比概念

**H. 地图实时化与路由修正（C3/C5）**

- `FactoryMap.tsx`：entity 位置改消费 SSE 增量（fallback 轮询）；删除 `Math.hypot/1000` 欧氏估算，改用 `routeGraph` 边权计算
- 新增执行偏差图层：assignment actualStart 与 planStart 偏差 > 阈值时橙色标记（已有 IntelligenceLayers 骨架，补数据源）
- 组件拆分：`CommandMap.tsx`（902 行）拆为 `CommandMapLayout` + `modeMachine`（useReducer 状态机）；`FactoryMap.tsx`（1328 行）拆 `Layers/`（StaticLayer/EntityLayer/ScheduleOverlayLayer）

#### 跨端契约

- `openapi/ewoh.yaml`：新增路径 `GET /api/scheduler/conflicts/stream`（SSE）、`POST /api/scheduler/plans/{id}/overrides/batch`（批量覆盖）；更新 `shared/scheduler.ts` 类型（baselineDelta 强类型、SSE 事件联合类型）
- `contracts/state-machines/plan.yaml`：补充 `replan_pending` 状态（自动重排进行中，避免人工审批与自动重排竞态）

### 2.3 关键接口设计（新增）

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/scheduler/conflicts/stream` | SSE | 冲突增量推送（Bearer 认证，sequence 去重） |
| `POST /api/scheduler/plans/{id}/overrides/batch` | POST | 批量覆盖（Lock/Exclude/Boost/Preferred/Adjust），事务化，返回 before/after diff |
| `POST /api/scheduler/plans/{id}/auto-replan` | POST | 手动触发局部重排（供异常场景值班员使用） |
| `GET /api/scheduler/tasks/{id}/candidates?sort=score` | GET | 候选资源按综合评分排序（距离/技能/负荷/电池） |
| `POST /api/scheduler/feedback/actuals` | POST | 回填执行实际值（actualStart/actualEnd），幂等（actualId） |
| `GET /api/scheduler/metrics/quality` | GET | 调度质量指标（成功率/回退率/偏差分布） |
| `POST /api/scheduler/events` | POST | 事件触发点（device_offline/route_blocked/task_created），供 ingest 与任务写入调用 |

---

## 三、分阶段实施计划

### Phase A：数据与模型打底（无 UI 变更，后端内部）

| 步骤 | 内容 | 影响范围 | 验证方式 |
|------|------|----------|----------|
| A1 | world-state 填充 productionImpact/safetyCritical/preemptible/candidateStationIds | scheduler/world-state.service.ts | 单元测试：构造带 productionImpact 的任务 → 断言快照字段 |
| A2 | 权重体系收敛为全可配（buildPolicy 扩展） | scheduling-policy.service.ts、constraints.ts | 契约测试：策略版本化 + shadow 对比 |
| A3 | feedback recordActuals 接线 + metrics 埋点 | scheduling-feedback.service.ts、scheduler.service.ts | 集成测试：派工后 actuals 回填 → KPI 更新；Prometheus 出数 |
| A4 | conflicts 增加 reservation_expiring + 触发链补 try/catch 熔断 | scheduler.service.ts、replan-coordinator | 单元测试：异常触发 3 次 → 降级 MANUAL |

**门禁**：`npm test -- --runInBand` + `node scripts/audit-openapi-routes.js`（新增字段不破坏契约）

### Phase B：事件驱动智能重排（核心智能化）

| 步骤 | 内容 | 影响范围 | 验证方式 |
|------|------|----------|----------|
| B1 | ReplanCoordinator 接入 ingest 事件流与任务写路径 | scheduler/replan-coordinator、trigger.service | 集成测试：模拟 device_offline 事件 → 自动触发重排 → 新方案 superseded 旧方案 |
| B2 | 新增 /api/scheduler/events 事件注入点 + SAFETY_EVENT 自动熔断 | scheduler.controller | API 测试 + 安全评审 |
| B3 | SSE 事件类型扩展（plan/conflict/resource/deviation 四类） | scheduler-stream、outbox | 端到端：SSE 客户端收到四类事件 |

**门禁**：`make test-contract`（状态机一致）+ 冲突场景验收脚本

### Phase C：前端智能调度交互（用户可见价值）

| 步骤 | 内容 | 影响范围 | 验证方式 |
|------|------|----------|----------|
| C1 | 引入 scheduler-store + useSchedulerEvents，收敛双源 | CommandMap/SchedulePanel/useSchedulerStream | 前端测试：store 单测 + 组件渲染 |
| C2 | ConflictCenterPanel + OverridePanel 落地（接现有 hook） | 新增 2 面板 | 组件测试：模拟 conflicts/overrides 数据渲染 |
| C3 | 地图实时化：SSE 增量位置 + RouteGraph 距离替代欧氏 | FactoryMap/CommandMap | Playwright 视觉测试（现有 playwright.visual.config.ts） |
| C4 | SchedulePanel 去 demo 数据 + Plan Diff 交互强化 | SchedulePanel | 组件测试：空态渲染 + diff 交互 |

**门禁**：`npm run test:client` + `npm run build:prod:standalone` + bundle-budget（首屏 < 460kB gzip）

### Phase D：反馈闭环与度量（持续优化）

| 步骤 | 内容 | 影响范围 | 验证方式 |
|------|------|----------|----------|
| D1 | 执行偏差回填 → 权重自调整（learning loop 雏形） | scheduling-feedback、policy | 影子评估：新旧权重方案对比报告 |
| D2 | CP-SAT 启用（部署 OR-Tools worker）或明确移除双重计算 | cpsat worker、solver.service | solver 一致性测试（OPTIMAL vs HEURISTIC 对齐） |
| D3 | 调度质量看板（成功率/回退率/偏差分布） | dashboard/observer | 验收：指标可查询可导出 |

---

## 四、风险与依赖

| 风险 | 缓解 |
|------|------|
| 双轨调度（Python 边缘 vs 云侧 V2）语义漂移 | 以云侧 V2 为 canonical，Python 仅保留离线降级；共享 contracts/state-machines |
| 自动重排与人工审批竞态（重排覆盖人工方案） | plan.yaml 增加 replan_pending 状态 + 审批 PLAN_STALE 守卫已存在 |
| 权重放开后调度结果不可复现 | 每次方案记录 policyVersion + solverVersion + snapshotVersion（已有 decisionTrace 机制） |
| SSE 事件风暴 | sequence 去重 + 缺口 resync + 前端节流（已有基础设施） |
| 前端 3 个超 900 行组件重构回归 | 先拆 store/数据层（无 UI 变更），再拆组件；Playwright 视觉回归守护 |

---

## 五、预期收益

| 维度 | 现状 | 升级后 |
|------|------|--------|
| 调度触发 | 仅 MANUAL（手动按下才转） | 13 类事件自动触发 + 熔断 |
| 优先级 | productionImpact 恒 0，权重硬编码 | 生产影响建模 + 全可配策略版本化 |
| 资源匹配 | 无位置匹配，候选不排序 | 距离/技能/负荷/电池综合评分 |
| 冲突处理 | 后端可查，前端不可见 | 冲突中心 + 点击定位 + 一键重排 |
| 人工干预 | 仅 LOCKED_PERSON 间接表达 | 六类覆盖动作 + before/after diff |
| 实时性 | 2s 轮询 | SSE 四类事件 + 增量位置 |
| 反馈闭环 | recordActuals 零调用 | 执行偏差回填 + 调度质量看板 |
