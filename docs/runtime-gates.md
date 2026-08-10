# EWOH 真实运行门禁（Runtime Gates）状态

Status: 2026-08-10 · Task 8 P1：G5/G8/G9 三道运行门禁已由 ephemeral kind 集群 job 在 CI 自动化
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
| 5 | Helm install/upgrade/rollback + smoke | ✅ CI 自动化（kind）/ 本地 BLOCKED | `runtime-gates.yml` job `helm-kind-gate`（ephemeral kind v0.23 + 集群内 PG17，真实 install/upgrade/rollback） | 见 §3.4 |
| 6 | backup/restore + version compatibility drill | ⚠️ CI 自动化 / 本地 BLOCKED | `standalone.yml` + `verify-backup-restore.mjs`（空库恢复/行数/不变量/组织隔离/跨版本） | backup/restore/verify + identity smoke |
| 7 | edge node disconnect/backlog/replay/duplicate | ✅ CI 自动化 | `test.yml`（`make test-contract` + 显式步骤） | Python 测试通过 |
| 8 | canary upgrade + failed rollback | ✅ CI 自动化（kind）/ 本地 BLOCKED | `runtime-gates.yml` job `helm-kind-gate`（canary 阶段，`canary-deploy.sh`，坏版本自动回滚） | 见 §3.5 |
| 9 | long soak/load test | ✅ CI 自动化 / 本地 BLOCKED | `runtime-gates.yml` job `soak-load-gate`（`soak-load.js` 2000/25 + `soak-scheduler-events.js` 500 事件+SSE） | 见 §3.6 |
| 10 | PostgreSQL 生产迁移门禁（空库/跨版本/幂等/回滚/权限） | ⚠️ CI 自动化 / 本地 BLOCKED | `runtime-gates.yml` + `verify-migration-prod.mjs` | 见 §4.10 |
| 11 | 容器镜像安全门禁（真实构建/SBOM/Trivy/摘要） | ⚠️ CI 自动化 / 本地 BLOCKED | `runtime-gates.yml` + `container-image-gate.sh` | 见 §4.11 |
| 12 | Scheduler V2 多租户隔离 E2E（Org A vs Org B，ADR-004） | ⚠️ CI 自动化 / 本地 BLOCKED | `standalone.yml` + `scripts/verify-scheduler-multitenant.mjs` | 见 §3.3 |

图例：✅ = 已在 CI 真实运行；⚠️ = 仅在 CI 可运行（本地环境不可复现）；🔴 = BLOCKED（需真实
基础设施/集群，当前环境无法运行，未伪造证据）。标注「本地 BLOCKED」的 ✅ 行 = 门禁已在
GitHub Actions 中真实自动化（含 ephemeral kind 集群），但本地开发机（macOS，无
kind/helm/kubectl/docker/PG）仍不可复现，CI 证据以 workflow 运行日志/artifact 为准。

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

## 3. 仅 CI 可运行（✅/⚠️，本地环境不可复现）

以下门禁依赖 Docker / 真实 PostgreSQL / ephemeral kind 集群，当前本地开发机（macOS，
无 Docker/PG/kind/helm/kubectl）**无法手动复现**，但已在 GitHub Actions ubuntu 上真实运行
（G5/G8/G9 由 `runtime-gates.yml` 的 `helm-kind-gate` / `soak-load-gate` 两个 job 执行，
工具链版本固定：kind v0.23.0 / kubectl v1.30.0 / helm v3.16.3）。**未**在本地伪造成通过。

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

### 3.3 G12 Scheduler V2 多租户隔离 E2E（Org A vs Org B，ADR-004）
- **CI**：`standalone.yml` 新增步骤「Scheduler V2 multi-tenant isolation E2E (Org A vs Org B)」——
  先应用 Scheduler V2 迁移链（standalone_017 补建表先于 008/009/011/014 的 ALTER，
  再按序 006..028），`--verify-standalone-scheduler-rls` + `--verify-standalone-assignment-event-tenancy`，
  然后以**运行时角色**（`ewoh_api`：service_role 成员、LOGIN NOBYPASSRLS；superuser 会绕过
  RLS，故不用 owner URL）执行 `scripts/verify-scheduler-multitenant.mjs`。
