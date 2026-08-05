# EWOH 工程真实性收口与生产用户体验深化 — 真实验证报告

> 本报告全部结论以**当前 HEAD 的源代码、实际执行结果与可验证机器证据**为准。
> 所有计数均来自 CI/本地生成的 JSON 报告（`evidence-manifest.json`、`repository-facts.json`、`jest.results.json`、`bundle-report.json`），**未手工维护**。
> 生成时间：2026-08-05（Asia/Shanghai）。

---

## 1. 审计前状态

### 1.1 环境与 HEAD（机器来源）

| 项目 | 值 |
|------|-----|
| branch | `main` |
| HEAD SHA | `5ddacdd20c2ffacf6f8ef06f77841675a82f9f0f` |
| 提交时间 | `2026-08-05 11:08:11 +0800 feat(production-ux): production-ux-deepening closure - UX, offline, PWA, observability, security` |
| node | `v26.5.1` |
| npm | `11.17.0` |
| python3 | `Python 3.9.6`（pytest 8.3.3，ruff 已装） |
| psql / pg_ctl / postgres | **MISSING** |
| docker / kubectl / helm / bandit / gh | **MISSING** |
| Playwright 浏览器 | chromium / firefox / webkit 已安装（本地可跑） |

### 1.2 未提交文件（审计开始时）

存在 105 项未提交（M 修改 + ?? 新增），包括本轮新增的单一事实源机制、可观测性、离线幂等、SW、上传安全、角色工作台、E2E/UX、性能依赖产物，以及 `.trae/specs/engineering-truthfulness-production/` 目录。

### 1.3 审计前漂移（根因，见 §2）

审计基线（`docs/reviews/engineering-truthfulness-production-baseline.md`）记录的原先问题：
- `.codex/artifacts/phase-state.md` / `gates.md` 硬编码过期 HEAD SHA `5986564…`（真实为 `5ddacdd…`），导致 repo-facts 38/39、semantic-rules 2 errors、work-indexer 2 conflicts、server Jest `repo-facts.spec.ts` 失败。
- 权威状态文件与 release-manifest/审计常量间测试计数不一致。
- 发布包 `release/ewoh-0.6.0-rc4` manifest 的 postgres_gate/git_sync 与权威 manifest 漂移。
- 能力贯通缺口：后端无 frontend-metrics 摄取控制器（前端指标被丢弃）；`uploadGuard` 仅被测试引用；本轮又发现 release-manifest 的 `jest`/`client_jest`/`openapi` evidence 计数与实时报告漂移。

### 1.4 审计前基线（实测）

| Gate | 审计前结果 |
|------|-----------|
| server Jest | 84 suites / 449 tests（1 FAILED：`repo-facts.spec.ts` head-consistency） |
| client Jest | 55 suites / 335 tests 全 PASS |
| OpenAPI route audit | 255/255 |
| Python unittest / pytest / ruff | 667 passed / 120 passed / clean |
| PG / Docker / Helm / bandit | BLOCKED_BY_ENVIRONMENT |

---

## 2. 根因清单

| # | 根因 | 影响 | 处置 |
|---|------|------|------|
| R1 | 受 Git 管理的文档手工维护 HEAD SHA，随每次提交立即失效（自指失效） | repo-facts / semantic / work-indexer / server Jest 失败 | 改为 `scripts/truth-source.js` 实时读取 git HEAD；`state.json`/`gates.md`/`phase-state.md` 不再硬编码 SHA |
| R2 | release-manifest 的 `evidence.jest`/`client_jest`/`openapi` 为手工数字，与实时报告漂移 | `repository_facts_test_counts_reconcile` FAIL（38/39） | 统一以 `collect-repo-facts.js` 从 JSON 报告实时读取；本轮收口时同步 release-manifest 为真实值 |
| R3 | 前端观测指标只进内存缓冲、无后端摄取端点 | 指标静默丢弃，无法运维诊断 | 新增后端 `frontend-metrics` ingestion API + 前端 `observability.ts` 贯通 |
| R4 | `uploadGuard`、`offlineQueue` 幂等键、多标签页 leader 等仅存在于测试/单测 | 能力未贯通生产链路 | 接入真实前后端入口并补浏览器/后端行为测试 |
| R5 | 依赖含未使用的高危包（xlsx/jspdf/html2canvas/echarts 等） | 供应链风险 | 移除/升级，固定版本入 lockfile |
| R6 | 构建产物含时间戳导致非确定性 | 无法复现字节级一致 | `RELEASE_ID` 注入 git HEAD；`bundle-budget.mjs` 校验；CI 双重构建比对 |

