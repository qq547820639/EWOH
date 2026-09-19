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

### 3.6m 投递配额 / 浏览器 UX 覆盖 / 轮换提示 / 清理自证（NO-67a/b/c/d，2026-09-13 第 67 轮）

- **命令**：`npm run test:browser:execution-boundary`（**30** 项：5 用例 × 6 浏览器画像；已并入
  `npm run test:browser:mock` → 100 → **105**）+
  `make e2e-control-actuator`（**29** 项）+ `npx jest server/modules/control`（59 例）。
- **NO-67a 执行边界浏览器验收**：在飞 / 排队（设备忙）/ 已撤回逐条区分、授权可信度两维、
  违规留痕单列、空态与错误态显式；含 axe 无障碍扫描（0 严重项）。
  修掉 3 处 strict-mode 定位问题（同一文案在摘要与逐条说明中重复出现 → 必须限定容器或用 count 断言分布）。
- **NO-67b 投递配额**：`delivered_at`（交付时刻）与 `authorization_verified_at`（复核通过）
  **拆成两个事实**（迁移 095）——首版用后者计配额，导致"刚下发就把配额算满"
  （e2e 实测 `delivered=0/quotaDeferred=4`）；现在 4 条 `pause` → 3 投递 + 1 排队（`reason=quota`），
  `stop` 插队且不占配额。
- **NO-67c 轮换窗口提示**：启动时检测 `_PREVIOUS` 并告警（窗口必须有期限）。
- **NO-67d 清理自证**：`e2e:plan-staleness` 收尾删除后计数，残留即 FAIL（异常也不许只 warn）。

### 3.6z 协同设备未就绪合并视图（NO-85a，2026-09-16 第 85 轮）

- **命令**：`EWOH_BROWSER_MODE=mock npx playwright test … mobile-device-execution.spec.js`
  （**48 项 = 8 用例 ×6 画像**，新增协同未就绪变体）。
- **语义**：主设备摘要 + 协同设备"未就绪聚合"（其余台设备排队/未交付/超时>0 计数）；
  单台查询失败不影响主摘要；未就绪（degraded 色）与已就绪（muted）**分色不混淆**。

### 3.76 receipt 授权边界自建前置（NO-100a，2026-09-19 第 100 轮）

- **命令**：`make e2e-receipt-fresh`（**19/19 全绿**，SKIP 清零）。
- **自建前置**：把一条未终结执行行归到张伟绑定人员（派工行 + 执行行同步改 person_id；
  行态 STARTED），20/21 断言本人可报 / 他人被拒 403。
- **要点**：授权比较的是派工行 personId（非执行行）；worker 只能 START→COMPLETED。
  自建前置消灭了最后两个环境依赖 SKIP——标准链 SKIP 清零。

### 3.75 积压趋势历史化（NO-91a，2026-09-17 第 91 轮）

- **命令**：`EWOH_DATABASE_URL=… node db/runner/run_migrations.js
  --apply/--verify-standalone-control-backlog-snapshot`（表+索引+探针）+
  `npm run e2e:control-actuator`（31/31，sweep 落快照）+
  `npx jest server/modules/control`（86 例，快照断言）。
- **表**：`ewoh_control_backlog_snapshot`（迁移 097；**含 ewoh_api GRANT**——
  新表不继承既有授权，漏 GRANT = 历史端点 500）。
- **链路**：巡检落快照（与提醒同节拍）→ history 端点（最近在前）→
  FactoryOperations 积压 sparkline。
- **教训**：新增表必须显式 GRANT 给运行时角色（同 fresh-chain 重置密码教训同族）。

### 3.74 KPI 历史自动积累 + sparkline（NO-90a/b，2026-09-17 第 90 轮）

- **命令**：`npx jest server/modules/scheduler/__tests__/kpi-persist-throttled.spec.ts`
  （3 例）+ 活体（两次 gate 相隔 2s → kpi 表仅 1 条）+
  `npm run test:client -- --testPathPattern PolicyGatePanel`（7 例，含 sparkline 断言）。
- **NO-90a**：`persistThrottled(orgId, minIntervalMs)`——按最近快照节流落库；
  门禁评估（含面板轮询、golden、e2e）顺带积累历史序列，节拍默认 5 分钟。
- **NO-90b**：趋势 sparkline（SVG 折线 + 阈值虚线；缺数据点断开）。

### 3.73 门禁指标历史化（NO-89a，2026-09-16 第 89 轮）

- **命令**：`npx jest server/modules/scheduler`（listHistory）+
  `npm run test:client -- --testPathPattern PolicyGatePanel`（7 例，含趋势两态）+
  活体 `GET /api/scheduler/kpi/history?limit=5`（200）。
- **语义**：`listHistory(orgId, limit≤48)` 按周期倒序返回快照序列（kpiJson 全量）；
  看板趋势表按阈值分色（达标/不达标/缺数据），无快照如实缺项。
- OpenAPI：`GET /api/scheduler/kpi/history` 契约（468 ops）。

### 3.72 门禁看板浏览器验收 + 面板未渲染缺陷修复（NO-88a，2026-09-16 第 88 轮）

- **命令**：`EWOH_BROWSER_MODE=mock npx playwright test … policy-gate-panel.spec.js`
  （**30 项 = 5 用例 ×6 画像**；`test:browser:mock` 121 passed）。
- **三态覆盖**：全通过（axe）/ 缺数据（"需显式确认"+"证据不足"+未验证标注）/
  不达标（"已拒绝"徽章 + cell 角色精确断言）/ 混合态（失败优先于缺数据）/
  读面失败显式报错。
- **缺陷修复**：FactoryOperations 三面板被错插进 useEffect 函数体（JSX 悬空表达式
  从不执行，面板从未渲染且完全静默）→ 挂载到页面 JSX 顶部。渲染测试的教训：
  **mount 断言必须配套可见性断言**。

### 3.71 golden 全路径复验工具链 + 门禁指标看板（NO-87a/b，2026-09-16 第 87 轮）

- **命令**：`make e2e-golden-fresh`（reset → clear-execution-facts → golden，**22/22 全绿**）+
  `npx jest …/PolicyGatePanel.test.tsx`（5 例）+ 活体 gate=201。
- **NO-87a**：`db/runner/clear-execution-facts.mjs`——reset 只删 seed 任务的执行行；
  场景自建任务的迟到回执残留会让门禁持续"不达标"。fresh 目标先清本 org 的
  执行/反馈/KPI 快照（派生事实，可重建；不碰配置种子），再跑 golden 全路径。
- **NO-87b**：`PolicyGatePanel`（FactoryOperations）——门禁逐条检查
  实际 vs 阈值 + 三态结论（通过/缺数据（未验证 ≠ 通过）/不达标——ack 无法豁免），
  60s 轮询；渲染测试 5 例（全通过/缺数据/不达标/失败/加载）。

### 3.70 golden 激活门禁第三分支（NO-86a，2026-09-16 第 86 轮）

