# 生产真实性与用户体验深化收口 — 交付报告

> 基线：`main` @ `5a810c70960702201f5b870c35f5be58c5373e48`
> 原则：以真实代码、测试结果、CI 门禁与运行证据为准；不信任 README/CHANGELOG/release manifest 中的文字结论。环境不具备项诚实标 `BLOCKED_BY_ENVIRONMENT`，不伪造通过。

## A. 当前 SHA 与基线问题清单

- 基线 commit：`5a810c70960702201f5b870c35f5be58c5373e48`（branch=`main`）
- 环境指纹（本机）：macOS 27.0 / Node `v26.5.1` / npm `11.17.0` / Python `3.9.6` / PostgreSQL、Docker 不可用（`psql`、`docker` 不在 PATH）
- 基线发现的问题：
  1. 设计 Token 静态检查未放行 3 个新组件（`AppErrorState`、`DataStates`、`OnboardingQuickStart`），`npm run lint` 退出码 1。
  2. OpenAPI route-manifest 与实时扫描不一致（记录 269，实扫 272），导致 `repo-facts.spec.ts` 与 `reconcile-authoritative-artifacts.spec.ts` 失败。
  3. `npm audit --audit-level=high` 依赖漏洞（经修复后 high/critical=0）。
  4. RoleWorkbench 前端仍使用浏览器内全量筛选/排序/`progressiveSlice`/浏览器 CSV/`localStorage` 保存视图，未走服务端数据路径。
  5. Playwright 浏览器矩阵配置含 6 个项目，但 CI 仅安装 chromium，firefox/webkit 不会真实执行。

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

## D. 各子系统变化

- **角色工作台（Task 4，P0，已完成）**：前端改为 `getWorkbenchList` 服务端分页/筛选/排序；删除 `progressiveSlice`/`buildCsv`/本地排序筛选；筛选/排序/分页状态同步到 URL search params（可刷新/返回/复制链接）；保存视图改走服务端 `workbench/views` API 并对旧 `localStorage` 视图做一次性幂等迁移后清理；CSV 导出改为服务端异步任务（创建→轮询进度→完成下载）；表格行虚拟化（`useWindowedRange`）；表头排序保持 `<button>` + `aria-sort`。后端 `operations.controller.ts` 与 `api/operations.ts` 已具备对应能力，未改动。
- **浏览器矩阵（Task 3，P0，CI 侧完成）**：CI 真实安装并执行 chromium/firefox/webkit 全矩阵并上传报告；WebKit 无头受限键盘焦点用例按既有 `BLOCKED_BY_ENVIRONMENT` 显式标记（见 `ux009-uxindustrial.spec.js`）。
- **工程事实源（Task 2，P0，验证既有实现）**：`truth-manifest.js` 已含完整证据字段并支持 `--check` 漂移检测；`make truth-check` 通过（39/39，无漂移），证据 manifest 已生成。
- **移动工作台 / PWA / 可观测性 / 上传安全（Task 5-8，P1）**：本轮未完成（见 H/I）。

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

## F. 各测试套件与浏览器项目真实结果

| 套件 | 结果 |
|---|---|
| typecheck（server+client） | PASS |
| lint（eslint + design-tokens） | PASS |
| Server Jest | 94 suites / 529 tests PASS |
| Client Jest | 73 suites / 529 tests PASS |
| OpenAPI drift | PASS |
| bundle budget | PASS |
| truth-check / repo-facts | 39/39 PASS |
| npm audit high | PASS（0 high / 0 critical） |
| 浏览器矩阵真实执行 | `BLOCKED_BY_ENVIRONMENT`（本机无 PG/浏览器依赖；CI 侧配置已就绪） |

## G. 当前 evidence manifest 摘要与 digest

- 生成：`output/evidence-manifest.json`
- HEAD=`5a810c...` branch=`main` version=`0.6.0-rc4`
- artifactDigest=`1b4fce3918166f3b611cd53b1cf2b2565770fdb451bcda412896835a57306aff`

## H. 仍未完成的外部验证 / 审批 / 环境阻塞

- PostgreSQL 迁移、并发验证、HTTP+PG E2E、浏览器矩阵、Docker 构建/启动健康检查：均为 CI-only 门禁，本机无 PG/Docker/浏览器依赖，无法手动复现 → `BLOCKED_BY_ENVIRONMENT`，需在 GitHub Actions 上运行。
- NestJS 11 大版本升级（消除剩余 moderate 漏洞）：未做，属高风险变更，需审批。

## I. 没有通过的事项与明确失败原因

- **Task 5（移动工作台与离线体验深化）**：未完成。
- **Task 6（PWA 更新与回滚）**：未完成。
- **Task 7（可观测性、隐私与上传安全深化）**：未完成。
- **Task 8（工业 UX 与可维护性：MobileWorkbench.tsx 拆分、状态机建模、泄漏/性能测试）**：未完成。
- **Task 1 中的 PG/E2E/浏览器/Docker 运行时门禁**：本机环境不具备，未在本机运行（CI 侧配置已就绪）。

## 结论（如实）

- P0 核心（恢复主分支全绿的本机可运行门禁、统一工程事实源验证、浏览器矩阵 CI 配置、RoleWorkbench 服务端数据路径）已实现并通过真实验证。
- 未提升到 "Runtime Verified / Pilot Ready / Production Ready"：P1 的移动/PWA/可观测性/上传安全深化与需要 PG/Docker/浏览器运行时证据的门禁仍未完成，不能宣称"全部完成"。