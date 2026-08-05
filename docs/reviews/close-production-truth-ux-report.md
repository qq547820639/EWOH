# 生产真实性与用户体验深化收口 — 交付报告

> 首轮基线：`main` @ `5a810c70960702201f5b870c35f5be58c5373e48`
> 本轮 P1 收口基线：`main` @ `5133bd8caf672317f6eae874b2114032e82561a4`（P0 收口已提交）。
> 原则：以真实代码、测试结果、CI 门禁与运行证据为准；不信任 README/CHANGELOG/release manifest 中的文字结论。环境不具备项诚实标 `BLOCKED_BY_ENVIRONMENT`，不伪造通过。

## A. 当前 SHA 与基线问题清单

- 基线 commit：`5a810c70960702201f5b870c35f5be58c5373e48` → P0 收口 `5133bd8` → 本轮 P1 收口（本次提交，见 git log）
- branch=`main`
- 环境指纹（本机）：macOS 27.0 / Node `v26.5.1` / npm `11.17.0` / Python `3.9.6` / PostgreSQL、Docker 不可用（`psql`、`docker` 不在 PATH）
- 基线发现的问题：
  1. 设计 Token 静态检查未放行 3 个新组件（`AppErrorState`、`DataStates`、`OnboardingQuickStart`），`npm run lint` 退出码 1。
  2. OpenAPI route-manifest 与实时扫描不一致（记录 269，实扫 272），导致 `repo-facts.spec.ts` 与 `reconcile-authoritative-artifacts.spec.ts` 失败。
  3. `npm audit --audit-level=high` 依赖漏洞（经修复后 high/critical=0）。
  4. RoleWorkbench 前端仍使用浏览器内全量筛选/排序/`progressiveSlice`/浏览器 CSV/`localStorage` 保存视图，未走服务端数据路径。
  5. Playwright 浏览器矩阵配置含 6 个项目，但 CI 仅安装 chromium，firefox/webkit 不会真实执行。
  6. security 工作流 gitleaks 在推送 `f54cbbe` 时失败：`ewoh-feishu-app/feishu-config.json` 内提交了真实飞书 Base `base_token`（历史遗留，非本轮引入）；`offlineDb.ts` 的 `MIGRATION_FLAG_KEY='pending-migrated-v1'` 被 generic-api-key 误报（非凭据）。

## B. 实际修改的文件及原因

- `ewoh-spark-app/package.json` / `package-lock.json`：修复 high/critical 依赖漏洞（升级 axios、drizzle-orm、form-data、multer、js-yaml、lodash、shell-quote、undici、tmp、OpenTelemetry 系列），并加入合法 overrides；`uuid` 升至 `11.1.1`（消除 moderate 越界写公告）。
- `ewoh-spark-app/client/.design-token-allowlist.json`：把 3 个新状态组件注册到设计 Token 放行清单（与既有 ErrorState/QueryState 等一致），使 lint 通过。
- `openapi/route-manifest.json`：按失败信息重生成（272=live），消除 route_manifest 漂移。
- `ewoh-spark-app/playwright.config.ts`：补充 JSON/JUnit/HTML reporter 与 trace/screenshot/video 采集，使每个浏览器项目可产出可审计证据。
- `.github/workflows/standalone.yml`：浏览器矩阵改为真实安装 chromium+firefox+webkit 并执行全部 6 个项目，上传 JSON/JUnit/HTML/report 等 artifacts。
- `ewoh-spark-app/client/src/pages/RoleWorkbench/RoleWorkbench.tsx`：重接到服务端数据路径（见 D）。
- `docs/reviews/close-production-truth-ux-report.md`：本报告。

## C. 安全漏洞根因与修复方式