- **命令**：`npm run e2e:golden`（**16 PASS / 0 FAIL / 2 SKIP**；SKIP 附实测指标）。
- **治理语义三分支**：① 全通过 → 正常激活+回滚；② 缺数据 → 拒绝未确认激活、
  ack 可豁免（记审计）；③ **逐条失败（有数据不达标）→ 未确认与 ack 激活都拒绝**
  （FAIL 不可被豁免——ack 只豁免"缺数据"，不豁免"数据不达标"）。
- 场景判定顺序：失败检查 > 缺数据 > 全通过；SKIP 附门禁实测指标（数据漂移可观测）。

### 3.6y 契约触达面审计 + 移动多设备浏览器变体（NO-84a/b，2026-09-16 第 84 轮）

- **命令**：`make audit-contract-touchpoints` + `npm run test:browser:mock`
  （mobile spec **7 用例 ×6 画像 = 42**，新增多设备协同变体）。
- **NO-84b 契约桩注册表**：`scripts/audit-contract-touchpoints.js`——
  首个受治理契约 = `SparkBridge._post_batch` verdict 词表（ok/retry/dead_letter）；
  **首跑即抓出** `tests/` 里残留的 bool 桩（`False`）→ 对齐为 `"retry"`。
  注册表可扩展：契约演进时**先注册、后改名**，门禁自动拦截未同步的桩。
- **NO-84a**：多设备协同派工在移动工单卡显示"+N 台协同"入真浏览器验收。

### 3.6x data-quality 清理自证 + 移动多设备显示（NO-83a/b，2026-09-16 第 83 轮）

- **命令**：`npm run e2e:data-quality`（**16/16**，含步骤 15 清理自证）。
- **NO-83a**：场景收尾先收尾自己注入的合成告警（本 tag），再自证无 open 残留；
  历史残留一次性清洗（8 条）；**TDZ 修复**（注入 id 提升到 try 外，早期失败时
  finally 读到的是 null 而非 ReferenceError）。
- **NO-83b**：移动工单 `deviceExecution` 返回全部派工设备；工单卡显示首台 + "+N 台协同"。

### 3.6w 排队原因细分（NO-81a，2026-09-16 第 81 轮）

- **命令**：`npx jest server/modules/control`（86 例，细分断言）+
  `EWOH_BROWSER_MODE=mock npx playwright test … mobile-device-execution.spec.js`
  （**42 项 = 7 用例 ×6 画像**，新增限流排队变体）。
- **细分语义**：`queuedReason ∈ {device_busy, quota, null}` 逐命令输出；
  配额用尽 → `queued_quota` 投递态（面板既有档位接上数据源）；
  移动端文案拆分"等上一单完成" vs "等下一分钟配额窗口"（解除条件不同）。
- **口径注释**：页面 remaining 为只读近似（未含网关 CAS 扣减）——诚实标注，不冒充精确值。

### 3.6v 移动工单状态行浏览器验收（NO-80a，2026-09-16 第 80 轮）

- **命令**：`EWOH_BROWSER_MODE=mock npx playwright test … mobile-device-execution.spec.js`
  （**30 项 = 5 用例 × 6 画像**；已并入 `test:browser:mock` → 105 → **113**）。
- 四态覆盖：排队中（不是工单失败）/ 执行中 / 积压（已通知值班）/ 空闲 + 无派工设备缺项。
- **分支顺序修复**：积压判定优先于排队（严重度倒挂缺陷，浏览器验收抓出）。

### 3.6u 移动工单设备执行状态行 + perception 清理自证（NO-79a/b，2026-09-16 第 79 轮）

- **命令**：`npx jest server/modules/mobile`（5 例）+ `npm run e2e:perception-fusion`
  （**21/21**，含步骤 17 清理自证）+ `npm run e2e:control-actuator`（31/31 回归）。
- **NO-79a**：移动工单详情 `deviceExecution`（派工表 → listDeviceCommands 摘要，
  同一判定实现）；工单卡状态行区分"设备执行中 / **设备排队中（不是工单失败）** /
  命令投递积压（已通知值班）/ 设备空闲"；查不到派工设备如实缺项。
- **NO-79b**：perception 场景收尾四类行计数自证（冲突/任务/融合/环境）。

### 3.6t 测试 CI 工作流 / TTL 缓存与下钻表 / exo 清理自证（NO-78a/b/c，2026-09-16 第 78 轮）

- **命令**：`npx jest …/DeliveryBacklogTable.test.tsx`（5 例）+
  `npx jest server/modules/control`（86 例，含 TTL 缓存 2 例）+
  `PYTHONPATH=src python3 -m pytest -q tests/test_edge_bridge_ingest.py`（6/6）+
  `npm run e2e:exo-session`（53/53，含步骤 16 清理自证）。
- **NO-78a**：快照 TTL 缓存（默认 5s；0=关闭；按租户分桶+容量 64；sweep 不走缓存）+
  FactoryOperations 逐设备下钻表（升级徽章/未交付与已投未回执分列/零积压不渲染/失败显式）。
- **NO-78b**：`.github/workflows/tests.yml`（Python 矩阵 3.11/3.12 + ruff + 标准链；
  Node 双 tsconfig + lint + jest；actions 按 SHA pin）——keywords: tests.yml、Python 矩阵。
- **NO-78c**：exo 场景步骤 16 清理自证（单点跟踪 createdSessionIds；无活跃残留 PASS，
  残留/自查失败 FAIL，无 OWNER_DB 显式 SKIP）。

### 3.6s 积压实时快照进工作台 + Python 测试矩阵（NO-77a/b，2026-09-16 第 77 轮）

- **命令**：`npx jest server/modules/dashboard/__tests__/workbench-now-backlog.spec.ts`
  （4 例）+ `npx jest server/modules/control`（84 例）+ `bash scripts/python-test-matrix.sh`
  （3.9 SKIP / 3.12 PASS）+ 活体 `GET /api/control/delivery-backlog/status`。
- **NO-77a**：判定抽取为 `collectBacklogRows` **唯一实现**（巡检/快照共用，永不两套口径）；
  快照端点（RBAC 同 sweep）+ `WorkbenchNow` 聚合项（升级 → priority 1/critical；
  零积压不伪造"需要处置"；快照失败不阻塞其余事实）。
- **NO-77b**：解释器矩阵脚本（3.9 SKIP[版本守卫] / 3.12 全绿），CI 接入就绪。

### 3.6r 桥接器挂死修复 + tests/ 目录全绿 + 配额徽章真浏览器验收（NO-76a/b，2026-09-16 第 76 轮）

- **命令**：`PYTHONPATH=src python3 -m pytest -q tests`（**688 passed / 11 skipped / 1.48s**，
  此前因桩过期+退避吞停止信号而"挂死"）+ `npm run test:browser:execution-boundary`
  （**7 用例 ×6 画像**全绿，新增配额徽章）。
