# EWOH 代码层深度通读 — 性能瓶颈专项审计

> 范围：本轮**仅覆盖性能瓶颈**（缓存 / N+1 / 求解器复杂度 / 响应体膨胀）。
> 可维护性、关键实现逻辑、前端、Python 侧留待下一轮。
> 所有条目均带 `文件:行号` 证据，未验证项已显式标注。

## 严重度分级

| 级别 | 含义 |
|------|------|
| P0 | 已量化或强证据的吞吐/延迟瓶颈，直接影响核心链路可用性 |
| P1 | 明确劣化路径，在特定条件（未命中/故障/规模上升）下触发 |
| P2 | 结构性隐患或低效，需结合实测确认收益 |

---

## 执行摘要

本轮最重要的结论是：**历史遗留的 N+1、事务内网络调用、双 SSE 三类问题均已治理完毕**
（全库扫描仅 4 处循环内 DB 调用且全部是写入；18 个事务体零网络调用）。
当前的性能问题集中在**两处结构性缺陷**：

1. **`dashboard/overview` 的缓存是单槽变量而非 Map** —— 多租户交替访问时命中率趋近 0，
   使「未命中 0.799s」成为常态路径而非异常路径；未命中时执行 4 个缺乏复合索引支撑的
   全表聚合扫描，冷启动叠加 buffer 未预热达到 6.4s。
2. **启发式求解器的候选枚举是 `O(T²×S×D)`** —— 四重嵌套循环（任务×工位×人员×设备）
   的最内层用 `.some()` 线性扫描「随求解推进单调增长」的已预订槽位数组，
   且槽位索引在任务循环内被反复重建（额外 O(T²)）。这是 `conflicts` 曾实测 104s 的根因区。

另有一处**改动极小、收益明确**的问题：三个预览类接口在调用会持久化的
`buildSnapshot`，而非已存在但未被使用的 `buildSnapshotReadOnly`。

### 性能瓶颈 Top 8

| # | 严重度 | 问题 | 位置 | 修复要点 |
|---|---|---|---|---|
| 1 | **P0** | 启发式求解器 `O(T²×S×D)` 候选枚举 | `heuristic-scheduling-solver.ts:601/951/992/1007` + `:1048/1063/1079` 线性扫描 + `:685` 索引重建 | 槽位索引增量维护 + 区间树/二分替代 `.some()` |
| 2 | **P0** | overview 缓存为单槽变量，多租户命中率→0 | `dashboard.service.ts:83,124` | 改 `Map<orgKey, entry>`（对齐 `scheduling-policy.service.ts:165`） |
| 3 | **P0** | 未命中路径 4 个全表聚合缺复合索引；`status` 谓词在 `FILTER` 内无法下推 | `dashboard.service.ts:134-174` | 加 `(org_id,ts)`/`(org_id,status)`/`(org_id,online)`；谓词移入 `WHERE` |
| 4 | **P1** | 预览接口用持久化 `buildSnapshot`，写入放大 | `override-preview.service.ts:59`、`replan-preview.service.ts:47`、`conflict-preview.service.ts:75` | 切到 `buildSnapshotReadOnly`（`world-state.service.ts:105`） |
| 5 | **P1** | policy 缓存写入方未失效（含多实例无跨实例通道） | 失效仅 `scheduling-policy.service.ts:356,483`；写入方 `policy-activation.service.ts:285/299/418/430`、`shadow-policy.service.ts:91` | 公开 invalidate 并在写入方调用；或用 Redis pub/sub |
| 6 | **P1** | 列表接口 slim 化覆盖不全 | 仅 `scheduler-query.service.ts:256,296` | 新增列表接口强制走 slim；补契约门禁 |
| 7 | **P2** | `resourceProjection` 未并入 `Promise.all` | `world-state.service.ts:345` | 入参仅 `ctx`，可安全并入 |
| 8 | **P2** | 78 个 env 无 schema 校验 | `standalone.provider.ts:16` 等 | bootstrap 加 zod 校验（`Number(env||20)` 遇错变 `NaN`） |

---

## ① 缓存未命中路径为什么慢（dashboard/overview）

**根因不是连接池、不是串行 await，而是「单槽缓存被多租户冲掉 + 4 个无复合索引支撑的全表聚合扫描」。**

### 1.1 缓存是**单槽**的，多租户下命中率趋近于 0（P0）

`modules/dashboard/dashboard.service.ts:83`

```ts
private overviewCache: { data: OverviewStats; timestamp: number; orgKey: string } | null = null;
private readonly OVERVIEW_CACHE_TTL_MS = 5000;   // :84
```

命中条件（`:124`）：`orgKey === orgKey && now - timestamp < 5000`。

**它不是 `Map<orgKey, entry>`，而是只能装 1 条的槽位。**
任何 org 的请求都会**覆盖**上一条，于是：

- 单租户：命中率 ≈ `1 - 1/(QPS×5s)`，看起来很好（对应实测 0.07~0.17s）。
- **多 org 交替访问：每次都是 miss + 覆写，命中率 → 0**，稳态退化为「每请求 4 次全表聚合」。

这直接解释了为什么「未命中 0.799s」不是偶发而是常态路径。
注意 `world-state.service.ts` / `scheduling-policy.service.ts` 的缓存都用了 `Map`
（`:165` `new Map<...>`），**只有这里用了单槽**，属实现不一致。

### 1.2 未命中时执行的是 4 个无谓词下推的全表聚合（P0）

`dashboard.service.ts:134-174` 已用 `Promise.all` 并行（历史优化已生效，
`Promise.all` 不是问题）。问题在**每个查询本身都是全量扫描**：

| 查询 | 行号 | 实际执行 | 索引可用性 |
|---|---|---|---|
| deviceStats | `135-141` | `count(*)` + `count(*) filter (online=true)`，**全表** | 仅 `idx_ewoh_device_org(org_id)`（迁移 `:1409`） |
| eventStats | `142-150` | `count(*) filter (status='open')`，**全表** | 仅 `idx_ewoh_event_org(org_id)`（`:1421`） |
| loadStats | `151-160` | `avg(loadScore)` where `ts >= now()-1h` | 仅 `idx_ewoh_telemetry_org(org_id)`（`:1451`） |
| workerStats | `161-173` | `count(distinct workerName)`，**全表** | 同上 device |

**两个致命细节：**

