# EWOH 测试覆盖画像与潜在风险点审计

> 审计人：严过关（QA 工程师）｜基线 commit：`c77895f`（2026-08-23 22:53）｜仓库：`/Volumes/Extra/CodeProj/EWOH`
> 原则：**所有结论均附 `文件:行号` 证据；无法证实者显式标注「未验证」；不采信仓库内既有 `audit-*.md` 的结论，一律重新取证。**
> 本任务为纯研究/分析，**未修改任何源码**（临时产物仅写入 `/tmp`）。

---

## 0. 执行摘要

| # | 结论 | 严重度 |
|---|------|--------|
| 1 | **前端并非「0 覆盖」**——存在 138 个测试文件 / 1173 用例，本机实测 **138/138 全绿、仅 13.9s**。但**无任何 CI 工作流执行它**。 | **P1** |
| 2 | 前端覆盖结构倒置：`lib/` 85.9%、`components/` **5.7%**、`api/` **8.3%**；**最大的 30 个前端源文件（21,282 行）零直接测试**。 | **P1** |
| 3 | 后端测试**极度集中于 scheduler**：3.9 个 spec/kLOC vs 非 scheduler **0.7 个 spec/kLOC（5.6× 落差）**。 | **P1** |
| 4 | **全仓库零覆盖率 instrumentation**：无 `--coverage`、无 `coverageThreshold`、`jest.results.json` 无 `coverageMap`。「2250 测试全绿」**无法换算为任何覆盖率数字**。 | **P1** |
| 5 | **视觉回归门禁已死**：`playwright.visual.config.ts` 声明 Linux 为金基线，但仓库 18 个基线**全部是 `-darwin`**，`-linux` 基线为 **0**；且 `"visual"` 在全部 7 个 workflow 中 **0 命中**。 | **P2** |
| 6 | 用户点名的 3 个「已知一致性问题」中，**2 个已被修复并有测试把守**（`is_shadow` R2-SSV-03、NEST-026 租户守卫顺序），**1 个仍为真问题**（shadow 方案无清理）。另 trigger cooldown 也已实体感知化。详见 §B。 | 见正文 |
| 7 | **dispatch 降级对前端完全不可见**：服务端写了 `executionSync:{ok:false}` 警告字段，但 **client 侧 0 处引用**。 | **P1** |
| 8 | RLS 覆盖 84.3%（86/102 表）；16 张表无 RLS，其中 **5 张含 `org_id` 列**且 4 张不在已登记的 ADR 偏差名单内。 | **P1** |
| 9 | 生产库**模拟器未关闭**（`EWOH_SIMULATOR_ENABLED=1`），已产生 105,269 条事件 / 104,504 条 expired。 | **P1** |
| 10 | 已提交的 `jest.results.json` 是**过期证据**（早于 HEAD 9 小时 / 17 commit）；本机实跑 HEAD 全量后端：**290 套件 / 2250 用例 100% 绿**。真实通过率高于文件所示。 | **P2** |

---

## A. 测试覆盖画像

### A1. 后端（TypeScript / Jest）

**权威数据 = 本机在 HEAD（`c77895f`）实跑全量后端套件的结果**（`npx jest --runInBand`，耗时 622s）：

```
Test Suites: 290 passed, 290 total
Tests:       2250 passed, 2250 total
Time:        622.538 s
```

→ **HEAD 上后端 290 套件 / 2250 用例 100% 通过，零失败。**

对比仓库内已提交的 `ewoh-spark-app/jest.results.json`（生成于 **2026-08-23 14:11:10**，HEAD 为 22:53，**落后 17 个 commit，其中 2 个非文档提交**）：

| 指标 | 已提交结果文件 | **HEAD 实跑（权威）** |
|------|---------------:|---------------------:|
| Suites | 290（289 pass / 1 fail） | **290 / 290 pass** |
| Tests | 2250（2249 pass / 1 fail） | **2250 / 2250 pass** |
| 失败项 | `test/unit/repo-facts.spec.ts:8` | **无** |
| coverageMap | **无** | — |

**唯一失败用例的性质（已复核证伪）**：

```
test/unit/repo-facts.spec.ts:8 — repository_facts_test_counts_reconcile
  detail: "release-manifest test-count drift vs live reports:
           manifest.jest=84 suites / 449 tests live=96 suites / 553 tests;
           manifest.client_jest=55 suites / 335 tests live=81 suites / 629 tests"
```

这是一个**元门禁**（release-manifest 声称的测试数 vs 实际数漂移检测），不是业务缺陷。
本机在 HEAD 上重跑该 spec：

```
PASS test/unit/repo-facts.spec.ts (6.692 s)
  ✓ passes all repository fact-source consistency checks (3248 ms)
Tests: 1 passed, 1 total
```

且 `docs/delivery/release-manifest.yaml:33-34` 现为 `jest: "290 suites / 2250 tests"` / `client_jest: "137 suites / 1156 tests"`，已与实况对齐。
→ **结论：HEAD 上该门禁为绿；`jest.results.json` 是过期证据产物，非真实失败。**

**Spec 文件分布（`find` 实测）**

| 位置 | spec 文件数 | 行数 |
|------|------------:|-----:|
| `server/` | 151 | 35,753 |
| `shared/` | 24 | — |
| `test/` | 130 | — |
| 其中 `test/unit/` | 107 | — |
| 其中 `test/e2e/` | 8 | 含 `ewoh-http.e2e.spec.ts` 3,612 行 / 122 KB |
| 其中 `test/browser/` | 20（Playwright） | — |
| 其中 `test/contract/` | 6 | — |

**按模块的真实覆盖（合并 `server/modules/<m>/*.spec.ts` 与 `test/unit/<m>/*.spec.ts`）**

> 注意：直接看 `server/modules/` 会严重低估覆盖——大量模块测试放在 `test/unit/<module>/`。下表为合并后的真实口径。

