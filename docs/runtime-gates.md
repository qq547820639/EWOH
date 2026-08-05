# EWOH 真实运行门禁（Runtime Gates）状态

Status: 2026-08-06 · 依据 `output/code-deepening-baseline.json` 与 CI 工作流审计
Owner: 平台/交付负责人

本文件逐一记录 EWOH 的**真实运行门禁**（真实 PostgreSQL / Docker / Helm / 边缘节点
行为）的自动化与受阻状态。严格遵守「诚实门禁」约束：

- 真实环境不可用的门禁一律标记 **BLOCKED**，绝不伪造通过、不用 mock 顶替、不宣称
  Production Ready。
- 可在 GitHub Actions ubuntu（含 PostgreSQL Service Container / Docker）里真实运行的
  门禁已接入 CI，并给出可复现的一键命令与所需环境变量。
- 本地开发机（macOS，无 PostgreSQL / Docker / Helm / kubectl / kind / k3d）无法复现的
  步骤，即使已在 CI 自动化，仍标注其**本地不可复现**，绝不谎称本地已跑通。

---

## 1. 门禁总表

| # | 门禁 | 状态 | 运行位置 / 命令 | 证据 |
|---|------|------|-----------------|------|
| 1 | PostgreSQL migration apply/verify/rollback/re-apply | ✅ CI 自动化 | `standalone.yml`（`standalone-postgres-check.sh` + F61-02 domain 步骤） | 迁移循环非零退出、DB 对象计数 |
| 2 | HTTP + PostgreSQL E2E | ✅ CI 自动化 | `standalone.yml`（`npm run test:e2e` + `test:browser`） | E2E/Jest 通过数 |
| 3 | concurrency / idempotency / lock-contention | ✅ CI 自动化 | `standalone.yml`（`scripts/verify-domain-concurrency.js`） | 双实例并发脚本非零退出 |
| 4 | Docker image startup + health check | ⚠️ CI 自动化 / 本地 BLOCKED | `standalone.yml`（新增步骤） | `/health/live`、`/health/ready` 200 |
| 5 | Helm install/upgrade/rollback + smoke | 🔴 BLOCKED（静态审计已接入 CI） | `deployment:tck` / `verify-helm-chart.js` | 见 §4.5 |
| 6 | backup/restore + version compatibility drill | ⚠️ CI 自动化 / 本地 BLOCKED | `standalone.yml`（新增步骤） | backup/restore/verify + identity smoke |
| 7 | edge node disconnect/backlog/replay/duplicate | ✅ CI 自动化 | `test.yml`（`make test-contract` + 显式步骤） | Python 测试通过 |
| 8 | canary upgrade + failed rollback | 🔴 BLOCKED（应用层部分覆盖） | 应用层 E2E；基础设施层待集群 | 见 §4.8 |
| 9 | long soak/load test | 🔴 BLOCKED（短时 perf-smoke 可运行） | `npm run perf:smoke` | 见 §4.9 |

图例：✅ = 已在 CI 真实运行；⚠️ = 仅在 CI 可运行（本地环境不可复现）；🔴 = BLOCKED（需真实
基础设施/集群，当前环境无法运行，未伪造证据）。

---

## 2. 已自动化门禁（✅）

### 2.1 G1 PostgreSQL migration apply/verify/rollback/re-apply
- **CI**：`.github/workflows/standalone.yml`
  - 步骤「PostgreSQL 17 migration, RLS, audit, and rollback」→ 执行
    `scripts/standalone-postgres-check.sh`：apply → verify → seed → users → runtime role →
    幂等重放 → RLS/安全校验 → 破坏性 rollback（校验零残留 ewoh_ 对象）→ rebuild。
  - 步骤「F61-02 domain migrations (apply, verify, rollback, re-apply)」→
    `run_migrations.js --apply-standalone-domain` / `--verify` / `--rollback` / `--apply` /
    `--apply`（重入）→ `--verify`，并执行 `migrate-domain-state.js --dry-run`。
- **一键命令（需真实 PG）**：
  ```bash
  export EWOH_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh'
  export EWOH_ALLOW_DDL=1
  export EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1
  bash scripts/standalone-postgres-check.sh
  # 或按需单步：
  node db/runner/run_migrations.js --apply-standalone && node db/runner/run_migrations.js --verify-standalone
  node db/runner/run_migrations.js --rollback-standalone-domain
  node db/runner/run_migrations.js --apply-standalone-domain
  ```