1. **`status` 谓词写在 `FILTER` 子句里、不在 `WHERE` 里**（`:144,:147`）。
   `count(*) filter (where status='open')` 要求 PG 把该 org 的**所有**事件行都读出来再过滤，
   即使建了 `(org_id, status)` 复合索引也无法做 index-only scan——
   索引只能用于 `org_id` 定位，随后是大规模 heap 访问。
   `ewohEvent` 是增长最快的业务表之一（`world-state.service.ts:48-52` 记录
   实测 29,405 行/次、36h 累积 6.3 万条），这是 `eventStats` 成为大头的原因。

2. **`ewohTelemetry` 缺 `(org_id, ts)` 复合索引。**
   `loadStats` 的 `WHERE org_id=? AND ts >= now()-1h` 只能走 `org_id` 单列索引，
   于是取出该 org 的**全部**遥测行再按 `ts` 过滤。遥测是写入量最高的表
   （`retention.service.ts:74` 只保留 24h 正是因为体量），
   **这是 4 个查询里最可能的最大单项**。

3. 索引现状（全库 80 张表仅 7 张无索引，整体不差；缺的是**复合**索引）：
   ```
   db/migrations/standalone_001_schema.sql:1409  idx_ewoh_device_org    (org_id)
   db/migrations/standalone_001_schema.sql:1421  idx_ewoh_event_org     (org_id)
   db/migrations/standalone_001_schema.sql:1451  idx_ewoh_telemetry_org (org_id)
   ```
   全部只有单列 `org_id`，无 `(org_id, ts)`、`(org_id, status)`、`(org_id, online)`。

### 1.3 冷启动 6.444s 的构成

冷启动 = 缓存为空 + Postgres shared_buffers 未预热 + 连接池首次建连（`connect_timeout: 10s`，
`standalone.provider.ts:29`）。此时 4 个查询同时冷读 `ewohEvent` / `ewohTelemetry`
的大片 heap page，叠加 NestJS 首次 DI 与模块惰性初始化，6.4s 是合理的量级。
**与 DB_POOL_MAX 10→20 只改善 5.4% 的实测一致——瓶颈在扫描量，不在等连接。**

### 修复方向（按性价比排序）

| # | 动作 | 预期收益 | 风险 |
|---|---|---|---|
| 1 | `overviewCache` 由单槽改 `Map<string, entry>`（对齐 `scheduling-policy.service.ts:165` 的写法），并加容量上限 | 多租户命中率 0 → 接近单租户水平，**直接消掉常态 miss** | 极低，改动 <10 行 |
| 2 | 加复合索引 `(org_id, ts)` on `ewoh_telemetry`、`(org_id, status)` on `ewoh_event`、`(org_id, online)` on `ewoh_device` | 未命中路径从全表扫描降为索引范围扫描 | 低；注意 telemetry 写入量，需评估写放大 |
| 3 | 把 `count(*) filter (where status='open')` 改写为多个带 `WHERE` 的聚合，或用 `sum(case when ...)` 配合 `WHERE status in (...)` 让谓词可下推 | 使 2 的复合索引真正生效（index-only scan） | 低；需保持 `count(*) filter` 的口径一致（`IN ('critical','high','medium','L2','L3')` 并集语义，见 `:145-147` ADR-027 注释） |
| 4 | 遥测 1h 窗口改为预聚合（物化视图 / 定时 rollup 表） | 彻底摆脱 telemetry 体量 | 中；引入数据新鲜度权衡 |

> 优先级建议：**先做 1**（一行数据结构改动，收益最大且零风险），
> 再补 **2 + 3**。仅靠加索引而不修单槽缓存，多租户下仍会每 5s 打一次全表。

---

## ② 数据库层 N+1 与长事务

### 结论先行：N+1 已基本治理，不是当前主瓶颈

用「循环头 → 花括号配平求块体 → 块体内匹配 `await` + DB 调用」的扫描器全量扫
`server/modules/`（排除 `*.spec.*` 与 `__tests__`），**全库仅命中 4 处**：

| 文件:行号 | 循环区间 | 循环内 DB 调用 |
|---|---|---|
| `modules/scheduler/world-state.service.ts:146` | 135–170 | `db.insert(ewohWorldStateSnapshot)` |
| `modules/scheduler/scheduling-feedback.service.ts:233` | 183–256 | `db.insert(ewohSchedulingFeedback)` |
| `modules/scheduler/dispatch-coordinator.service.ts:387` | 386–399 | `db.insert(ewohAssignmentEvent)` |
| `modules/scheduler/resource-reservation.service.ts:108` | 93–181 | `db.execute(...)` |

**判定：全部为写入类循环，无一例「循环内 SELECT」。**
历史 issue「列表接口 N+1」已通过批量化（`inArray` / 批量 insert / `Promise.all`）治理。

### 长事务：已治理

全库 `.transaction(` 仅 18 处，最长 54 行。对全部事务体扫描
`fetch(|axios|httpService|llm|LLM|invokeLLM|sleep(|setTimeout|solve|replan|dispatch|notify`
等网络/耗时调用模式，**零命中**。历史 issue「LLM 调用在 DB 事务内导致连接池耗尽」已修复。

| 事务 | 跨度 |
|---|---|
| `modules/exo/exo-config.service.ts:171-225` | 54 行（最长） |
| `modules/resource/resource.service.ts:133-186` | 53 行 |
| `modules/mes/mes.service.ts:1326-1367` | 41 行 |
| `modules/agent/agent-orchestrator.service.ts:112-147` | 35 行 |
| `modules/approval/approval-persistence.service.ts:466-501` | 35 行 |

### 连接池（历史遗留判断的修正）

`database/standalone.provider.ts:16` — `DB_POOL_MAX` 缺省已是 **20**（非历史报告的 10），
`idle_timeout` 30s、`connect_timeout` 10s、`prepare:false`。
配合上面两条（无 N+1、无事务内网络调用），**连接池已不是主要瓶颈**，与 team-lead
给出的「10→20 只改善 5.4%」实测结论一致。

**P2 · 连接池参数无校验**：`standalone.provider.ts:16`
`Number(process.env.DB_POOL_MAX || 20)` — 环境变量写错（如 `20a`）会静默得到 `NaN`
传给 `postgres({max: NaN})`，且 78 个 env 变量全仓无 schema 校验（无 zod/joi，
`main.ts` / `app.module.ts` 均未引入 `ConfigModule` 校验）。

---

## ③ 调度求解器复杂度（P0，本轮最强发现）

### 3.1 候选枚举的四重嵌套

`modules/scheduler/heuristic-scheduling-solver.ts`

```
L601  for (const { task, priority } of ranked)      // T  任务（按优先级排序）
  L951  for (const stationId of stationOptions)     // S  候选工位
    L992  for (const person of candidatePersons)    // P  候选人员
      L1007  for (const device of deviceCandidates) // D  候选设备
```