| 模块 | 源码 LOC | 模块内 spec | test/unit spec | 合计 | 判定 |
|------|--------:|------------:|---------------:|-----:|------|
| scheduler | 30,806 | 108 | 11 | **119** | OK |
| shared | 1,597 | 2 | 19 | 21 | OK |
| work-orchestration | 2,767 | 1 | 8 | 9 | OK |
| ingest | 2,123 | 4 | 3 | 7 | OK |
| **operations** | **4,239** | 0 | 7 | 7 | OK |
| files / observability / dashboard / notification / agent / ai / learning / metrics / workflow | — | — | — | 3~5 | OK |
| approval / auth / control / erp / exo / mes / mobile / model / onboarding / resource / rule-engine / **scale** / simulator / task / tracing / world / world-cursor | — | — | — | 2 | 偏薄 |
| aas / alert / audit / events / **gamification(1,262)** / health / identity / inference / knowledge / maintenance / **oee** / organization / parameters / policy / quality / reasoning / reliability / simulation / system / timeline / workorder | — | — | — | **1** | **THIN** |
| **spatial** | 270 | 0 | 0 | **0** | **NONE** |
| **view** | 27 | 0 | 0 | **0** | **NONE** |

**零测试模块仅 2 个（spatial 270 行 / view 27 行，合计 297 行）**——真正的风险不是"有没有"，而是**分布极度不均**：

| 区域 | 源码 LOC | spec 文件 | spec/kLOC |
|------|--------:|----------:|----------:|
| scheduler | 30,806 | 119 | **3.9** |
| 非 scheduler | 44,957 | 32 | **0.7** |

→ **5.6× 覆盖密度落差。** 非 scheduler 的 4.5 万行服务端代码仅由 32 个 spec 文件守着，其中 20 个模块**各只有 1 个 spec 文件**（含 gamification 1,262 行、oee 667 行、parameters 594 行）。

**表征测试（characterization test）评估**

仓库中命名含 `characterization` 的仅 2 处，且**均属"正当表征测试"**，不是「锁死现状」的反模式：

1. `server/modules/scheduler/__tests__/scheduler-facade-characterization.spec.ts:1-16`
   - 头注释明示用途：**Strangler 重构 oracle**——「拆分前/后都必须通过」，且「只断言公开 API 的行为（返回值形状/委托参数/错误类型/状态副作用），**不依赖内部实现细节**」。
   - 实测：1,063 行 / 57 个 `it()` 用例 / 21 处 `toEqual|toMatchObject|toStrictEqual`。
   - 判定：**意图明确、边界收敛、有退出条件**（重构完成后可评估保留价值）。维护成本中等，掩盖回归的风险**低**。
2. `src/edge_platform/tests/test_server_routes_characterization.py:1-9`
   - 同为路由模块化重构的 oracle，且明确「**只补充既有测试未覆盖的缺口**，不重复已断言内容」。
   - 判定：同上，正当。

→ **结论：本仓库不存在"表征测试泛滥"问题。** 相对地，`scheduler-domain.spec.ts`（952 行）、`world-state-derive.spec.ts`（949 行）虽命名不含 characterization，但体量大、位于核心域，应作为高维护成本对象看待（**未验证其断言语义是否为意图表达**）。

---

### A2. 前端（React 19 / Vite）

> ⚠️ **对基线的纠正**：任务书称"前端 spec/test 文件数 = 0，仅 `offlineDb.test.ts` 一个"。实测**不成立**。原因应为原测绘只按 `*.spec.ts` 检索，而前端 `client/jest.config.cjs` 的 `testMatch` 是 `src/**/*.test.ts(x)`。

**实测（本机在 HEAD 上执行 `npm run test:client`）**：

```
Test Suites: 138 passed, 138 total
Tests:       1173 passed, 1173 total
Time:        13.871 s
```

`client/src` 共 613 个源文件，其中 **138 个为测试文件（15,697 行）**。

**真正的风险：覆盖结构倒置**

| 目录 | 源文件 | 测试文件 | 测试/源 比 |
|------|------:|---------:|-----------:|
| `lib/` | 64 | 55 | **85.9%** |
| `pages/` | 157 | 67 | 42.7% |
| `types/` | 2 | 1 | 50.0% |
| `hooks/` | 8 | 1 | 12.5% |
| **`api/`** | 24 | 2 | **8.3%** |
| **`components/`** | 211 | 12 | **5.7%** |

`pages/` 的 42.7% 需打折扣：其测试绝大部分是 `xxxLogic.test.ts`（从大组件中**抽取出的纯函数**）与少量 `*.render.test.tsx`，**而非针对容器组件本身**。

**复杂度 × 无覆盖 = 风险排序（前 15，全部无直接单元测试）**

| 排名 | 文件 | LOC | 直接测试 | 风险 |
|---:|------|----:|:---:|------|
| 1 | `client/src/pages/CommandMap/FactoryMap.tsx` | 1,264 | ❌ | 极高 |
| 2 | `client/src/pages/CommandMap/CommandMapShell.tsx` | 1,176 | ❌ | 极高 |
| 3 | `client/src/pages/Operations/Operations.tsx` | 1,143 | ❌ | 极高 |
| 4 | `client/src/pages/CommandMap/panels/SchedulePanel.tsx` | 1,034 | ❌ | 极高 |
| 5 | `client/src/pages/WorkOrchestration/WorkGraphPanel.tsx` | 934 | ❌ | 极高 |
| 6 | `client/src/pages/Devices/DeviceConfigDrawer.tsx` | 896 | ❌ | 高 |
| 7 | `client/src/pages/Scale/Scale.tsx` | 861 | ❌ | 高 |
| 8 | `client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx` | 828 | ❌ | 高 |
| 9 | `client/src/pages/System/System.tsx` | 819 | ❌ | 高 |
| 10 | `client/src/pages/WorkOrchestration/SiteReadinessWizard.tsx` | 757 | ❌ | 高 |
| 11 | `client/src/components/ui/sidebar.tsx` | 728 | ❌ | 中 |
| 12 | **`client/src/pages/MobileWorkbench/useOfflineWorkbench.ts`** | 705 | ❌ | **极高**（离线同步核心） |
| 13 | `client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx` | 684 | ❌ | 高 |
| 14 | `client/src/pages/MobileWorkbench/MobileWorkbench.tsx` | 627 | ❌ | 高 |
| 15 | **`client/src/api/scheduler.ts`** | 584 | ❌ | **极高**（API 契约面） |

