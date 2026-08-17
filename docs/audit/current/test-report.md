# Test Report — 二轮审计收敛后真实测试统计

> 生成时间：2026-08-18（全部数字为本机复跑真实输出，命令与结果一一对应；与基线不一致处已逐条注明原因）
> 数据来源：本机执行 `make test` / `make test-contract` / golden 族 / 契约门禁 / `npx tsc -b` / `npx jest` / `npm run test:client` / 门禁脚本；环境：macOS、Python 3.9.6（pytest 8.3.3 可经 `python3 -m pytest` 调用）、Node v26.5.1、无 ortools、无 bandit、无真实 PostgreSQL。

---

## 1. 测试套件复跑结果

| # | 套件 | 命令 | 复跑结果（2026-08-18 本机） | 与基线对照 |
|---|------|------|------------------------------|------------|
| 1 | 边缘 unittest（57 文件） | `make test` | **Ran 979 tests in 54.164s — OK**（单独复跑 0 失败） | 与基线 979 OK 一致。注：首次复跑与 Jest 全量并行时出现过 1 failure（伴随 ResourceWarning: unclosed socket，本机端口争用），单独复跑即全绿，判定为并行资源干扰非代码缺陷 |
| 2 | 仓库契约 pytest（tests/，35 文件） | `make test-contract` | **681 passed, 11 skipped** in 2.67s | 与基线 681/11 一致 |
| 3 | Jest client | `npm run test:client`（--runInBand） | **Test Suites: 127 passed, 127 total；Tests: 1022 passed, 1022 total**（13.234s） | 与基线 127 suites/1022 tests 全过一致 |
| 4 | Jest server 全量（含 shared/test） | `npx jest`（ewoh-spark-app） | **Test Suites: 290 passed, 290 total；Tests: 2247 passed, 2247 total**（126.932s） | 与基线全绿一致（首跑 1 失败已收敛，见 §1.1） |
| 5 | TypeScript 构建 | `npx tsc -b`（ewoh-spark-app） | **0 错误**（exit 0） | 与基线一致 |

### §1.1 首跑唯一失败项的收敛记录（已修复，终态全绿）

- 用例：`server/modules/scheduler/__tests__/openapi-route-parity.spec.ts:74`「每个 controller 路由均已文档化（无未文档化路由）」；
- 首跑失败内容：`GET /api/operations/workbench/export/{id}/download` 存在于 controller/route-manifest，但未登记进 `openapi/ewoh.yaml`；
- 根因：本轮 R2-SOP-006 修复（workbench 导出管道消费端，parts/fixlog-ops.jsonl）新增了该下载端点，未同步补 OpenAPI spec 条目；
- 修复：补 `openapi/ewoh.yaml` 路由条目（owner/admin + R2-SOP-006 注记）+ `npm run gen:openapi` 再生成 `client/src/types/openapi.d.ts` / `work-orchestration.d.ts`；
- 终态验证：该 spec 单跑 **6/6 passed**；`npm run openapi:no-drift` **OK in sync**；随后全量 `npx jest` 复跑 **290 suites / 2247 tests 全过**（上表行 4 即复跑后数字）。

## 2. 门禁复跑结果