- 根因：直接依赖版本过旧（axios、form-data 等）及传递依赖（multer、js-yaml、lodash、shell-quote、undici、tmp、brace-expansion、minimatch、OpenTelemetry）存在已知公告；部分 build 工具链（webpack）与框架栈（@nestjs/@lark-apaas）沿用了旧版本。
- 修复：通过合法升级 + `overrides` 固定受影响版本，未使用 `|| true`、未降低 audit level、未使用 `npm audit fix --force`、未删除扫描步骤。
- 结果：`npm audit --audit-level=high` 退出码 0（high=0，critical=0）。剩余 moderate 集中在 `@nestjs/*`/`@lark-apaas/*` 框架栈（需要 NestJS 11 大版本升级，属高风险变更，本收口不改动以保生产线稳定）。

### 安全 CI（gitleaks）修复

- 根因（历史遗留，非本轮 P1 引入）：`ewoh-feishu-app/feishu-config.json` 将真实飞书 Base `base_token` 提交入库；`security.yml` 的 gitleaks（零豁免配置）在每次推送时扫描当前工作树，因而在 `f54cbbe` 上失败。
- 修复方式：
  - 将 `ewoh-feishu-app/feishu-config.json` 加入 `.gitignore` 并从版本控制中移除（`git rm --cached`，本地文件保留、连接器可继续运行）；新增 `ewoh-feishu-app/feishu-config.example.json` 占位模板供本地创建真实配置。连接器 `feishu.js` 对配置缺失已 try/catch 容错（`config=null`，不阻断主流程）。
  - `security/gitleaks.toml` 增加一条**精确、书面说明**的豁免，仅匹配 `pending-migrated-v1` 这一前端 localStorage 迁移标记键（非凭据，属 generic-api-key 熵值误报），不匹配任何真实凭据形态。
  - 未通过 allowlist 放行真实 `base_token`（那将削弱安全标准）；真实凭据从仓库移除。

## D. 各子系统变化