> **前 35 大前端源文件中，30 个无直接单元测试，合计 21,282 行。**
> 已覆盖的高复杂度项（`offlineDb.ts` 719 行 / `commandMapPerf.ts` 620 行 / `observability.ts` 617 行 / `gitSync.ts` 608 行）说明团队**确实具备测大文件的能力**，缺的是覆盖面而非能力。

**SSE 实时链路**：`client/src/hooks/useSchedulerStream.ts`（490 行）实现了 fetch+ReadableStream 手动 SSE 解析、`Last-Event-ID` 续传、轮询兜底、断线重连（`:289`、`:319`、`:352`、`:453`），逻辑复杂但 **hooks 目录覆盖率仅 12.5%，该文件无测试**。

---

### A3. Python（edge_platform）

| 指标 | 数值 |
|------|------|
| 源码（`src/edge_platform`，不含测试） | 38,801 行 / 253 文件 |
| 测试文件 | **97**（`src/edge_platform/tests` 60 + 仓库级 `tests/` 37） |
| 测试代码 | 24,679 行 |
| 测试/源码 行数比 | **0.64** |

**按包覆盖（`tests/` 中按名称匹配）**

| 包 | 源码 LOC | 匹配测试文件 | 判定 |
|----|--------:|-------------:|------|
| edge | 7,108 | 3 | 偏薄（最大文件 `edge/storage.py` 1,403 行，仅 `test_storage_tables.py` 554 行） |
| scheduler | 6,812 | 5 | OK |
| inference | 4,029 | 1（`test_inference.py` 1,275 行） | OK |
| contracts | 3,875 | 3 | OK |
| routes | 2,553 | 1（且为 characterization） | 偏薄 |
| world_model | 1,584 | 1（`test_world_model.py`） | **有覆盖 ✅** |
| **connectors** | 1,397 | **0** | **缺口** |
| spatial | 1,160 | 2 | OK |
| governance | 1,056 | 2 | OK |
| perception | 965 | 1 | 偏薄 |
| **assistant** | 794 | **0** | **缺口**（`local_llm.py` 769 行） |
| **scripts** | 787 | **0** | **缺口** |
| runtime | 454 | 1 | OK |
| auth | 426 | 4（含 `test_get_route_auth_matrix.py`、`test_write_route_auth_matrix.py`） | **OK（覆盖最好）** |
| monitoring | 400 | 1 | OK |
| **policy** | 262 | **0** | **缺口** |
| **migrations** | 222 | **0** | **缺口** |

**CP-SAT solver 测试：充分 ✅**

`src/edge_platform/scheduler/cpsat/` 下 solver.py 708 行 / worker.py 548 行 / objective.py，对应测试：
- `src/edge_platform/tests/test_cpsat_contract.py`
- `src/edge_platform/tests/test_cpsat_solver_real.py`（真实求解器，非 stub）
- `src/edge_platform/tests/test_cpsat_reservation.py`
- `src/edge_platform/tests/test_cpsat_worker_contract.py`
- `src/edge_platform/tests/test_cpsat_worker_hardening.py`（374 行）
- `src/edge_platform/tests/test_objective_lexicographic.py`
- `src/edge_platform/tests/test_warm_start_rolling.py`
- 仓库级 `tests/test_cpsat_solver_real.py`、`tests/test_cpsat_reservation.py`、`tests/test_cpsat_worker_contract.py`

**`advisory_only` 边界：有测试守卫 ✅**

`src/edge_platform/tests/test_scheduler_ownership.py:171-246` 提供 **10 个专用用例**，逐写路径断言 advisory 模式下拒绝（403 语义）：
`test_generate_plans_marks_advisory` / `test_confirm_rejected_in_advisory` / `test_execute_rejected_in_advisory` / `test_replan_rejected_in_advisory` / `test_feedback_rejected_in_advisory` / `test_set_assignment_status_rejected_in_advisory` / `test_reconcile_discards_local_state` / `test_confirm_works_when_writable` / `test_advisory_flag_absent_when_writable` / `test_write_methods_rejected`（`:276`）。
→ **判定：该边界已被良好把守，并含"可写时行为正确"的正向对照，不是只测拒绝路径。**

---

### A4. E2E（Jest E2E + Playwright）

**Jest E2E（8 个文件，`test/e2e/`）**

| 文件 | 行数 | 说明 |
|------|-----:|------|
| `ewoh-http.e2e.spec.ts` | 3,612（122 KB） | 主 HTTP 面 |
| `scheduler-upgrade.e2e.spec.ts` | 606 | 升级/回滚 |
| `concurrency-real-pg.e2e.spec.ts` | — | 并发（真实 PG） |
| `replan-dual-instance.e2e.spec.ts` | — | 双实例重排 |
| `snapshot-concurrency.e2e.spec.ts` | — | 快照并发 |
| `org-rls-guc.e2e.spec.ts` | — | **RLS：仅覆盖 `ewoh_scheduling_constraint` 1 张表**（`:64`、`:163`、`:179`、`:195`） |
| `pg-temporary-failure.e2e.spec.ts` | — | PG 瞬时故障 |
| `f61-02-persistence.e2e.spec.ts` | — | 持久化/幂等/事务 |

- 门禁：`standalone.yml:655` 运行 `npm run test:e2e`，配 PG Service Container。
- **优点（值得肯定）**：`standalone.yml:634-654` 设 `E2E preflight` 步骤（`../scripts/e2e-preflight.mjs`），PG 不可达时以 `::error::` **响亮失败**，注释明写「**绝不允许整包静默 SKIP**、**绝不伪造通过或静默跳过**」。测试自身也用 `BLOCKED_BY_ENVIRONMENT` 标记（`f61-02-persistence.e2e.spec.ts:29-36`）。这是本仓库测试工程化最扎实的一处。
- **弱点**：RLS E2E 只覆盖 **1/102** 张表。

**Playwright（20 个 spec，`test/browser/`）**