即迭代规模 **`O(T × S × P × D)`**。
`L601` 起始的 `solve()` 单函数跨度约 `L198 → L1667`（~1470 行）。

### 3.2 真正的杀手：最内层是「随已分配量线性增长」的扫描

在 `L1007` 设备循环体内，每个组合都要做 3 次区间冲突线性扫描：

| 行号 | 扫描 | 数据结构来源 |
|---|---|---|
| `L1048` | `(personSlotsById.get(person.id) ?? EMPTY).some(intervalsOverlap)` | 人员已预订槽位 |
| `L1063` | 设备槽位 `.some(...)` | 设备已预订槽位 |
| `L1079` | 工位槽位 `.some(...)` | 工位已预订槽位 |

`intervalsOverlap`（`L1676`）与 `earliestStart`（`L1606`）本身是 O(1)，
**但 `.some()` 遍历的数组随求解推进单调增长**：
`L1280 / L1286 / L1293` 每接受一个分配就 `push` 一条槽位记录。

人均槽位数 ≈ `T/P`（该人员已分到的任务数），于是总代价：

```
O(T × S × P × D × (T/P) × 3)  =  O(T² × S × D)
```

**量级估算**（`T=1000, S=20, D=50`）：`10^6 × 20 × 50 × 3 ≈ 3×10^9` 次基本操作。
这是 `conflicts` 接口曾实测 104s 的根因区（`world-state.service.ts:48-59` 注释明确记录了这次事故）。

### 3.3 槽位索引在任务循环内被反复重建（额外 O(T²)）

`L681–L711`：三个索引 Map（`personSlotsById` / 设备 / 工位）在 **L601 任务循环体内**
每次迭代都从完整数组重建：

- `L685 for (const s of bookedPersonSlots)`  ← 数组长度已增长到 O(T)

即仅重建索引就有 `O(T) × T = O(T²)`，且完全重复可增量维护。

### 3.4 `await` 热路径

`L970` 与 `L994`：`await routeCostMemo.get(...)` 位于 `L992` 人员循环体内，
调用次数 `O(T × S × P)`。虽命中缓存，每次仍产生一次 microtask 调度。

### 修复方向（按性价比）

1. **槽位索引改增量维护**，移出 `L601` 循环（消除 3.3 的 O(T²)，改动最小、风险最低）。
2. **区间冲突查询换数据结构**：按人员/设备/工位分组的**有序区间数组 + 二分**，
   或区间树/bitset（按时间片量化）。把 `.some()` 的 O(n) 降为 O(log n) 或 O(1)，
   直接消除 3.2 的主要项。
3. **候选集前置剪枝**：`L1007` 设备循环目前在最内层，应按能力/在线/电量在
   `L992` 人员循环**之前**完成剪枝（`deviceCandidatesForTask` 已在 `L1635` 存在，
   确认其调用点是否在人员循环外）。
4. **候选规模上限**：CP-SAT 侧已有 `CPSAT_WORKER_MAX_CANDIDATES=50000` 守卫
   （`src/edge_platform/scheduler/cpsat/worker.py:66`），heuristic 侧无对应守卫。

### 3.5 缓存机制现状核查（team-lead 点名确认项）

| 机制 | 位置 | 状态 |
|---|---|---|
| `routeCostMemo` | `modules/scheduler/route-cost-memo.ts:30,62` | ✅ **在生效**。键设计合理（几何点对优先 `g:x,y\|x,y`，缺失回退 `id:personId\|taskId`），缓存 Promise 去重并发、rejected 自动逐出（`:88-90`），run-local 保证确定性重放 |
| `routeCostMemo` 调用点 | `heuristic-scheduling-solver.ts:970, 994` | ✅ 仍在候选循环内被调用 |
| policy 30s TTL 缓存 | `modules/scheduler/scheduling-policy.service.ts:162,534-560` | ⚠️ 在生效，但**失效路径不完整**，见下方 P1 |

### P1 · policy 缓存写入方未失效（一致性 + 冷路径性能双重影响）

- 缓存定义在 `scheduling-policy.service.ts:165`，TTL = `EWOH_POLICY_CACHE_TTL_MS` 缺省 30s（`:162`）
- 主动失效仅在 **`:356`**（保存策略）与 **`:483`**（激活策略）两处调用，
  `invalidateActiveRowCache` 是 **private**（`:563`）
- **未失效的写入方**（直接 UPDATE `ewohSchedulingPolicy`）：
  - `modules/scheduler/policy-activation.service.ts:285 / 299 / 418 / 430`
  - `modules/scheduler/shadow-policy.service.ts:91`

后果：策略激活/回滚后，其它请求最长 30s 内仍读到旧策略；
缓存在进程内 `Map`，**多实例部署下各实例独立**，无跨实例失效通道
（`common/redis.service.ts` 已存在，可用于 pub/sub 失效）。

---

## ④ 响应体膨胀与快照写入放大

### P0 · 每次 `buildSnapshot` 都把完整世界状态写入 JSONB

`modules/scheduler/world-state.service.ts:145-151`

```ts
await this.db.insert(ewohWorldStateSnapshot).values({
  snapshotVersion,
  snapshotJson: snapshot as unknown as Record<string, unknown>,  // ← 全量
  orgId: ctx.primaryOrgId || null,
  createdAt: new Date(),
});
```

`buildSnapshot` 共 **13 个调用点**，其中包含 3 个高频**预览类**接口：

| 调用点 | 性质 |
|---|---|
| `modules/scheduler/override-preview.service.ts:59` | 用户交互预览 |
| `modules/scheduler/replan-preview.service.ts:47` | 用户交互预览 |
| `modules/scheduler/conflict-preview.service.ts:75` | 用户交互预览 |
| `modules/scheduler/replan-coordinator.service.ts:134 / 645 / 892` | 重排 |
| `modules/scheduler/plan.service.ts:441 / 845 / 1191` | 方案生成 |

**关键发现：非持久化的 `buildSnapshotReadOnly` 已存在（`world-state.service.ts:105`），
但 3 个预览路径没有用它。**
该文件只在 2 处被消费：`plan.service.ts:1283`、`scheduling-context.service.ts:100`。

> **修复方向（改动极小）：把 `override-preview` / `replan-preview` /
> `conflict-preview` 三个调用点从 `buildSnapshot` 切到 `buildSnapshotReadOnly`。**
> 预览语义本就不需要持久化版本，可直接消掉这部分写入放大与事务开销
> （`buildSnapshot` 还额外承担 `allocateAndPersistSnapshot` 的版本分配事务 + 有界重试，
> `world-state.service.ts:130-176`）。