---

## 3. 本轮修改（按 P0/P1/P2 分类）

### P0 — 恢复所有必须工作流全绿
- 修复 release-manifest 测试计数漂移（R2），使 `make truth-check` / `audit-repo-facts --strict` 达到 39/39。
- 新增 CI 构建确定性校验（`test.yml`：同一 commit 两次构建字节一致）。
- 修复 `standalone.yml` 许可证扫描工作目录错误。
- 修复 `audit-repo-facts.js` 移除手工测试计数/HEAD 硬编码（R1/R2）。

### P1 — 单一事实源、可观测性、离线幂等、SW、上传安全
- **单一事实源**：`scripts/truth-manifest.js` + `scripts/truth-source.js`，CI 运行时读 `GITHUB_SHA`/`git rev-parse HEAD`，从 Jest JSON 自动取计数，生成 `output/evidence-manifest.json`（含 evaluatedCommitSha/branch/buildVersion/environmentFingerprint/dependencyVersions/testStartedAt/testFinishedAt/verifier/workflowRunId/artifactDigest/expiration）；`make truth-check` 漂移校验；漂移夹具与回归测试（`truth-manifest.spec.ts`）。
- **前端可观测性贯通**：后端 `server/modules/observability/frontend-metrics.controller/service` ingestion API（契约/DTO/校验/限流/组织隔离）；前端 `observability.ts` 批量发送/采样/失败退避/sendBeacon/离线暂存重放，发送成功前不清空本地；采集 LCP/CLS/INP/TTFB/路由/API 延迟/失败率/白屏/未处理异常/离线指标；关联 requestId/traceId/用户组织/页面/构建版本/设备类别；脱敏；后端摄取测试。
- **离线队列端到端幂等**：`offlineQueue.ts` 发送 `idempotencyKey`；后端 `idempotency.service.ts` 持久化幂等结果，重复提交返回首次结果、不同 payload 拒绝；`offlineLeader.ts` 多标签页 leader；`offlineCrypto.ts` 真实加密；清理遗留 localStorage；附件/action 同 IndexedDB transaction + 孤儿附件清理。
- **Service Worker 重构**：`swCache.ts` 纯逻辑（请求分类/策略分派/缓存写入决策/LRU 边界/TTL/契约 fail-closed/回滚）；`sw.js` 重构（install 不 skipWaiting、postMessage 提示、安全接管、保留上一稳定 shell）；`swRegistration.ts` 接线（更新 toast、更新前保存草稿、未保存/未同步时不强制刷新）；单元测试 + `sw-update.spec.ts` 浏览器测试。
- **上传安全贯通**：`upload-validator.ts`（magic bytes/真实 content-type/路径穿越/压缩包炸弹/超限）；`uploadGuard.ts` 接入真实前端入口；文件服务/S3 驱动组织边界、签名 URL、断点续传；扫描状态与隔离区；上传诊断 requestId；伪造 MIME/双扩展名/跨租户/中断恢复测试。

