# EWOH Command Map → 生产级智能调度驾驶舱
## 最终代码级验收、差异裁决与迭代实施包

**验收日期：2026-08-10**  
**事实源：GitHub `qq547820639/EWOH` 当前公开 `main` 源码 + 用户提供的执行日志**  
**裁决原则：源码优先于执行日志；不能被当前 `main` 直接验证的“已完成/已推送”声明，不作为事实。**

---

# 0. 最终裁决

当前 EWOH 已经不是“静态指挥地图 + 硬编码派工”的早期系统，而是一套具有明显 Scheduler V2 基础的工业调度平台：

- Python Edge：现场数据、感知、世界状态与 advisory/降级调度能力；
- NestJS：生产调度控制面；
- PostgreSQL：调度方案、冲突、reservation、feedback、policy、route matrix 等业务事实源；
- React Command Map：调度、资源、路线、冲突、方案、人机干预驾驶舱；
- Scheduler：世界状态 → 优先级 → Eligibility → Candidate → RouteCost → Solver → Plan → Approval/Override → Reservation → Dispatch → Outbox/SSE → UI；
- 已有 Replan V2、Churn、Prediction Shadow、Priority explainability 等较成熟域模型。

但是，**用户提供的“60c7808 + ced0d89 已完成并推送”的执行日志，与当前公开 `main` 源码存在实质性冲突**。当前代码级验收确认：日志声称完成的多项收敛工作，在当前 `main` 中仍未出现。

因此，本报告以当前公开 `main` 为准，将这些项目重新列为待实施项。

---

# 1. 当前仓库架构

```text
EWOH/
├── src/edge_platform/                       # Python Edge Runtime
│   ├── collection/
│   ├── connectors/
│   ├── inference/
│   ├── perception/
│   ├── world_model/
│   ├── spatial/
│   ├── scheduler/
│   ├── governance/
│   ├── policy/
│   └── server.py / services.py / run.py
│
├── ewoh-spark-app/
│   ├── server/                              # NestJS 云端控制面
│   │   └── modules/
│   │       ├── scheduler/                   # 调度核心
│   │       ├── task/
│   │       ├── resource/
│   │       ├── spatial/
│   │       ├── world/
│   │       ├── ingest/
│   │       ├── events/
│   │       ├── approval/
│   │       ├── audit/
│   │       └── policy/
│   │
│   ├── client/                              # React SPA
│   │   └── src/pages/CommandMap/            # 生产 Command Map
│   └── shared/                              # TS 共享契约
│       └── scheduler.ts
│
├── db/
│   ├── migrations/
│   ├── rollback/
│   └── verify/
│
├── contracts/
├── openapi/
├── tests/
├── docs/
└── ui/command_map/                          # 历史静态 UX 原型
```

生产事实链：

```text
Telemetry / Task / Event
        ↓
Resource / Spatial / World Projection
        ↓
WorldStateSnapshot
        ↓
PriorityEngine
        ↓
ConstraintLoader + Eligibility
        ↓
CandidateEngine
        ↓
RouteCost / Routing
        ↓
SolverService
     ↙         ↘
Heuristic     CP-SAT
        ↓
SchedulingPlanV2
        ↓
Approve / Override / Compare
        ↓
Reservation + Dispatch
        ↓
Transactional Outbox
        ↓
Scheduler SSE
        ↓
React Query
        ↓
Command Map
```

---

# 2. 指挥地图当前实现

生产代码位于：

```text
ewoh-spark-app/client/src/pages/CommandMap/
├── CommandMap.tsx
├── FactoryMap.tsx
├── EntityDetail.tsx
├── ModePanel.tsx
├── TopBar.tsx
├── hooks/
│   ├── commandMapSelector.ts
│   ├── schedulerRealtimeCore.ts
│   └── useCommandMapSchedulerState.ts
├── layers/
├── panels/
└── vm/
```

历史原型位于：

```text
ui/command_map/
```

根 README 已说明该目录为历史 UX 参考、非生产事实源，但目录自身当前仍缺少显眼的 archived/non-production README。

---

# 3. 已经具备的智能调度能力