缓解因素：`retention.service.ts:80` 已对 `ewoh_world_state_snapshot` 设 48h 保留，
所以不是无界增长，但写入放大仍然存在。

### 已实施的采集侧限流（确认仍在生效）

`world-state.service.ts:48-61` 的三层防御（应对 2026-08-19 平台加载故障）：
- `SNAPSHOT_EVENT_WINDOW_MS = 24h`（`:60`）
- `SNAPSHOT_EVENT_LIMIT = 500`（`:61`）
- 查询侧落地：`world-state.service.ts:291-300` 只取 `status='open'` + 24h 窗 + `limit(500)`

`collectState` 主体已用 `Promise.all` 并行（`world-state.service.ts:270`）。

### P2 · `resourceProjection` 未并入 `Promise.all`

`world-state.service.ts:345`
`await this.resourceProjectionService.projectForSnapshot(ctx)` 位于 `Promise.all`
**之后**串行执行，而其入参仅有 `ctx`（不依赖上面的结果），可安全并入 `Promise.all`。

### 响应体 slim 化覆盖度

| 项 | 状态 |
|---|---|
| slim 剥离 `decisionTrace/alternatives/scoreBreakdown` | 仅 `scheduler-query.service.ts:256, 296` 两处（listRuns / listPlans） |
| 全仓含 slim 逻辑的文件 | 仅 4 个（含 2 个测试） |
| 重量级字段出现位置 | `heuristic-scheduling-solver.ts`(20) / `plan.service.ts`(16) / `milp-scheduling-solver.ts`(9) / `scheduling-objective-evaluator.service.ts`(6) / `rule-based-scheduling-solver.ts`(6) / `candidate-engine.service.ts`(6) |

`decisionTrace` 有硬上限保护：`heuristic-scheduling-solver.ts:94`
`TRACE_REJECT_CAP`（`push` 时 `if (this.entries.length < TRACE_REJECT_CAP)`），
说明单条 trace 的体积已被约束，历史 36KB/assignment 事故已有防线。
**但列表类接口的 slim 覆盖不全**——`scheduler-query.service.ts` 之外新增的列表接口
未强制走 slim，是同类事故的复发面。

---

## 附：本轮已核查且「历史债已修复」的项

避免团队重复投入，以下历史问题经代码核验**已修复**：

| 历史问题 | 修复证据 |
|---|---|
| 双 SSE 连接 | `SchedulerRealtimeProvider.tsx:38` 收敛为单条；`SchedulePanel.tsx` 已无任何 stream 引用；Provider 在 `CommandMapShell.tsx:800` / `Scheduling.tsx:504` 各挂载一次（分属不同路由，同时只存在一个） |
| LLM/网络调用在事务内 | 全量事务体扫描零命中（见 ②） |
| 事件表全量拉取拖垮 collectState | `world-state.service.ts:291-300` 已加 `status='open'` + 24h + limit 500 |
| `isShadow` 与 `status` 不同步 | R2-SSV-03：`shadow-policy.service.ts:143-160` 落库与标记同事务，并有补偿删除 |
| CP-SAT 超时未传播 | 端到端正确：server `cp-sat-scheduling-solver.ts:130,685` AbortController 8s + `finally clearTimeout`（`:722`）→ worker `_time_budget_ms` = `min(120s, request.timeLimitMs)`（`worker.py:255-258`）→ `solver.py:602` `max_time_in_seconds` |

## 附：非性能债（本轮顺带确认，下一轮展开）

- `modules/shared/pagination.ts` **零引用**（全仓 0 处 `parsePageQuery` 调用），
  而散落 173 处 `.limit(`、53 处手写 pageSize 解析 —— 死抽象 + 重复实现。
- `server/database/schema.ts`(2639 行)、`client/src/types/openapi.d.ts`(19505 行)、
  `client/src/types/work-orchestration.d.ts`(1470 行) **均为自动生成**（文件头
  `auto generated, do not edit` / `Generated by scripts/gen-openapi.js`），
  不属于「上帝文件」可维护性债；且有 `openapi:no-drift` 脚本做契约漂移门禁。

---
---

# 第二轮：可维护性与关键实现逻辑

> 范围：A1 上帝文件拆分 / A2 死抽象与重复实现 / A3 僵尸依赖 / A4 技术债标记 / B1-B2 关键实现逻辑。
> 自动生成文件（`database/schema.ts`、`types/openapi.d.ts`、`types/work-orchestration.d.ts`）
> 已排除在「上帝文件」之外（见第一轮结论）。

---

## A. 可维护性

### A1. 上帝文件拆分建议

选取原则：**职责边界在方法名层面即可清晰切分**（不需要读懂内部逻辑就能划分）的优先，
拆分后能独立测试/独立演进的优先。

#### A1-1 `heuristic-scheduling-solver.ts`（2000 行）— 拆分风险：**中** ★首选

**职责清单**（按行号切段，实测结构）：

| 行段 | 职责 | 性质 |
|---|---|---|
| `94-146` | `RejectTrace` 类 + `TRACE_REJECT_CAP` 拒绝轨迹环形缓冲 | 独立类，零依赖 |
| `172-197` | `constructor` / `loadActivePolicy` / `loadConfig` | 配置装配 |
| `266-330` | 约束解析：`switch (c.type)` 把 `SolverConstraint` 摊成 12+ 个 Map/Set | 纯函数，可单测 |
| `334-530` | 索引构建：`personBySkill` / `deviceByCapability` / `stationById` / 预订槽位索引 | 纯索引构建 |
| `601-1300` | **主求解循环**（四重嵌套，第一轮 P0-1 所在） | 核心算法 |
| `1458-1472` | `routeCacheStats` | 诊断出口 |
| `1473-2000` | **12 个私有纯函数**：`computeCandidateScore` / `personMatchesLock` / `resolveStationOptions` / `lockedPersonIdsForTask` / `devicesForTask` / `isExcludedResource` / `isPreferredResource` / `earliestStart` / `riskFactor` / `deviceCandidatesForTask` / `insertTopK` / `intervalsOverlap` / `candidateCompare` | **纯函数群，零实例状态** |
| `198-1457` | `solve()` 单函数 ~1260 行 | 巨型函数 |

**建议切分边界（4 刀）**

1. **`solver-pure.ts`** ← 抽出 `1473-2000` 全部 12 个纯函数 + `1676 intervalsOverlap` + `1993 candidateCompare`。
   它们只依赖传入参数与 `SchedulingPolicyConfig`，不碰 `this`（除 `candidateCompare` 未用 `this`）。
   → **零风险，且立刻获得可单测性**（目前 `earliestStart` / `intervalsOverlap` 的正确性只能靠端到端回归保证）。