- **覆盖**（ADR-004 三分类，DB 级断言）：
  - 8 张 TENANT_SCOPED 表（025 RLS）：org-b 连接对 org-a 行 SELECT/UPDATE/DELETE 均 0 行；
  - 无 GUC 连接：RLS 表仅可见全局行（`org_id IS NULL`）；
  - 3 张全局表（outbox / world_state_snapshot / assignment_event）跨 org 可读
    （GLOBAL_SHARED / DERIVED_TENANT_OWNERSHIP，RLS 关闭）；
  - `ewoh_assignment_event.org_id` 由 standalone_028 触发器从归属 plan/assignment 推导，
    派生不变量失配 = 0；
  - RLS 配置自检：8 表 relrowsecurity=true、3 表 false、8 条 policy FOR service_role。
- **一键命令（需真实 PG，连接角色须为非 superuser 的 service_role 成员）**：
  ```bash
  export EWOH_DATABASE_URL='postgresql://ewoh_api:<pw>@127.0.0.1:5432/ewoh' EWOH_ALLOW_DDL=1
  # 前置：迁移链 001..004 已应用；再应用 Scheduler V2 链（017 → 006..028，见 standalone.yml 步骤）
  node scripts/verify-scheduler-multitenant.mjs
  ```
- **所需环境变量/基础设施**：PostgreSQL 17（已迁移 025/028）；`EWOH_DATABASE_URL`（或
  `EWOH_RUNTIME_DATABASE_URL`）；`EWOH_SCHEMA`（默认 public）。
- **证据路径**：`RESULT {json}` 摘要 + `PASS`（退出码 0）；任一断言失败输出
  `FAIL: n/m assertions failed`（退出码非 0）；URL 未设置或 DB 不可达时如实输出
  `BLOCKED_BY_ENVIRONMENT`（退出码 0，绝不伪造通过）。

### 3.4 G5 Helm install/upgrade/rollback + smoke（kind 集群自动化，本地 BLOCKED）
- **CI**：`runtime-gates.yml` job `helm-kind-gate`（ubuntu-latest，`timeout-minutes: 30`
  硬上限；每个 shell 步骤另有步骤级 `timeout-minutes`，任何失败响亮失败，无
  `continue-on-error` 掩盖）——ephemeral kind v0.23.0 集群真实执行：
  1. 集群内供应 PostgreSQL 17（`postgres:17-alpine` Deployment + Service `postgres:5432`）；
  2. 安装 `local-path-provisioner` v0.0.30 并设为默认 StorageClass，使图表 PVC
     （`ewoh-uploads`，`storage.driver=local`）动态绑定；
  3. 创建 `ewoh-api-secret`（DATABASE_URL 指向集群内 postgres 的 `ewoh_api` 运行时角色 /
     JWT_SECRET / REDIS_URL 置空走内存回退）与 `ewoh-migration-secret`
     （EWOH_DATABASE_URL / EWOH_API_DATABASE_PASSWORD / EWOH_BOOTSTRAP_ADMIN_*）；
  4. 构建 `Dockerfile.api` / `Dockerfile.migrate` 并 `kind load docker-image`；
  5. `helm install ewoh deploy/cloud/helm/ewoh`（`--set replicaCount=1/autoscaling=false/
     ingress=false/service.type=NodePort/pdb.minAvailable=1` 单节点覆盖）→ 迁移 Job
     complete → rollout → PVC Bound → NetworkPolicy 存在 → `/health/live`、`/health/ready`
     断言 200（NodePort 直达，无需 port-forward）；
  6. 数据完整性：集群内 psql 断言 `ewoh_%` 表存在 + `ewoh_user / workbench_export_tasks /
     ewoh_schedule_task` 存在 + seed admin 落库；
  7. 升级模拟：`--set image.tag=does-not-exist`（坏镜像，`--wait` 超时）→ 升级必须失败 →
     `helm rollback ewoh <prev-revision>` → rollout → 健康 200 + 镜像 tag 恢复为 `ewoh-api:ci`；
  8. 报告：`output/helm-kind-report.json` + `output/gate-results/helm-runtime.json`
     （truth-gate-record SUCCEEDED），上传 artifact `helm-kind-gate-report-<sha>`。
- **一键命令（需 Docker + kind）**：一体化脚本 `scripts/verify-helm-runtime.sh` 在
  有集群时执行 install → 迁移 Job → probes → replicas(>=3) → worker → networkpolicy →
  PVC → restart → upgrade → rollback；无集群时如实记录 `BLOCKED_BY_ENVIRONMENT`。
