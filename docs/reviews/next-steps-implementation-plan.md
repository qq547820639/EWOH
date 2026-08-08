# EWOH 下一步实施计划（v0.7 之后）

> 制定日期：2026-08-08 | 基线：main@f134fd1（7 commits 已推送）
> 前置工作已完成：仓库全量走读 → 飞书侧车加固 v1.1.0 → 智能调度 v0.7 四批（A 数据/B 事件/C 前端/D 反馈）→ AI 接入修复

---

## 一、当前状态盘点（已完成）

| 域 | 状态 | 交付物 |
|----|------|--------|
| 仓库走读 | ✅ | `docs/reviews/architecture-walkthrough-2026-08-08.md` |
| 飞书侧车 v1.1.0 | ✅ 已推送 | 鉴权/落盘/幂等/签名修复，40 tests |
| 智能调度 A（数据打底） | ✅ | productionImpact 派生/13 类冲突/熔断 |
| 智能调度 B（事件驱动） | ✅ | events 端点 + ingest 离线重排 |
| 智能调度 C（前端交互） | ✅ | 冲突中心/覆盖面板/SSE 消费 |
| 智能调度 D（反馈闭环） | ✅ | recordActuals + execution.deviation |
| AI 接入修复 | ✅ | NULL org_id → 全局哨兵 |

---

## 二、剩余工作全景（按域）

### 2.1 调度后端（核心价值剩余）

| # | 项 | 现状证据 | 优先级 |
|---|----|----------|--------|
| R1 | **权重体系收敛**：buildPolicy 硬编码（workload=1/stationWait=1/changeCost=0.5/energy=minBattery/30）→ 全量可配 + 策略版本化 | `scheduling-policy.service.ts:270-285` | **P0** |
| R2 | **SSE 内存无界**：seenEventIds Set 无上限增长 | `scheduler-stream.service.ts:30` | **P0**（稳定性） |
| R3 | **13 类 trigger 完整接线**：目前仅 MANUAL + DEVICE_OFFLINE 走真实链路；ROUTE_BLOCKED/CONGESTED/RESERVATION_CONFLICT 的 dispatchStateTriggers 已实现未注入业务 | `replan-coordinator.service.ts:154` | P1 |
| R4 | **SAFETY_EVENT 自动熔断**：安全事件触发后自动阻止同区域派工 | 规划中 | P1 |
| R5 | **设备能力匹配**：任务 requiredDeviceCapabilities 尚未填充，求解器 capability 匹配空转 | `world-state.service.ts` taskList 映射 | P1 |
| R6 | **移动端/边缘回填调用方**：recordActuals 端点已就绪，等待执行侧接入 | `POST /api/scheduler/feedback/actuals` | P2（依赖业务侧） |
| R7 | CP-SAT 启用（部署 OR-Tools worker） | 外部依赖 | P3 |

### 2.2 前端（实时化与体验深化）

| # | 项 | 现状证据 | 优先级 |
|---|----|----------|--------|
| F1 | **地图实时化**：实体位置 2s 轮询 → SSE 增量（execution.deviation 已推送，需消费到地图层） | `CommandMap.tsx:152-212` | **P0** |
| F2 | **冲突→地图联动**：ConflictCenterPanel 点击定位实体（现有 onReplan 只跳转面板） | ConflictCenterPanel.tsx | P1 |
| F3 | **覆盖面板候选选择器**：OverridePanel 目标人员手动输入 ID → 接 `/tasks/{id}/candidates` | OverridePanel.tsx | P1 |
| F4 | **组件拆分**：CommandMap 902 行 / FactoryMap 1328 行 → 状态机 + 分层组件 | 走读报告 H5 | P2 |
| F5 | **SchedulePanel 去 demo**：buildDemoPlan 已有 isNonAuthoritativePlan 隔离，可移除（保持降级提示） | SchedulePanel.tsx:120 | P2 |

### 2.3 工程治理与稳健性（走读报告遗留）