- 配置：`playwright.config.ts` 6 工程矩阵（chromium / firefox / webkit / mobile-chromium / industrial-tablet / reduced-motion），`workers:1`、`fullyParallel:false`、`trace:'on-first-retry'`。
- 门禁：`standalone.yml:663` `npx playwright install --with-deps chromium firefox webkit`（全量真实安装）→ `standalone.yml:670` `npm run test:browser`。
- 用例包含 `comprehensive-platform.spec.ts`（591 行）、`ux009-uxindustrial.spec.js`（28 KB）、`scheduler-command-map.e2e.spec.ts`、`a11y.spec.ts`、`sw-update.spec.ts`、`auth-real-login.spec.ts` 等。
- **flakiness：未验证**（无历史运行记录可查；`playwright-report/` 目录存在但本机未解析）。

**视觉回归：门禁已失效 🚨**

- `playwright.visual.config.ts:8-14` 明文规定：**「主金基线（canonical golden）= Linux 桌面 Chromium」「本地 macOS 开发者可生成 `-darwin` 基线…但不得覆盖 Linux 基线」**，且 `snapshotPathTemplate` 使用 `{platform}` 后缀（Linux 为 `-linux`）。
- 实测：`test/browser/snapshots/ux009-visual.spec.js/` 下 **18 个基线文件，18 个均为 `-darwin`，`-linux` 基线数 = 0**。
- 实测：`grep -rn "visual" .github/workflows/` → **0 命中**。即 `test:browser:visual` **从未在任何 CI 工作流中被调用**。

→ **结论：视觉回归门禁存在双重失效——① 无 Linux 金基线，在 Linux runner 上无法比对；② 根本没接 CI。属"配置齐全但从未生效"的纸面门禁。**

**`test-report.md`（2026-08-22 11:30，根目录）——不可采信**

该报告为人工黑盒测试，针对 `http://121.43.230.202:3000`（容器 `ewoh-api:0.6.0-rc3`，非 rc4），结论 106 PASS / 37 FAIL / 13 WARN / 25 SKIP，判定 **NOT READY**（2 个 P0：无 HTTPS、SPA 深链 404）。
**距今 6 天、17 个 commit，且被测版本与当前版本不一致——仅作历史参考，不参与本次风险定级。**

---

### A5. CI 门禁

7 个 workflow：`test.yml` / `standalone.yml` / `runtime-gates.yml` / `perf.yml` / `security.yml` / `package.yml` / `feishu.yml`。

**`test.yml` 强制门禁（节选）**

| 步骤 | 命令 |
|------|------|
| Python unittest | `make test` |
| Python 契约测试 | `make test-contract` |
| 状态机契约 | `make contract-state-machine` |
| 生产装配门禁 | `make production-smoke`（防「单测通过但只能跑 stub」） |
| 禁静默 stub | `run.py` 真实启动校验 `rule_version=risk-rule-v0.2` |
| ruff | `ruff check src/edge_platform` |
| npm audit | `--audit-level=high` |
| 类型检查 | `npm run type:check` |
| **Jest** | `npm test -- --runInBand --json --outputFile=jest.results.json` |
| 事实源 | `make truth-check` → `truth-gate.js` |
| OpenAPI 路由 | `scripts/audit-openapi-routes.js --strict` |
| OpenAPI 生成物漂移 | `npm run gen:openapi:check` |
| 生产构建 + bundle 预算 | `build:prod` + `bundle-budget.mjs` |
| 确定性构建 | 同 commit 两次构建字节比对（TR-11.1） |

**实测验证**：本机执行 `npm run gen:openapi:check` → `OK: OpenAPI contract checked; committed outputs are in sync.` ✅

**门禁缺口**

| # | 缺口 | 证据 | 严重度 |
|---|------|------|--------|
| 1 | **前端测试未进 CI** | `test:client` 全仓库仅出现于 `scripts/standalone-check.sh:17`；该脚本仅被 `scripts/release-drill.sh:24` 调用；**7 个 workflow 中 0 处调用** | **P1** |
| 2 | **零覆盖率阈值** | `grep -rn "coverageThreshold\|--coverage\|coverage"` 于 `.github/workflows/` + `ewoh-spark-app/package.json` → **0 命中**；`jest.results.json` 无 `coverageMap` 字段 | **P1** |
| 3 | **视觉回归未进 CI** | `grep -rn "visual" .github/workflows/` → 0 命中 | **P2** |
| 4 | **`make audit-regression-gates`（十条主线防回归）未接 CI** | 仅定义于 `Makefile`，workflow 中未调用 | **P2** |
| 5 | E2E/Playwright 只在 `standalone.yml` | `test.yml` 不含 | P2（架构选择，可接受） |
| 6 | `continue-on-error: true` 出现 1 次 | `feishu.yml:41`（非核心门禁） | 无风险 |

---

## B. 潜在风险点

### B1. 数据一致性

#### ✅ 已修复（用户列出的"已知问题"复核后证伪，请勿再作为风险跟踪）

**① `is_shadow` 与 `status` 不同步 / SHADOW_PLAN_GUARD 失效 —— 已修复**

- `server/modules/scheduler/shadow-policy.service.ts:147-184`：R2-SSV-03 修复，落库与 `is_shadow` 标记**同事务原子化**（`requestDatabaseContext.runInTransaction`）；无 context 时走**补偿路径**——标记失败即 `delete` 该 plan 行，注释明写「**绝不留裸 shadow 方案**」（`:149`、`:172-176`）。
- **纵深防御**：`db/migrations/standalone_048_shadow_plan_isolation.sql:24-34` 加 **DB 层 CHECK 约束**——`is_shadow=true` 的行不得进入生产状态（approved/dispatched/executing/completed）且不得携带确认事实（`confirmed_by/confirmed_at`）；注释明写「**服务层 guard 被绕过时由数据库兜底拒绝**」（`:34`）。
- **测试把守**：`server/modules/scheduler/__tests__/shadow-plan-guard.spec.ts` 覆盖 approve / dispatch / reserve 三条路径。

**② `dispatchPlan` 先查 `isShadow` 后租户守卫（NEST-026）—— 已修复**