- **NO-76a**：`_backoff` 分片睡眠响应停止信号（产品健壮性）；测试桩对齐 verdict 契约。
- **预存在缺陷排查结论**：非 asyncua/端口问题，是**契约演进未同步非链目录**——
  教训：契约变更的触面盘点必须包含**所有**测试目录（包括不在链里的）。
- **入链（NO-76c）**：标准验证命令升级为
  `PYTHONPATH=src python3 -m pytest -q src/edge_platform tests tools`
  （**1934 passed / 13 skipped / 78s**）——`tests/` 修复后纳入权威链，
  防止非链目录再度腐化（契约演进触面盘点的结构性保障）。

### 3.6q Modbus 加固 + OPC-UA 真实栈（NO-75a/b，2026-09-16 第 75 轮）

- **命令**：`PYTHONPATH=src python3 -m pytest -q src/edge_platform/tests/test_actuator_modbus.py`
  （**18/18**）+ `PYTHONPATH=src python3.12 -m pytest -q src/edge_platform/tests/test_actuator_opcua_real.py`
  （**2/2，×3 连续**；3.9+asyncua 1.1.8 下显式 SKIP）+ 全量 `pytest -q src/edge_platform tools`
  （**1246 passed, 2 skipped**——SKIP 为真栈用例的显式版本守卫）。
- **NO-75a**：FC16 单事务批量写（撕裂写在协议层不可能）+ 重连指数退避（快速失败/成功重置）。
- **NO-75b**：`AsyncuaOpcUaClient`（可选依赖、懒加载、fail-closed）+ 真线用例
  （in-process asyncua Server；设备侧代理按节拍应用命令；2s 有界轮询等待状态迁移）。
- **发现并如实记录（预存在，非本轮引入）**：顶层 `tests/` 目录**不在标准验证链**
  （`pytest -q src/edge_platform tools`），其中 `test_edge_backfill.py` 存在挂起——
  待专项排查后才能入链。

### 3.6p 升级链 e2e / 凭证矩阵预检 / 运动类配额 / 轮换演练（NO-74a/b/c/d，2026-09-16 第 74 轮）

- **命令**：`npm run e2e:control-actuator`（**31** 项）+ `npx jest server/modules/control`（**82** 例）+
  `node tools/control-key-rotation-drill.mjs`（dry-run/apply/resume 三路径）+ jest 全量 3441。
- **NO-74a**：升级链 e2e（20b：回拨 6× SLA → escalated + production_manager + critical 实测通过）。
- **NO-74b**：链前凭证角色矩阵自检（配错立即失败带指引；三凭证不能混用）。
- **NO-74c**：运动类配额（默认通用一半；quota-motion 排队；stop 仍插队不占额）；
  OpenAPI quota 增 motion 三元组；本地 env 显式配置教训（默认 1/分钟会把主回路排队）。
- **NO-74d**：轮换演练四步全通；演练抓出并修复 4 个真实缺陷
  （子进程 env/日志、env 引号剥离、resume 守卫顺序、假清零）——**演练的意义就是这些**。

### 3.6o 积压巡检升级链与双状态扩展（NO-70a，2026-09-16 第 70 轮）

- **命令**：`npx jest server/modules/control`（80 例，含升级链 3 例）。
- **积压双状态**：`sent`（平台一直没能交付网关：网关掉线/密钥不配对/配额打满）与
  `gateway_received`（网关已收但设备迟迟不执行/不回执）**都是积压**——现场表现都是"设备不动"，
  都必须叫到人。提醒正文分两个数字：`未交付 X 条；已投未回执 Y 条`（处置入口不同）。
- **升级链（复用安灯 SLA 升级语义）**：积压年龄 ≥ N 倍 SLA
  （`EWOH_CONTROL_BACKLOG_ESCALATION_MULTIPLIER`，默认 3）→ 桶升 `delivery_backlog_escalated`
  + 加发 `production_manager`（critical）；**一级收件人仍在**（升级 = 加发管理者，不是拿走提醒）；
  未达阈值不升级。
- **纪律**：升级桶**替换**桶名（一条积压一条提醒链，靠桶名区分等级），收件人**加发**；
  轮换/升级都只放宽"叫到谁"，不放宽积压判定本身。

### 3.6n 投递积压巡检与提醒 / 清理自证推广（NO-68a/b，2026-09-16 第 68 轮）

- **命令**：`make e2e-control-actuator`（**30** 项，含步骤 20）+
  `npx jest server/modules/control`（62 例）+ `make e2e-capability-explain`（25 PASS / 3 SKIP，SKIP 原因可追）。
- **NO-68a 投递积压巡检**：`sent` 且 `delivered_at IS NULL` 且 `sent_at < now-SLA`（默认 5 分钟）
  → 按设备发确定性提醒（幂等，`NTF-CTRL-<deviceId>-delivery_backlog-*`），审计留痕；
  worker 逐租户 GUC 事务（`standalone_096` SECURITY DEFINER 只返回 org_id），值班角色可手动 sweep。
  人面读面给 `oldestWaitingMs`/`overdue`/`deliverySlaMs`，面板显"投递积压 N 条（最久等待 X 分钟）"。
- **NO-68b 清理自证推广**：capability 场景收尾自查停用能力已全恢复；plan-staleness 收尾删除后计数。
  同轮把 7b/7b2/7d 反事实建议断言**条件化**（放宽后无合格候选 = 引擎正确不给建议 → SKIP 附原因）。
- **巡检边界**：只写提醒与审计，**绝不改命令/设备事实**；已交付（`delivered_at` 非空）不计积压。
- **环境事故处置入库**：colima 停机数日 → postgres 不可达 + fresh-chain 重置集群级 `ewoh_api`
  密码 → dev 登录 503；处置与预防已写进 runbook（重置密码 SQL + 纪律）。

### 3.6l 执行边界对现场可见 + 密钥轮换 + 场景预检（NO-66a/b/c/d，2026-09-13 第 66 轮）

- **命令**：`make e2e-control-actuator`（**28** 项）+ `npx jest server/modules/control`（58 例）+
  `npm run test:client -- --testPathPattern ExecutionBoundary`（6 例）。
- **NO-66a 人面读面**：`GET /api/control/requests?deviceId=`（RBAC + 租户 + RLS 兜底）与设备抽屉
  「执行边界」面板。e2e 证据（17b/17c）：**同一台设备"在飞=1、排队=1、占用者正确、指纹方案 v2 且已验签"
  对现场可见**；未认证 401。展示纪律：排队（暂缓≠失败）与失败/撤回分档、指纹**方案**与**是否复核**
  分开、违规留痕单列为安全事件、空列表显式说明"无命令 ≠ 设备正常"。
- **NO-66b 密钥轮换窗口**：`EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS`（复核接受旧密钥，签发只用新密钥）；
  纪律见 runbook（previous==current 不放宽、窗口只放宽密钥不放宽内容、切完立即移除）。