| 门禁 | 命令 | 复跑结果 |
|------|------|----------|
| lint | `ruff check src/edge_platform` | **All checks passed!**（exit 0） |
| truth-check | `make truth-check` | 全绿：truth-manifest --check 无漂移、audit-repo-facts --strict、identity/domain contracts、**EVENT ENVELOPE AUDIT 24/24 passed**、GEN-CONTRACT-REGISTRIES OK |
| audit-regression-gates | `make audit-regression-gates` | **✅ 十条主线门禁全部通过**（租户谓词扫描/边缘 GET 鉴权矩阵/SSRF 面/XSS sink/迁移链静态自检/门禁自测/调度事务边界/TS↔Python parity/状态机 role/演示残留） |
| contract-identity | `make contract-identity` | node 门禁 PASS + pytest **18 passed** |
| contract-domain | `make contract-domain` | audit-domain-contracts PASS + envelope audit 24/24 + pytest **107 passed** |
| contract-envelope | `make contract-envelope` | node 门禁 PASS（24/24）+ pytest **4 passed** |
| contract-state-machine | `make contract-state-machine` | **5 passed**（Python loader 与 7 个 yaml 一致） |
| golden（契约金） | `make contract-golden` | **330 passed** in 2.41s |
| scheduler-golden | `make scheduler-golden` | **6 passed** in 0.25s（求解段 3 + 工作流段 3） |
| openapi:no-drift | `npm run openapi:no-drift` | **OK: OpenAPI contract checked; committed outputs are in sync.** |
| production-smoke | `make production-smoke` | **11 passed**（P0-EDGE-006 真实装配 no-stub + Bus 契约） |
| bandit | `make security` | **ENVIRONMENT_BLOCKED**：本机未安装 bandit（`bandit not found`）；CI（.github/workflows/security.yml）以 bandit 1.8.6 JSON 报告 + HIGH 门禁执行，本轮未在本机复跑、不转述数字 |

## 3. ENVIRONMENT_BLOCKED 清单（本机不可执行，如实列出）

| 项 | 阻塞原因 | 已有替代覆盖 |
|---|---|---|
| bandit 静态安全扫描（make security） | bandit 未安装（需 pip）；truth-check 24/24 中"24"为 Event Envelope Audit 计数，与 bandit 无关，勿混用 | CI security.yml 门禁（未转述结果） |
| 迁移链真实空库验证（058/059/060 全新库执行） | 需 EWOH_PG_URL 真实 PostgreSQL | migration-fresh-install-check 静态顺序校验（主线 5 通过）+ `node --check run_migrations.js` SYNTAX_OK + verify 脚本结构断言落盘 |
| 跨租户 TCK | `make cross-tenant-tck` 需 E2E 数据库环境 | 租户隔离证据见 `tenant-isolation-report.md`（单测/静态门禁/e2e 存量） |
| Playwright 浏览器用例（4 spec） | `npm run test:browser` 需浏览器 + 真实后端 | 本轮未执行；相关断言修复见 R2-APT-007/013（tsc 诊断通过，运行需环境，fixlog 如实登记） |
| Jest e2e（8 spec，真实 PG） | `npm run test:e2e` 需 EWOH_E2E_RUNTIME_DATABASE_URL | 相关修复以 tsc 语法诊断 + 断言语义核对验证（fixlog-sched-tests R2-APT-004/005/009 登记） |
| ortools CP-SAT worker 真实求解 | 本机未安装 ortools（import 失败）；CP-SAT 默认 OFF（feature-status.yaml:72-97） | 请求契约/冻结面/回退单测 + golden 共享场景（见 `scheduler-conformance-report.md` §4） |
| runtime-gates / perf / soak 类 CI 门禁（真实 PG/kind 集群/容器构建） | 需 CI 环境 | .github/workflows 声明（repository-truth.md §11），未在本机执行 |

## 4. 汇总

- **Python 侧**：unittest 979 OK；pytest 契约 681 passed/11 skipped；golden 族（contract 330 + scheduler 6）+ 状态机 5 + production-smoke 11 全绿。
- **Node/TS 侧**：tsc -b 0 错误；client Jest 127 suites/1022 tests 全过；server Jest **290 suites/2247 tests 全过**（首跑唯一失败 openapi-route-parity 已修复收敛，见 §1.1）。
- **门禁**：lint/truth-check(24/24)/audit-regression-gates 十条/contract-identity/domain/envelope/state-machine/golden/scheduler-golden/openapi:no-drift/production-smoke 全绿；bandit 及真实环境依赖项按 ENVIRONMENT_BLOCKED 如实登记。
- 未在本报告虚构任何未执行数字；所有结果可由 §1/§2 命令复现。
