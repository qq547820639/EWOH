# Command Map 智能调度升级 — 主理人侦察记录（2026-08-10）

> 主理人齐活林侦察产出，供 PM/架构师/工程师/QA 共享。本文件只记录**已确认的事实**，设计决策由架构师产出。

## 0. 范围与方式

- 仓库：`/Volumes/Extra/CodeProj/EWOH`（多运行时 Monorepo）
- 目标模块：`ewoh-spark-app/server/modules/scheduler/`（41 个源文件 + `__tests__` 60+ spec）
- 迁移：`db/migrations/standalone_001~022` 已存在；`shared/scheduler.ts`、`shared/api.interface.ts` 为共享契约
- 本次交付边界（主理人与用户对齐）：**Phase 0 完整 + Phase 1 核心**；Phase 2-5 为路线图

## 1. 测试基线（2026-08-10 实测）

- `npx jest modules/scheduler/__tests__/constraint-lifecycle.spec.ts modules/scheduler/__tests__/candidates.spec.ts` → **2 suites / 9 tests 全绿**（8.2s）
- 根 package.json：`jest` 全量、`type:check:server`（tsc --noEmit --project tsconfig.node.json）、`lint`（scripts/lint.js + design tokens）
- 注意（既有知识）：双端 tsc 需 `tsc -b`；`sw-update.spec.ts`（browser）有预存 22 个 tsc 错误，勿动

## 2. P0-1 Resource State SSOT —— **已实锤问题**

`world-state.service.ts:137-155`：`buildSnapshot` 直接 `select().from(ewohPersonnel/ewohDevice/ewohProductionTask/ewohSpatialEntity/ewohEvent/ewohRouteNode/ewohResourceReservation/ewohDeviceBinding)` 独立构建资源视图。

- `resource-projection.service.ts` 已有完整规范：`version/sourceTs/freshnessMs/dataQuality(FRESH/STALE/UNKNOWN)`、`:104` 坐标缺失 → `UNKNOWN(null)`（注释明确"禁止用 0 冒充真实坐标"）、STALE/UNKNOWN → unavailable
- **结论**：world-state 未消费 ResourceProjectionService → 双轨事实源，正是用户 P0-1 指出的问题

## 3. P0-2 持久化约束生命周期 —— **已实锤问题**

- `scheduler.service.ts:419` `createRun`：`solveVariants(snapshot, [], ...)` —— **传入空 constraints**
- `world-state.service.ts` 全文无 constraints 引用 → snapshot 不携带约束
- `replan-coordinator.service.ts` / `impact-analyzer.ts` / `trigger.service.ts` 均无 constraints 引用
- 唯一约束加载点：`plan.service.ts:303-307`（`listPlanConstraints`，按 planId+active）与 `loadEffectiveConstraints`（现有测试 constraint-lifecycle.spec.ts:73 覆盖其合并逻辑）
- 覆盖缺口：`constraint-lifecycle.spec.ts` 现有 5 个测试（list/loadEffective/deactivate/safety-locked），**未覆盖 createRun→solveVariants 链路** → 需补 integration test
- **结论**：manual/automatic run 主链路不加载持久化 active LOCK/EXCLUDE → 用户 LOCK 会在 run 中丢失，问题实锤

## 4. P0-3 坐标 —— **已有良好基础，需排查残留**

- `travel-cost.service.ts`：`hasCoord` 校验非 null + Number.isFinite；坐标缺失 → `feasible:false, fallbackReason:'coords_unknown', dataQuality:'UNKNOWN'`；Euclidean 仅显式 degraded（`source:'euclidean_fallback'` + geometry 注明）
- `resource-projection.service.ts:104`：UNKNOWN(null)
- **残留排查点**：`routing.service.ts:275/430` 的 `Math.hypot` 调用点输入来源需审计（坐标从哪来、是否可能 0,0）；world-state 独立构建的资源坐标是否有 0,0 兜底（`:137-155` 路径需核对）
- 共享契约 `shared/scheduler.ts` 需确认坐标类型定义（FACTORY_CARTESIAN/WGS84/UNKNOWN 显式类型是否已存在）

## 5. P0-4 TaskRequirement —— 表已存在，derived 标记待确认

- `standalone_016_task_requirement.sql` 已建 TaskRequirement 表（requiredSkills/skillMatchMode 等）
- 记忆库记录（commit ee4f3f3）：TaskRequirement 走 standalone_016 真实列，world-state 列空才派生并标记 `derived[]`
- **待确认**：scheduler 内 keyword fallback 是否全部带 derived 标记；`task-scheduling.bridge.ts`（42 行）仅为事件桥接，无派生逻辑

## 6. Phase 1 缺口 —— **已确认**

`heuristic-scheduling-solver.ts`：
- `:50` `const PREFERENCE_BONUS_MINUTES = 30;` —— **硬编码 magic number**
- `:456/482/493/529` `stationId: task.stationId` —— **station 非决策变量**，未枚举 candidateStationIds
- `:589` `score.total = Math.max(0, score.total - PREFERENCE_BONUS_MINUTES)` —— magic number 作用于 score
- `constraints.ts` 已定义 16 hard + 9 soft 支持清单；`solver.service.ts:75` solve 接受外部 constraints 参数

## 7. 其他现状

- CP-SAT：`cp-sat-scheduling-solver.ts` 已存在（记忆库：contract.py 字段声明、safetyBlocked 硬过滤、AddCumulative、fallback 语义已修复）→ Phase 2 增量基础好
- SSE：`scheduler-stream.service.ts` + `outbox.service.ts` + standalone_021 envelope + Last-Event-ID/gap resync/polling fallback 已有测试（scheduler-stream-last-event-id.spec.ts / scheduler-sse-events.spec.ts）
- 冲突：`conflict.service.ts` + `impact-analyzer.ts` + `replan-coordinator.service.ts` + conflict-preview 已有；GET /conflicts 副作用问题待架构师审计
- 前端：`ewoh-spark-app/client/` 为生产实现；`ui/command_map/` 为历史静态原型（勿动）；记忆库：双 SSE 连接遗留、PlanLayer 已用 selectedPlanId（不回退 plans[0]）
- 既有记忆（关键约束）：NestJS Scheduler 唯一写 authority；Python Edge advisory-only；travel cost SSOT；双 solver 统一评估；routeEdgeTaskIndex 判定；runner 显式注册制（新 migration 需注册 7 处）

## 8. 主理人下一步

1. PM 产出 PRD（docs/command-map-upgrade-prd-2026-08-10.md）
2. 架构师：现状调用链 + Phase 0/1 设计 + 任务分解（含文件级改动清单、依赖图、实现顺序）+ Phase 2-5 增量设计
3. 工程师：按任务列表实现（先补测试暴露问题，再改代码）
4. QA：unit/invariant/integration/replay 验证 + 回归
