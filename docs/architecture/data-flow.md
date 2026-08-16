# EWOH Data Flow Map（数据流地图）

> 维护规范：本文件记录跨运行时数据流与持久化落点；以 08-14 走读实测链路为基线，
> 数据落点变更（新表/新存储/新流）时更新。最后更新：2026-08-14。

## 1. 主数据流总览

```text
┌ 现场/边缘 ─────────────────────────────────────────────────────────────┐
│ 物理设备/传感器/MES                                                      │
│   │ Adapter(codec/protocol，源标识 source)                              │
│   ▼                                                                     │
│ MessageBus ──telemetry──▶ InferencePipeline（2s 滑窗/1s 步长，规则+模型）│
│   │                            │(features→rule→model，consent 门控)     │
│   ▼                            ▼                                        │
│ Storage(SQLite WAL)  ◀──  EventEngine（风险事件 L1-L3，±30s 证据窗口）  │
│   │(telemetry/inference/risk_event/person/device/audit/调度 9 表…)      │
│   ▼                                                                     │
│ 本地 HTTP/SSE API（routes/*，离线可用）                                  │
│   │ EventBus(SSE) ──▶ GET /api/command-map/stream                       │
│   ▼ Edge Bridge（edge_to_spark.py，批量≤100，断线补传/回填）             │
└───────────────┬─────────────────────────────────────────────────────────┘
                ▼ POST /api/ingest/*（X-Ingest-Key fail-closed + X-Org-Id）
┌ 云端/主产品 ────────────────────────────────────────────────────────────┐
│ IngestGuard → ingest.service → 遥测/事件表（PG17，RLS+GUC）              │
│ React SPA → NestJS（TokenGuard→RolesGuard→OrgContext→RequestDatabase-  │
│   Context→RLS→Service→DB）                                              │
│ Scheduler V2：run 触发(冷却+幂等) → WorldStateSnapshot(版本原子分配)     │
│   → 约束过滤 → A/B/C 求解(heuristic canonical / CP-SAT 阶梯 fail-closed)│
│   → plan → approve(version+snapshot 双校验) → dispatch(CAS+容量预占)    │
│   → Outbox(DB 序列) → SSE(sequence/Last-Event-ID/resync/2s 轮询兜底)    │
└───────────────┬─────────────────────────────────────────────────────────┘
                ▼ webhook/推送
┌ 飞书侧车 ───────────────────────────────────────────────────────────────┐
│ 验签(4 道) → 卡片处置 → lark-cli(异步+并发4+熔断) → Base/审批/文档        │
│ better-sqlite3 本地缓存；flushTelemetry 失败保留 buffer                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 关键链路清单

| 链路 | 起点 → 终点 | 一致性机制 |
|---|---|---|
| Web 请求链 | React → NestJS → PG | JWT + RBAC + 请求级事务 GUC + RLS |
| 实时设备数据链 | Device → Edge → /api/ingest → 遥测/事件表 | source 标识、X-Ingest-Key、限流 100/min |
| 身份解析链（NO-02b） | ingest 设备 ID → ewoh_identity_mapping（org 内 active 映射）→ ewoh_telemetry.entity_id | 契约解析规则（ambiguous_identity fail-closed）；未映射 → NULL（legacy 行为不变） |
| 调度闭环 | Task/Person/Device/Spatial → 快照 → 求解 → 审批 → 派工 → SSE | snapshotVersion 双校验、CAS、Outbox 序列 |
| 世界回放 | WorldState+Events+ScheduleTask+TaskStep+ResourceBinding → Replay Timeline | 时间归并、事件前后快照 |
| 边缘离线链 | 本地 SQLite → Bridge 补传 | 回填/backfill、离线判定 10s、批量≤100 |

## 3. 持久化落点（权威事实源）

| 存储 | 位置 | 内容 | 权威源 |
|---|---|---|---|
| SQLite WAL（边缘） | `EWOH_DB_PATH`（默认 demo.db） | 遥测/推理/风险事件/人员/设备/调度/治理/审计 | `src/edge_platform/edge/storage.py` + migrations/v001 |
| PostgreSQL 17（云侧） | `DATABASE_URL` | 56 张表（业务+scheduler 运行时 11 张+审计哈希链） | `db/migrations/standalone_001..031` |
| better-sqlite3（飞书） | 侧车本地 | 同步缓存/事件缓冲 | `ewoh-feishu-app/server/db.js` |
| 文件/对象 | `deploy/` 卷 | 上传文件（upload 安全校验） | docs/architecture/file-storage.md |
| 内存态 | — | 影子评估、预测 provider（advisory，不激活候选） | scheduler/prediction/* |

## 4. 数据流治理规则

1. 模拟数据显式标记（source=simulated / isShadow），禁止混入生产 World State 投影。
2. 事件写路径必须可回放：重要状态可从事件或可审计事实重建（outbox/审计哈希链已具备）。
3. 跨运行时数据必须经过契约层映射（catalog/mappings + contracts/mapping schema），
   禁止运行时私造字段语义。
4. 已知断点（走读实测）：
   - 非 exo 适配器帧与 insert_telemetry 契约不兼容被静默丢弃（待修）。
   - edge_to_spark 批量失效（len≥1 即刷）+ 断连缓冲无界（待修）。
   - 边缘 query_telemetry/query_inference 全表加载 + Python 过滤，长查询持锁阻塞 ingest（待修）。