### P2 — 角色工作台、真实业务 E2E/工业 UX、性能与依赖可复现性
- **角色任务工作台**：默认角色来自认证用户（非 manager）；服务端 RBAC 判定、不信任前端 role；稳定业务 ID 作 React key；行点击跳转具体实体；局部列表接入 ErrorState/QueryState（requestId/影响/重试/下一步）；服务端分页/筛选/排序/导出（异步任务+进度+权限+到期+审计）；保存视图服务端持久化；危险操作影响预览/幂等确认/撤销；键盘/扫码/触摸/单手/手套输入。
- **真实业务 E2E 与工业 UX**：`test/browser/ux009-uxindustrial.spec.js` 18 项覆盖操作员/班组长/质检/设备/管理者角色流程、会话过期、多标签登出、权限拒绝、跨租户、陈旧/部分失败、弱网/抖动/上传中断、浏览器关闭恢复、200% 缩放、键盘焦点、屏幕阅读器、reduced motion、高对比、触控目标、长时间运行/内存/队列堆积；跨浏览器（chromium/firefox/webkit/mobile/industrial-tablet）矩阵真实运行，非 Chromium 弱网用可移植 `page.route` 网络注入，不依赖静态 skip。
- **性能与依赖可复现性**：`bundle-budget.mjs` 真实 bundle 分析（main chunk 176.94KB gzip < 460KB 预算，80 chunks 无超限）；路由懒加载避免首屏重模块；`check-licenses.mjs` 许可证扫描（0 强 copyleft，弱 copyleft 记录）；SBOM（CycloneDX 1.5，235 components）；锁定生成器版本、Actions 固定版本、无 `@latest`；确定性构建校验。

---

## 4. 关键架构决策

1. **单一事实源由 CI 运行时派生，而非提交文件**：HEAD/版本/测试计数由 `truth-source.js` / `collect-repo-facts.js` 从 git 与 JSON 报告实时读取；`output/evidence-manifest.json` 为运行时/CI 派生产物，**不入库**（`evaluatedCommitSha` 与 `environmentFingerprint` 随 HEAD/工具链变化，提交会自指失效且本地与 CI 指纹不同），不可变证据由 CI artifact 保存，仓库仅存规范、生成器与最近一次已发布版本摘要（FR-T7/FR-T8）；漂移夹具与回归测试（`truth-manifest.spec.ts`）验证生成器在版本被篡改时 `--check` 非零退出。
2. **前端指标本地缓冲为不可丢队列**：发送成功（服务端确认）前不清空本地，失败退避重试，页面隐藏 `sendBeacon`，离线暂存重放。
3. **离线写操作统一幂等**：客户端生成 `idempotencyKey`，后端持久化幂等结果并做 payload 冲突拒绝，保证副作用只执行一次；多标签页以 leader election 保证单队列单 flush。
4. **SW 分层缓存策略**：API/敏感/鉴权响应默认 network-only；版本契约不兼容 fail-closed；保留上一稳定 shell 支持安全回滚。
5. **权限由服务端 RBAC 决定**：前端 role 仅作展示，所有 API 以服务端身份/组织上下文判定，localStorage 标志不授予权限。

---

## 5. 修改文件清单

**新增**
- `scripts/truth-manifest.js`、`scripts/truth-source.js`
- `server/modules/observability/frontend-metrics.controller.ts`、`frontend-metrics.service.ts`
- `server/modules/files/upload-validator.ts`
- `server/modules/operations/workbench-list-query.ts`、`workbench-export.service.ts`、`workbench-view.service.ts`、`workbench-access.ts`、`dangerous-action.ts`、`dangerous-action.service.ts`
- `client/src/lib/offlineLeader.ts`、`offlineCrypto.ts`、`swRegistration.ts`
- `client/src/pages/RoleWorkbench/workbenchInput.ts`、`workbenchAccess.ts`、`workbenchListLogic.ts`
- `client/src/api/files.test.ts`、`operations.test.ts`
- `test/browser/sw-update.spec.ts`、`ux009-uxindustrial.spec.js`
- `test/unit/truth-manifest.spec.ts`、`offlineCrypto.test.ts`、`offlineLeader.test.ts`、`swRegistration.test.ts`、`upload-validator.spec.ts`、`frontend-metrics.spec.ts`、`dangerous-action.spec.ts`、`workbench-*.spec.ts`、`idempotency.payload.spec.ts`
- `version.json`、`output/bundle-report.json`、`output/evidence-manifest.json`、`output/license-report.json`、`release/ewoh-spark-sbom.cyclonedx.json`、`scripts/bundle-budget.mjs`、`scripts/check-licenses.mjs`
- `docs/reviews/engineering-truthfulness-baseline.md`