- **所需环境变量/基础设施**：PostgreSQL 17；`EWOH_DATABASE_URL`、`EWOH_RUNTIME_DATABASE_URL`、
  `EWOH_API_DATABASE_PASSWORD`、`EWOH_BOOTSTRAP_ADMIN_USERNAME/PASSWORD`、`EWOH_ALLOW_DDL=1`、
  `EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1`。
- **证据路径**：CI 步骤日志（apply/verify/rollback/rebuild 无错误）、rollback 后
  `relations`/`functions` 计数为 0、`EWOH_DATABASE_URL` 上 verify 查询返回
  `ewoh_domain_table_count=6`。

### 2.2 G2 HTTP + PostgreSQL E2E
- **CI**：`standalone.yml` 步骤「E2E HTTP + PostgreSQL」`npm run test:e2e` 与「Browser
  authenticated flows」`npm run test:browser`，均使用 PostgreSQL Service Container。
- **一键命令（需真实 PG）**：
  ```bash
  export EWOH_E2E_OWNER_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh'
  export EWOH_E2E_RUNTIME_DATABASE_URL='postgresql://ewoh_api:<pw>@127.0.0.1:5432/ewoh'
  cd ewoh-spark-app && npm run test:e2e && npm run test:browser
  ```
- **证据路径**：E2E/Jest 通过数与`<working-directory>/jest.results.json`。

### 2.3 G3 concurrency / idempotency / lock-contention
- **CI**：`standalone.yml` 步骤「F61-02 dual-instance concurrency & upgrade/rollback
  verification」→ `scripts/verify-domain-concurrency.js`（两个独立连接在唯一约束锁竞争、
  乐观版本 CAS、持有者校验、过期锁接管、重入安全上并发）。
- **一键命令（需真实 PG）**：
  ```bash
  export EWOH_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh' EWOH_ALLOW_DDL=1
  node scripts/verify-domain-concurrency.js
  ```
- **证据路径**：脚本非零退出即失败；成功输出并发/幂等/锁竞争断言全部通过。

### 2.4 G7 edge node disconnect/backlog/replay/duplicate
- **CI**：`test.yml` 已通过 `make test-contract`（pytest `tests/`）覆盖，并新增显式命名步骤
  「Edge 节点断连/乱序/重放/去重门禁」运行
  `tests/test_edge_backfill.py` + `tests/test_edge_bridge_ingest.py` +
  `tests/test_connector_runtime.py`。
- **覆盖**：`SequenceBuffer` 乱序重排 / 重复拒绝 / stale / 窗口拒绝 / 缺口检测补传；
  edge bridge 失败批缓冲与成功排空 / `X-Org-Id` 头转发；Sparkplug session 序列缺口与
  重复检测。
- **一键命令**：
  ```bash
  PYTHONPATH=src python3 -m pytest tests/test_edge_backfill.py tests/test_edge_bridge_ingest.py tests/test_connector_runtime.py -q
  ```
- **证据路径**：pytest 通过数（无 PG/硬件依赖，纯单元级）。

---

## 3. 仅 CI 可运行（⚠️，本地环境不可复现）

以下门禁依赖 Docker / 真实 PostgreSQL，当前本地开发机（macOS，无 Docker/PG）**无法
手动复现**，但已在 GitHub Actions ubuntu 上真实运行。**未**在本地伪造成通过。

### 3.1 G4 Docker image startup + health check
- **CI**：`standalone.yml` 新增步骤「Docker image startup + health check」——构建后的
  `ewoh-api:ci` 以 `--network host` 启动（复用 PostgreSQL Service Container 的
  `127.0.0.1:5432`），轮询并校验 `/health/live` 与 `/health/ready` 返回 200；若
  `EWOH_RUNTIME_DATABASE_URL` 未注入则显式输出 `BLOCKED_BY_ENVIRONMENT` 并跳过，不误报通过。
- **一键命令（需 Docker + PostgreSQL 17）**：
  ```bash
  docker build -f deploy/cloud/Dockerfile.api -t ewoh-api:ci .
  docker run --rm --network host \
    -e EWOH_DEPLOY_TARGET=standalone \
    -e EWOH_OWNER_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh' \
    -e EWOH_RUNTIME_DATABASE_URL='postgresql://ewoh_api:<pw>@127.0.0.1:5432/ewoh' \
    ewoh-api:ci
  curl -fsS http://127.0.0.1:3000/health/live
  curl -fsS http://127.0.0.1:3000/health/ready
  ```
- **所需环境变量/基础设施**：Docker；PostgreSQL 17（含 `ewoh_api` 运行时角色）；`EWOH_DEPLOY_TARGET=standalone`。
- **证据路径**：`/health/live` 与 `/health/ready` 的 HTTP 200 响应体。

