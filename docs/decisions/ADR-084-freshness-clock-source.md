# ADR-084：资源新鲜度分类的时间原点取数据库时钟

日期：2026-09-19　状态：已采纳

## 背景

资源投影的新鲜度分类（`classifyFreshness`）把持久化时间戳（DB 时钟写入的
`_updated_at` / `actual_start_at` / 遥测 `ts`）与宿主机 `Date.now()` 比较。
2026-09-19 实测：Colima VM 的 PG 时钟可比宿主机超前 26~27ms，写后立读时
`sourceTs > now` → 全部资源瞬时 UNKNOWN → 求解/候选全员 person_unavailable
（device-physics E2E A5 稳定失败；同 HEAD 早晨全绿、下午必红，随钟差符号漂移）。

## 决策

1. **新鲜度分类的时间原点 = 数据库时钟**（`SELECT clock_timestamp()`，每次投影
   收集取一次）。理由：被比较的 `sourceTs` 全部来自 DB 时钟写入，同源比较消除
   双钟混用；DB 实例自身有集群时钟纪律，且不随应用横向扩缩引入新钟。
2. 写侧维持 DB `now()`/DEFAULT（与本决策同源）；应用代码**新增写路径一律显式
   传应用时间戳或使用 DB 默认**，禁止再引入第三种钟。
3. `classifyFreshness` 的 5s 前向钟差容忍（CLOCK_SKEW_TOLERANCE_MS，2026-09-19
   引入）**保留为纵深防御**：防 DB 时钟异常跳变，不作为主要机制。

## 后果

- 写后立读不再翻转（同钟比较）。
- 每次投影收集多一条 `SELECT clock_timestamp()`（单行，成本可忽略）。
- 取时失败回落宿主机 `Date.now()` + 5s 容忍（可用性优先，容忍兜底）。
- 跨源摄入帧（边缘设备自带 ts）仍属外部事实，由 ingest 侧坏时钟闸门处理，
  不在本 ADR 范围。

## 验证

- 单测：DB 时钟超前宿主机 27ms 的写后立读 → FRESH（新增）；
- E2E：device-physics 18/18、golden 22+/22+、receipt 19/19/0（实测）。
