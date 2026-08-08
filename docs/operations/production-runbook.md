# EWOH Production Runbook

> 基于生产验收（2026-08-08，commit a931759）整理。适用于 Pilot/Canary 阶段。

## 生产事实

```
Production Canonical Solver: HeuristicSchedulingSolver
CP-SAT: OPTIONAL / EXPERIMENTAL（未部署 OR-Tools，NOT PRODUCTION READY）
Edge Runtime: edge_platform.runtime（EWOH_RUNTIME_MODE=production 真实装配，fail-fast）
数据库: PostgreSQL 17（schema 事实源 db/migrations standalone_*）
```

## Startup

### Edge Runtime（Python）

```bash
# 真实装配；任何装配失败 fail-fast（不进入 stub）
EWOH_RUNTIME_MODE=production EWOH_DB_PATH=/data/ewoh/edge.db python3 run.py --port 8765
# 验证：/api/status 的 rule_version 应为 risk-rule-v0.2（真实规则引擎，非 stub）
```

### API（NestJS standalone）

```bash
EWOH_DEPLOY_TARGET=standalone \
DATABASE_URL=postgresql://ewoh_api:...@postgres:5432/ewoh \
JWT_SECRET='<32+ chars>' \
INGEST_API_KEY='<key>' \
node dist/server/main.js
# 缺 DATABASE_URL / JWT_SECRET(<32) / INGEST_API_KEY(production) → 启动失败（fail-closed）
```

### Feishu App

```bash
FEISHU_SIMULATOR_ENABLED=false FEISHU_VERIFICATION_TOKEN='<token>' node server/index.js
# 生产禁止 simulator（需 FEISHU_SIMULATOR_ENABLED + ALLOW_SIMULATOR_IN_PRODUCTION 双开关）
```

## Shutdown

- Edge/API：SIGTERM 优雅退出（Flush 遥测缓冲、停止轮询、关闭连接）。
- Feishu：SIGINT/SIGTERM → 停 simulator → 停轮询 → flush 遥测 → 关 HTTP → 关 DB。

## Migration

```bash
node db/runner/run_migrations.js --apply-standalone
node db/runner/run_migrations.js --verify-standalone
node db/runner/run_migrations.js --apply-standalone-users
node db/runner/run_migrations.js --apply-standalone-runtime-role
node db/runner/run_migrations.js --seed-standalone-admin
```
（compose migrate job 已封装此顺序；禁止用 delivery/release SQL 初始化。）

## Rollback

- 迁移回滚：`--rollback-standalone*` 系列。
- 应用回滚：回退镜像到上一版本（迁移向后兼容，先 verify 再回滚）。

## Health Check

- `/health/live`：进程存活（不碰 DB）。
- `/health/ready`：**校验 DB 可达**（select 1），DB 不可达返回 503 —— 作为就绪门禁。
- Edge `/api/status`：services.adapters/inference 应 healthy；rule_version 应为 risk-rule-v0.2。

## Logs

- Edge：stdout `[EWOH]` 前缀 + X-Request-ID 关联。
- API：NestJS logger；关键动作（dispatch/reservation/plan）写 ewoh_audit_log + ewoh_schedule_audit。
- Feishu：`[feishu]` / `[sync]` / `[rules]` 前缀；**不打印 base_token**（已修复）。

## Metrics

- Edge `/metrics`：uptime_seconds、db_counts、event_bus_handler_errors_total、inference 延迟。
- API `/metrics`：通用 HTTP 请求计数 + scheduler_run_total（solver_version/status label）、
  scheduler_fallback_total、scheduler_solver_timeout_total、scheduler_run_duration_ms。

## Backup / Restore

- **Edge（SQLite）**：`BackupManager`（db 文件 + JSON 副本 + integrity_check）：
  ```python
  from edge_platform.backup.manager import BackupManager
  bm = BackupManager()
  bkp = bm.backup('/data/ewoh/edge.db', '/backup/ewoh_edge')
  bm.restore(bkp, '/data/ewoh/edge.db')
  bm.verify('/data/ewoh/edge.db')  # PRAGMA integrity_check
  ```
- **PostgreSQL**：`pg_dump`/`pg_restore`（生产标准）。
- 已实测：Edge backup→destroy→restore→verify 数据完整。

## Restore 后一致性

- Edge 调度状态由 repository 持久化，重启后 `hydrate_from_repository()` 恢复
  （approved plan / reservation / assignment 不丢失）——已实测重启恢复。

## Incident 处理

| 症状 | 检查 | 动作 |
| ---- | ---- | ---- |
| API readiness 503 | DB 连接 | 检查 PostgreSQL 健康/连接池 |
| Edge 启动失败 | 日志 RealAssemblyError | 检查 DB 路径/权限；production 不降级 stub |
| Ingest 503/401 | INGEST_API_KEY | 确认环境变量已配置（production fail-closed） |
| Scheduler fallback 异常 | scheduler_fallback_total | 确认 heuristic 可用；CP-SAT UNAVAILABLE 属预期 |
| Feishu 验签失败 | FEISHU_VERIFICATION_TOKEN | 确认 token 一致；生产缺失=拒绝写操作 |
| SSE 断连 | 前端 useSchedulerStream | 自动 gap 检测→resync→poll fallback→恢复 |

## Scheduler Fallback

- Production Canonical = **HeuristicSchedulingSolver**；CP-SAT 不可用时 solverStatus=
  UNAVAILABLE/FALLBACK 显式标记，**绝不冒充 CP-SAT 成功**。
- 若未来启用 CP-SAT：需 OR-Tools pinned 依赖、worker 容器、readiness、资源限制、
  solver parity 测试、fallback 测试、production shadow 期。

## Edge Failure

- 真实组件装配失败 → fail-fast（进程退出非零），不静默 stub。
- development 模式需显式 EWOH_ALLOW_STUB=1 才允许 stub。

## Ingest Auth Failure

- production 缺 INGEST_API_KEY → 启动失败 + 请求 503（fail-closed）。
- 错误 key → 401。不泄露 key 到日志/响应。

## Feishu Failure

- webhook 验签失败 → 拒绝（fail-closed），不产生业务副作用。
- lark-cli 不可用（ENOENT）→ 同步降级（console.error，不阻断本地服务）；生产需安装 lark-cli。

## SSE Failure

- 前端自动：sequence 去重 → 缺口检测 → resync → 断线重连（Last-Event-ID）→ poll fallback → 恢复实时。