- **NO-66c 过期处置接入 golden/wave**：共享助手 `approveWithReplan`（诊断→重排→再审批，有界 2 轮）。
  实测：golden 22/22、wave 12/12。
- **NO-66d 链前漂移预检**：`e2e-chain` 第一屏打印能力漂移巡检结果（只读、不阻断）——
  让"环境漂移"与"产品缺陷"在排障时第一眼分开。

### 3.6k 签名授权范围指纹 / 一车一活闸门 / 能力漂移巡检（NO-65a/b/c/d，2026-09-12 第 65 轮）

- **命令**：`make e2e-control-actuator`（26 项）+ `make capability-drift`（只读巡检）+
  `npx jest server/modules/control`（57 例）+ `pytest -q src/edge_platform/tests/test_control_downlink.py`（17 例）。
- **NO-65a 签名指纹**：平台 `hmac-sha256:v2:<32hex>`（密钥 `EWOH_CONTROL_FINGERPRINT_SECRET`），
  `pending` 下发**可重建的 `authorizationScope`**，边缘**验签后才碰设备**；平台复核按已存方案
  （v2 缺密钥 → `fingerprint_key_missing`，迁移 094，**不退回 v1**）；未配密钥 → v1 + 启动告警。
  e2e 证据：步骤 12b（v2 + scope）、步骤 16（改写参数 → 平台复核撤回 + 边缘拿不到 + 设备不动）。
  跨语言固定向量 `hmac-sha256:v2:906de7f6e09dbd1adb6b5ae99d038876`（TS/Python 同一断言）。
- **NO-65b 一车一活**：设备有 `gateway_received` 的运动命令时，第二条运动命令暂缓
  （`deferred[{reason: device_busy, blockedBy}]`，保持 `sent`，自动解除）；**安全动作永不暂缓**。
  首版把 `sent` 也算在飞 → 候选命令把自己当占用者（单测抓出，见步骤 17 的 e2e 证据）。
- **NO-65c 漂移巡检**：`make capability-drift`（只读、阈值退出码）+ `scripts/capability-restore.js`
  （**审批路径**恢复、dry-run 默认、只恢复设备仍声明者）。实测：exo-lift 漂移 **116 台** →
  单审批批量恢复 116/116 → 巡检清零。
- **NO-65d 清理自证**：场景收尾删除后**数一遍**，有残留记 FAIL（e2e 步骤 18）。
- **纪律**：① 安全闸门的输入必须来自服务端**可验证**的事实（密钥签名），不是公开算法的一致性格式；
  ② "设备在忙"的口径必须是"已投到设备"，不是"已下发"；③ 环境漂移要有**只读巡检 + 产品路径恢复**
  的工具，而不是靠人肉记忆；④ 清理不写自证等于没清理。

### 3.6j 首个**全绿** e2e 链（18/18 场景，0 FAIL / 0 SKIP，2026-09-12 第 64 轮）

- **命令**：`make e2e-chain`（18 场景；`scripts/e2e-chain.sh` 逐场景复位 + 完整日志 + 三态汇总）。
- **结果**：**420 PASS / 0 FAIL / 0 SKIP**——
  golden 22 · receipt 20 · wave 12 · learning 27 · capability 28 · approval-expiry 22 ·
  observation 12 · master-data 15 · materials 27 · exo 52 · data-quality 15 · learning-signal 19 ·
  improvement 28 · control-actuator 24 · plan-staleness 7 · agv-transport 11 · perception 20 · edge 59。
- **为什么这轮才全绿**（前 63 轮每轮都有 FAIL 或 SKIP）：三件事同时到位——
  ① **NO-64a**：心跳/沉默不再被当成"世界变了"（否则每个方案都会过期，审批腿只能 SKIP）；
  ② **NO-64b**：审批确认人身份边界 + 场景残留清理（残留在场景之间互相伪装成产品缺陷）；
  ③ **场景自建前置条件**：人员档案/位置心跳、候选检查顺序、冷却等待、能力停用的 finally 恢复、
  `approveWithReplan` 共享助手（诊断→重排→再审批）。
- **纪律**：SKIP 不是成绩——每一个 SKIP 都要能被追到一个具体前置条件；能自建的自建，
  不能自建的写明原因并进 §3 候选清单。

### 3.6i 审批确认人身份边界 + 场景残留清理（NO-64b，2026-09-12 第 64 轮）

- **命令**：`make e2e-receipt`（19 项）+ `make e2e-agv-transport`（11 项）+ 调度域 jest 1155 例。
- **缺陷一（审计/授权边界）**：`ewoh_schedule_plan.confirmed_by` 原写**客户端自报**的
  `body.operator`。它是"独立审批"闸门的输入（`hasIndependentApproval`：`createdBy ≠ confirmedBy`；
  回执授权 `RECEIPT_PLAN_NOT_AUTHORIZED` 读它）→ 可用别人的名字落库，也能把
  "自己生成自己审批"伪装成独立审批。现在写**认证主体** `ctx.userId`，自报操作者只作声明进审计。
- **缺陷二（验证资产）**：`e2e:agv-transport` 收尾清理引用**不存在的表名/列**
  （`ewoh_schedule_assignment.schedule_task_id`）→ 抛错被 `try/catch` 吞成一行 warn，
  assignment/执行/反馈从未清理；残留被 `e2e:receipt` 捡到 → 7 FAIL + 3 SKIP（看起来像回执坏了）。
  现在按 `task_id` 顺序清理预占/执行/事件/反馈/assignment，并补 31s 冷却等待（MANUAL 去抖会复用旧方案）。
- **纪律**：① 安全闸门读的字段只能来自**服务端认证事实**，客户端自报字段不得参与判定；
  ② 场景收尾清理必须**验证真的删掉了**（错误不能只 warn 到控制台），否则 residue 会伪装成
  下一个场景的产品缺陷——这正是本轮"两个缺陷互相掩盖"的形态。

### 3.6h 事实变化 vs 证据老化的分档闸门（NO-64a，2026-09-12 第 64 轮）

- **命令**：`make e2e-agv-transport`（11 项）+ `npx jest server/modules/scheduler/__tests__/scheduler-domain.spec.ts`。
- **被修掉的口径缺陷**：`entityVersions` 里混进了"随时间自然变化"的字段（设备 `status/online`
  由遥测新鲜度派生、`telemetryUpdatedAt` 是证据时钟本身）→ **心跳与沉默都会让方案过期**，
  大库里没有任何方案批得下去（第 61–63 轮反复以 SKIP 记录的根因）。
- **新判定（审批与派工同一实现）**：内容版本不同 → 事实变化 → 拒绝；仅证据老化 → 只有
  **方案依赖且 dataQuality≠FRESH** 才拒绝（`EVIDENCE_STALE`），与方案无关则不阻断并如实报告；
  老快照缺内容版本 → 严格判定（fail-closed）。
- **证据（场景）**：`e2e:agv-transport` **11 PASS / 0 FAIL / 0 SKIP** —— 审批经
  「诊断→重排→再审批」200、派工 200、assignment 落 `dispatched`、本设备执行行已生成。
