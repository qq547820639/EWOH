# EWOH Deployment Runbook

Status: validated v1.2 (2026-08-04, Phase 5 补充备份/恢复/边缘/批量升级/回滚点)
Owner: AG-51

## Target Topology

Four zones are preserved:

- Device zone: exoskeleton controllers and local safety loops.
- Edge zone: adapters, protocol normalization, edge inference, buffering.
- Platform zone: NestJS API, Drizzle/PostgreSQL, world state, scheduler, AI,
  audit chain.
- Display zone: React command center and 2D/3D digital world.

## Prerequisites

- PostgreSQL 17 with a migration role that owns the target schema and can run
  DDL. The project dev role currently has USAGE but not CREATE.
- Node.js 22+, npm 10+, Python 3.11+ (runtime stdlib only).

## Database Install

```bash
EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --plan

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --apply

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
node db/runner/run_migrations.js --verify
```

Rollback:

```bash
EWOH_ALLOW_DDL=1 node db/runner/run_migrations.js --rollback
```

## Application Install

```bash
cd ewoh-spark-app
npm ci
EWOH_SKIP_PLUGIN_INIT=1 npm run build
npm start
```

The app serves at `http://localhost:3000/app/<appId>/`.

## Standalone Product Install

```bash
cd ewoh-spark-app
npm ci
npm run build:prod:standalone
EWOH_DEPLOY_TARGET=standalone \
DATABASE_URL='postgresql://ewoh_api:...@127.0.0.1:5432/ewoh' \
JWT_SECRET='<32+ chars>' \
PORT=3000 \
node dist/server/main.js
```

Standalone API serves at `http://127.0.0.1:3000`; login page, command center,
and command map are part of the same origin. Health checks:
`GET /health/live` and `GET /health/ready`.

Verified local smoke: `http://127.0.0.1:3200` with Playwright login and command
map rendering; `scripts/standalone-check.sh` passes end to end.

## Health Checks

- `GET /api/status` on the Python edge platform.
- NestJS app root returns 200.
- DDL verify query must return 48 managed tables, 48 RLS enabled, audit and
  world identity columns present, no direct authenticated DML.

## Operations

- Monitor API errors, RLS failures, world delta lag, device online status,
  audit chain continuity, and 3D load.
- Backup PostgreSQL before any migration.
- Keep rollback scripts in `db/migrations/`.

---

## Database Backup & Restore

> 备份/恢复工具为 `scripts/postgres-logical-backup.mjs`（逻辑备份，导出全部 `ewoh_*`
> 基础表为一 JSON manifest，`ON CONFLICT DO NOTHING` 恢复并推进 identity 序列）。
> 这是**本地/一次性演练与管理备份**工具；生产应叠加 PG 原生 `pg_dump`/时间点恢复（PITR）。

### Backup（逻辑备份）

```bash
node scripts/postgres-logical-backup.mjs \
  --action backup \
  --url 'postgresql://ewoh_api:...@127.0.0.1:5432/ewoh' \
  --out /backup/ewoh_$(date +%Y%m%d_%H%M%S).json
```

- 任何迁移、升级、灰度前**必须**先执行备份。
- 生产建议叠加连续归档（WAL/PITR），本脚本仅做逻辑快照。

### Restore（恢复到已迁移库）

```bash
node scripts/postgres-logical-backup.mjs \
  --action restore \
  --url 'postgresql://ewoh_api:...@127.0.0.1:5432/ewoh_restore' \
  --in /backup/ewoh_<timestamp>.json
```

- 目标库必须是**已迁移**（schema 就绪）的空库；恢复用 `ON CONFLICT DO NOTHING` 幂等写入。
- 恢复后自动推进 identity 序列，避免主键冲突。

### Verify（恢复后校验）

```bash
node scripts/postgres-logical-backup.mjs \
  --action verify \
  --url 'postgresql://ewoh_api:...@127.0.0.1:5432/ewoh_restore' \
  --in /backup/ewoh_<timestamp>.json
```

- 逐表比对行数，不一致即非零退出并报错。

### 恢复后序列冒烟

```bash
RESTORE_URL='postgresql://...' node scripts/post-restore-smoke.mjs
```

- 向 `ewoh_world_delta_log` 插入一条，验证 identity 序列在恢复后仍可推进。

### 编排脚本（一次性演练）

