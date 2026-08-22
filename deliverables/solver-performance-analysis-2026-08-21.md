# 求解器性能退化根因分析报告

**日期**: 2026-08-21
**分析范围**: EWOH 调度系统 createRun 端到端性能
**问题规模**: 17 任务 × 35 人员 × ~10 工位 × 3 变体

---

## 执行摘要

调度端点 `createRun` 端到端耗时 **~90 秒**（快照构建 ~30s + 求解 ~60s），正常应 <5s。通过源码级分析，定位到 **5 个独立瓶颈**，其中 2 个为 P0 级（直接导致数量级退化），3 个为 P1 级（叠加放大）。

---

## 1. 性能基线对比

| 阶段 | 历史基线 | 当前实际 | 退化倍数 |
|------|---------|---------|---------|
| 快照构建 (collectState) | 2-3s | ~30s | 10-15x |
| 求解 (3 变体) | 2-5s | ~60s | 12-30x |
| 持久化 + 响应 | 1-2s | ~5s | 2-5x |
| **端到端** | **5-10s** | **~90s** | **9-18x** |

---

## 2. 瓶颈分析

### P0-1: routeCostMemo.get() 异步调用风暴

**文件**: `heuristic-scheduling-solver.ts:951-979`
**严重度**: 🔴 P0（求解 ~60s 的主要根因）

#### 问题描述

求解器内层循环对每个 (person, station) 组合调用 `routeCostMemo.get()`，这是一个 **async 函数**，内部调用 `TravelCostService.estimate()` → `routingService.calculateRouteBetween()`。

```
for each task (17):
  for each station option (~1-3):
    for each person (35):      ← routeCostMemo.get() 在这里
      for each device (~5-10):
        eligibility check + score
```

#### 复杂度分析

- 每个任务：1 station × 35 persons = 35 次 `routeCostMemo.get()`
- 17 个任务 × 3 变体 = **~1,785 次 async 调用**
- 每次调用涉及 A* 路径计算或 Euclidean fallback

#### 为什么慢

1. **async 开销**: 即使命中 memo 缓存，async 函数的 microtask 调度在高并发下有显著开销
2. **首次未命中**: memo 是 per-solve-call 的（`createRouteCostMemo` 每次 solve 创建新实例），3 个变体各自独立，无法跨变体复用
3. **A* 路径计算**: `calculateRouteBetween` 涉及图遍历，虽然路由图已 TTL 缓存，但 A* 本身在大图上仍需 ~1-5ms
4. **串行 await**: 内层循环是 `for...of` + `await`，不是并行

#### 修复建议

```typescript
// 方案 A: 同步化路由成本（推荐）
// 预计算所有 person→station 的距离矩阵（一次批量计算），
// 求解器内用纯同步 Map 查找替代 async routeCostMemo.get()
const distanceMatrix = precomputeDistanceMatrix(persons, stations);
// 求解器内:
const routeCost = distanceMatrix.get(person.id, taskPoint); // 同步

// 方案 B: 跨变体共享 memo
// 将 routeCostMemo 从 per-solve-call 提升到 per-solveVariants-call
// 3 个变体共享同一个 memo 实例
```

---

### P0-2: policyService.getConfig() 反复 DB 查询

**文件**: `travel-cost.service.ts:473`, `scheduling-policy.service.ts:findActiveRow()`
**严重度**: 🔴 P0（快照 + 求解 ~30-60s 的叠加根因）

#### 问题描述

`policyService.getActivePolicy()` 和 `policyService.getConfig()` 每次调用都执行一次 DB 查询：

```sql
SELECT * FROM ewoh_scheduling_policy
WHERE active = true
ORDER BY config_version DESC
LIMIT 1
```

调用链路中的调用次数：
- `solveVariants`: 1 次 `getActivePolicy` + 1 次 `getConfig` + 1 次 `resolveProfiles`
- 每个变体 `solve`: 1 次 `getActivePolicy` + 1 次 `getConfig`
- 每次 `euclidean()` fallback: 1 次 `getConfig`
- `buildMatrix`: 1 次 `getActivePolicy`
- **总计**: 10-20+ 次 DB 查询/请求

#### 80 万次 seq_scan 来源

`ewoh_scheduling_policy` 表的 80 万次 seq_scan 来自：
1. 每次 `findActiveRow` 都全表扫描（无 `active=true` 的部分索引）
2. 每次调度请求 10-20 次调用
3. 多租户/多实例并发累积

#### 修复建议

```typescript
// 方案 A: 内存缓存 + TTL（推荐）
// SchedulingPolicyService 内部缓存 active policy，TTL 30s
private cachedPolicy: { policy: SchedulingPolicy; expiresAt: number } | null = null;

async getActivePolicy(orgId?: string | null): Promise<SchedulingPolicy> {
  const now = Date.now();
  if (this.cachedPolicy && this.cachedPolicy.expiresAt > now) {
    return this.cachedPolicy.policy;
  }
  const policy = await this.loadFromDb(orgId);
  this.cachedPolicy = { policy, expiresAt: now + 30_000 };
  return policy;
}

// 方案 B: 添加部分索引
CREATE INDEX CONCURRENTLY idx_scheduling_policy_active
ON ewoh_scheduling_policy (config_version DESC)
WHERE active = true;
```