- **纪律**：① 不拿过期证据背书（依赖资源证据过期仍拒绝）；② 不把"没上报"当成"世界变了"；
  ③ 分档必须与闸门**同一实现**，否则会出现"页面说只是老化、审批却被拒"的第二套口径。

### 3.6g 「过期 → 诊断 → 重排 → 审批」成为可复用的场景处置（NO-62c 配套，第 62 轮）

- **共享助手**：`test/e2e/helpers/plan-freshness.mjs`（`approveWithReplan` /
  `planStalenessOf` / `stalenessSummary`）——把"审批 409 PLAN_STALE → 读诊断 →
  `POST /plans/:id/replan` → 审批新方案"这条**有界**重试固化成一处实现，
  场景不再各写一套（重排产出的是新快照上的新方案，仍走完整审批链）。
- **`e2e:agv-transport`（12 PASS / 0 FAIL / 1 SKIP）**：本轮把三处**环境前置条件**
  显式建起来并断言，而不是把环境状态报成产品缺陷：
  ① **人员档案新鲜度**（`person:master` 24h 窗口）：种子档案超过 24h 未同步 → 全员
  `dataQuality=STALE` → 状态归一 UNKNOWN → 候选理由恒 `person_unavailable` → 搬运任务
  不可调度（求解不产出方案）。场景先做一次"档案同步"（`_updated_at = now()`，真实环境由
  HR/MES 同步任务完成）并**断言至少 1 人 AVAILABLE**；
  ② **人员位置补帧**（`person:location` 60s）：与设备心跳同一纪律；
  ③ **候选合格性检查放在审批之前**：审批会给工位/人员建预占，之后再查候选会出现
  `station_reserved`（自己的派工挡住自己的候选）→ 那是"审批生效"的证据，不是候选缺陷。
- **验收到的能力**：候选 `eligible=5`；方案把搬运任务派给该 AGV；审批经"诊断→重排→再审批"
  通过（`r2:RUN-…-R2:200`）；同一 AGV 的命令闭环 `executed`。
- **如实记录的 SKIP（1 项）**：**派工**步骤被新鲜度闸门拒绝（`assertFreshForWave` → 409
  PLAN_STALE）。根因是环境特性：本开发库数千待排任务 + 后台扫描，方案快照秒级失效。
  重要细节（已写进脚本注释）：**派工前不要再补心跳**——设备实体版本包含 `lastTelemetryAt`，
  补帧会立刻让刚生成的快照过期（实测：加了"派工前心跳"→ 审批成功但派工必然 409）。
- **仍存在的 SKIP（3 场景）**：`e2e:golden` / `e2e:receipt` / `e2e:wave` 的"方案链路"段
  仍按老口径记 SKIP（候选方案的快照在审批前失效）。**处置手段已就绪**
  （`approveWithReplan` 可直接接入），列入下一批：把三个场景的审批段换成共享助手，
  把 SKIP 变成真实的审批/派工验证。

### 3.6f 投递前授权复核 / 下行优先级 / 方案过期可解释（NO-62a/b/c，2026-09-12 第 62 轮）

- **命令**：
  `make e2e-control-actuator`（= `npm run e2e:control-actuator`；24 项）+
  `make e2e-plan-staleness`（= `npm run e2e:plan-staleness`；7 项）。
- **NO-62a 投递前授权复核（安全缺陷修复，不是加功能）**：命令落成 `sent` 之后，平台在**每次投递前**
  重新复核审批（实例存在/已通过/未过期/租户一致）并重算**授权范围指纹**（请求/设备/命令/审批实例/参数；
  平台 TS 与边缘 Python 逐位一致，固定向量双向钉死）。复核不过 → 命令撤回
  （`status=revoked` + 封闭原因码 + `delivery_rejected` 结果行 + 审计 + `NTF-CTRL-*` 提醒），**不投给设备**。
  证据（e2e，故障注入 + 真实状态机）：
  ① 安全停机插队：`stop`（最后下发）排在 `pause`/`return_to_dock` 之前（`priorities=[0,1,2]`）；
  ② 授权范围被改写（指纹不符）→ `revoked/fingerprint_mismatch` + 结果行；
  ③ 请求在投递窗口内被撤销 → `revoked/authorization_revoked`；
  ④ **终态请求下的命令拒绝投递确认**（409 + `revoked/request_terminal`）；
  ⑤ 无密钥 401 + 重复 ack 幂等（`alreadyAcked`）。
- **NO-62b 下行优先级与积压可见性**：`pending` 返回 `priority`/`priorityLabel`/`queued`/
  `oldestSentAt`/`revoked`/`truncated`；边缘侧再排一次并核对平台顺序（不一致上报
  `platformOrderViolation`，纵深防御）。
- **NO-62c 方案过期可解释**：`GET /api/scheduler/plans/{planId}/staleness`（只读；与审批**同一实现**）
  + 审批 409 体带差异明细（`error.planStaleness`，区分外部变化 / 本方案自身执行效果）
  + 页面差异面板与一键重排。证据（e2e）：生成方案 → 诊断形状完整 → **新建一个任务** →
  诊断报 stale 且逐项列出该 `task:<id>`（`change=added`）→ 审批 409 带同一份差异 → 重排产出新方案
  且仍是待审批 → 新方案绑定**新快照版本**。
- **同轮抓到的三个真实缺陷（都在本批修掉）**：
  ① `POST /plans/:id/replan` 省略可选字段 `lockedConstraints` → `[...undefined]` → **500**
     （新 e2e 场景当场抓到；已改为缺省空数组 + 非数组显式 400）；
  ② **错误路径上的写入被请求事务回滚**：`OrgContextInterceptor` 把请求包在一个事务里，
     "安全决策 + 抛 4xx"会把刚写的撤回/审计/结果行/outbox 事件一起回滚（实测：撤回后命令仍在
     `sent`，下一轮还会投给设备）。新增 `RequestDatabaseContext.runDetachedTransaction`
     （独立连接 + 独立事务 + 新 ALS 上下文，GUC/RLS 仍生效）承载拒绝路径上必须存活的写入；
  ③ SQL CHECK 的**三值逻辑**：`revoked_reason IN (...)` 在 `revoked_reason IS NULL` 时求值为 NULL，
     `false OR NULL = NULL` → "有时间无原因"的半成品撤回被静默放行（093 verify 探针当场抓到；
     092 的行动项归属 CHECK 同类问题一并烧掉并补第三个探针）。
- **纪律**：拒绝路径上的写入必须**独立提交**（否则"留痕"是空头承诺）；
  e2e 断言要覆盖"被拒绝"的反向路径（只断言 happy path 等于没测执行边界）。

### 3.6e 搬运任务 → 执行机构（NO-61a，2026-09-12 第 61 轮）