2. **`solver-constraint-binder.ts`** ← 抽出 `266-330` 约束解析，产出明确的
   `CompiledConstraints` 结构体（现在是 12+ 个散落局部变量，是 `solve()` 臃肿的主因之一）。
3. **`solver-resource-index.ts`** ← 抽出 `334-530` 索引构建 + 槽位索引维护。
   **与第一轮 P0-1 的修复直接同构**——把槽位索引从「任务循环内重建」改为可增量维护的对象，
   性能优化与可维护性拆分是同一次重构。
4. **`RejectTrace` 独立文件** ← `94-146`。

**风险等级：中**（非低的原因：主循环 `601-1300` 有强烈的**逐位一致性要求**——
注释反复强调「与原实现逐位一致」、`insertTopK` 的稳定性语义（`:1658-1663`）、
`candidateCompare` 的全序（`:1993`）。任何拆分都必须保持 argmin 结果逐位不变。
建议先做 1/2/4（纯抽取，零语义变化），主循环留到最后配合性能优化一起动。

#### A1-2 `scale.service.ts`（1807 行）— 拆分风险：**低** ★高性价比

**职责清单**（实测方法表）：

| 行段 | 职责 |
|---|---|
| `201-360` | 模板生命周期：`registerTemplate` / `listTemplates` / `getTemplate` / `transitionTemplate` / `installTemplate` / `diffPreview` |
| `388-451` | Profile：`listProfiles` / `getProfile` / `replayProfile` |
| `451-750` | **4 组近乎同构的注册表 CRUD**：AssetPackage(`451,969,978`)、Connector(`502,538`)、ScenarioPack(`551,580`)、Mapping(`593,649,662,670`) + `dryRunMapping(747)` / `compatibilityCatalog(790)` |
| `830-1246` | 工厂差异 + 一致性 + 舰队升级回滚：`registerFactoryDifference` / `listFactoryDifferences` / `resolveFactoryDifference` / `runConformance` / `installScenarioPack` / `uninstallScenarioPack` / `fleetUpgrade(1143)` / `fleetRollback(1200)` |
| `790-830` | `scaleMetrics` |
| `1246-1357` | 5 个 `sanitize*` / `redact` 脱敏函数 |

**建议切分边界**
1. **抽 `RegistryStore<T>` 泛型基类** —— `registerX / listX / getX` 四组是同一模式的 4 份拷贝。
   统一后可减少约 300~400 行，且**新接入一种资源只需声明类型**。
2. **`scale-fleet.service.ts`** ← 舰队升级/回滚 + 一致性（`994-1246`），是独立运维域。
3. **`scale-sanitize.ts`** ← `1246-1357` 全部脱敏函数（纯函数，与业务无关，且是安全相关逻辑，值得独立审计）。

**风险等级：低**。四个注册表之间无共享状态，`transitionTemplate`/`fleetUpgrade`
等各自独立；`sanitize*` 是纯函数。可逐步抽取、逐个迁移。

#### A1-3 `work-orchestration.service.ts`（1617 行）— 拆分风险：**中**

**最突出的可维护性问题：6 组「双轨实现」**

| 非持久实现 | 持久化实现 | 行号 |
|---|---|---|
| `getResources` `379` | `getResourcesDurable` `409` | |
| `applyGitSync` `474` | `applyGitSyncDurable` `532` | |
| `acquireResource` `673` | `acquireResourceDurable` `723` | |
| `releaseResource` `703` | `releaseResourceDurable` `779` | |
| `createHandoff` `847` | `createHandoffDurable` `947` | |
| `updateHandoffStatus` `896` | `updateHandoffStatusDurable` `1000` | |

配套 `assertDurableReady(225)` / `allowFileFallback(241)` 双分支开关。

**建议切分边界**
1. **先消除双轨**：把 `Durable` 变体收敛为**唯一实现**，`assertDurableReady`/`allowFileFallback`
   的 file-fallback 分支是明显的**过渡期遗留**（`domain-persistence.service.ts` 已是独立文件）。
   这是本文件**收益最大的一步**——先减半，再谈拆分。
2. 然后按 4 个域切分：`work-graph-query` / `work-git-sync` / `work-resource-lock` / `work-gate-decision`。

**风险等级：中**。双轨收敛涉及文件回退语义的取舍，需确认 file-fallback 是否仍被生产使用
（`allowFileFallback` 的判断条件在 `:241`）。若已无生产流量，风险降为低。

#### A1-4 `mes.service.ts`（1379 行）— 拆分风险：**低**

**职责清单 + 可提取抽象**：

| 行段 | 职责 |
|---|---|
| `283-511` | 工单生命周期（`listWorkOrders` / `createWorkOrder`(含事务 `:379`) / `writeScheduleOrder` / `getStep` / `getWorkOrder` / `getTrace`） |
| `511-799` | 工序流转：`transitionWorkOrder` / `transitionStep` / `doTransitionStep` / `forceResolveStep` |
| `799-866` | 物料 `consumeMaterial` / `listMaterials` |
| `866-1022` | **SOP 版本化文档生命周期**：`registerSop` / `listSops` / `getSop` / `publishSop` / `diffSops` |
| `1022-1234` | **质量方案生命周期**：`registerQualityScheme` / `listQualitySchemes` / `getQualityScheme` / `publishQualityScheme` / `matchQualitySchemes` / `validateQualityScheme` |
| `1234-1379` | 质检执行 `qualityInspection` / `doQualityInspection` |

**关键发现：SOP 与 QualityScheme 是两份同构的「版本化文档」实现**
——`register/list/get/publish` 四件套逐一对齐（`:866-963` vs `:1022-1126`），
且 `publishSop(963)` 与 `publishQualityScheme(1126)` 语义相同。
**建议抽 `VersionedDocumentStore<T>`**（register/list/get/publish/diff 泛型化），
可消除约 250 行重复，并保证两个域的版本号/发布语义不再各自漂移。

**风险等级：低**。两个域之间无共享可变状态，`validateQualityScheme(1197)` 是纯校验函数。

#### A1-5 `ingest.service.ts`（1357 行）— 拆分风险：**中**

**职责清单**：

