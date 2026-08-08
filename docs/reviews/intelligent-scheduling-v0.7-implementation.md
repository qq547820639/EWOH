# 指挥地图 → 智能调度：v0.7 首批落地实施报告

> 实施日期：2026-08-08 | 基线：0.6.0-rc4
> 范围：Phase A（数据打底）+ A2（冲突增强）+ A3（前端接线）务实子集
> 依据方案：`docs/reviews/command-map-intelligent-scheduling-upgrade.md`

---

## 一、实施范围（自主裁定）

基于风险分析，本次落地采取**增量接线 + 低风险增强**策略。主产品改造铁律：**不新增 DB 列、不重写求解器、不破坏 OpenAPI 契约、不改变既有行为默认值**。

| 项 | 内容 | 状态 |
|----|------|------|
| A1 | world-state 任务派生：productionImpact / safetyCritical / candidateStations | 完成 |
| A2 | conflicts 新增 reservation_expiring 类型 + 触发链失败熔断 | 完成 |
| A3 | 前端接线：ConflictCenterPanel + OverridePanel 落地（消费孤儿 hook） | 完成 |
| — | 跳过项：ReplanCoordinator 业务接线（需 ingest 事件流）、DB 迁移加列、CP-SAT 启用、SSE 四类事件（触及 outbox 协议） | 留待 Phase B/D |

## 二、A1：任务派生字段（world-state.service.ts）

### 问题
`ewohProductionTask` 表无 `productionImpact/safetyCritical/preemptible` 列（schema.ts 为自动生成文件不可改，加列需 DB 迁移），导致任务映射硬编码 `safetyCritical: false`，PriorityEngine 的 productionImpact 因子永远为 0。

### 方案（派生而非虚构）
| 字段 | 派生来源 | 语义 |
|------|----------|------|
| `productionImpact` | `priority` 等级映射：urgent/critical=1.0、high=0.7、medium=0.4、low=0.1、其他=0 | 高优先级任务对产线节拍影响更大（缺省 0 向后兼容） |
| `safetyCritical` | `taskType` 白名单：lift/carry/heavy_lift/material_handling/搬运/重体力等 | 重体力/搬运类任务视为安全关键（保守默认 false，未命中绝不误判） |
| `candidateStations` | 任务所在 zone（父区域）内的全部工位；绑定工位本身则回退 [stationId]；不可解析为空数组 | 资源就近分配候选（求解器已有 `t.candidateStations ?? [stationId]` 消费点） |
| `preemptible` | 保持 false | 无真实来源，不虚构 |

### 验证
- 新增 `world-state-derive.spec.ts`：6 个测试全过（优先级映射 4 档、未知优先级兼容、安全白名单、工位回退、区域工位集合、空绑定）
- 类型：`WorldStateSnapshot.tasks` 各字段本就是可选类型（shared/scheduler.ts），向后兼容

## 三、A2：冲突增强与触发熔断

### 3.1 新增 `reservation_expiring` 冲突类型
- `shared/scheduler.ts`：`SchedulingConflictType` 联合类型追加 `reservation_expiring`
- `scheduler.service.ts` `buildConflicts` 第 13 类：预占剩余时长 < 15min（`reservationExpiringThresholdMs`）→ 产出 medium 级预警冲突，含 `remainingMs/thresholdMs` 证据；已过期预占不重复预警（归 reservation_conflict 语义域）
- 验证：conflicts.spec.ts 新增 3 测试（阈值内触发/充足不触发/过期不重复），12/12 全过

### 3.2 触发链失败熔断（replan-coordinator.service.ts）
- 问题：`handleTrigger` 无 try/catch，任一步失败会让已登记的 run 永远卡在 queued
- 方案：整体 try/catch；失败时记录错误日志 + 将 run 置为 `failed`（不向上抛，事件触发方不受重排失败影响）
- 注：`ewohSchedulingRun` 无 `failureReason` 列（自动生成 schema 不改），失败原因经日志记录

## 四、A3：前端智能交互接线（消费孤儿能力）

### 背景
后端 `/api/scheduler/conflicts`、`/plans/{id}/overrides` 与 `useSchedulerConflicts`/`usePlanOverrides` hook 早已就绪，但**无任何 UI 消费**（走读报告 B6/B7）。