- `server/modules/scheduler/plan.service.ts:641-653`：`assertPlanTenantVisible(planRow?.orgId, ctx, planId)` **先于** `if (planRow?.isShadow)`；注释明写修复原因（避免跨租户泄露"该 planId 存在且为 shadow"的存在性事实）。

**③ trigger cooldown 仅按 `(orgId, triggerType)` 无 `entityId` —— 已修复**

- `server/modules/scheduler/trigger.service.ts:79-86`：cooldown 查询已包含 `eq(ewohReplanTrigger.entityId, entityId ?? 'ALL')`，注释「**不同实体的同类型触发不再互相抑制**」。
- 额外加固：`:113-121` 将 check-then-insert 竞态改为**原子 `INSERT ... ON CONFLICT (trigger_key) DO NOTHING`**（NEST-147），注释明写修复「并发同 triggerKey 双插入双建 run」。
- 空 org 防护：`:62-72` HTTP 路径强制 actor，否则抛 `UnauthorizedException`（NEST-146）。

#### 🚨 仍为真问题

**RISK-1｜dispatch 后 Execution 建档在事务外，且降级对前端完全不可见 —— P1**

- 事务边界：`server/modules/scheduler/plan.service.ts:654` → `dispatchCoordinator.dispatch()` 在 `dispatch-coordinator.service.ts:228` 的 `runInTransaction` 内完成（plan/task/assignment 更新 + `ewohAssignmentEvent` 插入）。
- 但 Execution 建档在**事务提交之后**：`server/modules/scheduler/scheduler-plan-application.service.ts:337` 先 `dispatchPlan()`，再于 `:344-378` 调用 `executionService.createFromPlan()`。
- 已有缓解：`scheduler-plan-application.service.ts:339-380` 加了 **3 次尝试 × 500ms 重试**（DATA-FLOW-L3），失败后响应体携带 `executionSync:{ok:false,error}` 字段（NEST-156，`:384-391`）。
- **但**：`executionSync` 在 `client/` 下 **0 处引用**（实测 `Grep executionSync client/` → No matches found）。
- **风险**：重试耗尽后，plan 状态为 DISPATCHED 但无 Execution 跟踪记录，服务端"知情"而**用户与前端完全无感**，形成静默数据缺口。
- **建议**：前端 dispatch 成功后检查 `executionSync.ok === false` 并显式提示「已派工但执行跟踪未建立，请联系运维」；或对 `ewoh_scheduling_execution` 缺失做定时对账告警。

**RISK-2｜shadow 方案永不清理 —— P1（用户列项正确，已证实）**

- 全仓库 `grep "deleteShadow|purgeShadow|shadow.*retention|cleanupShadow"` → **0 命中**。
- **对照**：同仓库其他域**有**清理机制——`server/modules/simulator/retention.service.ts:55`（`CLEAN_INTERVAL_MS` 定时过期）、`server/modules/scheduler/prediction/shadow-evaluator.service.ts:218`（「删除 `created_at < now − retentionMs` 的行」）。证明团队**具备**写清理任务的能力，shadow plan 是遗漏。
- 影响：`generateShadowPlan()`（`shadow-policy.service.ts:105`）每次调用生成 `SHADOW-<version>-<Date.now()>` 新行，长期累积。
- **建议**：复用 `shadow-evaluator.service.ts:218` 的既有 retention 模式，为 `is_shadow=true` 的 plan 加清理任务；先加一条对账查询确认当前 shadow 行数（**未验证当前生产库规模**）。

**RISK-3｜生产环境模拟器未关闭导致数据腐化 —— P1**

- 证据：`alert-backlog-cleanup.md:26-28`，生产库 `ewoh_event` 总 **105,269 行**，其中 `simulated` **105,255 行**，expired 104,504 行。
- 根因（同文档 `:24-25`）：运行容器 `EWOH_SIMULATOR_ENABLED=1`（持久化于 ECS `/opt/ewoh/.env` 第 18 行），`EWOH_SIMULATOR_MAIN_TICK_MS=30_000` 每 30s 持续产生 simulated 告警。
- **注意**：该文档为 2026-08-23「告警与运维专员」产出，结论是「simulated 已清零且不复发」，但根因段指出 `RetentionService` 仅能压 2h 内存量、**无法阻止再生**（`:26`）。
- **风险**：① 生产库 99.99% 事件为模拟数据，真实告警（inference 5 / simulation 2 / device 1 / person 1）被淹没，**告警有效性实质受损**；② 表持续膨胀。
- **建议**：确认生产 `.env` 中 `EWOH_SIMULATOR_ENABLED` 当前值（**未验证**）；若为 1，应立即置 0 并加部署前门禁断言。

**RISK-4｜含 `org_id` 但未启用 RLS 的表 —— P1**

实测（脚本解析 `db/migrations/*.sql`，含动态 `FOREACH` 循环数组）：

```
TABLES=102  RLS_ENABLED=86  COVERAGE=84.3%
```

16 张表无 RLS。其中**已登记为 ADR 偏差**（有正当理由，`db/migrations/standalone_057_rls_null_reject.sql:36-46` 裁决记录 + `db/contracts/schema-manifest.yaml:19`）：
`ewoh_outbox`、`ewoh_assignment_event`、`ewoh_world_state_snapshot`（ADR-004/028 GLOBAL_SHARED / DERIVED_TENANT_OWNERSHIP）、`prediction_shadow_observation`（GLOBAL_SHARED，advisory-only）、`ewoh_snapshot_version_counter`。

**以下 5 张含 `org_id` 列但无 RLS，且未在上述偏差名单内**：

| 表 | org_id 列 | 写入方 |
|---|:---:|---|
| `ewoh_scheduling_execution` | ✅（`standalone_018_execution_feedback.sql:11` 建表，`org_id varchar(255)`） | dispatch 路径（RISK-1 同一张表） |
| `ewoh_scheduling_conflict` | ✅（`standalone_013_conflict_lifecycle.sql`） | scheduler |
| `ewoh_scheduling_kpi` | ✅（`standalone_019_kpi_replay.sql`） | KPI replay |
| `ewoh_route_cost_matrix` | 需复核 | 路由成本 |
| `ewoh_policy_activation` / `ewoh_policy_replay` | 需复核 | 策略活化 |