## 3.1 世界状态

`WorldStateSnapshot` 已包含：

- `snapshotVersion`
- `worldVersion`
- entity versions
- persons / devices / stations / tasks
- reservation
- 坐标与位置
- data quality / freshness
- safety block
- skill / certification
- workload / fatigue
- available windows / availableFrom
- route status / forbidden zones

这说明系统已经具备构建智能调度“状态空间”的基础。

## 3.2 任务优先级

`PriorityDecision` 已具备：

- effectivePriority
- rank
- reasonCodes
- policyVersion
- factors
- explanation

reason code 已覆盖 base priority、deadline risk、waiting age、production impact、event severity、downstream blocking、manual boost。

结论：当前问题不是“没有优先级”，而是策略治理、反馈调优与生产验证。

## 3.3 约束

`SchedulingConstraint` 已统一 hard/soft constraint 表达。

系统已经具备技能、证书、资源可用性、容量、reservation、double booking、人工锁定/排除/偏好等建模基础。

## 3.4 求解器

当前架构已经存在：

```text
SolverService
├── HeuristicSchedulingSolver
└── CpSatSchedulingSolver
```

CP-SAT 已明确采用“可用则尝试，不可用显式 fallback heuristic”的架构方向，这一点符合工业生产系统的可用性要求。

## 3.5 Replan V2

当前共享模型已有：

- ReplanImpact
- ReplanConfig
- ReplanApprovalConfig
- ChurnConfig
- PredictionConfig

已覆盖：

- debounce
- minimum replan interval
- maximum replans/window
- conflict aggregation
- max propagation depth
- max affected tasks
- churn penalties
- safety critical / human lock approval

说明 Replan 已从“全局重算”发展到“影响域 + churn + 风暴治理”。

---

# 4. 当前 main 与上传执行日志的冲突

用户上传日志声称：

- 生产关键依赖已 required 化；
- RouteCost 已增加 STRICT/DEGRADED/ADVISORY；
- TS↔Python golden parity 已增加；
- `ui/command_map/README.md` 已增加；
- ReplanStabilityBudget 已补 `freezeWindowMinutes` / `minimumObjectiveImprovement`；
- `standalone_024_scheduler_outbox_notify` 已增加；
- SchedulerStream 已接入 PostgreSQL LISTEN/NOTIFY；
- Command Map 已消除重复 SSE；
- 所有任务已推送 `origin/main`。

但当前公开 `main` 的代码级检查显示：

| 项目 | 当前公开 main | 裁决 |
|---|---|---|
| WorldState ResourceProjection required | 仍为 optional，并保留旧直读 fallback | 未完成 |
| Solver core deps required | metrics / CandidateEngine 仍 `@Optional()` | 未完成 |
| Dispatch core deps required | feedback / policy 仍 `@Optional()` | 未完成 |
| Plan core deps required | feedback / constraintLoader / outbox / replan 仍 optional | 未完成 |
| RouteCost 三模式 | shared contract 无 `routeCostMode` policy | 未完成 |
| Replan freezeWindow | `ReplanConfig` 无该字段 | 未完成 |
| Replan minObjectiveImprovement | `ReplanConfig` 无该字段 | 未完成 |
| PostgreSQL notify migration | migrations 当前到 `standalone_023` | 未完成 |
| SchedulerStream LISTEN/NOTIFY | 当前仍固定 2s polling | 未完成 |
| `ui/command_map/README.md` | 当前目录无 README | 未完成 |
| golden fixture parity | 当前公开路径无法找到日志所述新文件 | 未验证/按未完成处理 |
| Command Map SSE 单例 | `useCommandMapSchedulerState` 和 `SchedulePanel` 都调用 `useSchedulerStream()` | 未完成 |
| selectedPlan 单一 ownership | SchedulePanel 仍维护本地 `selectedPlanId` | 部分完成 |

**裁决：上传日志属于“执行意图/候选交付记录”，不能作为当前 main 的验收证据。**

---

# 5. 当前最高优先级问题

## P0-1：资源状态仍存在双事实路径

当前：