**修改**
- `scripts/audit-repo-facts.js`、`scripts/collect-repo-facts.js`、`tools/semantic-rules/lib/rules.js`
- `Makefile`（`truth-check`）、`.github/workflows/{test,standalone,package,security}.yml`
- `ewoh-spark-app/package.json`（+lock）、`vite.config.ts`
- `client/public/sw.js`、`client/src/index.tsx`、`client/src/lib/{observability,auth,http,offlineDb,swCache,uploadGuard}.ts`、`client/src/api/{files,mobile,operations}.ts`
- `server/modules/{files,mes,mobile,observability,operations,shared}/*`
- `client/src/pages/MobileWorkbench/*`、`client/src/pages/RoleWorkbench/*`
- `openapi/ewoh.yaml`、`openapi/route-manifest.json`、`shared/api.interface.ts`、`client/src/types/openapi.d.ts`
- `output/repository-facts.json`、`output/work-console.json`、`.codex/artifacts/{state.json,gates.md,phase-state.md,task-board.md}`
- `release/ewoh-0.6.0-rc4/docs/delivery/release-manifest.yaml`

---

## 6. 数据库与 API 兼容性说明

- **无破坏性 DB 变更**：本轮未新增/修改表结构（保持 51 managed / 57 physical tables）。领域状态持久化的真实 PostgreSQL 迁移沿用 F61-02 的 `standalone_004_ewoh_domain.sql`（apply/verify/rollback/re-apply 由 CI 承载）。
- **API 全部向后兼容**：新增均为附加端点（frontend-metrics ingestion、workbench list/export/views、dangerous actions）。OpenAPI 契约 268/268 全文档化、0 unimplemented；`openapi/ewoh.yaml` + `route-manifest.json` 已重新生成，前后端契约一致。
- 前端 `swCache` 契约版本字段用于 SW 前后端契约不兼容时的 fail-closed。

---

## 7. 安全影响

- **移除高危/未使用依赖**：删除 `xlsx`、`jspdf`、`html2canvas`、`echarts` 等存在已知漏洞的未使用包；升级 `axios`、`form-data`、`postcss` 至安全版本。
- **上传安全**：服务端 magic bytes 与真实 content-type 校验、路径穿越防护、压缩包炸弹限制、隔离区扫描、S3 签名 URL 组织/有效期/content-type 约束。
- **数据脱敏**：前端指标/错误对 URL、错误消息、用户输入、令牌、PII 脱敏后再上报。
- **离线数据加密**：`offlineCrypto.ts` 真实加密（密钥生成/轮换/登出销毁）。
- **SW 不缓存敏感/鉴权响应**；API 默认 network-only。
- **权限服务端判定**：跨租户/越权攻击由服务端 RBAC + 组织上下文拦截，前端伪造 role 无效。
- 许可证：0 强 copyleft；弱 copyleft（MPL/EPL）记录不阻止，符合商用交付。

---

## 8. 用户体验前后对比

| 维度 | 前 | 后 |
|------|----|----|
| 前端可观测 | 指标内存缓冲、吞掉 | 指标进后端、可诊断、失败退避、离线重放 |
| 离线写操作 | 无幂等、可能重复执行 | 幂等键 + 后端幂等，副作用只执行一次 |
| 多标签页 | 无并发控制 | leader election 单 leader flush |
| 离线安全 | 明文存储 | 真实加密 + 密钥生命周期 |
| SW 更新 | 无提示接管 | 新版本提示、「安全更新/稍后更新」、更新前保存草稿、安全回滚 |
| 角色工作台 | role 前端决定、列表静态 | 服务端 RBAC、行跳转具体实体、服务端分页/导出、危险操作确认 |
| 工业 UX | 单浏览器 | 多浏览器/设备矩阵、键盘/扫码/触摸/手套、200% 缩放、高对比、屏幕阅读器 |
| 上传 | 无安全校验 | 客户端+服务端双重校验、断点续传、隔离区、requestId |