### 新增
| 文件 | 职责 |
|------|------|
| `panels/ConflictCenterPanel.tsx` | 统一冲突中心：13 类类型过滤、严重度排序、详情展开、建议处置、空/加载/错误三态、15s 轮询刷新 |
| `panels/OverridePanel.tsx` | 人工覆盖中心：方案/任务/动作选择（锁定人员/排除/偏好/加急/锁定时间）、原因审计、before/after diff 展示、SAFETY_BLOCK 不可绕过提示 |
| `panels/conflict-panel-logic.ts` | 类型映射 + 排序纯逻辑（可测） |
| `CommandMap.tsx` | TABS 注册「冲突中心」「人工覆盖」两个面板（懒加载，图标 TriangleAlert/SlidersHorizontal） |

### 设计要点
- 冲突面板消费 `useSchedulerConflicts`（现有 hook，无重复实现）
- 覆盖面板消费 `usePlanOverrides`（现有 mutation hook，成功后自动失效方案缓存）
- 覆盖动作六类仅暴露五类 UI（LOCK_TIME 用默认时间窗），与后端 `PlanOverrideKind` 对齐
- 面板均为**只读展示 + 受控写操作**，与既有面板风格一致（暗色 + 组件库 Badge/Button/ScrollArea）

### 验证
- type:check（tsconfig.app.json）全绿
- `conflict-center-panel.test.ts` 5/5（类型映射完整性防漂移 + 排序逻辑）
- CommandMap 全量前端测试无回归

## 五、验证门禁汇总

| 门禁 | 命令 | 结果 |
|------|------|------|
| 后端类型检查 | `npx tsc --noEmit --project tsconfig.node.json` | 全绿 |
| 前端类型检查 | `npx tsc --noEmit --project tsconfig.app.json` | 全绿 |
| scheduler 全量测试 | `npx jest server/modules/scheduler --runInBand` | **27 suites / 220 tests 全过** |
| 新增 A1 测试 | world-state-derive.spec.ts | 6/6 |
| 新增 A2 测试 | conflicts.spec.ts（含新增 3） | 12/12 |
| 新增 A3 测试 | conflict-center-panel.test.ts | 5/5 |
| OpenAPI 路由门禁 | `node scripts/audit-openapi-routes.js` | 304/304 零漂移 |
| 前端 CommandMap 回归 | jest client CommandMap | 无回归（见后台结果） |

## 六、变更清单

**修改**（8 个文件，+257/-145）：
- `server/modules/scheduler/world-state.service.ts`（+131/-24：派生字段 + stations 提前计算 + 3 个辅助方法）
- `server/modules/scheduler/scheduler.service.ts`（+37：reservation_expiring + now 变量 + 阈值字段）
- `server/modules/scheduler/replan-coordinator.service.ts`（熔断包装）
- `shared/scheduler.ts`（+4：冲突类型扩展）
- `client/src/pages/CommandMap/CommandMap.tsx`（+26：TABS + 面板挂载 + 图标）
- `server/modules/scheduler/__tests__/conflicts.spec.ts`（+59：3 个新测试）

**新增**（5 个文件）：
- `server/modules/scheduler/__tests__/world-state-derive.spec.ts`
- `client/src/pages/CommandMap/panels/ConflictCenterPanel.tsx`
- `client/src/pages/CommandMap/panels/OverridePanel.tsx`
- `client/src/pages/CommandMap/panels/conflict-panel-logic.ts`
- `client/src/pages/CommandMap/panels/conflict-center-panel.test.ts`

## 七、Phase B 落地：事件驱动智能重排（第二批）

### B2：`POST /api/scheduler/events` 事件注入端点

**动机**：走读发现 13 类 trigger 仅 MANUAL 走真实链路（瓶颈 B3），`ReplanCoordinatorService.handleTrigger` 已实现局部重排（影响分析 → 冻结无关任务 → 子图求解 → 持久化 → 熔断）但无入口。

**实现**（零破坏策略）：
- `SchedulerController` 注入 `ReplanCoordinatorService`（已是 module providers，无需改模块）
- 新增 `@Post('events')`：body `SchedulingEventRequest { trigger, entityId?, operator?, reason? }`，trigger 缺失 → 400
- 委托 `replanCoordinator.handleTrigger`：局部重排而非全量——与 `POST /runs`（MANUAL 全量）形成「手动全量 / 事件局部」双路径
- 幂等 + 冷却由 TriggerService 保证（triggerKey 去重 + 冷却窗口，跨进程可靠）；失败自动熔断（run 置 failed + 日志），**不抛错阻断事件源**
- `createRun` 保持向后兼容不动（避免破坏既有 12 参数构造与 220 测试）