```text
WorldStateSnapshotService
  ├── ResourceProjectionService.projectForSnapshot()
  └── optional 缺失时 → 旧 personnel/device/spatial 直读逻辑
```

风险：

- 生产代码与测试代码可能走不同路径；
- Resource Projection 修复不能保证覆盖 Snapshot；
- 两条路径对 freshness、位置、设备 capability、reservation 的解释可能漂移；
- 智能调度无法保证“同一时刻只有一个世界”。

改造：

- `ResourceProjectionService` 改为 required；
- 删除 world-state legacy fallback；
- 测试通过显式 mock provider 构造；
- 添加测试保证 snapshot/resource-state projection parity。

---

## P0-2：Command Map 存在重复 Scheduler SSE consumer

当前：

```text
useCommandMapSchedulerState()
    └── useSchedulerStream()

SchedulePanel
    └── useSchedulerStream()
```

风险：

- 两个 EventSource；
- 双 cache mutation；
- 双 gap/resync；
- 顺序竞争；
- 网络和数据库负载重复；
- 调度状态难以追踪。

目标：

```text
SchedulerRealtimeProvider
        ↓
唯一 useSchedulerStream()
        ↓
React Query Cache
        ↓
CommandMap / SchedulePanel / Conflict / Resource panels
```

面板不再自行订阅 SSE。

---

## P0-3：selected plan ownership 仍然分裂

SchedulePanel 内部仍：

```ts
const [selectedPlanId, setSelectedPlanId] = useState(...)
```

而 Command Map 同时存在 activePlan / selected plan overlay 语义。

改造：

统一：

```ts
SchedulerUIState {
  selectedTaskId
  selectedResourceId
  selectedPlanId
  selectedAssignmentId
  comparePlanIds
  activeLayers
  activePanel
  viewport
  previewOverride
}
```

CommandMap/Provider 为唯一 owner，SchedulePanel 变 controlled component。

---

## P0-4：RouteCost 只有“结果来源”，没有“业务策略模式”

当前 CandidateRouteCost 已有：

```text
route_graph
euclidean_fallback
fallbackReason
dataQuality
feasible
```

但这与生产策略不同。

必须增加：

```ts
type RouteDecisionMode =
  | 'STRICT'
  | 'DEGRADED'
  | 'ADVISORY';
```

语义：

### STRICT

route graph 无法确认：

```text
candidate.feasible = false
```

适用于：

- safety critical
- AGV/设备受限路径
- 禁行区
- 高风险工位

### DEGRADED

允许 Euclidean fallback：

- 标记 degraded；
- 明确 fallback reason；
- 加高 penalty；
- 不伪造 risk/congestion；
- UI 显示“数据降级”。

### ADVISORY

允许给人看推荐，但：

```text
degraded route
+
safetyCritical
→ 禁止自动 dispatch
```

---

# 6. P1：Replan Stability Budget

当前 Replan 已有风暴治理，但还缺两个决定现场可用性的关键约束：

```ts
freezeWindowMinutes?: number
minimumObjectiveImprovement?: number
```

建议完整模型：

```ts
interface ReplanStabilityBudget {
  freezeWindowMinutes: number;
  maxChangedAssignments: number;
  maxCascadeDepth: number;
  minimumObjectiveImprovement: number;
  manualLockedAssignments: string[];
  changePenalty: number;
}
```

规则：

1. 已执行/即将执行 assignment 进入 freeze window；
2. LOCK 始终冻结；
3. hard conflict / safety event 可突破 improvement gate；
4. 普通 trigger 只有当 objective 改善超过阈值才接受新方案；
5. 限制一次 replan 的 changed assignment 数量；
6. 超阈值转人工审批而非自动发布。

工业现场的关键目标不是“每次都找到数学更优解”，而是：

> 获得足够明显的收益，同时避免计划频繁抖动。

---

# 7. P2：实时链路升级

当前：

```text
Outbox
   ↓
SchedulerStream 每 2 秒 polling
   ↓
SSE
```

目标：