### 3.2 G6 backup/restore + version compatibility drill
- **CI**：`standalone.yml` 新增步骤「Backup/restore + post-restore identity smoke drill」——
  `postgres-logical-backup.mjs` backup → restore → verify + `post-restore-smoke.mjs`
  （恢复后 identity 序列推进冒烟），全部作用于真实 PostgreSQL Service Container。
- **一键命令（需真实 PG）**：
  ```bash
  export EWOH_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh'
  node scripts/postgres-logical-backup.mjs --action backup --url "$EWOH_DATABASE_URL" --out /tmp/backup.json
  node scripts/postgres-logical-backup.mjs --action restore --url "$EWOH_DATABASE_URL" --in /tmp/backup.json
  node scripts/postgres-logical-backup.mjs --action verify --url "$EWOH_DATABASE_URL" --in /tmp/backup.json
  RESTORE_URL="$EWOH_DATABASE_URL" node scripts/post-restore-smoke.mjs
  ```
- **所需环境变量/基础设施**：PostgreSQL 17（已迁移、含 F61-02 领域表 `ewoh_world_delta_log`）。
- **证据路径**：backup/restore/verify 输出成功、`verify complete`、`identity sequence advanced
  after restore`。
- **诚实说明**：该 drill 为**就地恢复**（`ON CONFLICT DO NOTHING`，同一库内往返），验证脚本
  与格式兼容与行数一致，并非空库全量恢复演练；完整空库恢复 + 跨版本还原仍需真实备份环境。

---

## 4. BLOCKED 门禁（🔴，需真实集群/设备，未伪造证据）

> 这些门禁当前环境（无 Docker/Helm/kubectl/kind/k3d、无真实边缘硬件）无法运行。以下给出
> 一键命令、所需基础设施/环境变量与预期证据路径，作为拿到相应环境后的执行清单。**未**以
> mock 或静态检查顶替其结论。

### 4.1 G5 Helm install/upgrade/rollback + smoke
- **BLOCKED 原因**：需要 kind/k3d 或真实 k8s 集群 + Helm + kubectl + 集群内可达的
  PostgreSQL。本地无 Helm/kubectl/kind/k3d。
- **静态部分（已接入 CI）**：`scripts/verify-helm-chart.js`（123 项图表结构审计）已通过
  `npm run deployment:tck` 在 CI 运行。**静态审计 ≠ 真实安装**。
- **一键命令（需集群）**：
  ```bash
  kind create cluster --name ewoh-ci
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx  # 如需入口
  kubectl create namespace ewoh
  # 预置 Secret（图表不生成 secret）：
  kubectl -n ewoh create secret generic ewoh-secret \
    --from-literal=EWOH_OWNER_DATABASE_URL='postgresql://postgres:<pw>@<pg-host>:5432/ewoh' \
    --from-literal=EWOH_RUNTIME_DATABASE_URL='postgresql://ewoh_api:<pw>@<pg-host>:5432/ewoh' \
    --from-literal=EWOH_JWT_SECRET='<openssl rand -hex 32>'
  helm install ewoh deploy/cloud/helm/ewoh --namespace ewoh --wait --timeout 10m
  # smoke：
  kubectl -n ewoh rollout status deploy/ewoh
  curl -fsS http://<ingress>/health/live && curl -fsS http://<ingress>/health/ready
  # upgrade / rollback：
  helm upgrade ewoh deploy/cloud/helm/ewoh --namespace ewoh --set image.tag=<new> --wait
  helm rollback ewoh 1 --namespace ewoh --wait
  kubectl -n ewoh get pods -o wide   # 确认全部 Ready
  ```
- **所需基础设施/环境变量**：kind/k3d 或 k8s 集群；PostgreSQL 17（集群可达）；Helm、kubectl；
  `ewoh-secret` 中的 `EWOH_OWNER_DATABASE_URL` / `EWOH_RUNTIME_DATABASE_URL` / `EWOH_JWT_SECRET`。
- **预期证据路径**：`helm install/upgrade/rollback` 成功、`helm test`（若定义）、
  `kubectl rollout status` 完成、`/health/live` 与 `/health/ready` 200、迁移 Job 成功。

### 4.2 G8 canary upgrade + failed rollback
- **BLOCKED 原因**：需要部署在含 canary/ring 能力的集群（G5 前置）并人为注入失败以验证
  回滚。当前无集群。
- **应用层部分覆盖（已自动化）**：HTTP + PostgreSQL E2E 已覆盖应用级
  `POST /api/scale/fleet/upgrade` / `/api/scale/fleet/rollback`（shadow-ring
  install/upgrade/rollback、全部 profile 回滚、审计）。**应用状态机 ≠ 基础设施 canary 回滚**。
