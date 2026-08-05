# EWOH 工程真实性收口 — 只读审计基线

> 审计性质：**只读**（未修改任何代码/配置，未运行任何写仓库文件的命令）。
> 审计时间：2026-08-05（Asia/Shanghai）。
> 审计对象：`/Volumes/Extra/CodeProj/EWOH`，git HEAD=`5ddacdd20c2ffacf6f8ef06f77841675a82f9f0f`。
> 唯一落盘的写操作：本报告文件。

---

## 1. 环境指纹

| 项目 | 值 |
|------|-----|
| `git rev-parse HEAD` | `5ddacdd20c2ffacf6f8ef06f77841675a82f9f0f` |
| `git log -1 --format="%H %ci %s"` | `5ddacdd20c2ffacf6f8ef06f77841675a82f9f0f 2026-08-05 11:08:11 +0800 feat(production-ux): production-ux-deepening closure - UX, offline, PWA, observability, security` |
| `node -v` | `v26.5.1` |
| `npm -v` | `11.17.0` |
| `python3 --version` | `Python 3.9.6` |
| `python3 -m pytest --version` | `pytest 8.3.3` |

工具链存在性（`command -v`）：

| 工具 | 状态 |
|------|------|
| psql | **MISSING** |
| pg_ctl | **MISSING** |
| postgres | **MISSING** |
| docker | **MISSING** |
| kubectl | **MISSING** |
| helm | **MISSING** |
| gh | **MISSING** |
| bandit | **MISSING** |
| ruff | 存在 `/Users/panhao/.local/bin/ruff` |

Playwright 浏览器缓存目录 `~/Library/Caches/ms-playwright` 已安装版本：
- chromium-1223、chromium-1228
- chromium_headless_shell-1223 / -1228 / -1234
- firefox-1522、firefox-1538
- webkit-2287、webkit-2336
- ffmpeg-1011

> 注：浏览器二进制已就位，但完整 auth 浏览器流程仍需真实 PostgreSQL 运行时库（见 §8）。

---

## 2. Git 状态

| 项目 | 输出 |
|------|------|
| `git status --short` | `?? .trae/specs/engineering-truthfulness-production/`（**存在一个未跟踪目录**，与“git 已干净”的预期不符） |
| `git branch --show-current` | `main` |
| `git remote -v` | `origin  git@github.com:qq547820639/EWOH.git (fetch/push)` |

> 除 `.trae/specs/engineering-truthfulness-production/` 外，无其他未跟踪/已修改文件。

---

## 3. GitHub Actions 配置审计

共 4 个 workflow：`test.yml`、`standalone.yml`、`package.yml`、`security.yml`。**所有 `uses:` 均固定到主版本标签（`@v4`/`@v5`），未使用 `@latest` 或浮动版本**；`npm ci` 依赖 `package-lock.json` 锁定。未发现 `@latest` 依赖。

### 3.1 test.yml（job: `test`）
| 步骤 | 内容 |
|------|------|
| 检出代码 | `actions/checkout@v4` |
| 安装 Python | `actions/setup-python@v5` (3.11) |
| 安装 Python 开发依赖 | `pip install -r requirements-dev.txt` |
| 运行 unittest 测试套件 | `make test` |
| 运行仓库级契约测试 | `make test-contract` |
| 运行 ruff 静态检查 | `ruff check src/edge_platform` |
| 安装 Node.js | `actions/setup-node@v4` (22, cache npm) |
| 安装前端/后端依赖 | `npm ci` |
| 仓库事实源一致性校验 (P0-1) | `audit-repo-facts --strict` + `collect-repo-facts` + `validate-repo-facts` |
| Work Graph 不变量与阻塞诊断 (P0-6/P0-7) | `work-indexer --strict --invariants` + `work-console --strict` |
| 权威制品一致性对账 | `reconcile-authoritative-artifacts --strict` |
| NestJS 类型检查 | `npm run type:check` |
| NestJS Jest 测试 | `npm test -- --runInBand` |
| NestJS 生产构建 | `EWOH_SKIP_PLUGIN_INIT=1 npm run build:prod` |
| 断言零第三方运行时依赖 | grep `dependencies = []` |