```text
事务
 ↓
Outbox INSERT
 ↓
PostgreSQL AFTER INSERT trigger
 ↓
pg_notify('scheduler_outbox')
 ↓
PgNotifyListener
 ↓
SchedulerStream.immediatePoll()
 ↓
SSE

同时保留：
2s polling fallback
```

原则：

- Outbox 是 durable source；
- sequence 是顺序事实；
- NOTIFY 只是低延迟 wake-up；
- NOTIFY 丢失不会丢业务事件；
- LISTEN 失败自动退化 polling；
- Last-Event-ID / replay / gap / resync 继续保留。

新增增量 migration：

```text
standalone_024_scheduler_outbox_notify.sql
standalone_024_scheduler_outbox_notify.rollback.sql
standalone_024_scheduler_outbox_notify.verify.sql
```

---

# 8. 目标智能调度模块划分

```text
scheduler/
├── world-state/
│   ├── resource-projection
│   ├── snapshot
│   └── freshness
│
├── priority/
│   ├── engine
│   └── explanation
│
├── policy/
│   ├── policy-version
│   ├── weights
│   ├── route-policy
│   └── shadow/replay
│
├── constraint/
│   ├── loader
│   ├── hard
│   └── soft
│
├── candidate/
│   ├── eligibility
│   ├── candidate-matrix
│   └── explanation
│
├── routing/
│   ├── normalizer
│   ├── route-cost
│   └── data-quality
│
├── solver/
│   ├── solver-port
│   ├── heuristic
│   └── cpsat
│
├── plan/
│   ├── lifecycle
│   ├── compare
│   ├── approval
│   └── override
│
├── conflict/
├── reservation/
├── replan/
├── dispatch/
├── execution/
├── feedback/
└── realtime/
```

不要求一次物理搬目录。

第一步只建立依赖边界。

---

# 9. 推荐接口

## 9.1 调度运行

```http
POST /api/scheduler/runs
```

输入：

```json
{
  "trigger": "MANUAL",
  "taskIds": [],
  "horizonMinutes": 240,
  "policyVersion": 12,
  "solverPreference": "AUTO"
}
```

输出/计划必须持久化：

- snapshotVersion
- worldVersion
- policyVersion
- effectiveConstraintsHash
- solverVersion
- solverStatus
- fallbackReason

---

## 9.2 Candidate Explanation

```http
GET /api/scheduler/tasks/:taskId/candidates
```

建议返回：

```json
{
  "taskId": "T-1",
  "snapshotVersion": "WS-...",
  "policyVersion": 12,
  "candidates": [
    {
      "personId": "P-1",
      "deviceId": "D-1",
      "stationId": "S-1",
      "eligible": true,
      "hardConstraintResults": [],
      "score": 81.4,
      "scoreBreakdown": {},
      "etaMs": 120000,
      "routeCost": {},
      "routeDecisionMode": "DEGRADED",
      "dataQuality": "DEGRADED",
      "reasonCodes": []
    }
  ]
}
```

---

## 9.3 人工干预

所有操作统一：

```text
preview → diff/impact → confirm → audit
```

支持：

- LOCK assignment
- exclude resource
- prefer resource
- manual boost
- force station
- retime
- freeze horizon

每个操作必须含：

- actor
- reason
- expiry
- snapshotVersion
- audit record

---

# 10. Command Map 目标状态流

```text
Backend Fact State
        ↓
React Query
        ↑
Single Scheduler SSE Provider
        ↓
CommandMap Selector / VM
        ↓
┌─────────────────────────────┐
│ Map                         │
│ • tasks                     │
│ • persons/devices/stations  │
│ • reservations              │
│ • routes                    │
│ • plan                      │
│ • conflicts                 │
│ • degraded data             │
└─────────────────────────────┘
        ↕
┌─────────────────────────────┐
│ Panels                      │
│ • Candidate explanation     │
│ • Schedule                  │
│ • Resource pool             │
│ • Conflicts                 │
│ • Plan compare              │
│ • Override preview          │
└─────────────────────────────┘
```

颜色/图层必须区分：

1. 事实；
2. 推荐；
3. 人工预览；
4. 已审批正式计划；
5. 冲突；
6. 数据降级。