- **本地诚实说明**：本地 macOS 无 kind/helm/kubectl/docker，**本地仍 BLOCKED**，仅由
  GitHub Actions 的 `helm-kind-gate` job 执行；CI 证据以 workflow 运行日志/artifact 为准。

### 3.5 G8 canary upgrade + failed rollback（kind 集群自动化，本地 BLOCKED）
- **CI**：与 G5 复用同一 `helm-kind-gate` job（rollback 验证通过后追加 canary 阶段）——
  运行 `scripts/canary-deploy.sh`（`API_URL` 指向 kind NodePort；`CANARY_POLLS=10` /
  `CANARY_POLL_INTERVAL=5` / `HELM_TIMEOUT=2m`，全程有界）：
  - 基线健康 → `helm upgrade --set image.tag=ewoh-broken-canary --set factory.upgradeRing=canary`
    （坏镜像，升级预期失败）→ 轮询失败阈值（`/health/ready` 非 200）→ 自动
    `helm rollback` → 回滚后 rollout + 健康 200 + 镜像 tag 恢复为 `ewoh-api:ci`。
  - 报告：`output/canary-report.json` + `output/gate-results/canary-upgrade.json`。
- **一键命令（需集群，承接 G5）**：
  ```bash
  bash scripts/canary-deploy.sh   # env: API_URL / MAX_ERROR_RATE / MAX_P95_MS / BAD_IMAGE_TAG
  ```
- **本地诚实说明**：本地仍 BLOCKED（无集群），仅 CI `helm-kind-gate` 的 canary 阶段执行。

### 3.6 G9 long soak/load test（CI 自动化，本地 BLOCKED）
- **CI**：`runtime-gates.yml` job `soak-load-gate`（ubuntu-latest + PostgreSQL Service
  Container，`timeout-minutes: 25` 硬上限）：
  1. 应用 standalone 迁移链 + 种子（含 Scheduler V2/outbox 链与 demo 数据）；
  2. `npm run build:prod:standalone` 后真实启动 standalone API（后台，等待 `/health/ready`）；
  3. `scripts/soak-load.js`（`SOAK_REQUESTS=2000` / `SOAK_CONCURRENCY=25` /
     `TARGET_URL=http://127.0.0.1:3000`）：HTTP+PG churn、多 org 隔离、连接池、队列积压、
     导出任务状态机、弱网重连、资源泄漏；
  4. `scripts/soak-scheduler-events.js`（Task 8 P1 新增，`SOAK_SCHEDULER_EVENTS=500`）：
     登录 → 500 事件风暴（POST `/api/scheduler/events`，轮换 trigger + 唯一 entityId）→
     SSE 订阅 `api/scheduler/v2/stream` → 携带 Last-Event-ID 断线重连续传；脚本级
     `SOAK_SCHEDULER_TIMEOUT_MS`（默认 240s）兜底，绝不无限跑。
  - 报告：`output/soak-load-report.json`、`output/soak-scheduler-events-report.json` +
    `output/gate-results/soak-load.json`、`gate-results/soak-scheduler-events.json`。
- **一键命令（需运行中 API + PG）**：
  ```bash
  export TARGET_URL='http://127.0.0.1:3000'
  export EWOH_SOAK_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh'
  SOAK_REQUESTS=2000 SOAK_CONCURRENCY=25 node scripts/soak-load.js
  SOAK_SCHEDULER_EVENTS=500 EWOH_SOAK_ADMIN_USERNAME=ci_admin EWOH_SOAK_ADMIN_PASSWORD='<pw>' node scripts/soak-scheduler-events.js
  ```
- **本地诚实说明**：本地仍 BLOCKED（无 PG/API 运行环境），仅 CI `soak-load-gate` 执行。

---

## 4. 本地 BLOCKED 门禁（🔴，本地环境不可复现，未伪造证据）

> 这些门禁本地开发机（macOS，无 Docker/PG/集群）无法运行。以下给出一键命令、所需
> 基础设施/环境变量与预期证据路径，作为拿到相应环境后的执行清单。**未**以 mock 或
> 静态检查顶替其结论。
> 说明：G5/G8/G9 已在 CI 自动化（见 §3.4-3.6），本节仅余需真实 PostgreSQL 的
> G10/G11 与需真实设备的基础设施类门禁。