- **角色工作台（Task 4，P0，已完成）**：前端改为 `getWorkbenchList` 服务端分页/筛选/排序；删除 `progressiveSlice`/`buildCsv`/本地排序筛选；筛选/排序/分页状态同步到 URL search params（可刷新/返回/复制链接）；保存视图改走服务端 `workbench/views` API 并对旧 `localStorage` 视图做一次性幂等迁移后清理；CSV 导出改为服务端异步任务（创建→轮询进度→完成下载）；表格行虚拟化（`useWindowedRange`）；表头排序保持 `<button>` + `aria-sort`。后端 `operations.controller.ts` 与 `api/operations.ts` 已具备对应能力，未改动。
- **浏览器矩阵（Task 3，P0，CI 侧完成）**：CI 真实安装并执行 chromium/firefox/webkit 全矩阵并上传报告；WebKit 无头受限键盘焦点用例按既有 `BLOCKED_BY_ENVIRONMENT` 显式标记（见 `ux009-uxindustrial.spec.js`）。
- **工程事实源（Task 2，P0，验证既有实现）**：`truth-manifest.js` 已含完整证据字段并支持 `--check` 漂移检测；`make truth-check` 通过（39/39，无漂移），证据 manifest 已生成。
- **移动工作台与离线体验（Task 5，P1，已完成）**：`MobileWorkbench.tsx`（1128 行）已拆分为 `StepCard.tsx`/`PendingQueuePanel.tsx`/`OfflineStatusBar.tsx`/`ConflictResolution.tsx`/`labels.ts`/`useNetworkState.ts`/`useOfflineSettings.ts` 与既有 `useOfflineWorkbench.ts`；离线队列 UI 展示完整字段（类型/创建时间/状态/重试次数/`computeNextRetryAt` 下次重试/失败原因/业务实体/`idempotencyKey`）；新增批量重试（`offlineDb.onlyIds`）与 401 认证暂停/恢复（`authPaused`）；409/412 字段级差异不静默覆盖；IndexedDB 空间/清理/密钥失效/多标签竞争/时钟偏差可恢复（`storageController`/`offlineLeader`/`offlineClock`）；附件断点续传/校验和/孤儿清理（`resumableUpload`/`offlineDb`）；弱网/数据陈旧/同步失败显著标识（`OfflineStatusBar`+`networkQuality`）；扫码/触控/单手/手套设置按用户与设备持久化（`offlineSettings`）。
- **PWA 更新与回滚（Task 6，P1，已完成）**：新增纯 TS 状态机 `swUpdateStateMachine.ts`（checking/available/saving-drafts/activating/reloading/success/rollback/failed，可单测），`swRegistration`/`index.tsx` 接线驱动；更新前 saving-drafts 落盘成功后才 activating；缓存版本化/迁移/失效清理/回滚已由 `swCache`+`public/sw.js` 实现并新增 `pruneCacheNames` 纯函数；API/鉴权/用户文件/敏感数据 network-only 不缓存；`sw.js` 通过 postMessage 上报 install/activate/rollback/migration 事件，页面经 `recordMetric` 上报 `sw.*` 指标；新增跨 v0/v1/v2 多版本升级清理测试。
- **可观测性、隐私与上传安全（Task 7，P1，已完成）**：前端指标具备采样率/限速/队列上限/退避/批量/丢弃统计（`observability`）；结构化脱敏覆盖 URL/错误/表单/文件名/查询参数/输入（`sensitiveData`）并有脱敏回归测试；session/requestId/traceId/构建版本与后端关联并保持组织隔离（`requestCorrelation`）；上传流式校验 magic bytes 不整文件载入内存（`uploadGuard`）；压缩包限制含文件数/展开尺寸/压缩率/嵌套深度/单文件/处理时间（`upload-validator.ts`）；隔离区文件扫描完成前不可下载/消费（`file.service` 扫描状态门禁+组织隔离）；新增恶意文件/伪造扩展名/路径穿越/嵌套压缩包/上传取消/分片缺失/跨组织测试。
- **工业 UX 与可维护性（Task 8，P1，已完成）**：`RoleWorkbench.tsx`（720 行）拆为 `WorkbenchChrome`/`WorkbenchList`/`SavedViewsPanel` + 纯逻辑 `roleWorkbenchState`/`workbenchExport`（465 行编排器）；危险操作建模为可测试状态机 `dangerousModel`（影响预览/二次确认/幂等键/结果/可撤销窗口/审计）+ `DangerousActionDialog`/`useDangerousConfirm`；`a11y`/`a11yAudit` 提供焦点序/reachableFocus/非颜色通道断言；新增 `leakAudit`/`runtimeLifecycle` 泄漏回归测试（定时器/监听器/Object URL/scope）；`perfBudget` 串入 `build:client` 与 CI `test.yml`，按路由 JS/CSS/异步 chunk 预算超限 CI 失败；保留既有 hsl 工业视觉语言。

## E. 执行过的完整命令

- `npm ci`（退出码 0，1991 packages）
- `npm audit --json` → `output/npm-audit-report.json`
- `npm audit --registry=https://registry.npmjs.org --audit-level=high`（退出码 0）
- `npm install uuid@11.1.1 --save-dev`
- `npm run type:check`（server+client 退出码 0）
- `npm run lint`（修复 allowlist 后退出码 0）
- `npm run gen:openapi:check`（退出码 0）
- `npm test -- --runInBand`（修复 route-manifest 后 94 suites / 529 tests 通过）
- `npx jest test/unit/repo-facts.spec.ts test/unit/reconcile-authoritative-artifacts.spec.ts --runInBand`
- `npm run test:client`（73 suites / 529 tests 通过）
- `npm run build:prod:standalone`（退出码 0）
- `npm run build:client`（含 bundle budget，退出码 0）
- `node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json`
- `make truth-check`（39/39）
- `node scripts/truth-manifest.js --out output/evidence-manifest.json`
- P1 收口（本轮）：`npm run type:check`、`npm run lint`、`npm run test:client`（81 suites / 629 tests）、`npm test`（96 suites / 553 tests）、`npm run build:client`（含 bundle budget，PASS）、`make truth-check`（39/39 无漂移）。