---

# 11. 分阶段实施计划

## Phase 0 — 一致性与权威性

优先级：最高。

1. ResourceProjection required 化，删除 legacy world-state fallback；
2. 清理 Solver/Plan/Dispatch 中仅为旧测试存在的 silent optional fallback；
3. Command Map 引入唯一 SchedulerRealtimeProvider；
4. 删除 SchedulePanel 自己的 `useSchedulerStream()`；
5. 将 selectedPlanId lift 到统一 UI state；
6. RouteCost 增加 STRICT/DEGRADED/ADVISORY；
7. `ui/command_map/README.md` 标记 ARCHIVED；
8. TS↔Python golden contract parity。

验证：

- server tsc；
- scheduler full Jest；
- client tsc；
- CommandMap tests；
- EventSource 单实例测试；
- TS/Python parity pytest；
- no migration drift。

---

## Phase 1 — 重排稳定性

1. `freezeWindowMinutes`
2. `minimumObjectiveImprovement`
3. `maxChangedAssignments`
4. hard-conflict bypass
5. stability decision reason code
6. replan suppression SSE/audit

验证场景：

- minor ETA fluctuation 不重排；
- safety event 必须重排；
- executing task 不移动；
- manual LOCK 不移动；
- objective improvement 不足被 suppress；
- urgent task 可进入局部重排。

---

## Phase 2 — 实时

1. standalone_024 migration；
2. PostgreSQL `pg_notify`；
3. PgNotifyListener；
4. immediate poll；
5. 2s fallback；
6. metrics：
   - notify wakeup
   - poll fallback
   - SSE gap
   - resync
   - listener reconnect

---

## Phase 3 — 人机协同深化

1. candidate ranking；
2. route degradation visualization；
3. why A not B explanation；
4. conflict action suggestions；
5. plan compare；
6. override preview；
7. URL/deep-link UI state；
8. stale/degraded explicit UX。

---

## Phase 4 — 反馈学习

1. planned vs actual；
2. duration model；
3. travel model；
4. congestion model；
5. policy shadow；
6. historical replay；
7. canary；
8. rollback。

任何 prediction 都不得绕过 hard constraints。

---

# 12. 验收指标

必须加入：

```text
hard_constraint_violation = 0
double_booking = 0
stale_snapshot_dispatch = 0
```

同时观测：

- solver success rate
- solver fallback rate
- timeout rate
- infeasible rate
- solve P50/P95/P99
- approval rate
- override rate
- average lateness
- walking/travel time
- station waiting
- conflict resolution time
- replan rate
- schedule churn
- stale resource ratio
- degraded route ratio
- SSE notify latency
- SSE gap/resync
- actual/planned deviation

业务总目标：

> 提高准时率、减少无效移动、减少资源冲突和人工改派，同时确保 hard constraint 零违规，并控制 schedule churn。

---

# 13. 代码质量重点

## 必须改

- 生产核心依赖不能为了旧测试而 optional；
- 前端只有一个 scheduler realtime consumer；
- single UI ownership；
- 不允许假坐标 `(0,0)`；
- 不允许 degraded route 冒充 confirmed route；
- 不允许 stale snapshot 静默 dispatch；
- 不允许 ML 绕过 hard constraint；
- 不复制第二套 Scheduler；
- 不在 `ui/command_map/` 写生产功能。

## 可以保留 optional

例如 CP-SAT 配置/worker 可以 optional，因为：

- CP-SAT 是可选能力；
- fallback 是显式状态；
- 系统不能因 OR-Tools unavailable 整体不可用。

“能力可选”与“核心事实依赖 optional + 静默换算法”必须严格区分。

---

# 14. 当前代码级验收等级