### 3.2 standalone.yml（job: `build-test`，含 Postgres 17 Service Container）
步骤：Checkout(`@v4`) → Setup Node(`@v4`) → Install deps → Type check → Lint → Jest → OpenAPI route audit(`--strict`) → OpenAPI contract drift gate(`gen:openapi:check`) → Work Graph 不变量/控制台 → Build standalone → DDL runner plans → **PostgreSQL 17 migration, RLS, audit, and rollback**(`standalone-postgres-check.sh`) → **F61-02 domain migrations(apply/verify/rollback/re-apply)** → **F61-02 dual-instance concurrency & upgrade/rollback verification**(`verify-domain-concurrency.js`) → **E2E HTTP + PostgreSQL**(`test:e2e`) → Install Playwright browsers → **Browser authenticated flows**(`test:browser`) → **Build Docker image**(`Dockerfile.api`+`Dockerfile.migrate`) → Collect/Upload F61-02 CI evidence(`actions/upload-artifact@v4`)。

### 3.3 package.yml（job: `package`）
步骤：Checkout(`@v4`) → 安装 Python(`@v5`) → 打包源码 tarball（纯标准库 tar，`VERSION="${GITHUB_REF_NAME#v}"`） → 上传构建产物(`actions/upload-artifact@v4`)。触发：tag `v*`。

### 3.4 security.yml（job: `security`）
步骤：Checkout(`@v4`) → 安装 Python(`@v5`) → 安装 bandit(`pip install bandit`) → **运行 bandit 静态安全扫描**(`bandit -r src/edge_platform -ll`) → 安全边界守护(grep 禁止控制符号 estop/emergency_stop/joint_torque_limit_set/assist_closed_loop)。

---

## 4. 版本与状态漂移扫描

### 4.1 版本一致性（`0.6.0-rc4`）→ 一致 ✓
| 来源 | 值 |
|------|-----|
| CHANGELOG.md 顶部已发布版本 | `## [0.6.0-rc4] - 2026-08-04`（顶部另有 `[Unreleased]` 段，未发布） |
| docs/delivery/release-manifest.yaml | `release: 0.6.0-rc4` / `date: 2026-08-04` |
| release/ewoh-0.6.0-rc4/docs/delivery/release-manifest.yaml | `release: 0.6.0-rc4` / `date: 2026-08-04` |
| ewoh-spark-app/package.json | `name: ewoh-spark-app` / `version: 0.6.0-rc4` |
| .codex/artifacts/state.json | 含 `0.6.0-rc4` |
| README.md | `发布候选为 0.6.0-rc4`、`release/ewoh-0.6.0-rc4` |

### 4.2 不一致项清单（按严重度）

**D1（高）— 权威状态文件硬编码的 HEAD SHA 与真实 HEAD 不一致（已由 4 重工具实证）**
- `.codex/artifacts/phase-state.md` 第 6 行、`.codex/artifacts/gates.md` 第 20 行均声明 `HEAD 5986564ac34b63785959d9e92c3d2750e2c7a7b2`；
- 真实 HEAD = `5ddacdd20c2ffacf6f8ef06f77841675a82f9f0f`，**不匹配**。
- 触发链：`semantic-rules` → 2 条 `head-consistency` error；`work-indexer --invariants` → 2 条冲突；`audit-repo-facts --strict` → `repository_semantic_consistency` FAIL（38/39）；server Jest `test/unit/repo-facts.spec.ts` 失败（详见 §7）。