```bash
EWOH_OPS_SOURCE_URL=... EWOH_OPS_RESTORE_ADMIN_URL=... EWOH_OPS_RESTORE_DB=... \
  bash scripts/standalone-ops-check.sh
```

- 创建一次性恢复库 → 应用 schema → 逻辑备份 → 恢复 → 校验 → 序列冒烟。

---

## Edge 断网 / 重连 / 重放 / 远程升级

### 断网与重连

- 边缘侧（`src/edge_platform`）本地缓冲事件，断网时继续采集并落盘。
- 重连后按连续 SEQ 重放，不丢帧、不丢事件（`src/edge_platform/edge/backfill.py`、
  `world_model/replay.py`）。
- 本机验证：`make test` 中 `test_sustained_run` 覆盖 5s 断连重连无数据丢失、36000 帧大流
  无丢包（见 `docs/reviews/LATEST_HEAD_AUDIT.md` §2）。

### 重放（Replay）

- 世界模型/状态回放：`src/edge_platform/world_model/replay.py`，可按时间窗口重建状态快照。
- 断网期间边缘缓冲的事件在恢复后按序重放至平台。

### 远程升级（边缘平台）

- 边缘平台为 Python 零依赖实现，升级采用**先备份、再替换、后回滚**三步：
  1. 备份当前边缘包与配置（`src/edge_platform/scripts/backup_db.py`）。
  2. 部署新版本（替换代码/重启服务）。
  3. 若健康检查失败，回滚到上一版本并重放未提交事件。
- 升级窗口内暂停新事件提交，避免半新半旧状态。

---

## 批量升级 / 灰度 / 暂停 / 回滚

### 升级泳道（Release Ring）

- 环境变量 `EWOH_FACTORY_UPGRADE_RING`（`pilot`/`canary`/`stable`）划分升级批次。
- 优先级：`pilot`（试点）→ `canary`（金丝雀）→ `stable`（稳定），逐级推进。

### 批量升级流程

1. **备份**：对目标库执行 §Database Backup & Restore 的备份。
2. **套用迁移**：`node db/runner/run_migrations.js --apply`（或 `--apply-standalone`）。
3. **校验**：`--verify`（/ `--verify-standalone`）确认 48 张受管表齐备、RLS 开启。
4. **逐批推进**：按工厂先 `pilot`，观察后 `canary`，最后 `stable`。

### 灰度（Canary）

- 先对 `canary` 环部署新版本，观察错误率/延迟（对齐 `docs/delivery/slo-error-budget.md`）。
- 灰度窗口内（建议 ≥10 分钟）无降级再全量。

### 暂停（Pause）

- 灰度或升级中发现异常，立即**暂停后续批次**（不再推进 `canary`→`stable`），
  保留当前批次运行以便回溯。

### 回滚（Rollback）

- 数据库回滚：`EWOH_ALLOW_DDL=1 EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1 node db/runner/run_migrations.js --rollback`
  （`--rollback-users` / `--rollback-standalone` / `--rollback-standalone-users` 按需）。
- 应用回滚：切换回上一镜像版本（K8s 回滚 `kubectl rollout undo`）。
- 数据回滚：从备份恢复逻辑快照（§Database Backup & Restore）。

---

## 可验证回滚点（Verifiable Rollback Points）

每次升级/灰度前记录**可验证回滚点**，作为回滚成功的判定依据：

| 回滚点 | 验证方式 | 通过标准 |
|---|---|---|
| 备份 manifest | 可解析、`format=ewoh-postgres-logical-backup-v1` | 备份文件存在且可读 |
| 迁移前表数 | `--verify` 基线 | 48 张受管表、48 RLS |
| 迁移后表数 | `--verify` 复核 | 与目标版本一致 |
| 恢复后行数 | `verify` 逐表比对 | 行数与备份一致 |
| identity 序列 | `post-restore-smoke.mjs` | 插入成功、序列推进 |
| 健康检查 | `GET /health/live`、`GET /health/ready` | 200 |
| 错误率 | 对齐 SLO（P95≤800ms、错误率≤0.5%） | 未超预算 |

> 回滚成功 = 回到备份点且 `--verify` 通过 + 序列冒烟通过 + 健康检查 200。
> 外部验证项（真实 PG 迁移/回滚/备份恢复、容器/K8s 部署、真实边缘断网演练）在
> `docs/reviews/LATEST_HEAD_AUDIT.md`（Phase 5）登记为 `Blocked by External Validation`。