| # | 项 | 现状证据 | 优先级 |
|---|----|----------|--------|
| G1 | **RLS 覆盖审计**：ewohNotification/ewohOutbox/ewohWorldStateSnapshot 等表无 org_id 列 | 走读 M4 | P1 |
| G2 | **迁移双基线收敛**：001_ewoh_managed_tables（121KB）与 standalone_001_schema（88KB）并行重叠 | 走读 M8 | P2 |
| G3 | **边缘双总线统一**：edge/bus.py（handler 语义）vs scheduler/events.py（queue 语义）| 走读 H1 | P2（高风险） |
| G4 | **遥测帧格式对齐**：UnifiedExoFrame vs storage.insert_telemetry 字段不一致 | 走读 H2 | P2 |
| G5 | **verify 期望值去硬编码**：run_migrations.js 内嵌表计数 | 走读 L5 | P2 |

### 2.4 飞书侧车（v1.2 候选）

| # | 项 | 优先级 |
|---|----|--------|
| FEA1 | lark-cli 同步调用改异步 spawn + 超时（当前 spawnSync 阻塞事件循环） | P2 |
| FEA2 | 多实例支持（webhook_dedup 依赖 SQLite 单写 → PostgreSQL/Redis） | P3 |
| FEA3 | 遥测批量分页（batch-create 单次上限） | P3 |

---

## 三、分阶段实施计划

### Batch 5：调度稳健性 + 权重收敛（P0，纯后端，无 UI 变更）

**目标**：消除两个已知稳定性/可配置性缺陷，为策略调优铺路。

| 步骤 | 内容 | 影响范围 | 验证门禁 |
|------|------|----------|----------|
| 5.1 | 权重体系收敛：buildPolicy 增加 workloadBalance/stationWait/changeCost/energy 权重源（从 SchedulingPolicyConfig 读取，缺省保持现值 1/1/0.5/minBattery/30 兼容） | `scheduling-policy.service.ts` + `shared/scheduler.ts`（SchedulingPolicyConfig 扩展）+ policy-version.spec | type:check + jest（policy-version 12 tests） |
| 5.2 | SSE 内存去重有界化：seenEventIds 改 LRU（上限 5000，超限淘汰最老） | `scheduler-stream.service.ts` + scheduler-stream 测试 | type:check + jest |
| 5.3 | 设备能力匹配：world-state 任务映射补充 requiredDeviceCapabilities（从任务模板/extra 派生，缺省空数组兼容）；deviceList 补充 capabilities | `world-state.service.ts` + world-state-derive.spec | type:check + jest 6 tests |
| 5.4 | OpenAPI 契约检查（SchedulingPolicyConfig 扩展为 body 字段，无新端点 → 306/306 保持） | openapi/ewoh.yaml | audit-openapi-routes |

**提交**：`refactor(scheduler): converge policy weights + bound SSE dedup + device capability matching`

### Batch 6：事件驱动补全（P1，后端）

**目标**：13 类 trigger 中高价值事件接入真实业务链路，SAFETY_EVENT 熔断。

| 步骤 | 内容 | 影响范围 | 验证门禁 |
|------|------|----------|----------|
| 6.1 | dispatchStateTriggers 注入：世界快照构建后（trigger 成功路径）调用，ROUTE_BLOCKED/CONGESTED/RESERVATION_CONFLICT 自动触发 scoped 重排（受冷却去抖保护，无风暴） | `scheduler.service.ts` createRun/solveVariants 路径 + replan-coordinator | jest（event-driven 9 tests + 新增集成） |
| 6.2 | TASK_CREATED/TASK_UPDATED 接线：任务写路径（createTask/updateTask）→ injectSchedulingEvent（fire-and-forget） | `task.service.ts` 或 controller 层 | jest |
| 6.3 | SAFETY_EVENT 熔断：L2/L3 安全事件 open 期间，world-state safetyBlocked* 已有；补"派工前校验安全事件"守卫 | `dispatch-coordinator.service.ts` | jest（dispatch-integration） |
| 6.4 | metrics 埋点：SchedulerMetricsService.recordRun/recordFallback 接入 createRun/fallback 路径 | `scheduler.service.ts` + scheduler-metrics.spec | jest |

**提交**：`feat(scheduler): wire 13-class event triggers + safety circuit breaker + metrics`

### Batch 7：前端实时化 + 交互深化（P0/P1，用户可见价值）

**目标**：地图从 2s 轮询升级为 SSE 增量；冲突/覆盖面板闭环。