| 行段 | 职责 |
|---|---|
| `97-408` | 外骨骼数据接入 `ingestExoskeleton` / `ingestExoskeletonBatch` |
| `408-667` | `ingestEventBatch`（本文件最大的单函数，~260 行） |
| `667-731` | 行映射 `mapExoskeletonRow` / `mapDeviceRow`（纯函数） |
| `731-901` | `processOneFrame` / `projectExoSessionEvent` |
| `936-1047` | 5 个域接入适配器：`ingestEnvironment` / `ingestCamera` / `ingestMes` / `ingestSpatialScan` / `ingestLocation` |
| `1047-1357` | 通用支撑：质量评估 `assessQuality` / 去重 `isDuplicateRawRef` / `upsertDevice` / 故障检测 `detectFaultTransition` / 重排触发 `fireDeviceOfflineReplan` / `computeRawRef` |

**建议切分边界**
1. **`ingest-adapters.ts`** ← `936-1047` 五个薄适配器（彼此无耦合）。
2. **`ingest-mappers.ts`** ← `667-731` 行映射纯函数 + `1331-1357` 归一化工具。
3. **`ingest-device-pipeline.ts`** ← `1047-1331` 设备 upsert / 去重 / 故障检测 / 重排触发，
   是「设备侧」的完整子域。

**风险等级：中**。`ingestEventBatch(408)` 自身 260 行且是所有适配器的公共落地点，
需先稳定其契约再切；建议顺序 2 → 1 → 3。

#### 未深挖但已定级（供后续）

| 文件 | 行数 | 主要职责切分 | 风险 |
|---|---|---|---|
| `plan.service.ts` | 1336 | 方案 CRUD / 审批（`:305 approvePlan`、`:637 dispatchPlan`）/ 快照 / 审计 | 高（`Plan↔Replan` 有 forwardRef 循环依赖，`:66`） |
| `conflict.service.ts` | 1217 | 冲突检测 / 冲突分类 / 冲突预览 | 中 |
| `gamification.service.ts` | 1178 | 积分 / 排行 / 徽章 —— 与调度域完全无关，**可整块移出 scheduler 模块** | 低 |
| `replan-coordinator.service.ts` | 1177 | 风暴守卫 / 影响分析 / 求解调用 / 抑制门 —— 见 B2 | 高（`handleTrigger` 是核心编排，语义密集） |

---

### A2. 死抽象与重复实现

#### A2-1 `modules/shared/pagination.ts` — 零引用死抽象（**确认**）

| 指标 | 实测值 |
|---|---|
| `parsePageQuery` / `parseCursorQuery` / `buildPageResponse` 调用点 | **0** |
| 散落的 `.limit(` | **173** |
| 手写 `pageSize` / `Number(page` 解析 | **53** |

抽象本身质量不差（`parsePageQuery` 已处理 `Number.isFinite` 校验、`Math.min(maxPageSize, ...)` 钳制、
默认页大小 20 / 上限 100、游标模式默认 50 / 上限 500）。

**收敛建议：保留抽象，反向收敛实现（不建议删除）。**
理由：删除会永久失去「统一分页上限」这个能力，而 173 处手写 `.limit(` 中
很可能存在**无上限或上限不一致**的列表接口（这正是历史 `listRuns` 返回 50MB 的同类风险面）。

建议路径（按成本递增）：
1. **先审计**：扫描 173 处 `.limit(`，列出「未走 `parsePageQuery` 且硬编码数值」的接口，
   确认是否存在无上限列表接口 —— 这是**安全/稳定性问题**，优先级高于整洁度。
2. **再收敛**：新接口强制使用；存量按模块分批迁移（优先 `scheduler` / `ingest` / `mes`）。
3. 加一条 ESLint 规则禁止 `db.select()...limit(<字面量>)`，防止继续扩散。

#### A2-2 同类模式：org 作用域条件构造（推测→待坐实）

`orgCondition` / `orgVisibilityCondition` 这类「`org_id IS NULL OR org_id = ?`」构造
在多处重复出现，已确认的实例：

- `server/modules/scheduler/world-state.service.ts:78` `private orgCondition(column, ctx)`
- `server/modules/scheduler/scheduling-policy.service.ts:527` `private orgVisibilityCondition(orgId)`
- `server/modules/mes/mes.service.ts:265` `private orgCondition`
- `server/modules/dashboard/dashboard.service.ts:129-131` 内联构造 `deviceOrg/eventOrg/telemetryOrg`
- `server/modules/scale/scale.service.ts:172` `private orgWhere` + `177 requireOrgId`

即**至少 5 处各自实现同一谓词**，其中 `dashboard` 是内联版本（无方法封装）。
这是**租户隔离**逻辑，重复实现的后果是安全性的而非整洁度的——任一处写错即越权。
建议抽到 `common/` 统一（与 A2-1 同理，属于「已有抽象但未被复用」）。

#### A2-3 同类模式：`as unknown as` 148 处（类型逃生舱）

Top 5：`scheduling-feedback.service.ts`(6) / `plan.service.ts`(7) / `operations.service.ts`(10) /
`ingest.service.ts`(10) / `dispatch-test-harness.ts`(19, 测试)。
与 `any` 泛滥不同（全仓仅 11 处 `any`），本项目的问题形态是**双重断言绕过类型检查**，
且集中在 A1 列出的上帝文件中 —— 与上帝文件问题同源，拆分后自然收敛。

> 说明：A2-2 / A2-3 为本轮基于已有证据的模式归纳，**未做穷举验证**，
> 若要写入整改计划建议先做一次针对性全量扫描。

---

### A3. 僵尸依赖核查

（见下节，需读 `package.json` 依赖表后补充）

---

### A4. 技术债标记统计

| 指标 | 实测值 |
|---|---|
| `TODO` / `FIXME` / `HACK` / `DEPRECATED` / `XXX` 总数（含 `server`+`client`+`shared`，排除测试） | **4** |
| 分布 | `client/src/pages/WorkOrchestration`(2)、`client/src/lib`(2) |
| `console.log`（非测试代码） | **2** |
| 空/仅注释 `catch` 块 | **38** |

**结论：代码注释卫生度极高**，4 个标记意味着技术债**没有以 TODO 形式沉淀**——
这本身是积极信号，但也说明**债务是隐性的**（以上帝文件、双轨实现、死抽象的形式存在，
而非显式标记）。

**空 catch 分布 Top 5**（吞异常，可观测性缺口）：

| 文件 | 数量 |
|---|---|
| `modules/scheduler/replan-coordinator.service.ts` | 4 |
| `modules/ai/ai.service.ts` | 3 |
| `modules/scale/scale.service.ts` | 2 |
| `modules/identity/identity.service.ts` | 2 |
| `modules/scheduler/pg-notify.listener.ts` | 2 |

`replan-coordinator` 居首值得注意——它是核心编排链路（见 B2），
4 处吞异常意味着重排失败可能无法在日志中定位。