- 缓解：`standalone_057_rls_null_reject.sql` 已为其中多数表补了**复合唯一键**（如 `uq_ewoh_scheduling_run_org_run_id`），但未补 RLS。
- **风险**：租户隔离仅靠应用层 `WHERE org_id = ?`；任一条查询漏写 org 条件即跨租户泄漏。对比 `standalone_056_route_org_isolation.sql` 的注释——路由表本无写入方仍被加固 RLS 以闭合「**跨租户布局泄漏**」，说明团队认可该风险模型，此处属遗漏。
- **建议**：对这 5 张表按 `standalone_056` 的模式补 RLS；并把「新表必须带 RLS」加入迁移评审门禁。

**RISK-5｜空 catch / 吞异常 —— P2（实测优于预期）**

- 字面空 catch（`catch {}`）：`server/` + `shared/` 中 **0 处**。
- 但存在 **约 20+ 处「单注释 catch」**，分为两类：
  - **可接受**：`scheduler/execution.service.ts:223`、`shadow-policy.service.ts:217`、`policy-activation.service.ts:199`、`:338`、`policy-replay.service.ts:349`（均为「观测失败不阻断」，即 metrics/outbox 旁路失败不影响主流程）；`pg-notify.listener.ts:75`、`:91` 与 `scheduler-stream.service.ts:178`（LISTEN 失败**降级纯轮询**，注释明写「不阻塞不抛给调用方」）——这类是有设计的降级。
  - **需关注**：`scheduler/kpi.service.ts:274` 与 `scheduling-feedback.service.ts:179` 均为「**测试替身/无 execute 环境：跳过锁（单进程测试无并发）**」——即**锁在测试环境下被静默跳过**。这意味着并发相关的逻辑**在单测中根本没被真正执行**，是覆盖率的隐性黑洞（与 RISK-6 呼应）。
- **建议**：为这两个「跳过锁」分支加显式计数/日志，并在 CI 中统计其触发次数；真实并发由 `test/e2e/concurrency-real-pg.e2e.spec.ts`、`replan-dual-instance.e2e.spec.ts` 覆盖（**已存在 ✅**）。

### B2. 并发与竞态

**RISK-6｜单测静默跳过并发锁，并发保证依赖 E2E 兜底 —— P2**

- `server/modules/scheduler/kpi.service.ts:274`、`scheduling-feedback.service.ts:179`：测试替身环境跳过锁。
- 兜底：`test/e2e/concurrency-real-pg.e2e.spec.ts`、`replan-dual-instance.e2e.spec.ts`、`snapshot-concurrency.e2e.spec.ts`、`f61-02-persistence.e2e.spec.ts:219`（「coalesces two concurrent app instances onto a single resource lock」）、`:297`（「rolls back a composite write when the audit step fails (no partial lock)」）——真实并发语义由 E2E 守着，**但这些 E2E 仅在 `standalone.yml` 运行，不在 `test.yml`**。
- **建议**：将并发 E2E 提升为 `test.yml` 的发布阻断项，或至少在 PR 阶段可选择性触发。

**RISK-7｜乐观锁 / 幂等性覆盖面 —— 已证实有机制，覆盖不均 —— P2**

- 幂等机制存在且多样：`ON CONFLICT DO NOTHING`（`trigger.service.ts:118-121`、`execution.service.ts:126-131`）、复合唯一键（`standalone_057_rls_null_reject.sql:413-433`）、`ewoh_idempotency_keys` 表 + RLS（`standalone_060_idempotency_org.sql`，`--verify` 于 CI）。
- **但**：20 个「THIN」模块（各 1 个 spec）中多数未验证幂等/并发语义（**未逐模块验证**）。

**RISK-8｜CP-SAT worker 并发 —— 未验证**

`src/edge_platform/scheduler/cpsat/worker.py`（548 行）有 `test_cpsat_worker_hardening.py`（374 行）与 `test_cpsat_worker_contract.py`。**并发语义覆盖未验证**。

### B3. 错误处理与容错

**✅ CP-SAT 降级路径：设计良好**

`server/modules/scheduler/solver.service.ts` 采用「**heuristic 为生产默认，CP-SAT 需双重门禁**」：

- `:395` 未采样 → 仅 heuristic（「与 OFF 同语义」）。
- `:400-407` `PRODUCTION` 激活但 `EWOH_SOLVER_PRODUCTION_ENABLED!=='1'` → **fail-closed 回退 heuristic**，`fallbackReason='production_not_gated'`。
- `:429-457` SHADOW 模式：heuristic 为生产方案，CP-SAT 仅作 shadow 对比；**CP-SAT 不可达/超时仅记录，生产方案保持 heuristic**（`:457`）。
- `:494` CANARY：CP-SAT 不可用时「采纳 heuristic 回退方案 + canary 归 0 + outbox `policy.shadow.canary.rollback`」。
- → **判定：CP-SAT 失败确实能回退 heuristic，且有可观测的 fallbackReason 与 canary 归零机制。风险低。**

**RISK-9｜前端 SSE/离线链路无单测 —— P1**

- `useSchedulerStream.ts`（490 行，SSE 解析 + Last-Event-ID 续传 + 轮询兜底 + 重连）无测试。
- `useOfflineWorkbench.ts`（705 行，离线工作台核心）无测试。
- **注意**：`offlineDb.ts`（719 行）**有** 737 行测试、`offlineQueue.test.ts` 323 行、`offlineConflict.test.ts`、`offlineCrypto.test.ts`、`offlineClock.test.ts` 均有覆盖——说明**离线数据层测了，但编排层（`useOfflineWorkbench`）没测**。
- **建议**：优先补 `useOfflineWorkbench.ts` 的状态机测试。

### B4. 安全

**RISK-10｜RLS 覆盖 84.3%，租户隔离 E2E 仅覆盖 1 张表 —— P1**