- **一键命令（需集群，承接 G5）**：
  ```bash
  helm upgrade ewoh deploy/cloud/helm/ewoh --namespace ewoh \
    --set factory.upgradeRing=canary --set image.tag=<broken> --wait \
    || echo "canary 升级失败（预期，触发回滚）"
  helm rollback ewoh <prev-revision> --namespace ewoh --wait
  kubectl -n ewoh rollout status deploy/ewoh
  kubectl -n ewoh get pods && curl -fsS http://<ingress>/health/ready
  ```
- **所需基础设施/环境变量**：G5 全部 + 一个可注入故障的 canary ring。
- **预期证据路径**：canary 升级失败被捕获、`helm rollback` 成功、`/health/ready` 200、
  pod 全部 Ready、审计/事件记录回滚。

### 4.3 G9 long soak/load test
- **BLOCKED 原因**：需要长时间运行的集群 + 真实 PostgreSQL + 持续负载注入与指标采集
  （数小时级）。当前无运行中集群。
- **短时性能冒烟（可运行）**：`scripts/perf-smoke.js`（1000 req / 50 并发，p95 等）可在
  有真实 API + PG 时运行：`cd ewoh-spark-app && npm run perf:smoke`。**冒烟 ≠ 长稳负载**。
- **一键命令（需运行中 API + PG）**：
  ```bash
  cd ewoh-spark-app && npm run perf:smoke
  # 长稳（需自备负载工具 + 指标采集，如 k6 + Prometheus + Grafana）：
  export TARGET_URL='http://<host>:3000' DURATION='4h' RPS='200' CONCURRENCY='50'
  k6 run --duration "$DURATION" --vus "$CONCURRENCY" load-script.js   # 需自建脚本
  ```
- **所需基础设施/环境变量**：运行中的 API + PostgreSQL；负载工具（k6 等）；指标采集
  （Prometheus，`GET /metrics` 已暴露）；`TARGET_URL` / `DURATION` / `RPS` / `CONCURRENCY`。
- **预期证据路径**：长稳期间 QPS/延迟/错误率曲线、`GET /metrics` 计数器、无内存泄漏/OOM、
  后台任务（如重放/补传）在长稳下行为一致。

---

## 5. 迁移/部署 TCK 脚本可运行性

| 脚本 | 可运行 | 说明 |
|------|--------|------|
| `scripts/deployment-tck.js`（`npm run deployment:tck`） | ✅ | 静态：deploy 制品验证 + Helm 图表审计 + Scale Release 复核 + Rego 门禁；已接入 standalone.yml |
| `scripts/scenario-tck.js`（`npm run scenario:tck`） | ✅ | 静态：Golden Factory/策略/工作流/映射/事件目录/资产目录契约审计；已接入 standalone.yml |
| `scripts/verify-helm-chart.js`（`npm run verify:helm`） | ✅ | 静态图表审计（含于 deployment:tck）；**不验证真实安装** |
| `scripts/verify-deploy-artifacts.js` | ✅ | 静态 K8s/Compose/Dockerfile 校验（含于 deployment:tck） |
| `scripts/verify-domain-concurrency.js` | ✅（需 PG） | 真实 PG 并发门禁，已接入 standalone.yml |
| `scripts/postgres-logical-backup.mjs` / `post-restore-smoke.mjs` | ✅（需 PG） | 备份/恢复 drill，已接入 standalone.yml |
| `scripts/standalone-postgres-check.sh` | ✅（需 PG） | 迁移/RLS/审计/回滚/重建，已接入 standalone.yml |

---

## 6. CI 变更清单

- `.github/workflows/standalone.yml`：
  - 新增「Deployment TCK」（`npm run deployment:tck`，含 Helm 图表静态审计）。
  - 新增「Scenario TCK」（`npm run scenario:tck`）。
  - 新增「Docker image startup + health check」（`--network host` + `/health/live`、`/health/ready`）。
  - 新增「Backup/restore + post-restore identity smoke drill」。
- `.github/workflows/test.yml`：
  - 新增显式「Edge 节点断连/乱序/重放/去重门禁」命名步骤（覆盖
    `test_edge_backfill.py` / `test_edge_bridge_ingest.py` / `test_connector_runtime.py`）。

> 说明：本文件记载的 CI 步骤为**新增/修正的配置**，是否已在一台真实 GitHub Actions runner
> 上跑通本仓库最新 HEAD，需以实际 workflow 运行结果为准；撰写时未在本地执行 CI（本地无
> Docker/PG/集群），故未宣称以上新增步骤已「通过」，仅按「可运行 + BLOCKED 如实标注」记录。