### 4.10 G10 PostgreSQL 生产迁移门禁（空库/跨版本/幂等/回滚/权限模型）
- **BLOCKED 原因**：需真实 PostgreSQL 17 + `ewoh-spark-app` 依赖（postgres 驱动）。本地无 PG。
- **CI 已接入**：`runtime-gates.yml` 用 PostgreSQL Service Container 创建一次性库
  `mig_test`，运行 `scripts/verify-migration-prod.mjs`，覆盖空库升级、上一版本升级、
  幂等重放、破坏性回滚及重放、运行时角色权限模型（`service_role` 授权 + `ewoh_api` 成员）。
- **一键命令（需真实 PG）**：
  ```bash
  export EWOH_MIGRATION_TEST_DB_URL='postgresql://postgres:<pw>@127.0.0.1:5432/mig_test'
  node scripts/verify-migration-prod.mjs
  ```
- **预期证据路径**：`output/migration-prod-report.json` + `gate-results/postgres-migration-prod.json`。

### 4.11 G11 容器镜像安全门禁（真实构建/SBOM/Trivy/镜像摘要）
- **BLOCKED 原因**：需 Docker + Trivy。本地无 docker。
- **CI 已接入**：`runtime-gates.yml` 运行 `scripts/container-image-gate.sh`——真实构建
  `Dockerfile.api`，产出 CycloneDX SBOM、Trivy 镜像漏洞报告（HIGH/CRITICAL 阻断）与镜像摘要
  （digest），无 docker/trivy 时如实记录 `BLOCKED_BY_ENVIRONMENT`。
- **一键命令（需 Docker + 网络）**：`bash scripts/container-image-gate.sh`
- **预期证据路径**：`output/container-image-report.json`、
  `output/ewoh-api-sbom.cyclonedx.json`、`output/trivy-image-report.json` +
  `gate-results/container-image.json`。

---

## 5. 迁移/部署 TCK 脚本可运行性

| 脚本 | 可运行 | 说明 |
|------|--------|------|
| `scripts/deployment-tck.js`（`npm run deployment:tck`） | ✅ | 静态：deploy 制品验证 + Helm 图表审计 + Scale Release 复核 + Rego 门禁；已接入 standalone.yml |
| `scripts/scenario-tck.js`（`npm run scenario:tck`） | ✅ | 静态：Golden Factory/策略/工作流/映射/事件目录/资产目录契约审计；已接入 standalone.yml |
| `scripts/verify-helm-chart.js`（`npm run verify:helm`） | ✅ | 静态图表审计（含于 deployment:tck）；**不验证真实安装** |
| `scripts/verify-deploy-artifacts.js` | ✅ | 静态 K8s/Compose/Dockerfile 校验（含于 deployment:tck） |
| `scripts/verify-domain-concurrency.js` | ✅（需 PG） | 真实 PG 并发门禁，已接入 standalone.yml |
| `scripts/verify-scheduler-multitenant.mjs` | ⚠️（需 PG，本地 BLOCKED） | Scheduler V2 多租户隔离 E2E（025 RLS + 028 派生归属），已接入 standalone.yml |
| `scripts/postgres-logical-backup.mjs` / `post-restore-smoke.mjs` | ✅（需 PG） | 备份/恢复 drill，已接入 standalone.yml |
| `scripts/standalone-postgres-check.sh` | ✅（需 PG） | 迁移/RLS/审计/回滚/重建，已接入 standalone.yml |
| `scripts/verify-migration-prod.mjs` | ⚠️（需 PG，本地 BLOCKED） | 生产迁移门禁（空库/跨版本/幂等/回滚/权限），已接入 runtime-gates.yml |
| `scripts/verify-backup-restore.mjs` | ⚠️（需 PG，本地 BLOCKED） | 备份/恢复门禁（空库恢复/行数/不变量/组织隔离/跨版本），已接入 runtime-gates.yml |
| `scripts/verify-helm-runtime.sh` | ⚠️（需集群，本地 BLOCKED） | Helm install/upgrade/rollback/worker/networkpolicy/restart 一体化；CI 由 `helm-kind-gate` job 内联执行等价序列 |
| `scripts/canary-deploy.sh` | ⚠️（需集群，本地 BLOCKED） | canary 失败阈值 + 自动回滚 + 回滚后业务校验；CI 由 `helm-kind-gate` job 真实调用 |
| `scripts/soak-load.js` | ⚠️（需运行中 API+PG，本地 BLOCKED） | 长稳/负载门禁（并发/连接池/队列/导出/弱网/泄漏），CI 由 `soak-load-gate` job 真实调用 |
| `scripts/soak-scheduler-events.js` | ⚠️（需运行中 API+PG，本地 BLOCKED） | 调度事件风暴 + SSE 订阅/断线重连（Task 8 P1 新增），CI 由 `soak-load-gate` job 真实调用 |
| `scripts/container-image-gate.sh` | ⚠️（需 Docker，本地 BLOCKED） | 真实构建 + SBOM + Trivy + 镜像摘要，接入 runtime-gates.yml |