- **命令**：`make e2e-agv-transport`（= `npm run e2e:agv-transport`；需运行中 API + PG）。
- **验证（10 PASS / 0 FAIL / 1 SKIP）**：执行机构状态帧 → 设备台账/世界快照可见（`transport.move` +
  电量 + 坐标）→ 建搬运任务并走**任务状态机**（`submit` → `skip_approval` → `pending_dispatch`；
  `draft` 不参与排程）→ 候选里出现该 AGV 且**至少一条 eligible** → **调度方案把该任务派给该 AGV** →
  同一台 AGV 的命令闭环 `executed`。
- **场景纪律（本轮踩到并写进脚本）**：
  ① 执行机构必须**持续上行**：`device:telemetry` 新鲜度 **60s**，过期即判 OFFLINE、候选理由变
  `device_offline` → 每轮调度前补一帧心跳（现场本来也该这样接）；
  ② `objectiveProfile`（单变体）会按画像筛任务，可能"本任务不在方案里"——验证派工必须用默认三变体；
  ③ **候选计算很慢**（本开发库约 8800 条），不能挤在"方案→审批"的快照窗口里，故挪到审批之后；
  ④ 残留任务会抢同一台执行机构，场景收尾只删自己造的事实行（调度域行交给 reset 脚本）。
- **如实记录的 SKIP**：设备新鲜度 60s vs 单次求解数分钟 → 方案到达即过期，`approve` 被
  `assertFreshForApprove` 正确拒绝（`PLAN_STALE`）。场景记 SKIP + 原因（未验证 ≠ 通过）。
  **第 62 轮已按"过期可解释 + 一键重排"落地（NO-62c，见 §3.6f）**：审批语义不放宽（过期仍拒绝），
  但 409 体带差异明细、页面可一键重排；"冻结窗口审批"未采纳（会削弱新鲜度闸门）。

### 3.6d 场景必须自建前置条件（NO-60a 同轮修复）

- **教训**：`e2e:capability-explain` 依赖"当前有**生效中**的高风险执行能力"，而**上一轮被中断的运行**
  会把 `exo-lift` 留在已停用状态 → 本轮脚本继续往下断言，报出一串与"停用解释链路"无关的 FAIL，
  并连带让 `e2e:exo-session` 因"没有具备 exo-lift 的外骨骼设备"而 SKIP。
- **修复**：场景先尝试按**规范审批路径**恢复一台设备的能力（自批会被拒 → 另一身份审批 →
  带审批号恢复），恢复不了才 SKIP 并写明原因。**环境状态不得伪装成产品缺陷**，
  前置条件不满足时"明确的 SKIP"比"一串假 FAIL"诚实。
- **运维提醒**：**不要并发跑两条链**（同一 DB）——实测两条链并发时 `POST /api/scheduler/runs`
  会在世界快照版本计数器上争锁（响应 30s 后 500）；强杀场景进程还会把设备能力留在中间状态。

### 3.6c 主产品闭环 E2E 链入库（NO-60a，2026-09-12 第 60 轮）

- **命令**：`make e2e-chain`（= `bash scripts/e2e-chain.sh`；需 `EWOH_E2E_*` 凭据 + 运行中 API + PG）。
- **为什么入库**：这条链（**16 个场景**：golden / receipt / wave / learning / capability-explain /
  approval-expiry / observation-reasoning / master-data / materials / exo-session / data-quality /
  learning-signal / improvement-action / **control-actuator** / perception-fusion / edge）此前只存在于
  本地临时脚本，别人无法复现——它恰恰是"感知—理解—决策—授权—执行—反馈—学习"最有力的证据来源。
- **三条纪律**（都是踩过的坑）：① `set -o pipefail`（管道会吃掉失败场景的退出码，实测出现过
  21 PASS/1 FAIL 仍 exit=0）；② 每场景保留完整日志 + 打印 FAIL/SKIP 明细（`tail -3` 排障时什么都看不到）；
  ③ 三态退出码：0=全过、1=有 FAIL、2=有 SKIP（未验证 ≠ 通过）。
- **本地实测（2026-09-12）**：16 场景全过、0 FAIL、0 SKIP（含新增 `e2e:control-actuator` 18/18）。

### 3.6b 平台授权 → 边缘执行 → 回执（NO-60a，2026-09-12 第 60 轮）

- **命令**：`make e2e-control-actuator`（= `npm run e2e:control-actuator`，需运行中 API + PG）。
- **验证链（18 项）**：高危请求创建 → 未审批下发 403 → 生成人自批 403（审批独立性）→
  独立审批通过 → 缺 payload 400 → 下发含 payload（台账 `sent`）→ 边缘轮询拿到命令 +
  **平台签发授权号** `control:<requestId>` + payload → 别的设备号取不到（设备隔离）→
  边缘子进程执行（投递确认 + 执行回执）→ 平台台账 `executed` → 结果表区分
  `gateway_ack` / `command_receipt` → 审计（send + ack）→ 终态重复 ack 409 →
  孤立命令（无对应请求）不投递 → 无密钥 401 / 重复 ack 幂等。
- **本轮 e2e 自证抓到的两个真缺陷**：① 人面回执路径要 Bearer 用户令牌，机器身份不可达
  → 命令停在 `gateway_received`、执行结果丢（新增网关回执面，按 commandId 复用同一套校验）；
  ② 控制详情读面形状是 `{request, status}`，脚本按平铺读 → 断言读到 `undefined`
  （已把"读面形状"写进断言）。
- **执行边界同源**：`HIGH_RISK_COMMAND_KEYS` 并入共享契约 `ACTUATOR_HIGH_RISK_COMMANDS`
  （`dispatch_task`/`resume`/`clear_fault`）——此前平台不知道 `dispatch_task` 是高危，
  一条让设备在共享空间动起来的命令可以绕过审批直达设备。

### 3.6a 执行机构（AGV/PLC）适配与命令面（NO-59b，2026-09-12 第 59 轮）

- **命令**：`python3 -m pytest -q src/edge_platform/tests/test_actuator_adapter.py src/edge_platform/tests/test_actuator_api.py
  src/edge_platform/tests/test_sensor_frame_contract.py src/edge_platform/tests/test_capability_field_parity.py`
  （随 `make test` / 全量 pytest 一起跑）。
- **覆盖**：适配器与传输（17：派工→移动→到达、暂停/恢复、返航、故障注入、低电量自停、
  未知目标工位显式故障）；边缘 API（11：清单/详情/未注册 404、缺授权 403、授权号形状非法 400、
  安全命令 202、未知命令 400、离线传输 503、审计写入）；帧归一化（5：actuator kind、
  三段压平、词表外状态标记、缺字段 FrameContractError、端点登记）；能力字段对账（执行机构样本帧
  参与"契约字段必须真的被产出"断言）。
- **`EWOH_ADAPTERS` 配置示例**（无硬件时用回环模拟器）：
  `[{"kind":"agv","deviceId":"AGV-01","sourceType":"simulated","stationId":"ST-1","batteryPct":88}]`