- `test/e2e/org-rls-guc.e2e.spec.ts` 只对 `ewoh_scheduling_constraint` 一张表验证 RLS（`:64`、`:163`、`:179`、`:195`），覆盖率 **1/102**。
- 配合 RISK-4（5 张含 org_id 未启用 RLS），租户隔离的**数据库层保证缺少回归网**。
- **建议**：将 RLS E2E 参数化为表清单驱动，至少覆盖全部 86 张 RLS 表；对 5 张无 RLS 的表加应用层 org 谓词静态扫描（仓库已有 `scripts/audit-org-predicates.js`，在 `Makefile` 主线 1 中，**但未接 CI**——与 A5 缺口 #4 同源）。

**其他安全面（快速结论）**

| 检查项 | 结论 |
|--------|------|
| 认证/授权 | `src/edge_platform/auth/`（426 行）有 **4 个**测试文件，含 `test_get_route_auth_matrix.py` / `test_write_route_auth_matrix.py` / `test_auth_failclosed.py` —— **覆盖最好** ✅ |
| 越权读 | 见 RISK-4 / RISK-10 |
| SQL 注入 | 全站 `drizzle-orm` 参数化 + `postgres` 驱动；**未发现裸 SQL 拼接**（未逐条验证，但 raw SQL 仅限迁移脚本） |
| 原型污染 | `grep "__proto__\|constructor.prototype\|Object.create(null)"` 于 `server/` + `client/src/` → **0 命中**；**未验证**是否存在用户可控键的深合并 |
| 敏感信息 | `systemLogic.ts:redactConfigValue`（CLI-210 递归脱敏）+ `leakAudit.test.ts` 存在 ✅ |
| `contracts/` rego 策略 | `tests/test_rego.py` 存在，且 `make rego-tck` 定义于 `Makefile`；**是否接 CI：未验证（workflow 中未直接 grep 到 rego-tck）** |
| HTTPS | `test-report.md` 标记 P0「HTTPS 未启用」，但**该报告针对 rc3 部署且已过期 6 天；当前生产配置未验证** |

### B5. 契约漂移

**✅ OpenAPI 契约：无漂移，且门禁有效**

- `openapi/ewoh.yaml`（515 KB，2026-08-23 13:50）→ `client/src/types/openapi.d.ts`（649 KB，2026-08-23 13:50）**同时间戳**。
- 实测 `npm run gen:openapi:check` → **OK: committed outputs are in sync** ✅
- CI 双重门禁：`test.yml` 的 `audit-openapi-routes.js --strict`（双向：未文档化路由 + 已文档化未实现路由）与 `gen:openapi:check`。
- `openapi/route-manifest.json` 亦由 `audit-repo-facts.js:232-252` 校验时效性。

**✅ 跨运行时契约：有独立仲裁机制（设计优秀）**

`Makefile` 定义 `contract-identity` / `contract-domain` / `contract-envelope` / `contract-golden` / `scheduler-golden`，且 `test.yml` 全部调用。其模式是：**JS 侧独立重实现解析规则做仲裁 + Python 与 TS 消费同一份共享测试向量**（`tests/golden-fixtures/*.json` ↔ `shared/golden-contract-scenarios.spec.ts`）。这是防「两套实现互相迁就」的正解。

**RISK-11｜`shared/` ↔ server ↔ client 三方漂移的运行时校验 —— P2**

- `shared/` 有 24 个 spec 文件 + `test/unit/shared/` 19 个 = 43 个，覆盖充分。
- 但**客户端对契约的使用**缺少回归：`api/` 目录 24 个源文件仅 2 个测试（8.3%），其中 `client/src/api/scheduler.ts`（584 行）**无测试**。若 server 改了响应形状而 `shared/` 类型未同步，`tsc` 能拦住；但若 `api/*.ts` 内部做了字段映射/兜底，`tsc` 拦不住。

### B6. 可观测性

**✅ tracing 已有基础**：`server/` 下 `traceId|trace_id|correlationId` 共 **134 处**引用；`client/src/lib/requestCorrelation.test.ts`、`observability.test.ts`（253 行）存在。

**RISK-12｜告警有效性实质受损 —— P1**

- 见 RISK-3：生产 `ewoh_event` 105,269 行中 105,255 行为 `simulated`，真实告警仅个位数（inference 5 / simulation 2 / device 1 / person 1 / seed 3 / system 2）。
- 根目录 `alert-backlog-cleanup.md` 本身即告警积压问题的证据，且其「处理」方式是**人工清理数据库**而非修根因（根因段自陈 `RetentionService` 无法阻止再生）。
- **建议**：① 生产关闭模拟器；② 为 `ewoh_event` 加「simulated 占比」监控项，超过阈值告警；③ 把人工 DB 清理动作替换为受控运维脚本（当前方式不可审计、不可回滚）。

---

## C. 回归风险最高的改动面（Top 5）

排序依据 = 改动频率敏感性 × 无测试兜底程度 × 故障影响面。

| 排名 | 区域 | 为什么危险 | 兜底现状 |
|---:|------|-----------|----------|
| **1** | **`client/src/pages/CommandMap/` 容器组件**（FactoryMap 1,264 / CommandMapShell 1,176 / SchedulePanel 1,034 / TaskOrchestrationPanel 828 / ResourcePoolPanel 684 / OverridePanel 622 / IntelligenceLayers 542 / SchedulerLayers 531 / ConflictCenterPanel 530 / WorkbenchPanel 524 / EventCenterPanel 521 / DecisionCockpit 509） | 合计 8,000+ 行 UI 容器， CommandMap 是产品主界面；**全部零直接单测**；改动后只能靠 Playwright E2E 兜底，而 E2E 只跑 `standalone.yml` | 仅 E2E（`scheduler-command-map.e2e.spec.ts`、`ux009-command-map-axe.spec.js`）+ 少量抽出的纯逻辑测试 |
| **2** | **非 scheduler 的 4.5 万行服务端代码** | 32 个 spec 守 44,957 行（0.7 spec/kLOC）；20 个模块各仅 1 个 spec；`operations`（4,239 行，7 spec）是业务主链路 | 薄 |
| **3** | **`client/src/api/`（24 文件 / 2 测试）** 与 `client/src/hooks/`（8 文件 / 1 测试） | API 层是契约落地点；`useSchedulerStream.ts`（490 行 SSE + 续传 + 重连）与 `useOfflineWorkbench.ts`（705 行）是**状态机密集**逻辑，最易因改动引入竞态 | 几乎无 |
| **4** | **`ewoh_scheduling_execution` 相关链路** | 该表**无 RLS**（RISK-4）＋ 写入在事务外（RISK-1）＋ 降级字段前端不读（RISK-1）＋ 无 E2E 覆盖 | 仅 `standalone_018_execution_feedback.verify.sql` |
| **5** | **Python `connectors`（1,397 行）/ `assistant`（794 行）/ `scripts`（787 行）/ `policy`（262 行）/ `migrations`（222 行）** | 5 个包零匹配测试；`connectors` 是边缘数据入口、`migrations` 直接改变生产数据形态 | 无 |