---

## 6. CI 变更清单

- `.github/workflows/standalone.yml`：
  - 新增「Deployment TCK」（`npm run deployment:tck`，含 Helm 图表静态审计）。
  - 新增「Scenario TCK」（`npm run scenario:tck`）。
  - 新增「Docker image startup + health check」（`--network host` + `/health/live`、`/health/ready`）。
  - 新增「Backup/restore + post-restore identity smoke drill」。
  - **Task 3 新增**「Scheduler V2 multi-tenant isolation E2E (Org A vs Org B)」：
    应用 Scheduler V2 迁移链（017 → 006..028）+ verify-025/028 + `verify-scheduler-multitenant.mjs`。
- `.github/workflows/test.yml`：
  - 新增显式「Edge 节点断连/乱序/重放/去重门禁」命名步骤（覆盖
    `test_edge_backfill.py` / `test_edge_bridge_ingest.py` / `test_connector_runtime.py`）。
- **Task 8 新增** `.github/workflows/runtime-gates.yml`：
  - PostgreSQL 生产迁移门禁（`verify-migration-prod.mjs`，一次性库）。
  - PostgreSQL 备份/恢复门禁（`verify-backup-restore.mjs`，source+target 两库）。
  - Helm 静态审计（`helm lint` + `helm template`，无需集群）。
  - 容器镜像安全门禁（`container-image-gate.sh`：真实构建 + SBOM + Trivy + 摘要）。
  - **Task 8 P1 新增** job `helm-kind-gate`（`timeout-minutes: 30` 硬上限）：ephemeral
    kind v0.23.0 集群 + 集群内 PostgreSQL 17（Deployment+Service）+ local-path-provisioner，
    真实执行 helm install → 迁移 Job → rollout → PVC → NetworkPolicy → 探针 200 →
    坏镜像 upgrade 失败 → helm rollback → 健康恢复 → canary 坏版本自动回滚 → 健康恢复 →
    数据完整性（psql 断言）；报告 `output/helm-kind-report.json` +
    `gate-results/helm-runtime.json`（truth-gate-record SUCCEEDED）。
  - **Task 8 P1 新增** job `soak-load-gate`（`timeout-minutes: 25` 硬上限）：PostgreSQL
    Service Container + standalone API 真实启动（`build:prod:standalone` +
    `start:standalone`），`soak-load.js`（`SOAK_REQUESTS=2000`/`SOAK_CONCURRENCY=25`）+
    新增 `scripts/soak-scheduler-events.js`（500 事件风暴 + SSE 订阅/断线重连，脚本级
    超时兜底）；报告 `output/soak-load-report.json`、`output/soak-scheduler-events-report.json`
    + `gate-results/soak-load.json`、`gate-results/soak-scheduler-events.json`。
  - 原先的「Helm 运行时 / canary / 长稳负载」三步 BLOCKED 步骤已移除（改由上述两个
    kind/soak job 真实执行，避免同 gate id 出现 BLOCKED 与 SUCCEEDED 冲突证据）。
- **Helm 图表扩展**（`deploy/cloud/helm/ewoh`）：
  - `templates/migration-job.yaml`：补入 `--apply-standalone-domain` 与
    `--apply-standalone-workbench-prod` + 各自 verify。
  - 新增 `templates/worker.yaml`（worker Deployment，独立伸缩）。
  - 新增 `templates/networkpolicy.yaml`（默认拒绝 + API 入站白名单 + worker 出站）。
  - `values.yaml` 新增 `worker` 与 `networkPolicy` 块。

> 说明：本文件记载的 CI 步骤为**新增/修正的配置**，是否已在一台真实 GitHub Actions runner
> 上跑通本仓库最新 HEAD，需以实际 workflow 运行结果为准；撰写时未在本地执行 CI（本地无
> Docker/PG/集群），故未宣称以上新增步骤已「通过」，仅按「可运行 + BLOCKED 如实标注」记录。