- **真实硬件路径**：实现 `ActuatorTransport`（`send`/`recv`/`close`）并在配置里注入即可，
  适配器判定顺序、审计与结果契约不变；真机联调前，全部语义由回环模拟器与 pytest 锁定。
- **端到端（真实 PG）**：`make e2e-edge`（`e2e:edge` **59 项**）新增 2k~2k5——边缘模拟 AGV
  （`tools/edge_sensor_sim.py --with-actuator`）→ 归一化（`FRAME_KIND_ACTUATOR`）→ 上行桥 →
  `POST /api/ingest/actuator` → `ewoh_world_state.state_json.actuator`（位置/故障/授权号）+
  `ewoh_device`（类别 `agv`）+ `ewoh_device_capability`（transport.move / observe.actuator_state /
  observe.position）。
- **场景确定性提醒**：三类感知适配器与执行机构适配器**共享同一个故障注入 RNG**，
  新增适配器必须**追加在列表末尾**（插到前面会改变既有迟到/重复注入模式，
  实测导致 `2d 迟到帧仍然落库` 下线）。
- **已登记的偶发**：`test_event_uplink.py::test_loop_drains_and_posts` 在**全量套件**下偶发失败、
  单独运行稳定通过（第 59 轮实测 1 次；属时序敏感，与本轮改动无因果关系，未做掩盖式重试）。

### 3.5a-7 本轮新增断言（NO-59a，2026-09-12 第 59 轮）

- `e2e:perception-fusion` **20 项**：新增 `7g`（真实摄入外骨骼**膝角**（直立）+ 视觉动作 `squatting`
  → 动作维度两个独立源结论相反 → 记 `action` 冲突，`posture.action` 取外骨骼派生动作）、
  `7h`（膝角落在中间态 → 不判定动作、如实写原因、不再产生动作冲突）。
- **本轮抓到的三类真缺陷（都可复现，不是"看起来不对"）**：
  ① `Number(pitchDeg)` 把 `null` 变成 `0` → 缺俯仰的输入被判成 `standing`（缺失被伪造成确定事实）；
  ② 置信度按**观测**累加 → 同一源报 N 个维度拿 N 倍权重（`min(1,…)` 还把膨胀掩盖成"高置信"）；
  ③ 冲突读面存在**第二份推导**（`SchedulerQueryService.buildConflicts`）且让 **GET 产生 SSE 写副作用**。
- **删除孪生实现后的测试迁移**：19 个冲突场景改为注入真实 `ConflictService`（场景断言不变、覆盖更强）；
  facade 表征测试改为钉住"未装配即显式失败 + 读面零副作用"；`conflict.detected` 的推送由
  `ConflictService.reconcileNow` 单点承担（本文件用真实实例断言 orgId 正确）。

### 3.5a-6 本轮新增断言（NO-58a/b/c，2026-09-12）

> **已知不稳定（记录在案，不掩盖）**：`e2e:golden` 的 `18-19. Reservation + Dispatch` 偶尔
> 返回 `409 PLAN_STALE`（第 58 轮两次全链跑：一次 22/22 PASS、一次 21/22）。原因是"生成方案 →
> 派工"之间世界版本被并发推进（同一窗口内的其它扫描/回放），**不是本轮改动引入**；
> 单独重跑 `npm run e2e:golden` 稳定 22/22。后续要么给该步骤加"等待快照稳定"的重试，
> 要么在派工前显式重取快照——两条都还没做，先如实登记。


- `e2e:improvement-action` **28 项**：新增 `19`（归属由 incident `target_id` 派生并落库）、
  `20`（复发度量：完成前 3 次 / 完成后 0 次 → `recurrence_dropped` + "不等于改进有效"）、
  `21`（plan 复盘无单一对象 → `no_subject`，不硬算）、`22`（空归属成对落库）、
  `23`（人员归属写 `person:<uuid>` 规范引用，执行事实表存裸 id → **仍要能查到 3 条偏差**）。
- `e2e:perception-fusion` **18 项**：新增 `7d`（视觉骨架换算躯干角 → 与外骨骼 30° 差 57° →
  姿态角度冲突）、`7e`（骨架缺髋部要点 → 不换算、如实写原因、不再产生角度冲突）、
  `7f`（不可信主体牵涉在飞任务 → 调度冲突面出现 `perception_inconsistent`，带资源/任务/依据，
  且 `resolution` 明说"不阻断调度"）。
- **本轮的"断言自伤"教训（两处，都是脚本自身写错）**：
  ① 7d 首版骨架几何只算出 ~40°（与外骨骼 30° 差 10° < 容差 30°）→ 断言必然失败；
  ② 7f 首版用文本任务号写 `ewoh_production_task.id`（uuid 列）→ `invalid input syntax for type uuid`，
  且 `status='in_progress'` 不在 `ck_production_task_status_contract` 词表内、任务未挂 `assignee_id`
  （人是冲突主体，任务不挂人就永远进不了冲突面）。写 e2e 断言时必须**先核对列类型/CHECK 词表/关联字段**。
- **实现侧同轮抓到的两个"前缀不一致"缺陷**：① 复发度量用带前缀的归属查裸 id 列 → 恒 0 行
  （`executionSubjectKey` 归一）；② 冲突面把 `person:<id>` 主体误判成 `device`
  （先认规范前缀再查实体表）。两者都是"看起来对、数据永远为空"的静默错误。

### 3.5a-5 本轮新增断言（NO-57a/b/c）

- `e2e:materials` **27 项**：新增 `NO-57a`（订单链可用 + 缺口词表封闭）、`NO-57b`（对账：样本足够给比率、
  不足给 null 且绝不给 0%）。
- `e2e:improvement-action` **23 项**：新增 `17c`（完成即回流知识条目：行动项带 `outcomeRef` 且知识条目可检索）。
- **注意**：`e2e:materials` 的步骤顺序敏感（订单链依赖前面的 ERP 出站与实时评估），
  改动脚本时必须保持块位置（本轮修过一次错位导致语法破损）。

### 3.5a-4 本轮扩容后的三个场景（NO-56b）

- `e2e:perception-fusion` **14 项**（NO-56b 时点；NO-58c 后为 **18 项**）：新增 7b（同工位两台环境传感器一致 →
  区域主体 consistent + 代表值）、7c（单台传感器 → single_source + 超阈值只报事实）。
- `e2e:data-quality` **15 项**：新增 12b（>24h 未了结 → `quality_aging` 再催一次）。
- `e2e:improvement-action` **22 项**：新增 16b/16c（逾期提醒命中班组长角色 + 重复扫描幂等）、
  17b（完成后提醒落 `action_completed` 终态，同事务）。
- **注意**：`e2e:improvement-action` 的 17 号断言依赖"完成发生在扫描之前"的**步骤顺序**，
  调整脚本时必须同步（本轮先失败后修正过一次）。

### 3.5a-3 多模态感知融合场景（NO-56a 新增，需运行中 API + PG）