| 步骤 | 内容 | 影响范围 | 验证门禁 |
|------|------|----------|----------|
| 7.1 | 地图位置实时化：useSchedulerStream 消费 execution.deviation → 更新 entity 位置缓存；保留轮询兜底（SSE 断线降级） | `CommandMap.tsx` + `FactoryMap.tsx` + `useSchedulerStream.ts` | type:check + CommandMap 前端测试 23 tests |
| 7.2 | 冲突→地图定位：ConflictCenterPanel onLocate 回调 → FactoryMap 选中实体 | CommandMap.tsx + ConflictCenterPanel | type:check + 组件测试 |
| 7.3 | 覆盖面板候选选择器：接 `/tasks/{id}/candidates`（距离/技能/负荷排序）下拉替代手输 ID | OverridePanel.tsx + scheduler.ts API | type:check + 组件测试 |
| 7.4 | SchedulePanel 移除 buildDemoPlan（保留 isNonAuthoritativePlan 逻辑防回归） | SchedulePanel.tsx + schedule-panel.test | jest 3 tests |
| 7.5 | bundle 预算验证 | client | build:prod:standalone + bundle-budget |

**提交**：`feat(command-map): SSE-driven map realtime + conflict locate + candidate picker`

### Batch 8：治理与稳健性（P1/P2）

**目标**：走读报告遗留问题收敛，降低长期维护成本。

| 步骤 | 内容 | 影响范围 | 验证门禁 |
|------|------|----------|----------|
| 8.1 | RLS 覆盖审计：检查无 org_id 表清单，评估补列 vs 声明"全局表"（AI 配置已是全局哨兵先例） | db/migrations + schema 说明 | 迁移 dry-run + verify |
| 8.2 | 迁移双基线收敛：standalone 链为唯一事实源，001_managed_tables 标注 deprecated（文档 + 门禁提示，不删） | docs + scripts/audit-repo-facts | truth-check |
| 8.3 | 边缘双总线统一：edge/bus.py 与 scheduler/events.py 收敛为一个 EventBus 契约 | src/edge_platform（**高风险，需充分测试**） | make test + production-smoke |
| 8.4 | 遥测帧格式对齐：UnifiedExoFrame 与 storage.insert_telemetry 字段映射补齐 | src/edge_platform/edge | make test + connector-tck |

**提交**：按 8.1/8.2、8.3/8.4 分两个 commit（治理低风险与边缘高风险分离）

### Batch 9：外部依赖项（P2/P3，需环境条件）

| 项 | 前置条件 | 说明 |
|----|----------|------|
| CP-SAT worker 部署 | 服务器 + OR-Tools 容器 | Docker 部署 Python worker，solverStatus=OPTIMAL 可达；启用前跑 solver-invariants |
| 移动端回填调用 | 移动端开发排期 | recordActuals 端点已就绪，执行侧接入即闭环 |
| 飞书真实联调 | lark-cli 授权 + Base 表权限 | 端到端：卡片推送/处置/回写 |
| feishu 多实例 | 部署规模决策 | PostgreSQL/Redis 迁移规划 |

---

## 四、优先级与依赖说明

```
Batch 5（无依赖，纯后端）→ Batch 6（依赖 5.3 设备能力）→ Batch 7（依赖 6.1 SSE 事件）
Batch 8（独立，可与 5-7 并行）→ Batch 9（外部依赖，随时可启）
```

**建议执行顺序**：Batch 5 → 7 并行启动（7.1 依赖 5.2 SSE 有界化）→ 6 → 8；Batch 9 项按外部条件就绪逐个启。

**风险提示**：
- Batch 6.1 自动重排接入生产链路后，调度行为变化最大——需在影子评估（policy compare）跑一轮后激活
- Batch 8.3 边缘双总线统一涉及核心运行时，必须 production-smoke + 全量 make test 绿后才能推送
- 每个 Batch 独立 commit + 全门禁绿，保持可回滚

## 五、每批次的完成标准（Definition of Done）

- [ ] 代码变更完成，模块职责清晰（无 >300 行新文件）
- [ ] type:check（node + app）全绿
- [ ] 相关 jest 测试全绿（新增 + 既有无回归）
- [ ] OpenAPI 路由零漂移（audit-openapi-routes）
- [ ] 相关文档/CHANGELOG 更新
- [ ] 独立 commit + push