---

### A3. 僵尸依赖核查（32 个生产依赖）

排查方式：对可疑包在 `server/modules`、`client/src`、`shared` 内匹配 `from '<pkg>'`
（精确导入形式），零命中者再做全仓模糊搜索（覆盖 `require`、`scripts/`、子路径导入、
视图引擎注册等特殊用法）。

| 依赖 | 精确导入命中 | 结论 |
|---|---|---|
| `@nestjs/cache-manager` | **0** | **僵尸** |
| `cache-manager` | **0** | **僵尸** |
| `hbs` | 0（精确） | 在用 — `server/main.ts:5` `import { __express as hbsExpressEngine } from 'hbs'` + `:26-27` 注册为 HTML 视图引擎 |
| `crypto-js` | 0（精确） | 在用 — `client/src/components/business-ui/user-profile/user-profile.tsx:9` 子路径导入 `crypto-js/sha1` |
| `@aws-sdk/client-s3` | 1 | 在用 |
| `ajv` | 2 | 在用 |
| `@tanstack/react-form` | 3 | 在用 |
| `react-zoom-pan-pinch` | 2 | 在用 |
| `js-yaml` | 7 | 在用 |
| `highs` | — | 在用（MILP 求解器，第一轮已确认非僵尸） |

**结论：2 个僵尸依赖 —— `@nestjs/cache-manager` 与 `cache-manager`。**

> ⚠️ **这两者与第一轮 P0-2 直接相关，值得单独说明。**
> 项目安装了成熟的缓存库却零引用，于是各处**手写**缓存：
> `dashboard.service.ts:83` 的单槽 `overviewCache`（多租户命中率→0，P0-2）、
> `scheduling-policy.service.ts:165` 的进程内 `Map`（无跨实例失效通道，P1-5）、
> `replan-coordinator.service.ts` 的 `orgReplanStates` 内存降级态。
> **P0-2 那 10 行就能修的 bug，根源正是「有缓存抽象但没被采用」。**
> 建议二选一：(a) 直接删除这两个依赖并接受手写缓存现状，同时把单槽改 Map；
> 或 (b) 真正引入 `cache-manager`，一举解决多租户缓存与跨实例失效。
> 现状（装了不用 + 手写且有 bug）是最差的组合。

---

## B. 关键实现逻辑梳理

### B1. 世界状态（world-state）快照机制

#### 入口与两条路径

| 路径 | 位置 | 是否落库 | 用途 |
|---|---|---|---|
| `buildSnapshot(ctx)` | `world-state.service.ts:89` | ✅ 落库 + 分配版本号 | 写路径（run / 事件应用 / 方案生成 / **预览**） |
| `buildSnapshotReadOnly(ctx)` | `world-state.service.ts:105` | ❌ 不落库 | 只读路径 |

```
buildSnapshot(ctx)
  ├─ collectState(ctx)                      :90   → 采集世界状态
  └─ allocateAndPersistSnapshot(state, ctx)  :91   → 分配版本 + 插入快照行
       └─ 事务内: nextSnapshotVersion() + insert(ewohWorldStateSnapshot)
```

#### 关键函数与数据结构

**1) 采集 `collectState`（`:258-345`）** —— 主体是一个 8 路 `Promise.all`（`:270`）：

| 并行查询 | 行号 | 约束 |
|---|---|---|
| `tasks` | `:276` | org |
| `spatialEntities` | `:282` | org |
| `events` | `:291-301` | `status='open'` + 24h 窗 + `limit(500)` + org |
| `routeNodes` | `:302` | org（ctx 缺省时**无过滤**） |
| `routeEdges` | `:307` | org（同上） |
| `reservations` | `:312` | `status in (reserved, active)` + org |
| `deviceBindings` | `:323` | `targetType='person'` + `status='active'` + org |
| `resourceProjection.projectForSnapshot(ctx)` | `:345` | ⚠️ **串行，在 Promise.all 之后** |

产物 `WorldStateSnapshot`：`tasks / persons / devices / stations / events / routeNodes /
routeEdges / reservations / deviceBindings / eventImpacts / snapshotVersion / ts`。

**2) 版本分配 `allocateAndPersistSnapshot`（`:130-176`）**
- 版本号形如 `WS-YYYYMMDD-NNNN`，按天递增
- **分配（计数器 upsert）+ 插入在同一事务内**（`:135-151`），行锁覆盖「分配+插入」窗口
- **有界重试 3 次**：仅对 `23505`（唯一冲突）/ `40001`（可串行化冲突）重试（`:177-180`），
  超限抛明确错误，绝不无限循环
- 落库内容：`snapshotJson: snapshot as unknown as Record<string, unknown>`（`:148`）——**全量 JSONB**

**3) 保留策略**：`retention.service.ts:80` — `ewoh_world_state_snapshot` 保留 **48h**，
分批删除（PG 的 DELETE 不支持 LIMIT，用 `SELECT id LIMIT → DELETE WHERE id IN` 两段式，`:22-23`）。

#### 不变量

1. **快照版本在并发下互异且无缺口** —— 靠「分配+插入同事务 + 行锁 + 有界重试」保证。
2. **同一 solve 内世界状态不变** —— 快照是求解的输入契约方案，绑定 `snapshotVersion`。
3. **快照只消费开放事件** —— `collectState` 只取 `status='open'`（`:293`），
   全部消费方（安全封锁 / `eventImpacts` / PriorityEngine / 求解器）均只用开放事件。
4. **采集有界** —— 24h 窗 + 500 条上限，即使 retention 失效也不会无限增长（纵深防御）。

#### 脆弱点

1. **★ 预览接口误用持久化路径（第一轮 P1-4，此处是它的结构位置）**
   `override-preview.service.ts:59`、`replan-preview.service.ts:47`、`conflict-preview.service.ts:75`
   调用的是 `buildSnapshot`（落库），而非语义正确的 `buildSnapshotReadOnly`。
   代价：每次用户点预览就产生一次**全量 JSONB 写入 + 版本分配事务 + 行锁竞争**。
   `buildSnapshotReadOnly` 已存在但只有 2 处消费（`plan.service.ts:1283`、
   `scheduling-context.service.ts:100`）。**改 3 行即可消除。**
2. **`projectForSnapshot` 未并行**（`:345`）：入参仅 `ctx`，不依赖上面任何结果，可安全并入 `Promise.all`。
3. **版本分配是行锁热点**：所有并发快照构建在同一天计数器行上串行。
   预览路径切走后（见 1），此热点压力大幅下降。