**D2（高）— server/client 测试计数在“权威状态文件”与“release-manifest/审计常量”之间不一致**
- 权威状态文件（phase-state.md / gates.md / state.json `final_authoritative`）：server `81 suites / 391 tests`、client `15 suites / 50 tests`、OpenAPI `253/253`、DB `51 managed / 57 physical`。
- release-manifest（docs/delivery）+ `audit-repo-facts.js` 的 `TEST_COUNT_DRIFT`：server `84 suites / 449 tests`、client `55 suites / 335 tests`、OpenAPI `255/255`。
- **实测值**（§7）：server `84 suites / 449 tests`、client `55 suites / 335 tests`、OpenAPI `255/255` —— 与 release-manifest/审计常量一致，说明 `.codex/artifacts` 状态文件（phase-state/gates/state）为**过期快照**，未随 HEAD 收口更新。
- 另：phase-state.md 内 OpenAPI 写 `255/255`，而 gates.md/state.json 写 `253/253`（状态文件内部自相矛盾）。

**D3（中）— 发布包 manifest 与权威 manifest 漂移**
- docs/delivery/release-manifest.yaml（权威）：`postgres_gate: 57 managed tables / 57 RLS`、`git_sync: 238 items`、e2e 注明 `onboarding/mapping/replay/SOP/quality/slow-query/role-workbench paths included`、browser `4/4 passed on real PG`、含 `world_replay/esop/quality_schemes/observability/frontend_perf/role_workbench/progressive_lists/replay_context_ui` 等 evidence 键。
- release/ewoh-0.6.0-rc4/docs/delivery/release-manifest.yaml：`postgres_gate: 51 managed tables / 51 RLS`、`git_sync: 188 items`、无上述新 evidence 键、browser 无 "4/4" 与 "real PG"、额外含 `contracts.database` 段。
- 即发布包内 manifest 是更早版本，未与权威 manifest 同步。

**D4（低）— git 工作区非完全干净**
- 存在未跟踪目录 `.trae/specs/engineering-truthfulness-production/`（任务描述称已干净，实测非完全干净）。

`output/work-console.json` 与 `output/work-graph.json` 的图计数一致：`252 items / 209 edges / 48 actors / 191 evidence / 14 gates / 0 invariant conflicts`（与权威 manifest 的 work_graph 一致）。`work-console` 的 `missingEvidence` 列出 G7、G9、WP-ENV-001 无证据，`gateSummary` 要求人工批准 G10-G13。

---

## 5. 硬编码审计

| 文件 | 硬编码内容 |
|------|-----------|
| `scripts/audit-repo-facts.js` | `TEST_COUNT_DRIFT` 常量：`serverJest:'84 suites / 449 tests'`、`clientJest:'55 suites / 335 tests'`、`openapi:'255/255'`、`e2e:'33/33'`、`browser:'5/5'`；`version='0.6.0-rc4'`；`release/ewoh-0.6.0-rc4/...` 路径。**无硬编码 HEAD SHA**。 |
| `scripts/collect-repo-facts.js` | `VERSION='0.6.0-rc4'`、`release/ewoh-0.6.0-rc4/...` 路径。 |
| `scripts/scale-release-review.js` | `version = process.env.EWOH_RELEASE_VERSION \|\| '0.6.0-rc4'`（env 可覆盖）。 |
| `scripts/validate-repo-facts.js` | 无硬编码版本/计数/HEAD（从 snapshot 读取）。 |
| `scripts/reconcile-authoritative-artifacts.js` | 无硬编码版本/计数/HEAD；动态比对 changelog 与 manifest 版本。 |
| **受 Git 管理的文件硬编码 HEAD SHA** | `.codex/artifacts/phase-state.md`、`.codex/artifacts/gates.md` 硬编码 `5986564...`（**过期、不匹配**）；`docs/reviews/production-ux-deepening-report.md` 亦引用 `5986564...`（作为“本报告执行起始”的历史引用）。 |

> 结论：工具脚本未硬编码 HEAD SHA；但**文档型受管文件硬编码了过期 HEAD SHA**，且是当前唯一使 repo-facts/语义规则失败的原因。

---

## 6. 能力贯通性审计（只读确认）