- **命令**：`make e2e-perception-fusion`（= `npm run e2e:perception-fusion`）。
- **验证**：三源**真实摄入**（`/api/ingest/location` + `/exoskeleton` + `/camera`）→
  规则 1 一致/高置信 → 规则 2 冲突（各源取值保留、禁止强建议）→ 规则 3 视觉缺失降级 →
  不猜（视觉未匹配计数、坐标超半径工位未知）→ 幂等 + 只读（世界状态行未被改写）→
  规则 4/7 过期证据 → `insufficient`+`unknown`+`score=null` → 读取面返回最新快照与五条规则留痕。
- **本地实测（2026-09-12）**：12 PASS / 0 FAIL / 0 SKIP（真实 PG）。
- **注意**：该场景同时是**摄入映射的回归网**——它曾抓到 `pose.pitch_deg` 与帧内 `entity_id`
  在摄入层被静默丢弃（映射方言与身份覆盖），修复后场景才转绿。

### 3.5a-2 改进行动项场景（NO-55a 新增，需运行中 API + PG）

- **命令**：`make e2e-improvement-action`（= `npm run e2e:improvement-action`）。
- **验证**：已发布复盘的 warning/critical 经验 + 缺口 → 行动项（info 不立项、草稿不扫）→
  来源/证据/建议类型 → 扫描只读复盘且幂等 → 接受门槛（负责人+期限+判据）与重复接受 409 →
  完成门槛（结果说明）与终态不可转移 → 拒绝必须给理由 → 逾期待办口径 →
  重复扫描保留人的决定 → 落库事实与响应一致。
- **本地实测（2026-09-12）**：19 PASS / 0 FAIL / 0 SKIP（真实 PG）。
- **注意**：扫描有条数上限，开发库里其它已发布复盘会挤占名额——场景用
  `{retrospectiveIds}` **聚焦扫描**保证确定性（这也是页面"从这篇复盘生成行动项"的能力）。

### 3.5a 学习回路接线场景（NO-54a 新增，需运行中 API + PG）

- **命令**：`make e2e-learning-signal`（= `npm run e2e:learning-signal`）。
- **验证**：运行记忆（提醒治理积压 / 数据质量待核实积压 / 执行偏差复发）→ 信号
  （证据引用、样本量、可信度、方向）→ 信号不创建提案 → 重复扫描幂等且不覆盖人的决定 →
  忽略必须给理由 → 不可执行信号拒绝提案 → **基线漂移 409** → 重新扫描 →
  人生成提案（基线=扫描时值、目标=人给值、停在人审阶梯之前）→ 不可重复提案。
- **本地实测（2026-09-12）**：19 PASS / 0 FAIL / 0 SKIP（真实 PG）。
- **注意**：信号号是**确定性**的，所以场景必须在开始时显式复位同族的信号/提案行
  （脚本 `resetScenarioSignals`）——按 tag 清理抓不到确定性 id，会出现"幂等 PASS 但提案永远 409"。

### 3.5b 全新库迁移链 + 全量 verify（NO-53a 新增，需 PG）

- **命令**：`EWOH_PG_URL=postgresql://ewoh_owner:***@127.0.0.1:55432/ewoh \
  EWOH_API_DATABASE_PASSWORD=*** make migration-fresh-chain`
  （等价于 `node scripts/migration-fresh-chain-check.js`；加 `KEEP=1` 保留临时库排查）。
- **做什么**：建一个临时库 → `standalone-chain.js --apply` 顺序执行**全部**迁移 →
  逐条执行**全部** `--verify-standalone*` → 打印 PASS/FAIL 清单。
- **与主线 5 的区别**：`make audit-regression-gates` 的主线 5 默认只做静态顺序校验
  （真实空库模式需要主机装 `psql`）；本命令用仓库自带的 node 迁移 runner，不依赖 `psql`，
  且覆盖**全部 verify**（主线 5 的 PG 模式只 apply + verify 文件，且需 `psql`）。
- **基线**：`db/migration-verify-baseline.txt` 登记**已知**失败项。基线只允许缩小：修好一项删一行
  （脚本会提示 FIXED）；出现基线外的新失败 → 非零退出（回归即失败）。
- **本地实测（2026-09-12，第 58 轮烧账后）**：apply **90/90 成功**；verify **90/90 通过、
  已知基线失败 0**（基线文件已清空）。
- **烧账记录（12 → 0，全部是"验证资产自身"的缺陷）**：缺自证标记（058/059/060/067/068）／
  标记写错迁移号（065 写成 057）／verify 从未登记进 `SIMPLE_VERIFY_COMMANDS`
  （063 → runner 报 `path argument must be of type string`）／`FROM (VALUES 'a','b')` 语法错误
  （057，基线曾误记为"psql 专属 `\gexec`"）／psql 专属 `\gset` + `:var`（064/069）／
  探针行未满足后续收紧的 CHECK 且 `EXCEPTION WHEN OTHERS` 静默吞错（053，已把 `SQLERRM`
  写进断言消息）／可见性探针以 **owner（superuser）** 连接被 RLS 绕过 → 三项探针恒 false
  （056 → 探针改在 `SET LOCAL ROLE ewoh_api`（service_role 成员、NOBYPASSRLS）下执行，
  结束时 `RESET ROLE` 再清理）。
- **同轮另一条教训（改共享结论形状时）**：NO-58b 给推理结论加了 `advisoryOnly`/`advisoryReason`/
  `perceptionGate` 三个**总是存在**的字段 → 跨语言金标场景（`tests/golden-fixtures/contract-golden-scenarios.json`
  + TS/Python 两侧消费）立刻红：边缘运行时的结论形状没有这三个字段。正解不是改 fixture 迁就平台，
  而是**字段只在有感知门控时出现**（"未评估"用缺省表达，而不是 `false`；这也让调用方能区分
  "未评估"与"已评估且允许"，符合原则 7）。凡是要动共享结论/事件形状，先跑
  `shared/golden-contract-scenarios.spec.ts` + `tests/test_golden_contract_scenarios.py`。
- **教训（写验证资产时）**：① 每个 verify **必须输出与本迁移号一致的自证标记行**（只做 DO 断言
  等于永远失败）；② 新增 verify 命令要同时登记进 `SIMPLE_VERIFY_COMMANDS`/`COMPLEX_VERIFY_COMMANDS`
  与 `FILES` 映射（只加进命令清单 → runner 读不到文件）；③ 迁移 runner 是 postgres.js，
  **不许用 psql 元命令**；④ 探针要按**终态约束**构造（后续迁移收紧的 CHECK 会拒绝旧探针）；
  ⑤ RLS 探针必须在**非属主角色**下跑（属主/超级用户绕过 RLS）。**注意**：这条命令必须用**独立临时库**——`EWOH_PG_URL` 指向正在服务的库时，
  迁移里的 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` 会与运行中的 API 争锁
  （实测 deadlock detected），脚本已自动建/删临时库规避。

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