---

## D. 补测试的最小有效集合（按性价比排序）

> 原则：优先补**已经绿但没进 CI** 的（成本≈0），其次补**高复杂度 × 零覆盖**的，最后补**跨层契约**。

### 第一梯队：几乎零成本，立即执行

| # | 动作 | 成本 | 收益 |
|---|------|------|------|
| **D-1** | **把 `npm run test:client` 加入 `.github/workflows/test.yml`**（在 `npm test -- --runInBand` 之后） | **≈1 行 YAML + 14 秒 CI 时间** | 立即把 **138 套件 / 1173 用例**纳入发布门禁。这是整个审计中**投入产出比最高**的一项 |
| **D-2** | 为两个 Jest 配置开启覆盖率并设**分层阈值**：scheduler（现行高密度）阈值可高，非 scheduler 设 40% 起步，前端 `lib/` 70% / `pages/` 30% | 半天 | 让「2250 测试全绿」第一次可换算为可治理的数字；暴露真实的无覆盖区 |
| **D-3** | 修复视觉回归门禁：① 在 Linux runner 上生成 18 个 `-linux` 金基线；② 在 `standalone.yml` 加 `npm run test:browser:visual` 步骤 | 半天 | 激活一个已完整配置但从未生效的门禁 |

### 第二梯队：高价值新测试（建议 2 周内）

| # | 目标 | 粒度 | 理由 |
|---|------|------|------|
| **D-4** | `client/src/pages/MobileWorkbench/useOfflineWorkbench.ts`（705 行） | 单元测试（状态机） | 离线同步是现场工人主链路，`offlineDb` 层已测但**编排层未测**；失败即数据丢失 |
| **D-5** | `client/src/hooks/useSchedulerStream.ts`（490 行） | 单元测试 + mock SSE 流 | SSE 解析 / Last-Event-ID 续传 / 轮询降级三态切换，纯逻辑易测、收益高 |
| **D-6** | `client/src/api/scheduler.ts`（584 行）+ `api/` 全目录 | 契约测试（响应形状 → 领域对象映射） | 补上 `shared/` ↔ client 的最后一段（RISK-11） |
| **D-7** | `server/modules/operations/*`（4,239 行） | 服务级集成测试 | 业务主链路，当前仅 `test/unit/operations/` 7 个 spec |
| **D-8** | dispatch → Execution 全链路 | **集成测试（真实 PG）** | 覆盖 RISK-1 的事务外写入；断言「plan DISPATCHED ⇒ Execution 行数 == assignment 数」，并对 `executionSync.ok===false` 建档告警 |
| **D-9** | RLS E2E 参数化为表清单驱动 | E2E（扩展现有 `org-rls-guc.e2e.spec.ts`） | 从 1/102 表 → 86/102 表（RISK-10） |
| **D-10** | Python `connectors` 包（1,397 行） | 单元测试 + 契约测试 | 五个零测试包中 LOC 最大，且是边缘数据入口 |

### 第三梯队：机制性补强

| # | 动作 |
|---|------|
| **D-11** | 为 `kpi.service.ts:274` / `scheduling-feedback.service.ts:179` 的「测试环境跳过锁」分支加计数埋点，CI 统计触发次数并公示——把隐性的覆盖率黑洞显性化 |
| **D-12** | 将 `make audit-regression-gates`（十条主线）与 `scripts/audit-org-predicates.js` 接入 CI，避免「只在 Makefile 里、没人跑」 |
| **D-13** | 为 `is_shadow=true` 的 plan 增加 retention 清理任务（复用 `shadow-evaluator.service.ts:218` 既有模式），并加对账查询 |

---

## E. 证据与方法说明

| 项 | 说明 |
|----|------|
| 实跑命令 | `npx jest --config client/jest.config.cjs --runInBand`（HEAD，138/138、1173/1173 全绿，13.9s） |
| 实跑命令 | `npx jest test/unit/repo-facts.spec.ts`（HEAD，**通过**） |
| 实跑命令 | `npm run gen:openapi:check`（HEAD，**in sync**） |
| 实跑命令 | `npx jest --runInBand`（**全量后端，HEAD：290/290 套件、2250/2250 用例全绿，622.5s**） |
| 静态取证 | `find` / `grep` / Python 脚本解析（RLS 覆盖率、模块-测试矩阵、前端复杂度矩阵） |
| **未验证项（明确标注）** | ① Playwright flakiness 历史；② 生产 `.env` 当前 `EWOH_SIMULATOR_ENABLED` 值；③ 生产是否启用 HTTPS；④ `contracts/` rego 是否在 CI 真实调用；⑤ `scheduler-domain.spec.ts` / `world-state-derive.spec.ts` 的断言语义是否为意图表达；⑥ CP-SAT worker 并发语义；⑦ 各「THIN」模块的幂等/并发覆盖 |
| 数据新鲜度 | `jest.results.json` 生成于 **2026-08-23 14:11:10**，HEAD 为 **2026-08-23 22:53:38**，中间 **17 个 commit（含 2 个非文档提交：`61efdfb` 改 23 个服务 25 处 `insert(ewohEvent)`、`cdfdcff` 前端）** → 该结果文件**落后约 9 小时，不可作为当前状态证据** |
| 未修改源码 | 本次审计**未改动任何仓库文件**；临时产物仅写入 `/tmp` |