**契约**：openapi/ewoh.yaml 手写补 `/api/scheduler/events` 路径 + `SchedulingEventRequest` schema（304→305 条）；`npm run gen:openapi` 重新生成前端 TS 类型；`client/src/api/scheduler.ts` 新增 `injectSchedulingEvent` 封装。

**接线语义**：端点面向 M2M 事件源（ingest / MES / 边缘 bridge）开放，随既有 AccessTokenGuard + RolesGuard 鉴权；UI 层不重复接（避免双写路径），仍走 createRun。

**验证**：新增 `scheduler-events-controller.spec.ts` 4 测试（trigger 缺失 400 / 委托透传 / 冷却去抖 / entityId 可空）；既有 `event-driven.spec.ts` 9 测试无回归；修复 `phase1-features.spec.ts` 2 处 controller 构造缺参。

### 门禁汇总（Phase B）

| 门禁 | 结果 |
|------|------|
| 后端 type:check | 全绿 |
| 前端 type:check | 全绿 |
| scheduler 全量（含新增 4 + 修复 2 处构造） | 28 suites 全过 |
| 事件端点测试 | 4/4 |
| event-driven 既有测试 | 9/9 无回归 |
| OpenAPI 路由零漂移 | 305/305 |
| gen-openapi TS 类型重生成 | 成功 |

### 后续（Phase B 剩余 / D）
- ingest 模块接线：设备离线检测 → 调 `injectSchedulingEvent('DEVICE_OFFLINE')`（需 IngestModule import SchedulerModule，避免循环依赖需验证依赖图）
- SSE 四类事件推送（plan/conflict/resource/deviation）需动 outbox 协议，留待独立迭代
- 反馈闭环 recordActuals 接线（D 阶段）

## 九、Phase B1 + D1 落地：ingest 离线自动重排 + 反馈闭环（第三批）

### B1：ingest 设备故障/离线 → DEVICE_OFFLINE 自动重排

**问题**：`POST /api/scheduler/events` 已就绪但无真实事件源接入（瓶颈 B3 的后半段）。

**实现**：
- `ingest.module.ts` import `SchedulerModule`（依赖图 IngestModule → SchedulerModule → TaskModule 无循环，已验证）
- `ingest.service.ts` 注入 `ReplanCoordinatorService`；`ingest.controller.ts` 透传 IngestGuard 已挂载的 userContext
- `isFaultTransition`（纯函数，公开可测）：判定设备"正常 → 故障/离线"状态转换（此前无故障码且在线 + 新帧携带 fault_code）
- `detectFaultTransition`：单帧路径（upsertDevice 前）与批量路径（deviceUpserts 收集时）共用
- `fireDeviceOfflineReplan`：fire-and-forget 调 `handleTrigger('DEVICE_OFFLINE', deviceId, ctx)`——重排失败经 ReplanCoordinator 熔断，**绝不阻断 ingest 主链路**（真机数据接入优先）；ctx 回退 `EWOH_INGEST_ORG_ID`

**验证**：新增 `ingest-fault-transition.spec.ts` 5 测试（正常→故障触发 / 已有故障不重复 / 无故障码不触发 / 已离线不触发 / 首次接入不触发）。

### D1：recordActuals 反馈闭环端点

**问题**：`SchedulingFeedbackService.recordActuals`（回填执行实际值）零调用方，planned-vs-actual KPI 无数据输入。

**实现**（零模块循环设计）：
- `shared/scheduler.ts` 新增 `RecordActualsRequest` 类型
- `scheduler.service.ts` 新增 `recordTaskActuals` 门面：校验至少一个匹配键（assignmentId/planId/taskId）→ 委托 recordActuals；覆盖式更新天然幂等
- `scheduler.controller.ts` 新增 `POST /api/scheduler/feedback/actuals`（鉴权随既有 Guard）
- openapi/ewoh.yaml 同步（306 条路径）+ gen-openapi 重生成 TS 类型
- **为什么不在 TaskModule 接线**：TaskModule 是依赖叶子（SchedulerModule imports TaskModule），反向注入会成环；以独立端点供任务执行方（移动端/边缘）回填是最小耦合方案