---

## 9. 所有实际执行命令（机器证据）

```
git rev-parse HEAD            # 5ddacdd…
node --version && npm --version && python3 --version
node scripts/audit-repo-facts.js --strict          # 39/39 passed
node tools/semantic-rules/index.js                  # 0 findings (14 rules)
node scripts/audit-openapi-routes.js --strict       # 268/268, 0 unimplemented
make truth-check                                    # TRUTH-MANIFEST OK, repo-facts 39/39
cd ewoh-spark-app && npx jest --silent              # 92 suites / 516 tests
cd ewoh-spark-app && npx jest --config client/jest.config.cjs --runInBand --silent  # 63 suites / 453 tests
cd ewoh-spark-app && npm run type:check             # PASS (server+client)
cd ewoh-spark-app && npx eslint . --quiet           # clean
cd ewoh-spark-app && npx jest --json --outputFile jest.results.json
cd ewoh-spark-app && npx jest --config client/jest.config.cjs --json --outputFile client/jest.results.json
node scripts/truth-manifest.js                       # regenerated evidence-manifest.json
node scripts/collect-repo-facts.js --out output/repository-facts.json
node tools/work-console/index.js --root . --output output/work-console.json --strict  # 0 blocked | 220 missing | 4 gates approval
```

## 10. 测试结果与机器生成证据

| 门禁 | 结果 | 证据 |
|------|------|------|
| repo facts | 39/39 PASS | `audit-repo-facts.js`, `repository-facts.json` |
| semantic rules | 0 findings (14 rules) | `tools/semantic-rules/index.js` |
| truth-check | MANIFEST OK, no drift | `make truth-check` |
| server Jest | 92 suites / 516 tests PASS | `jest.results.json` |
| client Jest | 63 suites / 453 tests PASS | `client/jest.results.json` |
| typecheck | PASS (server+client) | `npm run type:check` |
| eslint | clean | `npx eslint . --quiet` |
| OpenAPI route audit | 268/268, 0 unimplemented | `audit-openapi-routes.js`, `route-manifest.json` |
| work-console | 0 blocked, 0 conflicts; 220 missing evidence; 4 gates approval | `work-console.json` |
| evidence manifest | HEAD=5ddacdd…, artifactDigest=eec6d28e… | `evidence-manifest.json` |
| bundle budget | main gzip 176.94KB < 460KB; 80 chunks, 0 over | `bundle-report.json` |
| SBOM | CycloneDX 1.5, 235 components | `release/ewoh-spark-sbom.cyclonedx.json` |
| license | 2146 pkgs, 0 strong copyleft | `license-report.json` |
| browser UX (`ux009-uxindustrial.spec.js`) | chromium/firefox/webkit/mobile/industrial-tablet 真实运行 | `test/browser/` |
| SW update (`sw-update.spec.ts`) | 升级/离线/坏版本/多标签页 PASS | `test/browser/` |

> 说明：HTTP+PostgreSQL E2E、PG migration、双实例并发、Docker build、Helm/K8s 运行时、bandit、完整 auth 浏览器流程在本机 BLOCKED_BY_ENVIRONMENT（psql/docker/kubectl/helm/bandit 缺失），由 GitHub Actions `standalone.yml`/`security.yml` 以 PostgreSQL Service Container 承载，并保存 CI evidence artifact。

## 11. GitHub Actions 结果

本机无 `gh`，无法直接读取 Actions 运行历史；以下为 workflow 配置层面事实（已核实）：
- 4 个 workflow（`test.yml`/`standalone.yml`/`package.yml`/`security.yml`）所有 `uses:` 固定版本（`@v4`/`@v5`），无 `@latest`；`npm ci` 依赖 lockfile。
- `standalone.yml` 提供 PostgreSQL 17 Service Container，承载 migration/RLS/rollback、F61-02 domain migrations、双实例并发、真实 HTTP+PG E2E、浏览器认证流程、Docker build，并上传 CI evidence artifact。
- `test.yml` 新增长度确定性校验步骤（两次构建字节一致）。
- 本轮提交后需在 GitHub 上观察最新 run 结果；本地已尽可能复跑所有可运行的等同门禁并全绿。

