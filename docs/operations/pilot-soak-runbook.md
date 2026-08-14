# EWOH Pilot Soak 运行手册（常驻试点真值环境）

> 目标：把 `feature-status.yaml` 中所有 `runtimeVerified: false` 的项，在常驻试点环境中
> 逐个翻成 true——这是仓库当前最大的单点卡项：所有「待真实环境」的验收都等这一件事。
> 本手册要求**任何 `runtimeVerified: false` 的功能不得再新增代码**，直到试点把它翻 true
> （诚实边界：本机无 PostgreSQL/Docker/真机，以下步骤在部署环境执行；本地可执行部分
> 已由 `scripts/pilot-soak.sh` 编排，不可执行部分如实输出 BLOCKED，不伪造）。

## 1. 拓扑（最小试点 = 1 边缘盒 + 1 云侧 + 1 真机/仿真源）

```text
[NY-EXO-A1 真机 或 WireInjector 仿真源]
        │ TCP/串口（EWOH_ADAPTER_PORTS）
        ▼
[Edge 盒：python run.py（production 模式，SQLite）] ──edge_to_spark──▶ [云侧 standalone：NestJS + PG17]
        │                                                                        │
        └─ 本地 HTTP/SSE（/api/command-map/stream）                  [React SPA + 飞书侧车]
```

## 2. 部署前检查清单（每项必须 PASS 才进入 soak）

| # | 检查 | 命令/证据 |
|---|---|---|
| P1 | PG17 可用且迁移链全绿 | `node db/runner/run_migrations.js --apply-standalone && --verify-standalone` |
| P2 | standalone 构建与启动 | `npm run build:prod:standalone` + `/health/ready` 200 |
| P3 | Edge production 装配（禁 stub） | `EWOH_RUNTIME_MODE=production python run.py --db /data/ewoh/edge.db`，日志无 stub 字样 |
| P4 | 真机/仿真源注入链路 | 边缘 `/api/status` 在 60s 内出现 telemetry 计数增长（ingest_chain 活体证据） |
| P5 | 云侧 ingest 收到边缘帧 | `GET /api/ingest/...` 遥测计数增长（X-Ingest-Key） |
| P6 | SSE 双通道可达 | `curl -N -H "Authorization: Bearer <token>" /api/scheduler/v2/stream` 15s 内出现心跳 |
| P7 | 飞书侧车验签 + 卡片闭环 | webhook 探针 + 手动点一次卡片「确认」 |

## 3. Soak 运行协议（24/7，最低 8 周）

- **数据源**：真机 4h/天 + `WireInjector`（乱序/补传/故障注入）其余时间；周末全仿真。
- **调度负载**：每 30min 一次 MANUAL run + 事件驱动 replan（TASK_CREATED 写路径）；
  每 10 次 run 触发一次影子评估（已验证自动化存在）。
- **故障注入日历**（每周一轮）：
  - 周一：边缘进程 kill -9 → 重启 → 校验 hydrate 后派工可查（R-3 修复后验证）；
  - 周二：断网 10min（edge→cloud）→ bridge 缓冲补传不丢帧（E-14）；
  - 周三：DB 连接池打满场景（20 并发 SSE）→ 观察降级与恢复（P0-1 SSE 修复后验证）；
  - 周四：PG 主库只读演练 + 备份恢复（`scripts/verify-backup-restore.mjs`）；
  - 周五：CP-SAT worker 上线一天（需部署环境安装 ortools）→ 影子评估比对；
    未部署 ortools 前此步保持 BLOCKED 并如实记录。

## 4. 观测与验收门

- 每小时：`scripts/pilot-soak.sh --report` 输出健康摘要（见下）写入 `output/pilot-soak/`。
- 每周：对照 §6 验收表逐项更新 `feature-status.yaml` 的 `runtimeVerified` 字段并附证据路径。
- 触发退出条件（立即停机排查，不自动恢复）：安全事件误报率 >5%、数据丢失、审计断链。

## 5. 本地可执行部分（scripts/pilot-soak.sh）

编排边缘侧可在无 PG 环境执行的检查（unittest 冒烟 / production 装配门禁 /
connector TCK / 静态门禁），云侧需 PG 的步骤输出 `BLOCKED: <原因>` 而非失败，
保证脚本退出码语义诚实：0=全部通过；2=有 BLOCKED（环境缺失）；非零=真实失败。

## 6. runtimeVerified 验收表（试点每周回填）

| feature | 本地证据（已有） | 试点需补证据 | 翻 true 条件 |
|---|---|---|---|
| edgeServer | production 装配冒烟（CI） | 真机遥测 8 周 soak 无静默 stub | P3+P4 连续 PASS |
| schedulerRls | 真实 PG E2E（CI） | 试点多租户用例 | 已有，无需重验 |
| runtimeGates | 真实 PG（CI） | 试点每日门禁运行 | 已有，无需重验 |
| schedulerV2 / commandMap / decisionCockpit / feishuSidecar | 单测+契约 | 试点真机/真 PG 全链路 | P5+P6+P7 连续 PASS |
| cpSat | 纯函数回归（本次修复） | 部署 ortools 环境求解 fixture + 影子评估 | 周五演练连续 2 周 |
| heuristicSolver | 单测 | 试点基准矩阵复跑 | 见 schedulerV2 |

## 7. 诚实记录规范

- 任何未在试点验证的能力，在 feature-status/README 中保持 `runtimeVerified: false`；
- soak 脚本对无法执行的步骤输出 `BLOCKED`（绝不静默跳过）；
- 每周摘要（hourly 报告聚合）提交到 `docs/operations/pilot-soak/`，附原始日志路径。