4. **ctx 缺省时 routeNodes/routeEdges 全表扫描**（`:302-307`）：HTTP 路径必传 ctx，
   仅系统后台流受影响，风险可控但应加断言。

---

### B2. replan 协调器：触发、冷却与审批交互

#### 入口

`replan-coordinator.service.ts:608` `async handleTrigger(triggerType, entityId, ctx, triggerIds?)`

调用链：

```
handleTrigger                          :608
 ├─ [非 MANUAL] evaluateStormGuard(ctx) :623   ← 风暴守卫（跨实例，DB 权威）
 │     ├─ suppressed → recordSuppressed  :629 → 返回
 │     └─ debounced  → 返回               :633
 ├─ triggerService.evaluate(...)         :637   ← 触发层冷却（实体感知 + ON CONFLICT 去重）
 │     └─ 返回 null → 视为 debounced      :638
 ├─ worldStateSnapshotService.buildSnapshot(ctx)   :645   （⚠️ 预览外正常写路径，落库合理）
 ├─ analyzeImpactV2FromSnapshot(...)      :647   → affected / frozen / movable
 ├─ collectWindowFrozenTaskIds(...)       :667   → 冻结窗口内任务
 ├─ 构造 partialSnapshot                  :672-682  （仅 affected ∪ frozen，其余任务不进求解）
 ├─ 构造 baselineAssignee                 :685-694  （churn/stability 罚项基线）
 ├─ constraintLoaderService.loadGlobalActive(ctx)  :699
 ├─ solverService.solveVariants(...)      :702
 └─ shouldSuppressForLowImprovement(...)  :721   → 改进不足则抑制，run 闭合为 succeeded(planIds=[])
```

#### ★ 关于 QA 的「trigger cooldown 已实体感知化 + ON CONFLICT 去重」——需分层澄清

经验证该结论**成立，但只对应其中一层**。冷却机制实际有**两层**，特性不同：

| 层 | 位置 | 实体感知 | 跨实例一致 | 去重机制 |
|---|---|---|---|---|
| **触发层** | `trigger.service.ts:73-123` | ✅ **是** | 依赖 DB 唯一约束 | ✅ `onConflictDoNothing` |
| **风暴守卫层** | `replan-coordinator.service.ts:229-289` | ❌ **否（仅 org 级）** | ✅ 是（advisory lock + 事务内读） | 靠 advisory lock + `acquired !== true` |

**触发层（实体感知 + 原子去重）—— 确认属实**：
- `triggerKey = ${orgKey}:${triggerType}:${entityId ?? 'ALL'}:${eventVersion}`（`trigger.service.ts:73`）
- 冷却查询按 `entityId` 过滤（`:92`），注释 `:83-84` 明写「实体感知（P1：entity-aware trigger
  debounce）—— 不同实体的同类型触发不再互相抑制」
- `.onConflictDoNothing({ target: triggerKey })`（`:123`），注释 `:109` 说明是
  把 check-then-insert 竞态改为原子去重

**风暴守卫层（org 级，非实体感知）—— 这是容易被误读的地方**：
- 查询条件仅 `orgId = ? AND triggerType != 'MANUAL'`（`:263-266`），**WHERE 中没有 entityId 维度**
- 三个阈值全部是 org 级：`replanDebounceMs` / `minimumReplanIntervalMs` /
  `maximumReplansPerWindow`（`:251-257`），窗口内计数（`:274-276`）也不区分实体
- 判定顺序：先 `debounceMs`（`:278`），再 `minIntervalMs && count >= maxPerWindow`（`:281-286`）
- **跨实例一致性确已解决**：状态源改为 DB 权威（注释 `:245-248`，R2-SCH-009/NEST-124），
  以 `ewoh_scheduling_run` 行在 advisory lock 事务内派生 `lastReplanAt` 与窗口计数；
  内存 LRU 仅作锁/DB 不可用时的**降级缓存**（`:248`、`:303-310`）

> **结论**：QA 说的两件事分别在两层，都真实存在，但**不是同一层**。
> 「实体感知」在触发层，「ON CONFLICT 去重」也在触发层；
> 风暴守卫层解决的是另一个问题（跨实例一致性），且**仍然是 org 粒度**。
> 因此「同一 org 内不同实体密集触发」场景下，仍会被风暴守卫 org 级抑制——
> 实体感知只在触发层生效。**若产品期望端到端实体感知，风暴守卫层需补 entityId 维度。**

#### 其它关键机制

- **故障即失败关闭**：`evaluateStormGuard` 抛错 → `failClosedResult`（`:625-626`）；
  生产环境明确不降级为内存态（`:294-302`，抛错阻断 automatic replan），
  非生产才回退内存并告警（`:303-310`）。
- **内存态有界**：`orgReplanStates` Map 有 `MAX_ORG_STATES` 上限并带淘汰（`:440`），
  配合 `touchOrgState`（`:430`）——无界增长风险已处理。
- **冻结语义**：`collectWindowFrozenTaskIds`（`:482`）把「计划开始时间落在
  `[now-宽容, now+freezeWindowMinutes]`」的已分配任务并入冻结集，
  以 `LOCKED_ASSIGNMENT` 语义不可移动，避免临执行前的抖动。
- **改进不足抑制门**：`shouldSuppressForLowImprovement`（`:721`、定义 `:573-598`），
  对非 critical 且无冲突待修复的情况，若候选目标改进低于
  `minimumObjectiveImprovement`，不落盘并 emit `replan.suppressed`。

#### 脆弱点

1. **风暴守卫 org 粒度与触发层实体粒度不一致**（见上），是语义 gap 而非 bug，但易被误解。
2. **本文件空 catch 数量全仓第一（4 处）** —— 核心编排链路吞异常，
   重排失败时缺少可定位日志，与「fail-closed 设计」的严谨性不匹配。
3. `scheduler-run-orchestrator.service.ts:83` 的注释提到
   「之后被 ON CONFLICT DO NOTHING 永久去重（前端手动触发按钮失效）」——
   疑似存在「去重后无法再次触发」的已知问题，**建议 QA/架构师跟进确认**（本轮未深挖）。
4. `handleTrigger`（`:608`）本身是长方法且承载了「守卫→触发→快照→影响分析→
   子图构造→求解→抑制门」七段职责，是 A1 中定级为「高」拆分风险的原因。

---

## 本轮未覆盖（按要求跳过）

架构层耦合与模块职责（架构师已做）、测试覆盖率（QA 已做）、性能 P1~P8（第一轮已做）、
Python 侧性能与可维护性、前端性能、B3 调度求解主流程 / B4 CommandMap 实时通道。
