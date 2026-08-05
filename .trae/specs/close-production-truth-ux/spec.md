# 生产真实性与用户体验深化收口 Spec

## Why
当前 `main` @ `5a810c70960702201f5b870c35f5be58c5373e48` 上，CI 声明、测试配置与真实运行路径之间存在断层：Playwright 配置声明了 6 个浏览器项目但 CI 只安装 Chromium；RoleWorkbench 仍依赖浏览器端全量筛选/排序/导出与 localStorage 保存视图；证据清单与 release manifest 的一致性仅靠静态对账脚本，未与当前 workflow run 动态绑定。目标是把当前版本收敛到可复现、可审计、可长期维护的受控试点就绪状态，而非新增概念性功能。

## What Changes
- **P0 恢复主分支全绿**：在干净环境执行 `npm ci` + 结构化 `npm audit`；修复 high/critical 依赖；升级 GitHub Actions 到支持 Node 24 的稳定版本（固定 commit SHA）；完整跑通 typecheck/lint/Jest/客户端测试/OpenAPI 漂移/PG 迁移与并发/E2E/浏览器矩阵/构建/Docker/仓库卫生。
- **P0 统一工程事实源**：交付状态由 CI 动态生成；为每条证据记录 commit SHA/branch/workflow/run id/时间/环境指纹/依赖版本/artifact digest/verifier/expiration/状态；release manifest、版本页、关于页、交付报告引用同一 derived evidence manifest；界面与清单对 STALE/FAILED/BLOCKED/NOT VERIFIED 显式标注；加入漂移测试。
- **P0 修复 Playwright 浏览器矩阵**：CI 真实安装并执行 chromium/firefox/webkit/mobile-chromium/industrial-tablet/reduced-motion；每项目输出 JSON/JUnit、HTML report、trace、失败截图；WebKit 触发受限项按 BLOCKED_BY_ENVIRONMENT 处理并给出证据与后续入口。
- **P0 贯通 RoleWorkbench 生产数据路径**：分页/筛选/排序由服务端执行；cursor 分页协议（total/hasNextPage/nextCursor/一致排序）；组织隔离与 RBAC 不信任前端；状态同步到 URL search params；服务端持久化保存视图（创建/重命名/更新/删除/默认/权限/跨设备）；CSV 导出改为服务端异步任务（进度/取消/通知/过期/权限/审计/脱敏）；行虚拟化；1 万/10 万级性能测试；表头排序 button 语义 + aria-sort + 键盘/焦点/读屏；localStorage 视图一次性迁移后清理。
- **P1 深化移动工作台与离线体验**：拆分 MobileWorkbench 为领域 hooks/队列状态机/附件/冲突/展示组件；离线队列展示完整字段与批量重试/放弃/冲突差异/重认证恢复；401 暂停队列、409/412 字段级冲突不静默覆盖；IndexedDB 空间/清理/密钥失效/多标签/时钟偏差可恢复；附件断点续传/取消/重试/校验和/孤儿清理；在线/离线/弱网/陈旧/同步中/失败显著标识；扫码/触控/单手/手套设置持久化。
- **P1 完善 PWA 更新与回滚**：SW 更新为明确状态机（checking/available/saving-drafts/activating/reloading/success/rollback/failed）；更新前持久化草稿与离线队列；缓存版本化与迁移；新 shell 失败自动回滚；API/鉴权/敏感数据默认不缓存；清理失效缓存；上报安装/激活/失败/回滚/迁移指标；跨两个版本升级自动化测试。
- **P1 可观测性、隐私与上传安全深化**：前端指标采样率/限速/队列上限/退避/批量/丢弃统计；结构化脱敏（URL/错误/表单/文件名/查询参数/输入）；脱敏回归测试；session/requestId/traceId/构建版本与后端链路关联并保持组织隔离；上传流式校验 magic bytes；压缩包最大文件数/展开尺寸/压缩率/嵌套深度/单文件/处理时间限制；隔离区文件扫描前不可下载；恶意文件/伪造扩展名/路径穿越/嵌套压缩包/取消/分片缺失测试。
- **P1 工业 UX 与可维护性**：拆分超大页面（RoleWorkbench.tsx 720 行、MobileWorkbench.tsx 1128 行）；网络/会话/离线队列/上传/危险操作/页面查询建模为可测试状态机；主要页面验证 200%/400% 缩放、键盘、焦点返回、读屏、reduced-motion、contrast、触控目标、中文长文本、空数据、部分失败、大数据、长时运行；危险操作含影响预览/二次确认/幂等键/结果/可撤销窗口/审计；不以颜色为唯一表达；内存/定时器/监听器/Object URL/缓存泄漏测试；按路由 JS/CSS/chunk 预算，超预算 CI 失败；保留既有工业视觉语言。
- **不可破坏的系统边界**：不改造为实时设备安全控制器；保持只读监督/审批门禁/人机协同；不削弱组织隔离/RBAC/RLS/审计链/幂等/不可逆操作审批；不以 mock/stub/skip/固定数字替代生产验证；环境不具备时按 BLOCKED_BY_ENVIRONMENT 报告。