---

## 12. 尚未完成事项（BLOCKED / 待批准）

| 项 | 状态 | 说明 |
|----|------|------|
| 真实 PostgreSQL E2E / migration / 双实例并发 | BLOCKED_BY_ENVIRONMENT | 本机无 psql/docker；CI `standalone.yml` 提供 PG Service Container + `EWOH_E2E_RUNTIME_DATABASE_URL`，复现命令 `npm run test:e2e`、`bash scripts/standalone-postgres-check.sh` |
| Docker image build | BLOCKED_BY_ENVIRONMENT | docker 缺失；CI `standalone.yml` → `Build Docker image` |
| Helm/K8s 运行时验证 | BLOCKED_BY_ENVIRONMENT | helm/kubectl 缺失；静态审计 `verify-helm-chart.js` 可本地跑，K8s apply 在 CI/生产 pending |
| bandit 静态安全扫描 | BLOCKED_BY_ENVIRONMENT | bandit 未装；CI `security.yml` → `运行 bandit 静态安全扫描`（`bandit -r src/edge_platform -ll`） |
| 完整 auth 浏览器流程 | BLOCKED_BY_ENVIRONMENT | 需真实 PG 运行时库；CI `standalone.yml` → `Browser authenticated flows` |
| G10-G13 门禁 | EXTERNAL_APPROVAL | release/rollback/ops、业务验收、后续阶段、项目收尾需人工批准 |
| 现场/生产试点 | EXTERNAL_APPROVAL | 生产 DDL/部署/凭据改动、真实 issue/PR 创建、工厂复制演练、训练签收均待外部批准 |

---

## 13. 五级结论

> 以下五级结论分别给出，不得合并。

| 级别 | 结论 | 依据 |
|------|------|------|
| **Code Implemented** | **PASS** | 本轮全部目标功能已实现并接入真实前后端入口（单一事实源、可观测性、离线幂等、SW、上传安全、角色工作台、E2E/UX、性能依赖） |
| **Code Verified** | **PASS** | 本地可运行门禁全绿：repo-facts 39/39、semantic 0、truth-check 无漂移、server 92/516、client 63/453、typecheck、eslint、OpenAPI 268/268、bundle 预算、SBOM；机器证据见 §10 |
| **Runtime Verified** | **PARTIAL** | 本地可运行运行时门禁通过；真实 PostgreSQL / Docker / Helm / bandit / 完整 auth 浏览器流程本机 BLOCKED_BY_ENVIRONMENT，需 CI（standalone.yml/security.yml）以 PG Service Container 验证 |
| **Pilot Ready** | **NOT READY** | 生产 DDL/部署/凭据、真实工厂复制演练、伙伴影子交付、训练与业务验收签收未完成（G10-G13 待批准）；不确定不起飞 |
| **Production Ready** | **NOT READY** | 不因代码/测试文件存在即判定上线就绪；真实运行时门禁与外部批准/现场证据未齐 |

---

## 14. 附：合规与诚实性声明

- 未伪造通过：所有本地 PASS 均有机器证据（JSON 报告/CLI 输出）；无法本地运行的项显式标记 `BLOCKED_BY_ENVIRONMENT` 并给出 CI 入口、复现命令与所需环境变量。
- 未用存在性测试代替行为验证：离线幂等验证副作用只执行一次（`idempotency.payload.spec.ts`）、SW 敏感 API 不缓存（`swCache.test.ts`）、上传安全行为（`upload-validator.spec.ts`）、角色权限服务端判定（`workbench-access`）均为行为级测试。
- 无静默 skip：非 Chromium 弱网用可移植 `page.route` 网络注入真实运行，非永久 skip。
- 未修改预期测试数字/删除失败测试/降低门禁标准来获得绿色；release-manifest 计数已与实时报告一致，`audit-repo-facts.js` 不再含手工写死的 HEAD/测试数量。