| 领域 | 成熟度 |
|---|---:|
| 世界状态模型 | 4/5 |
| Priority explainability | 4/5 |
| Constraint model | 4/5 |
| Candidate/eligibility | 4/5 |
| Route cost | 3/5 |
| Heuristic solver | 4/5 |
| CP-SAT productionization | 3/5 |
| Reservation/Dispatch | 4/5 |
| Conflict | 4/5 |
| Replan | 4/5 |
| Replan stability | 3/5 |
| Realtime durability | 4/5 |
| Realtime latency | 2/5 |
| Command Map | 4/5 |
| Frontend state consistency | 2.5/5 |
| Human-in-loop | 4/5 |
| Feedback/Shadow | 4/5 |
| Cross-language contract governance | 3/5 |

总体：

**3.7 / 5：智能调度基础成熟，但生产级一致性收敛尚未完成。**

---

# 15. 一键投喂编码助手的最终提示词

```text
你是一名资深工业互联网架构师、NestJS/React/Python 全栈工程师和智能调度优化工程师。

请直接在当前 EWOH 仓库 main 分支代码基础上，完成“Command Map → 生产级智能调度驾驶舱”的最终收敛开发。

仓库：
qq547820639/EWOH

重要原则：
当前源码是唯一事实源。不要相信历史执行日志中“已完成/已提交”的声明，必须先检查当前工作树/HEAD 后再修改。

一、项目结构

- `src/edge_platform/`：Python Edge Runtime；
- `ewoh-spark-app/server/`：NestJS 云端生产控制面；
- `ewoh-spark-app/client/`：React SPA；
- `ewoh-spark-app/client/src/pages/CommandMap/`：生产 Command Map；
- `ewoh-spark-app/shared/scheduler.ts`：TypeScript Scheduler contract；
- `db/migrations/`：PostgreSQL migration 事实源；
- `ui/command_map/`：历史 UX 原型，禁止写生产逻辑。

生产联网模式下：
NestJS Scheduler 是正式计划、reservation、dispatch 唯一写权威。
Python Edge 只负责状态、事件和 advisory/降级，不允许形成云边双写。

二、当前源码已经存在

不要重复实现以下已有能力：

- WorldStateSnapshot / worldVersion / entityVersions；
- persons/devices/stations/tasks/reservations；
- freshness/dataQuality；
- PriorityEngine；
- PriorityDecision(rank/reasonCodes/factors/explanation)；
- hard/soft SchedulingConstraint；
- Eligibility；
- CandidateEngine；
- route graph + euclidean fallback；
- HeuristicSchedulingSolver；
- CpSatSchedulingSolver + timeout/status/fallback；
- SchedulingPlanV2；
- plan approval/reject/compare/override；
- resource reservation；
- conflict lifecycle；
- Replan V2；
- ReplanApprovalConfig；
- ChurnConfig；
- prediction shadow；
- execution feedback / KPI；
- transactional outbox；
- SSE Last-Event-ID/replay/gap/resync；
- React Command Map layers/panels。

三、当前 main 经源码验收仍存在的 P0 问题

1. `WorldStateSnapshotService`
   `ResourceProjectionService` 仍为 optional，缺失时回退旧 personnel/device/spatial 直读逻辑。
   要改为 required，并删除 legacy fallback。

2. `SolverService`
   `SchedulerMetricsService`、`CandidateEngineService` 仍是 `@Optional()`。
   对真正的生产核心依赖改 required。
   `CpSatSolverConfig` 可以继续 optional，因为 CP-SAT 是合法可选能力，fallback 必须显式。

3. `DispatchCoordinatorService`
   `SchedulingFeedbackService`、`SchedulingPolicyService` 仍 optional，并存在 30min silent fallback。
   将生产核心依赖 required，并使用统一 policy default。

4. `PlanService`
   feedback / constraintLoader / outbox / replanCoordinator 仍存在为了旧单测的 optional path。
   生产依赖 required。
   测试使用显式 mock provider，不允许生产代码为测试保留第二条业务路径。

5. Command Map 目前有重复 SSE：
   - `useCommandMapSchedulerState()` 调用 `useSchedulerStream()`
   - `SchedulePanel` 又调用 `useSchedulerStream()`
   必须统一成唯一 `SchedulerRealtimeProvider` / single EventSource。

6. `SchedulePanel` 仍自己维护 `selectedPlanId`。
   将 plan/task/resource/assignment selection lift 到 Command Map 统一 UI state。
   SchedulePanel 改 controlled component。

7. RouteCost 当前只有：
   `route_graph | euclidean_fallback`
   这是结果来源，不是生产策略。
   新增：
   `STRICT | DEGRADED | ADVISORY`

   STRICT：
   route graph 不可确认 → candidate infeasible。

   DEGRADED：
   允许 Euclidean fallback，但：
   - dataQuality 标 degraded；
   - fallbackReason；
   - 高 penalty；
   - 不伪造 congestion/risk。

   ADVISORY：
   可用于人工推荐；
   safetyCritical + degraded route → 禁止正式 dispatch。

   默认使用 DEGRADED，保证向后兼容。

8. `ui/command_map/` 当前没有目录级 archived README。
   新增 README：
   - ARCHIVED
   - NON-PRODUCTION
   - production source = `ewoh-spark-app/client/src/pages/CommandMap/`

9. 建立 TS↔Python golden contract parity：
   - repo-level JSON fixture；
   - Jest 解析/序列化；
   - pytest 解析/序列化；
   - SolverRequest/SolverResponse；
   - SolverStatus enum；
   - constraint/route/candidate 字段；
   - no extra/missing required keys。

四、P1：Replan Stability Budget

当前 ReplanConfig 已有：
- debounce；
- minimum interval；
- maximum replans/window；
- conflict aggregation；
- max propagation depth；
- max affected tasks。

必须补：

- `freezeWindowMinutes?: number`
- `minimumObjectiveImprovement?: number`
- 如现有字段不能直接表达，再补 `maxChangedAssignments?: number`

语义：

- executing/dispatched/人工 LOCK assignment 在 freeze window 内不可移动；
- hard conflict / safety event 可绕过 improvement threshold；
- 普通 replan 若 objective improvement 不足，发出 suppressed decision，而不是发布新方案；
- 超过 changed assignment budget 转人工审批；
- 每个 suppress/approve/replan 决策必须可解释、可审计。

五、P2：Scheduler realtime wake-up

当前 `SchedulerStreamService.start()` 仍是固定 2 秒 DB polling。

实现：

transactional outbox
→ PostgreSQL AFTER INSERT trigger
→ `pg_notify('scheduler_outbox', ...)`
→ `PgNotifyListener`
→ SchedulerStream immediate poll
→ SSE

同时必须保留原 2s polling 作为 fallback。

要求：

- NOTIFY 只做 wake-up；
- durable source 仍是 outbox；
- sequence/replay/Last-Event-ID/gap/resync 不变；
- LISTEN 建连失败继续 polling；
- listener 断线重连；
- shutdown 正确释放连接。

新增 migration：

- `standalone_024_scheduler_outbox_notify.sql`
- rollback
- verify
- 更新 migration runner/manifest（按仓库当前约定）。

六、Command Map 人机协同

统一：

React Query = server state
Single SSE Provider = incremental update
CommandMap UI store/state = interaction only
Backend = decision authority

统一 UI state：

- selectedTaskId
- selectedResourceId
- selectedPlanId
- selectedAssignmentId
- comparePlanIds
- activeLayers
- activePanel
- viewport
- previewOverride

地图必须明确区分：

- fact
- recommendation
- manual preview
- approved plan
- conflict
- degraded/stale data

点击任务时要能回答：

“为什么推荐 A，不推荐 B？”

显示：

- priority factors；
- candidate rank；
- hard constraint pass/fail；
- skill/cert；
- ETA/location；
- workload；
- reservation；
- objective contribution；
- rejection reason；
- snapshotVersion；
- policyVersion；
- solverVersion。

七、禁止事项

- 禁止创建第二套 Scheduler；
- 禁止在 `ui/command_map/` 实现生产功能；
- 禁止前端重新实现 eligibility/score；
- 禁止 `(0,0)` 假坐标；
- 禁止 stale snapshot dispatch；
- 禁止 degraded route 冒充真实路线；
- 禁止 ML/prediction 绕过 hard constraint；
- 禁止破坏 RLS/RBAC/audit/approval；
- 禁止修改历史 migration，新增只允许增量 migration；
- 禁止为了旧单测保留生产 silent fallback。

八、实施顺序

P0：
1. required deps + test mocks
2. single SSE provider
3. unified selected plan state
4. RouteDecisionMode
5. archived README
6. TS/Python parity

P1：
7. Replan Stability Budget

P2：
8. PostgreSQL LISTEN/NOTIFY

P3：
9. explanation/degraded UX

九、测试要求

Server：
- TypeScript compile；
- 全 scheduler Jest；
- route mode tests；
- dispatch tests；
- world state projection parity；
- replan stability；
- SSE wake-up；
- replay/gap/Last-Event-ID。

Client：
- TypeScript compile；
- CommandMap tests；
- 只创建一个 EventSource；
- panel 与 map selectedPlan 同步；
- deep link 刷新恢复；
- degraded route UI；
- override preview。

Python：
- pytest；
- SolverRequest/SolverResponse golden parity；
- enum parity。

DB：
- migration apply；
- migration verify；
- rollback；
- trigger 存在；
- INSERT outbox 能触发 notify；
- notify listener down 时 polling 仍正常。

十、最终验收必须达到

hard constraint violation = 0
double booking = 0
stale snapshot dispatch = 0

并输出：

- scheduler test 数；
- client test 数；
- python test 数；
- tsc 结果；
- eslint 结果；
- migration apply/verify 结果；
- LISTEN/NOTIFY integration result；
- single EventSource test result。

十一、最终交付

执行过程中不要停留在方案讨论。

按顺序：

1. `git status` + 当前 HEAD；
2. 验证上述问题是否仍存在；
3. 已存在则不重复实现；
4. 直接逐项修改；
5. 每项补测试；
6. 全回归；
7. 输出变更文件；
8. 输出 migration；
9. 输出兼容性说明；
10. 输出剩余风险；
11. 生成 PR description；
12. 只有所有验证通过后才标记完成。

不要把“写了代码”视为完成。
完成 = 当前源码 + 测试 + migration + runtime integration evidence 均一致。
```