## Impact
- Affected specs: production-ux-deepening、engineering-truthfulness-production、code-deepening-ux-closed-loop、latest-head-audit-and-deepening
- Affected code:
  - `.github/workflows/{standalone,test,security,package}.yml`
  - `ewoh-spark-app/package.json` + `package-lock.json`
  - `ewoh-spark-app/playwright.config.ts` + `test/browser/*`
  - `ewoh-spark-app/client/src/pages/RoleWorkbench/*`、`MobileWorkbench/*`
  - `ewoh-spark-app/server/**`（RoleWorkbench 数据 API、保存视图、异步导出、上传校验）
  - `scripts/truth-manifest.js`、`scripts/*`（evidence manifest 派生）
  - `ewoh-spark-app/client/src/**`（PWA SW、可观测性、脱敏、右移预算法）

## ADDED Requirements
### Requirement: Evidence-Manifest-Derived Engineering Facts
The system SHALL derive all delivery status from the current CI run and bind each evidence record to commit SHA, workflow, run id, environment fingerprint, dependency versions, artifact digest, verifier, expiration, and status. The release manifest, version page, about page, and delivery report SHALL reference the same derived manifest. When evidence SHA != current build SHA, evidence is expired, critical gates did not run, or a workflow failed, the UI and manifest SHALL display STALE / FAILED / BLOCKED / NOT VERIFIED.

#### Scenario: Deriving evidence from a CI run
- **WHEN** a workflow completes on a commit
- **THEN** an evidence manifest is produced with per-job status and metadata, and any mismatch with the release manifest is surfaced (drift test fails CI)

### Requirement: Server-Side RoleWorkbench Data Path
The RoleWorkbench SHALL perform pagination, filtering, sorting, and large-data export on the server. Client SHALL NOT pull all business data into the browser for filtering, sorting, or export. Saved views SHALL persist server-side, be scoped to user/org/role, and support create/rename/update/delete/default/permission/cross-device sync. CSV export SHALL run as a server-side async task with progress, cancel, completion notification, expiring download URLs, permission checks, audit records, max row limits, and field-level redaction.

#### Scenario: Paginated server query
- **WHEN** a user filters/sorts/paginates in the workbench
- **THEN** the server returns total/hasNextPage/nextCursor with a consistent sort definition, honoring org isolation and RBAC regardless of client-supplied role

### Requirement: Real Browser Matrix Execution
GitHub Actions SHALL actually install and execute all configured Playwright projects (chromium, firefox, webkit, mobile-chromium, industrial-tablet, reduced-motion). Each project SHALL emit JSON/JUnit results, HTML report, trace, and failure screenshots. Configured-but-not-run projects SHALL NOT count as passed. WebKit headless restrictions on keyboard-focus tests SHALL be reported as BLOCKED_BY_ENVIRONMENT with a reproducible reason, real Chromium/Firefox evidence, and a follow-up validation entry.

#### Scenario: Reporting per-browser results
- **WHEN** the browser matrix runs in CI
- **THEN** the report and evidence manifest browser pass counts derive from actual per-project test results

## MODIFIED Requirements
### Requirement: Restore Green Main
The full gate set (typecheck, lint, Jest, client tests, OpenAPI drift, PG migrations + concurrency, HTTP+PG E2E, browser matrix, build, Docker, repo hygiene) SHALL pass on the latest commit. `npm audit --audit-level=high` SHALL pass with high/critical = 0 (or documented risk exceptions). No gate may be skipped, muted with `|| true`, or passed via lowered audit level. GitHub Actions SHALL target runtimes supporting Node 24 using pinned commit SHAs.

## REMOVED Requirements
### Requirement: Browser-Side Full Data Filtering/Sorting/Export in RoleWorkbench
**Reason**: Pulling all business data into the browser for filtering, sorting, and CSV generation does not scale and conflicts with org isolation/audit/redaction requirements.
**Migration**: Replace with server-side cursor pagination, server-side export tasks, and a one-time localStorage view migration that is cleaned up after success.