### 6.1 后端 frontend metrics 摄取
- `server/modules/` 含 `metrics/`（metrics.controller/interceptor/module/service）与 `observability/`（observability.module / slow-query.controller / slow-query.service）。
- **observability 模块无 frontend-metrics 摄取控制器**，仅 `GET /api/observability/slow-queries`。
- 前端 `client/src/lib/observability.ts` 中 `FRONTEND_METRICS_ENDPOINT = ''`（空串），注释明确“后端未暴露 `/api/observability/frontend-metrics`”，`flush()` 退化为“清空缓冲+日志”。**前端指标仅缓冲、不落后端**。

### 6.2 uploadGuard 接入
- `client/src/lib/uploadGuard.ts` 仅被 `uploadGuard.test.ts` 引用（grep `uploadGuard` 在 client/src 仅命中这 2 处，均在测试文件）。**未接入任何非测试入口**。

### 6.3 offlineQueue.ts idempotencyKey
- grep `idempotencyKey|idempotency` 于 `client/src/lib/offlineQueue.ts` → **0 命中**。offlineQueue 不含幂等键。

### 6.4 leader election / navigator.locks
- grep `navigator.locks|WebLock|leader` 于 client/src → 仅命中 `types/openapi.d.ts` 中角色枚举 `"shift_leader"`。**前端无 leader election / Web Locks 实现**。

### 6.5 observability.ts 接入
- `client/src/index.tsx` 第 15 行 `import } from './lib/observability'`（**非测试入口已引用**）。另有 `observability.test.ts`。接入状态：**已接入前端入口**，但后端摄取端点为通配（见 6.1）。

### 6.6 client/src/lib 现有模块清单
offline/上传/可观测相关：`offlineQueue.ts`、`offlineConflict.ts`、`offlineDb.ts`、`offlineStatus.ts`、`resumableUpload.ts`、`uploadGuard.ts`、`attachmentCompression.ts`、`attachmentDataUrl.ts`、`storageController.ts`、`observability.ts`、`diagnosticQuery.ts`、`requestCorrelation.ts`、`swCache.ts`、`gitSync.ts`、`siteReadiness*`、`draftStore.ts`、`feedback.ts`、`logger.ts` 等。

---

## 7. 可本地运行的 gate 基线（实测）

| Gate | 命令 | 结果 |
|------|------|------|
| 类型检查 | `npm run type:check` | **PASS**（server+client tsc，exit 0） |
| Lint | `npm run lint` | **PASS**（eslint+stylelint+typecheck，exit 0） |
| server Jest | `npm test -- --runInBand` | **84 suites / 449 tests：1 FAILED / 448 passed**。失败项：`test/unit/repo-facts.spec.ts` → `repository_semantic_consistency`：`2 unexempted conflicts: head-consistency(error), head-consistency(error)`（即 §4-D1） |
| client Jest | `npm run test:client` | **55 suites / 335 tests 全 PASS**（exit 0） |
| OpenAPI route audit | `node scripts/audit-openapi-routes.js --strict` | **Controller=255 / Spec=255 / Documented=255 / Undocumented=0 / Unimplemented=0**（exit 0） |
| OpenAPI drift | `npm run gen:openapi:check` | **PASS**：`OK: OpenAPI contract checked; committed outputs are in sync.` |
| Python unittest | `python3 -m unittest discover -s src/edge_platform/tests` | **Ran 667 tests in 21.569s — OK** |
| Python pytest | `PYTHONPATH=src python3 -m pytest tests/ -q` | **120 passed in 0.32s** |
| ruff | `ruff check src/edge_platform` | **All checks passed!** |
| bandit | `bandit` | **BANDIT_MISSING**（本机未安装，无法本地运行；CI 见 security.yml） |
| repo facts | `node scripts/audit-repo-facts.js --strict` | **38/39 passed；FAIL `repository_semantic_consistency`（head-consistency）**；注：脚本 exit code=0（报告 FAIL 但退出码为 0） |
| semantic rules | `node tools/semantic-rules/index.js --strict` | **2 findings（2 errors / 0 warnings）across 14 rules**：head-consistency 两处（phase-state.md、gates.md）；exit 0 |
| work indexer | `node tools/work-indexer/index.js --strict --invariants` | **252 items / 209 edges / 48 actors / 191 evidence / 14 gates / 0 conflicts；Semantic conflicts: 2（head-consistency）**；exit 0 |
| gate engine | `node tools/gate-engine/index.js` | **14 gates / 0 approved / 4 require human approval**（G10、G11、G12、G13）；exit 0 |