---

# 16. PR Description 模板

```markdown
## Summary

Converge EWOH Command Map / Scheduler V2 toward production-grade intelligent scheduling.

### P0
- remove silent core dependency fallbacks
- enforce ResourceProjection as WorldState SSOT
- consolidate scheduler SSE to one client connection
- unify Command Map selected scheduling state
- introduce STRICT / DEGRADED / ADVISORY route policy
- add TS ↔ Python scheduler contract golden parity
- mark legacy ui/command_map as archived

### P1
- add replan freeze window
- add minimum objective improvement gate
- control schedule churn

### P2
- add PostgreSQL LISTEN/NOTIFY scheduler wake-up
- retain transactional outbox + polling fallback

## Safety / Compatibility

- NestJS remains scheduling write authority
- Edge remains advisory in connected production mode
- CP-SAT remains optional with explicit heuristic fallback
- hard constraints cannot be bypassed
- no historical migration rewrites
- no changes to RLS/RBAC/audit semantics

## Verification

- [ ] server tsc
- [ ] scheduler Jest
- [ ] client tsc/tests
- [ ] Python pytest
- [ ] TS/Python golden parity
- [ ] DB migration apply
- [ ] DB migration verify
- [ ] DB rollback
- [ ] PostgreSQL notify integration
- [ ] single EventSource client test
- [ ] stale snapshot dispatch test
- [ ] double booking test
- [ ] hard constraint violation = 0
```

---

# 17. 最终结论

EWOH 的正确下一步不是继续堆“智能”功能，而是先完成三个生产收敛：

1. **Single Truth**  
   Resource/World/Scheduler/Frontend 必须只有一条权威状态链。

2. **Stable Decision**  
   调度不仅要优化，还必须知道什么时候“不应该重排”。

3. **Reliable Realtime**  
   Outbox 保证正确性，NOTIFY 提供低延迟，SSE 只负责传播。

完成这三个收敛后，再继续做预测 duration/travel、策略自适应和更强 CP-SAT，才不会把系统复杂度放大成生产风险。