---

### P1-1: 三变体独立求解无法跨变体复用

**文件**: `solver.service.ts:167-223`
**严重度**: 🟡 P1（3x 放大效应）

#### 问题描述

`solveVariants` 使用 `Promise.all` 并行执行 3 个变体，但每个变体：
1. 独立调用 `getActivePolicy()` + `getConfig()`（2 次 DB 查询）
2. 独立构建 `routeCostMemo`（无法共享缓存）
3. 独立执行完整求解循环

#### 复杂度

- 3 个变体 × (求解循环 + 路由计算 + 策略加载) = 3x 计算量
- 实际上 3 个变体仅权重不同，候选枚举和资格判定完全相同

#### 修复建议

```typescript
// 方案: 候选枚举与评分分离
// 1. 执行一次候选枚举 + 资格判定（共享 routeCostMemo）
// 2. 对每个变体仅重新计算评分（纯 CPU，无 I/O）
const sharedCandidates = await this.enumerateCandidates(snapshot, constraints, opts);
const plans = profiles.map(profile => {
  const weightedPolicy = applyProfile(base, profile);
  return this.scoreAndSelect(sharedCandidates, weightedPolicy, opts);
});
```

---

### P1-2: eventImpacts O(events × tasks) 嵌套循环

**文件**: `world-state.service.ts:629-680`
**严重度**: 🟡 P1（快照 ~30s 的贡献因子）

#### 问题描述

```typescript
const eventImpacts = events.map((e) => {
  // ...
  for (const t of taskList) {  // O(events × tasks)
    if (LOCKED.has(t.status)) continue;
    const related = ...;
    if (related) relatedTaskIds.add(t.id);
  }
  // ...
});
```

当前有 500 个事件（SNAPSHOT_EVENT_LIMIT）× 17 个任务 = 8,500 次迭代。

#### 修复建议

```typescript
// 方案: 倒排索引
const tasksByStation = new Map<string, string[]>();
const tasksByZone = new Map<string, string[]>();
const tasksByDevice = new Map<string, string[]>();
// 一次遍历构建索引
for (const t of taskList) {
  if (t.stationId) (tasksByStation.get(t.stationId) ?? tasksByStation.set(t.stationId, []).get(t.stationId)!).push(t.id);
  // ...
}
// 事件影响查找从 O(tasks) 降为 O(1)
```

---

### P1-3: SHA-256 版本计算

**文件**: `world-state.service.ts:782-790`
**严重度**: 🟡 P1（快照 ~1-3s 的贡献因子）

#### 问题描述

对所有实体（persons + tasks + devices + stations + routes + reservations + zones）的 JSON 序列化做 SHA-256 哈希。

#### 修复建议

```typescript
// 方案: 增量版本（替代全量哈希）
// 仅当实体变更时更新版本号，不变实体复用缓存版本
// 或使用更快的哈希（xxhash / fnv1a）替代 SHA-256
```

---

## 3. 优化实施优先级

| 优先级 | 瓶颈 | 预期收益 | 实施难度 | 建议 |
|--------|------|---------|---------|------|
| P0-1 | routeCostMemo 异步风暴 | -40~50s | 中 | 同步化距离矩阵 |
| P0-2 | policy 反复 DB 查询 | -5~10s | 低 | 内存缓存 + TTL |
| P1-1 | 三变体无法复用 | -30~40s | 中 | 候选枚举与评分分离 |
| P1-2 | eventImpacts 嵌套循环 | -2~5s | 低 | 倒排索引 |
| P1-3 | SHA-256 版本计算 | -1~3s | 低 | 更快哈希/增量版本 |

---

## 4. 关键代码位置

### 快照构建

- 入口: `scheduler-run-orchestrator.service.ts:94` (`buildSnapshot`)
- 核心: `world-state.service.ts:251` (`collectState`)
- 资源投影: `resource-projection.service.ts` (`projectForSnapshot`)
- 事件影响: `world-state.service.ts:629-680`
- 版本计算: `world-state.service.ts:782-790`

### 求解器

- 入口: `solver.service.ts:138` (`solveVariants`)
- 启发式求解: `heuristic-scheduling-solver.ts:198` (`solve`)
- 路由成本: `travel-cost.service.ts:54` (`estimate`)
- 候选引擎: `candidate-engine.service.ts` (`buildCandidatePool`)
- 资格判定: `eligibility.service.ts` (`check`)

---

## 5. 回归测试建议

优化实施后需验证：

1. **结果正确性**: 同一 (snapshot, policy) 输入 → 同一 assignments 输出（确定性）
2. **指标一致性**: objective / scoreBreakdown / violations 与优化前一致
3. **性能回归**: 端到端 <10s（17 任务 × 35 人员 × 3 变体）
4. **内存占用**: 候选缓存不导致内存泄漏

---

## 6. 长期架构建议

1. **异步调度模式**: createRun 立即返回 runId，前端轮询结果（已在 MEMORY.md 中提到）
2. **候选池预计算**: 跨请求复用 eligibility 判定结果（人员/设备状态变化时失效）
3. **CP-SAT 生产化**: 当前 CP-SAT 回退 heuristic 是性能退化的间接原因——CP-SAT 在小规模问题上应 <1s