> 关键观察：`semantic-rules` / `work-indexer` / `audit-repo-facts` 均报告 head-consistency 错误但**退出码为 0**；而包裹它的 server Jest 测试 `repo-facts.spec.ts` 因断言 `failed===[]` 而**失败**。即“工具 CLI 宽容、Jest 封装层严格”，两者对同一残缺状态判定不一致。

---

## 8. BLOCKED_BY_ENVIRONMENT 项（本机无法运行）

| 项 | 本机阻塞原因 | CI 入口（workflow → 步骤名） |
|----|--------------|------------------------------|
| PostgreSQL migration / RLS / audit / rollback | psql、pg_ctl、postgres 均 MISSING | standalone.yml → `PostgreSQL 17 migration, RLS, audit, and rollback` |
| F61-02 domain migrations（apply/verify/rollback/re-apply） | 需真实 PG | standalone.yml → `F61-02 domain migrations (apply, verify, rollback, re-apply)` |
| 双实例并发验证 | 需真实 PG | standalone.yml → `F61-02 dual-instance concurrency & upgrade/rollback verification` |
| HTTP + PostgreSQL E2E（`npm run test:e2e`） | 需真实 PG 运行时库 | standalone.yml → `E2E HTTP + PostgreSQL` |
| Docker build | docker MISSING | standalone.yml → `Build Docker image`（及 `Collect F61-02 CI evidence` 依赖 `docker exec`） |
| Helm / K8s 运行时验证 | helm、kubectl MISSING（chart 静态审计 `verify-helm-chart.js` 可本地跑，K8s apply 阻塞） | standalone.yml / package.yml（打包）；K8s 生产 apply 处于 pending |
| bandit 静态安全扫描 | bandit MISSING | security.yml → `运行 bandit 静态安全扫描` |
| auth browser flows 全路径 | Playwright 浏览器已装，但完整认证流程需真实 PG 运行时库（`EWOH_E2E_RUNTIME_DATABASE_URL`） | standalone.yml → `Browser authenticated flows` |

> 上述阻塞项与 docs/delivery/release-manifest.yaml 的 `pending` 段（Docker/Kubectl/Helm absent locally）一致，且均在 standalone.yml/security.yml 中以真实 PG/docker Service Container 提供运行时门禁，未伪造通过或静默跳过。

---

## 附：审计结论摘要

1. 版本（0.6.0-rc4）在 CHANGELOG / manifest / package.json / README / state 间**一致**。
2. **核心待收口项**：`.codex/artifacts/phase-state.md` 与 `gates.md` 硬编码的 HEAD SHA（`5986564…`）过期，与真实 HEAD（`5ddacdd…`）不符——这是当前唯一使 repo-facts / semantic-rules / work-indexer 及 server Jest `repo-facts.spec.ts` 失败的原因。
3. 权威状态文件（phase-state/gates/state.json）的 server/client Jest 计数（81/391、15/50）与已收口的 release-manifest/审计常量（84/449、55/335）不一致，属过期快照。
4. 发布包 `release/ewoh-0.6.0-rc4` 内 manifest 的 postgres_gate（51 vs 57）、git_sync（188 vs 238）等与权威 manifest 漂移。
5. 能力贯通性缺口：后端无 frontend-metrics 摄取控制器（前端指标被丢弃）；`uploadGuard` 仅被测试引用、未接入；`offlineQueue` 不含幂等键；前端无 leader election / Web Locks。
6. 本地可跑的门禁除「head-consistency 相关 1 个 server Jest 用例」外全部通过；E2E/browser/Docker/Helm/bandit/PG 相关门禁本机 BLOCKED_BY_ENVIRONMENT，由 standalone.yml/security.yml 承载。