## F. 各测试套件与浏览器项目真实结果

| 套件 | 结果 |
|---|---|
| typecheck（server+client） | PASS |
| lint（eslint + design-tokens） | PASS |
| Server Jest | 96 suites / 553 tests PASS |
| Client Jest | 81 suites / 629 tests PASS |
| OpenAPI drift | PASS |
| bundle budget | PASS |
| truth-check / repo-facts | 39/39 PASS |
| npm audit high | PASS（0 high / 0 critical） |
| security（gitleaks） | 首轮 `f54cbbe` FAIL（feishu base_token 真实凭据 + MIGRATION_FLAG_KEY 误报）→ 已修复（移除真实凭据 + 精确豁免），待 CI 复跑 |
| 浏览器矩阵真实执行 | `BLOCKED_BY_ENVIRONMENT`（本机无 PG/浏览器依赖；CI 侧配置已就绪） |

## G. 当前 evidence manifest 摘要与 digest

- 生成：`output/evidence-manifest.json`
- HEAD=`5133bd8...`（P0 收口）→ 本轮 P1 收口提交（见 git HEAD） branch=`main` version=`0.6.0-rc4`
- artifactDigest / evidence 总数：以 `make truth-check` 于当前 HEAD 生成输出为准（本轮已验证 39/39 无漂移；提交后重新生成最终 digest）

## H. 仍未完成的外部验证 / 审批 / 环境阻塞

- PostgreSQL 迁移、并发验证、HTTP+PG E2E、浏览器矩阵、Docker 构建/启动健康检查：均为 CI-only 门禁，本机无 PG/Docker/浏览器依赖，无法手动复现 → `BLOCKED_BY_ENVIRONMENT`，需在 GitHub Actions 上运行。
- NestJS 11 大版本升级（消除剩余 moderate 漏洞）：未做，属高风险变更，需审批。

## I. 没有通过的事项与明确失败原因

- **Task 1 中的 PG/E2E/浏览器/Docker 运行时门禁**：本机环境不具备（无 PostgreSQL/Docker/浏览器依赖），未在本机运行，仍为 `BLOCKED_BY_ENVIRONMENT`，需在 GitHub Actions 上执行以产出真实运行时证据。这是唯一未闭环的运行时验证项。
- **浏览器矩阵真实执行结果**：本机无法执行，等待 CI；CI 配置已真实安装并执行 chromium/firefox/webkit 全矩阵并上传 JSON/JUnit/HTML/trace/截图 artifacts。
- **security 工作流（gitleaks）首轮失败**：`feishu-config.json` 真实 `base_token`（历史遗留）+ `MIGRATION_FLAG_KEY` 误报。已修复（移除真实凭据 + 精确豁免），待 CI 复跑确认。
- **NestJS 11 大版本升级（消除剩余 moderate 漏洞）**：未做，属高风险变更，需书面风险评估与审批。

## 结论（如实）

- P0 核心（恢复主分支全绿的本机可运行门禁、统一工程事实源、浏览器矩阵 CI 配置、RoleWorkbench 服务端数据路径）已实现并通过真实验证。
- P1 的移动工作台离线体验、PWA 更新回滚、可观测性/隐私/上传安全、工业 UX 与可维护性已在代码层面实现，并通过本机可运行的 typecheck/lint/Jest（客户端 629、服务端 553）/build/bundle-budget/truth-check 全部门禁。
- 达标结论：**Code Implemented + Code Verified**。尚未提升到 "Runtime Verified / Pilot Ready / Production Ready"：PG 迁移、并发、HTTP+PG E2E、浏览器矩阵、Docker 构建/健康检查等需要 PG/Docker/浏览器运行时的门禁仍为 `BLOCKED_BY_ENVIRONMENT`，须待 GitHub Actions 运行为真实运行时证据后方可宣称更高等级。不宣称"全部完成"。