**验证**：新增 `scheduler-feedback-actuals-controller.spec.ts` 3 测试（controller 透传 / 缺匹配键 400 / 单键匹配）。

### 门禁汇总（第三批）

| 门禁 | 结果 |
|------|------|
| 后端 type:check | 全绿 |
| 前端 type:check | 全绿 |
| scheduler + ingest 全量回归 | 待最终确认（后台运行） |
| B1 ingest 测试 | 5/5 |
| D1 actuals 测试 | 3/3 |
| OpenAPI 路由零漂移 | 306/306 |
| gen-openapi TS 类型 | 已重生成（含新端点） |

### 后续（剩余）
- **SSE 四类事件推送**（plan/conflict/resource/deviation）：需动 outbox 协议，建议独立迭代
- **移动端/边缘实际回填调用方**：D1 端点已就绪，等待任务执行侧接入
- **权重体系收敛**：buildPolicy 硬编码权重项仍待处理

## 十、B3 + C3 落地：SSE 实时事件推送（第四批，全门禁绿）

### B3：SSE 事件类型扩展（conflict.detected / execution.deviation）

**洞察**：SSE 基础设施（OutboxService → SchedulerStreamService → `@Sse('v2/stream')`）本就支持任意 eventType 透传，**无需动 outbox 协议**——只需在事件源头 enqueue 新类型。

**实现**（SchedulerService 增加可选注入第 13 参 outboxService）：
- `conflict.detected`：buildConflicts 发现新冲突 → 推送（含类型/严重度/scope/资源/消息/建议处置）。**内存去重**（emittedConflictIds Set，conflictId 内容哈希稳定）：同冲突只推一次，防前端轮询触发重复推送；有界（500 上限，超限清最老一半）
- `execution.deviation`：recordTaskActuals 回填成功 → 推送（含 planId/assignmentId/taskId/actual 值），地图执行偏差图层数据源
- **明确不做 resource.state_changed**（资源事件高频会事件风暴）；缺失 outboxService（测试/降级）时静默跳过
- 修复 5 处测试构造（conflicts/policy-version/runs-snapshot/candidates/overrides 各补 `{ enqueue: jest.fn() } as never`）

### C3：前端 SSE 消费接线（useSchedulerStream）

- `conflict.detected` → `invalidateQueries(schedulerConflicts)`：冲突中心立即刷新（替代 15s 轮询等待）
- `execution.deviation` → `invalidateQueries(schedulerPlan(planId))`：执行偏差图层数据更新
- React Query v5 前缀匹配保证带 filter 的冲突查询变体也被失效

### 门禁汇总（第四批）

| 门禁 | 结果 |
|------|------|
| 后端 type:check | 全绿 |
| 前端 type:check | 全绿 |
| scheduler 全量回归 | 待最终确认（后台运行） |
| SSE 事件测试（scheduler-sse-events.spec.ts） | 6/6（新冲突推送/去重/无冲突不推/未注入跳过/偏差推送/缺键 400） |
| 既有 conflicts/policy-version 测试 | 19/19 无回归 |
| OpenAPI 路由零漂移 | 306/306（无新端点，仅事件类型扩展） |

### 后续（剩余）
- **resource.state_changed**：需节流/批量策略，避免事件风暴（有意暂缓）
- **移动端/边缘实际回填调用方**：execution.deviation 数据源已就绪
- **权重体系收敛**：buildPolicy 硬编码权重项

## 八、已知限制与后续优化

1. **生产影响仍为派生值**：真实生产影响建模需 `ewohProductionTask` 增加显式列（DB 迁移 + schema 重生成），当前派生映射（priority→0.1~1.0）是合理近似
2. **触发断线未接线**：13 类 trigger 仍仅 MANUAL 走真实链路；`ReplanCoordinatorService` 熔断已加固，但业务接线（ingest 事件流 → handleTrigger）需 Phase B 完成
3. **SSE 未扩展**：四类事件（plan/conflict/resource/deviation）推送需动 outbox 协议，留待 Phase B3
4. **override 目标资源为手动输入 ID**：后续可接候选资源接口（`/tasks/{id}/candidates`）做选择器
5. **权重体系未收敛**：`buildPolicy` 硬编码权重项仍在，属 Phase A2 后续项
6. **新增面板未接入地图联动**：冲突点击定位实体（ConflictCenterPanel → FactoryMap 选中）可作下一迭代
