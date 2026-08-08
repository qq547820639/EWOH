# 变更日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 1.1.0 规范，
并使用[语义化版本](https://semver.org/lang/zh-CN/) 2.0.0 进行版本管理。

## [Unreleased]

### Added
- **智能调度 v0.7（四批增量，指挥地图 → 智能调度驾驶舱）**：
  - **任务派生建模**（`world-state.service.ts`）：`productionImpact`（priority 映射 urgent=1.0→low=0.1）、
    `safetyCritical`（taskType 白名单）、`candidateStations`（空间拓扑推导）从既有字段派生，无 schema 变更；
    PriorityEngine 生产影响因子首次真实生效。
  - **冲突增强**：新增第 13 类 `reservation_expiring`（预占 15min 倒计时预警）；
    `buildConflicts` 新冲突经 outbox 推送 `conflict.detected` SSE（内存去重防轮询重复推送）。
  - **事件驱动智能重排**：`POST /api/scheduler/events`（局部重排：影响分析→冻结无关任务→子图求解→熔断）；
    `POST /api/scheduler/feedback/actuals`（执行实际值回填，覆盖式更新幂等，回填后推送 `execution.deviation` SSE）；
    ingest 设备故障/离线转换自动触发 `DEVICE_OFFLINE` 重排（fire-and-forget，熔断不阻断真机接入）；
    `ReplanCoordinator.handleTrigger` 失败熔断（run 置 failed 不再卡 queued）。
  - **前端智能交互**（CommandMap）：新增「冲突中心」（13 类过滤/严重度排序/建议处置/三态）与「人工覆盖」
    （LOCK/EXCLUDE/PREFER/BOOST/LOCK_TIME → 重排 → before/after diff）；`useSchedulerStream` 消费
    `conflict.detected`/`execution.deviation` 实时刷新。
  - **OpenAPI 同步**：304 → 306 条路径零漂移；客户端 TS 类型重生成。
- **飞书侧车生产级加固 v1.1.0**（`ewoh-feishu-app`）：
  - **API 统一鉴权**：写操作 fail-closed（token 未配置 → 503，不匹配 → 401），Bearer/X-API-Key 双格式，常量时间比较。
  - **SQLite 落盘持久化**：默认文件库（WAL + busy_timeout）替代 `:memory:`，进程退出数据保留。
  - **webhook 业务幂等**：`webhook_dedup` 表 `(event_id, action_type)` 唯一约束，重复投递返回 `duplicated:true`；
    失败回滚可重试；closed 事件禁止再处置（409）。
  - **签名协议修复**：HMAC 时间戳按飞书协议用秒级字符串（原毫秒导致 encrypt_key 校验永远失败）。
  - **规则单一事实源**：规则引擎从 DB 加载（阈值可运行时调参）。
  - **启动不阻塞**：飞书集成延迟至 HTTP 就绪后初始化（lark-cli 不再阻塞 listen）。
- **AI 接入修复**：`ark.service.ts` 配置保存改用全局哨兵 org_id（原 INSERT 缺 org_id → NULL →
  `ON CONFLICT` 永不触发 → 无限插行且读取常拿到旧行，AI 接入整体失效）；`getConfig` 按哨兵精确读取 + 排序。

### Fixed
- **AI 接入失效**：`saveConfig` 未提供 `org_id` 列 → NULL → PG 唯一索引视 NULL 互不相等 →
  `ON CONFLICT (org_id, config_key)` 永不触发，每次保存插入新行；`getConfig` 无 org 过滤 + 无排序读取不确定行。
  修复为显式全局哨兵 `GLOBAL_ORG_SENTINEL`（固定 UUID）+ 按哨兵过滤 + `_updated_at desc` 排序。
- **Feishu webhook 签名**：HMAC source 使用毫秒时间戳（协议要求秒字符串），配置 encrypt_key 时签名永远不匹配。
- **Feishu 事件处置接口无鉴权**：`/api/events/:id/handle` 等写端点全站无鉴权，任何人可改事件状态。
- **Feishu 数据丢失**：SQLite `:memory:` 进程退出数据全丢，与 30s 全量同步设计矛盾。
- **调度 run 卡死**：`handleTrigger` 失败时 run 永远停留在 queued；现置为 failed 并记录日志。

- **角色工作台生产化深化与真实数据闭环**（`deepen-roleworkbench-production`）：
  - **数据库级列表查询**：`RoleWorkbenchService.getWorkbenchList` 改为真实 PostgreSQL 查询
    （参数化 WHERE 含强制 `org_id` / ORDER BY / LIMIT），删除 `.limit(5000)` 全表内存读取；
    稳定排序键 cursor 分页（`(sort, uniqueId)` 处理重复时间戳/优先级，无重复无遗漏）；
    页码模式单独准确 COUNT；`workbench-list-query.ts` 提供 cursor 编解码与稳定排序协议。
  - **占位业务数据消除**：`overdueInspections`/`dispositions`/`maintenanceTasks`/
    `capacityDegradation`/`riskTrend` 等改为真实 SQL 聚合或明确 `value/status/calculatedAt/
    dataRange/source` availability 表达（`no_data`/`not_configured`/`permission_denied`/
    `source_unavailable`/`stale`），前端 `workbenchDataStates.ts` 区分「真实为零」与「无数据」。
  - **保存视图 PostgreSQL 持久化**：`saved_views` 表 + `standalone_005_workbench_prod.sql`，
    org+owner 隔离、默认视图唯一、软删除；`PostgresWorkbenchViewStore` 为生产存储，
    内存实现仅作 test adapter。
  - **导出任务真实任务系统**：`workbench_export_tasks` 表 + `workbench-export-state.ts`
    状态机（queued/running/succeeded/failed/cancelling/cancelled/expired）、原子 claim
    （双 worker 不重复）、幂等、重试/退避、到期；`PostgresWorkbenchExportStore` 生产存储；
    审计日志记录谁/范围/记录数/文件大小/完成时间。
  - **发布真值**：`scripts/truth-status.js` 统一四态（NOT_RUN/FAILED/BLOCKED_BY_ENVIRONMENT/
    SUCCEEDED），`BLOCKED_BY_ENVIRONMENT` 不计为 PASS；Production Ready 由当前 SHA 门禁
    自动计算；`truth-gate.js` 对 STALE/SHA 漂移 fail-closed；镜像未构建时扫描不入 PASS。
  - **大数据量性能验收**：`scripts/perf/seed-workbench-data.js` + `workbench-benchmark.js` +
    `perf-gate.js` 生成 10k/100k 确定性数据并记录 p50/p95/p99、DB 执行/扫描/返回行数；
    `perf.yml` 接入 CI，超预算即失败。
  - **生产运行时门禁**：`runtime-gates.yml` + `verify-migration-prod.mjs` /
    `verify-backup-restore.mjs` / `verify-helm-runtime.sh` / `canary-deploy.sh` /
    `soak-load.js` / `container-image-gate.sh`；环境不可用项如实标 `BLOCKED_BY_ENVIRONMENT`
    并给出可复制命令。
  - **前端性能深化**：`bundle-budget.mjs` 首屏/异步 chunk 预算（首屏 175.09kB gzip < 460kB
    PASS；单异步 chunk 243.57kB < 520kB PASS）；`browser-metrics.mjs` 记录真实 LCP/INP/CLS。
  - 验收报告：`docs/reviews/deepen-roleworkbench-production-report.md`。

- 代码深化与用户体验闭环验收（全量门禁证据采集）：
  - **语义化设计系统**：`client/src/lib/designTokens.ts` + `client/src/tokens.css` 集中
    semantic design tokens（背景/表面/边框/文本、success/warning/danger/info、
    normal/degraded/offline/blocked/conflict/unknown、spacing/radius/typography/
    elevation/motion/z-index）；深色/高对比/prefers-reduced-motion 适配；
    `scripts/lint-design-tokens.mjs` 静态检查阻断业务页面新增未经批准硬编码样式值。
  - **统一对象时间线**：`server/modules/timeline/*` 统一时间线 DTO（鉴权+组织隔离），
    `GET /api/timeline/events`；`client/src/lib/timelineModel.ts` 客户端只消费统一 DTO；
    OpenAPI 契约注册（TimelineSource/PermissionVisibility/TimelineCredibility/
    TimelineEvidenceRef/TimelineEvent）。
  - **首次使用与样例工厂闭环**：角色化 Quick Start、可清除样例工厂、五分钟闭环引导
    （可跳过/恢复/重开+版本记录）、统一空状态与无权限/无设备/无数据/断连/同步中/
    初始化失败路径、匿名化产品事件。
  - **性能预算**：`client/src/lib/perfBudget.ts` + `scripts/bundle-budget.mjs` 真实
    预算门禁（首屏 JS 174.72kB gzip < 460kB；单异步 chunk 319.60kB < 520kB）。
  - **跨浏览器弱网与视觉回归**：可移植弱网注入（登录后断连/提交断连/离线队列重放/
    重复提交/冲突 409/SW 更新/刷新/多标签并发）；`ux009-weaknetwork.spec.js`；
    Linux Chromium 主金基线 + 本地 darwin 自检基线。
  - **前端资源生命周期统一**：`client/src/lib/runtimeLifecycle.ts` 统一 session/runtime
    生命周期（BroadcastChannel/WS/SSE/SW listener/timer/retry/AbortController/
    IndexedDB/Blob URL/event listener），覆盖卸载/登出/Token 失效/租户切换/角色切换/
    后台/网络恢复/SW 升级。
  - **安全扫描固定 CI**：Bandit 锁定 1.8.6（`security.yml` 实际运行+JSON 报告+
    `bandit-gate.py` 阻断未豁免 HIGH）、Gitleaks 秘密扫描（基线豁免历史遗留）、Node 生产
    依赖审计、SBOM（CycloneDX）校验、镜像漏洞扫描（Trivy，BLOCKED_BY_ENVIRONMENT）、
    suppressions 文件（带原因/责任人/到期）。
  - **真实运行门禁**：`docs/runtime-gates.md` 记录 PG migration 往返/HTTP+PG E2E/并发/
    备份恢复/Docker 健康的 CI 自动化与 Helm/soak 等 BLOCKED + 一键命令。
  - **错误与恢复体验**：核心页面 12 态一致 + 统一错误组件 `AppErrorState.tsx`
    （现象/影响/是否已保存/可执行下一步/可复制 trace|request id）。
  - 验收报告：`docs/reviews/code-deepening-ux-closed-loop-report.md`（修改内容/风险/
    文件清单/测试清单/验证命令/性能对比/无障碍跨浏览器/BLOCKED/技术债务/五级结论）。
  - **单一事实源**：`scripts/truth-manifest.js` + `scripts/truth-source.js` 由 CI 运行时读取
    `GITHUB_SHA`/`git rev-parse HEAD`，从 Jest JSON 自动取测试计数并生成 evidence manifest
    （evaluatedCommitSha/branch/buildVersion/environmentFingerprint/dependencyVersions/
    testStartedAt/testFinishedAt/verifier/workflowRunId/artifactDigest/expiration）；
    `version.json` 为唯一版本源头；`make truth-check` 漂移校验；漂移夹具与回归测试。
    `output/evidence-manifest.json` 为运行时/CI 派生产物不入库（避免自指失效与跨环境漂移）。
  - **前端可观测性贯通**：后端 `frontend-metrics` ingestion API（契约/DTO/校验/限流/组织隔离），
    前端批量发送/采样/失败退避/sendBeacon/离线暂存重放，发送成功前不清空本地；采集
    LCP/CLS/INP/TTFB/路由/API 延迟/失败率/白屏/异常/离线指标；关联 requestId/traceId/组织/页面/
    构建版本/设备类别并脱敏；后端摄取测试。
  - **离线队列端到端幂等**：所有离线写操作发送 `idempotencyKey`，后端持久化幂等结果、重复提交
    副作用只执行一次、不同 payload 拒绝；附件/action 同 IndexedDB transaction 与孤儿清理；
    多标签页 leader election；401 暂停引导重认证；409/412 冲突展示差异；真实加密与密钥生命周期。
  - **Service Worker 重构**：区分 app shell/静态资源/HTML/API/用户文件/鉴权/敏感响应；API 与
    敏感内容默认不缓存；新版本提示、「安全更新/稍后更新」、更新前保存草稿、上一稳定 shell 回滚。
  - **上传安全贯通**：服务端 magic bytes/真实 content-type/路径穿越/压缩包炸弹校验接真实入口；
    隔离区扫描状态；S3 签名 URL 组织边界；断点续传/取消/进度/失败恢复/requestId。
  - **角色任务工作台深化**：默认角色来自认证用户；服务端 RBAC 判定、不信任前端 role；行点击跳转
    具体实体；服务端分页/筛选/排序/导出（异步+进度+权限+到期+审计）；保存视图服务端持久化；
    危险操作影响预览/幂等确认/撤销；键盘/扫码/触摸/单手/手套输入。
  - **真实业务 E2E 与工业 UX**：`test/browser/ux009-uxindustrial.spec.js` 覆盖角色流程、会话过期、
    多标签登出、权限拒绝、跨租户、陈旧/部分失败、弱网/抖动/上传中断、浏览器关闭恢复、200% 缩放、
    键盘焦点、屏幕阅读器、reduced motion、高对比、触控目标、长时间运行/内存/队列堆积；跨浏览器
    （chromium/firefox/webkit/mobile/industrial-tablet）真实运行，非 Chromium 弱网用可移植
    `page.route` 网络注入。
  - **性能与依赖可复现性**：`bundle-budget.mjs` 真实 bundle 分析（main chunk 176.94KB gzip < 460KB）；
    路由懒加载避免首屏重模块；`check-licenses.mjs` 许可证扫描（0 强 copyleft）；SBOM（CycloneDX）；
    移除未使用高危依赖（xlsx/jspdf/html2canvas/echarts）并升级 axios/form-data/postcss；
    无 `@latest`、Actions 固定版本、确定性构建（CI 两次构建字节一致）。
- F61-01 单一事实源语义一致性：7 个版本化 JSON Schema、14 条跨文件语义规则、
  13 类漂移夹具检测；`audit-repo-facts.js --strict` 任一未豁免冲突即非零退出。
- F61-02 领域状态持久化（Code Complete / Runtime Verification Blocked）：
  6 张领域表 `ewoh_resource_locks` / `ewoh_handoffs` / `ewoh_git_sync_state` /
  `ewoh_evidence_metadata` / `ewoh_factory_replication_sessions` /
  `ewoh_idempotency_keys` 迁移（`standalone_004_ewoh_domain.sql`）与可逆回滚脚本；
  乐观锁 `version` CAS 列用于资源锁（holder+version 校验），其余事实由唯一约束/
  幂等键保证多实例安全；时间戳命名与 Drizzle Schema 对齐。
- `DomainPersistenceService` 作为持久化事实源，替换进程内 Map 单例；六类领域事实
  读路径以数据库为准，旧 Map/数组/JSON 仅作缓存或灾备副本。
- 事务边界：获取锁+审计、交接+责任转移、接受交接+状态更新、git-sync+证据、
  复制步骤推进+输出证据、幂等键+业务对象创建均置于显式 `db.transaction`，中途
  失败无部分写入。
- 多实例正确性：DB 时间 `now()`、唯一约束竞争锁、版本 CAS、过期锁安全接管、
  非持有者拒绝续租/释放、并发冲突返回明确错误。
- 代码层测试：`domain-persistence.service.spec.ts` 29/29 通过；真实 HTTP +
  PostgreSQL E2E 代码完整且标记 `BLOCKED_BY_ENVIRONMENT`（不伪造、不静默跳过）。
- CI 环境验证入口：GitHub Actions `standalone.yml` 提供 PostgreSQL Service Container，
  应用/验证/回滚/重放迁移、双实例并发（`scripts/verify-domain-concurrency.js`）、
  真实 HTTP E2E，并保存证据 artifact `f61-02-ci-evidence-<sha>`。

### Notes
- **F61-02 最终状态：`F61-02 Code Complete / Runtime Verification Blocked`**。真实
  HTTP + PostgreSQL E2E 因本地无 PostgreSQL / docker 暂阻塞，运行时门禁已移至 CI
  （`EWOH_E2E_RUNTIME_DATABASE_URL`）。在真实 E2E 解锁通过前不宣称 Production /
  Scale Ready，不启动 F61-03。

## [0.6.0-rc4] - 2026-08-04

### Added
- 仓库事实源一致性门禁：`scripts/audit-repo-facts.js` 校验 README 导航、CHANGELOG、
  发布清单、Task Board、门禁、OpenAPI 路由清单、数据来源词汇与错误契约；
  已接入 `scripts/standalone-check.sh` 与 `test.yml`（30/30 通过）。
- 统一错误契约补全：错误响应增加 `errorCode`、`requestId`、`retryable`、
  `recommendedAction` 与 `details`，`requestId` 与 Tracing 的 `x-trace-id` 关联。
- 数据来源词汇扩展为 `real / controlled_test / simulated / replayed / stale /
  offline`，OpenAPI 枚举同步；新增可复用 `DataSourceBadge`，设备页接入。
- `RequestDatabaseContext.runInTransaction` 复用活动请求事务，避免 Scheduler
  在 HTTP 事务内再开根事务连接。
- 移动工作台：SOP 说明展示、暂停/恢复、异常上报（写 `resultJson.exception`）、
  质检（新 `POST /api/mobile/.../quality`）、离线提示与失败重试入口。
- 全局 `ValidationPipe`（`APP_PIPE`）注册到 Legacy 与 Standalone 两个启动路径，
  `class-validator` 错误映射为统一 `fieldErrors` 与 `VALIDATION_ERROR` 422 响应。
- 指挥地图实体详情：人员档案（组织/岗位/班组/技能/风险/外骨骼）与设备档案
  （电量/固件/协议/故障/温度/最近通信），并展示关联告警、最近事件与处置入口。
- 移动工作台离线待同步队列：离线操作进入 `localStorage` 队列并显示待同步数量，
  恢复联网后按顺序自动提交；队列工具与单元测试覆盖。
- 控制指令状态守卫：终态（executed/timeout）禁止再次发送或回执，同一指令存在
  in-flight 尝试时禁止重复发送，终态尝试禁止重复回执；失败后仍允许重试发送。
- Work Orchestration 交接状态机：open → accepted/rejected → closed，非法跳转
  拒绝；门禁决定重复提交幂等，变更前决定写入 `gate-decision-history.json`。
- Scale 幂等守卫：已 installed/uninstalled 的场景包重复安装/卸载直接返回；
  fleet upgrade/rollback 跳过已处于目标状态的 Profile；已 resolved 的工厂
  差异重复解决直接返回。
- 本地真实 PostgreSQL E2E：HTTP + PostgreSQL 29/29 通过（embedded PG 17，
  `127.0.0.1:55432`），覆盖鉴权/RBAC、组织隔离、MES/OEE/ERP、Scale、
  参数、AAS、Work Orchestration 与幂等场景。
- 移动异常照片附件：异常上报表单支持选择 JPG/PNG/WebP 照片，先经
  `/api/files` 上传并把文件引用写入 `resultJson.exception.attachments`。
- PWA 可安装基础：`manifest.webmanifest` + 最小 Service Worker + 客户端注册，
  Standalone 页面可安装到移动端/工业平板；repo-facts 增加 PWA 资产门禁。
- 离线照片队列：离线异常照片以 Data URL 存入待同步队列（约 2MB 上限），
  恢复联网后先上传 `/api/files`，再把文件引用写入异常附件后提交。
- 发布验证证据：`RELEASE DRILL PASSED`（PG apply/verify/RLS/audit/rollback/
  rebuild + 全门禁 + E2E 29/29）；性能冒烟 4610 QPS / p95 26.83ms；
  `STANDALONE SECURITY VERIFY OK`。
- 浏览器证据：Playwright 对 Standalone `/login` 在移动端（390x844）与桌面端
  （1440x900）截图，输出到 `output/playwright/iteration-login-*.png`。
- 请求关联：TracingInterceptor 通过 `AsyncLocalStorage` 把 `requestId` 传给
  审计写入路径，`AuditLogEntry.requestId` 自动填充；repo-facts 增加
  `request_context_correlation` 门禁。
- 错误脱敏：`HttpException` 不再把原始响应对象序列化进 `details`；
  Site Readiness 解析失败只返回通用错误码，不泄露底层异常文本。
- 设备页加载状态：失败时显示可重试错误状态，并展示最近更新时间，避免把
  加载失败误渲染为“未找到设备”。
- 静态安全扫描本地可执行：`python3 -m bandit -r src/edge_platform -ll`
  扫描 28286 行，0 medium/high。
- 指挥地图查询状态：空间实体/世界状态/总览/环境任一查询失败时显示错误横幅
  与“全部重试”，不再静默渲染为空地图。
- 版本同步：Helm appVersion、Compose/K8s 默认值、运行时默认版本与相关测试
  从 `0.6.0-rc3` 提升到 `0.6.0-rc4`。
- 认证浏览器测试：新增 `npm run test:browser`，用真实 PostgreSQL fixture 启动
  Standalone，Playwright 完成 dispatcher 登录、指挥中心、指挥地图、移动工作台
  和风险告警渲染（4/4），截图到
  `output/playwright/browser-authenticated-command-center.png`。
- CI 接入：`standalone.yml` 在 E2E 后安装 Playwright Chromium 并运行
  `npm run test:browser`，推送/PR 都会执行认证浏览器流程。
- 交付文档同步：`acceptance-evidence.md` 与 `release-checklist.md` 记录 RC4
  本地门禁、E2E、浏览器、性能、安全和发布包证据。
- README 更新为全栈产品导航：Python 边缘平台、Standalone 云产品命令、
  Playwright 浏览器门禁与 `0.6.0-rc4` 发布包校验。
- Pilot 就绪门禁重跑：本地 7 项通过（含数据库验证/运行库连接），3 项因
  本机无 Docker/Kubectl/Helm 失败，5 项等待外部批准与现场输入。
- 运维备份/恢复门禁重跑：`standalone-ops-check.sh` PASSED，57 表逻辑备份、
  恢复到一次性数据库、行数校验与身份序列推进全部通过。
- P0 移动工作台硬化：工作台按 `assigned_person_id` + `org_id` 过滤并
  fail-closed；扫码支持工单/工序/设备/物料/批次/工位/工厂类型识别；
  异常附件服务端持久化；离线队列增加
  `local/queued/syncing/synced/failed/conflict` 状态，单项失败不再阻塞后续项；
  `worker` 角色开放移动工作台。
- Work Graph 证据绑定与失效：证据 Markdown 支持 front matter
  （`commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/
  verifier/expiresAt`），解析器自动推导并输出
  `valid/stale/expired/unbound` 状态；`--invariants` 检查孤立边、循环依赖、
  重复 ID 与无 Owner 任务。
- 新增 `tools/work-console` 一键阻塞诊断 CLI：回答当前卡点、原因、解除人、
  缺失证据与受影响任务；接入 `standalone-check.sh` 与 CI。
- 修正 Task Graph 依赖引用为真实节点 ID，消除 19 条孤立边；重新生成
  `output/work-graph.json`、`output/gate-decisions.json`、
  `output/git-sync.json` 并新增 `output/work-console.json`。
- 独立审查修复：worker 只能操作 `assigned_person_id` 归属自己的工序；
  离线冲突项提供丢弃入口且不再自动重放；CI 使用
  `work-indexer --strict --invariants`；扫码空请求体返回 400 而非 500。
- Onboarding F0-F3 真执行：F0 校验场地就绪证据，F2 发布并核验连接器，
  F3 安装并核验场景包，均写审计。
- 映射 Dry Run：`POST /api/scale/mappings/:id/dry-run` 对样本载荷执行规则，
  返回 `REQUIRED_FIELD_MISSING`/`TRANSFORM_ERROR` 并定位源字段与目标字段。
- 真实数据库验证：HTTP+PostgreSQL E2E 29/29 通过，认证浏览器流程 4/4 通过。
- 世界回放统一时间轴：`/api/world/replay` 合并任务/工序/物料/质检/告警泳道，
  新增事件前后对比接口与从回放创建跟进问题的审计链路。
- E-SOP：`/api/mes/sops` 支持版本注册、发布与 Diff；工序可绑定 SOP、强制
  步骤、必需工具/物料；开工与报工前强制签收并记录签名。
- 质检方案：`/api/mes/quality-schemes` 支持首检/巡检/终检方案注册、发布与
  自动匹配；质检接口强制必检项并校验结果一致性。
- 慢查询观测：数据库事务支持 `statement_timeout` 与慢事务阈值记录，新增
  `GET /api/observability/slow-queries` 与 `ewoh_slow_queries_total` 指标。
- 前端性能：页面路由改为 `React.lazy` 分块加载，Standalone 主包从约 2.3MB
  降至约 374KB；世界状态与回放请求支持 `AbortSignal` 取消。
- MES 角色工作台：`GET /api/operations/role-workbench` 聚合操作员、班组长、
  质检、设备与管理者视图，新增 `/role-workbench` 页面。
- 渐进列表：新增 `progressiveSlice/hasMoreItems/nextProgressiveLimit`，
  角色工作台大列表先渲染 50 条并支持“加载更多”。
- Pilot Go/No-Go 重跑：7 通过 / 3 失败（本机无 Docker/Kubectl/Helm）/
  5 待批准，结果仍为 NOT READY。
- 事件中心新增“回放上下文”：展示事发前/事发时/处置后的快照摘要。
- 编排控制台新增受写回与人工批准保护的 `POST /api/work/git-sync/apply`。
- 最终全量门禁重跑：`ALL STANDALONE CHECKS PASSED`（真实 PG E2E 33/33、
  浏览器 5/5、server 81/391、client 15/50、OpenAPI 253/253）。

## [0.6.0-rc3] - 2026-08-04

### Added
- 采用 Final 6.0 权威基线：`authoritative-plan-final6.txt` 入库，
  决策 D-033 记录；新增 EWOH Work Orchestration Control Plane 产品主线。
- C7 Work Graph / C8 Asset Catalog / C9 Factory Profile 契约：
  `contracts/work/work-graph.schema.json`、`contracts/work/artifact-paths.json`、
  `contracts/catalog/asset-catalog.schema.json`、
  `contracts/factory/factory-profile.schema.json` 及示例与严格审计脚本。
- Work Graph 文件化索引器：`tools/work-indexer` 将 `.codex/artifacts` 解析为
  `ewoh:///work-graph/v1`，含路径注册表、校验和、冲突检测与严格 CLI。
- Gate Engine：`tools/gate-engine` 分离规则状态与人类决定，G10-G13 默认
  要求人工批准。
- 资源锁与交接服务：`tools/resource-registry`、`tools/handoff-service`，
  锁/交接记录以文件形式落盘并受 `EWOH_WORK_WRITABLE` 门禁。
- Work Orchestration API：`/api/work/*` 提供 overview/graph/items/evidence/
  agents/gates/risks/resources/handoffs/catalog 以及资源锁、交接和门禁决定
  写接口；`openapi/work-orchestration.yaml` 契约。
- GitHub Issue/PR 同步（离线优先）：`tools/git-sync/` 生成
  `ewoh:///git-sync/v1` 计划，`GET /api/work/git-sync` 与控制台 Git 同步页
  展示 issue/PR 关联缺口；真实创建必须人工批准并显式启用。
- 工厂复制验收：`tools/factory-replication/` 与
  `contracts/factory/replication-report.schema.json` 校验“无核心分支、Profile
  回放、配置/资产满足率≥80%、定制≤20%、差异已解决”的验收规则。
- 场地就绪检查：`tools/factory-replication/site-readiness.js` 与
  `contracts/factory/site-readiness.schema.json` 校验第二/第三工厂上线前
  的设备台账、ERP 端点、网络批准、培训计划和数据保留证据。
- 控制台体验深化：因果 DAG 支持缩放/平移、节点搜索、门禁状态筛选、
  证据类型/结果筛选；后端 `/api/work/items` 与 `/api/work/evidence` 支持
  `q/limit/offset`，资源锁按 `expiresAt` 自动过期释放。
- 证据内容预览：`GET /api/work/evidence/:id/content` 提供最多 500 行的
  证据文件摘要，前端证据抽屉内置行内预览。
- 门禁批量记录：`POST /api/work/gates/batch-decision` 一次写入多个门禁的
  人工决定；资源锁列表显示到期倒计时。
- 工厂场地就绪控制台：`GET /api/work/site-readiness` 扫描
  `catalog/factory-sites/*.json`，控制台新增“场地就绪”页签展示
  Go/No-Go 汇总。
- 交接状态流转：`POST /api/work/handoffs/:id/state` 支持接收/拒绝/关闭，
  状态写回 Markdown 记录，交接页提供对应操作按钮。
- 前端测试门禁：`client/jest.config.cjs` 与 `npm run test:client`，7 套件 /
  25 测试纳入 `standalone-check.sh`；审计链新增 100 条连续追加压力用例。
- 发布版本提升至 `0.6.0-rc3`：Helm appVersion、Compose/K8s/Standalone 环境
  默认版本同步更新；`release/ewoh-0.6.0-rc3` 包含 Final 6 工具、目录、
  制品与控制平面源码，1537 个文件并生成校验和。
- React 执行控制台：`/work-orchestration` 页面提供因果 DAG、门禁、证据抽屉、
  Agent、风险、资源锁、交接和 Final 6 资产目录视图。
- Final 6 资产目录：Order-to-Delivery、移动 E-SOP、质量追溯、库存协同四个
  场景包 Manifest，ERP 订单/库存连接器 Manifest，ERP→EWOH 订单/库存映射。
- 部署环境契约：`EWOH_WORK_ARTIFACTS_DIR`、`EWOH_WORK_TOOLS_DIR`、
  `EWOH_WORK_WRITABLE` 贯通 Standalone、Compose、Kubernetes 与 Helm；
  Docker 运行时镜像携带 `catalog/`、`tools/` 与 `.codex/artifacts/`。
- 验证证据：`round69-final6-work-orchestration.md`；Jest 74 套件 / 331 测试，
  前端 7 套件 / 27 测试，E2E 29/29，OpenAPI 231/231，Work Graph 202 节点 / 0 冲突，
  Python unittest 667 / pytest 120 / ruff 通过，release-drill 全通过，
  PostgreSQL 17 DDL/RLS/审计/回滚/重建全通过，本地门禁扫描全通过，
  性能冒烟 1368 QPS / p95 74.80ms，备份恢复 57 表通过，
  Release Review 34/34。

## [0.6.0-rc2] - 2026-08-03

### Added
- 真机接入协议对齐：`UnifiedExoFrame.to_storage_dict()` 标准格式（`entity_id`
  与嵌套 `pose`/`load`/`device`/`quality`）全量映射到 Ingestion 网关。
- 机器对机器租户上下文：`X-Org-Id` 或 `EWOH_INGEST_ORG_ID` 建立请求级
  `app.current_org_id` GUC，Ingestion 落库遵循 RLS 组织隔离。
- 游戏化资源分配真实持久化 E2E：`ewoh_schedule_plan` 与
  `ewoh_schedule_audit` 均验证 org 归属。
- 新增 IngestService/IngestGuard/GamificationService 单元测试与
  edge bridge 契约测试。
- PostgreSQL 逻辑备份/恢复工具：`scripts/postgres-logical-backup.mjs`，
  支持全部 `ewoh_*` 表导出、恢复、行数比对与身份序列回填。
- 一键恢复演练：`scripts/standalone-ops-check.sh`，覆盖建库、Schema、
  逻辑备份、恢复、行数校验与恢复后写入冒烟。
- 运维手册补全：告警分级与处置 SOP、故障注入、恢复演练、应急停止、
  自动运维检查均从占位升级为可执行流程。
- 培训计划升级为可执行版本 v1.1：四类 Session、角色化练习、真机接入、
  运维恢复练习与讲师复核要求。
- Prometheus 指标端点 `GET /metrics`：HTTP 请求计数、活跃请求、进程运行
  时间、数据库就绪检查计数。
- 部署工件本地校验：`scripts/verify-deploy-artifacts.js` 检查 Kubernetes、
  docker-compose 与 Dockerfile，共 62 项检查。
- 采用 Final 4.0 权威基线：`authoritative-plan-final4.txt` 与
  `delivery/01_开发基线/...最新研究升级版_Final4.0.docx` 入库，Final 3.0 保留
  为历史基线。
- MES P0 生产执行闭环：工单创建/释放/开工/完工、工序
  开工/报工/审核/交收、投料消耗、质量检验与审计，映射到既有
  `ewoh_schedule_task` / `ewoh_schedule_task_step` / `ewoh_resource_binding` /
  `ewoh_event`，48 张受管表包装不变。
- OEE/安灯闭环：设备状态时序、OEE 计算与停机原因分布、安灯状态机、
  SLA 升级通知与审计，复用 `ewoh_event` / `ewoh_notification`。
- ERP 连接器：入站订单幂等并自动生成工单、出站消息队列与确认/失败状态、
  对账汇总，复用 `ewoh_event` / `ewoh_schedule_task` /
  `ewoh_schedule_task_step`。
- 质量追溯图：工单→工序→投料→质量检验的节点与关系图。
- 移动工作台 API：按人员列出待办工序、扫码查工单、移动端工序状态流转。
- 移动工作台前端页面：扫码查单、待办工序列表、开工/报工/审核/交收操作。
- 采用 Final 5.0 规模化复制版权威基线：
  `authoritative-plan-final5.txt` 与 `delivery/01_开发基线/...Final5.0.docx`
  入库，Final 4.0 保留为历史基线。
- 规模化内核：工厂模板注册/继承/生命周期、模板安装生成工厂 Profile、
  资产包注册；新增 `ewoh_factory_template` / `ewoh_factory_profile` /
  `ewoh_asset_package`，受管表 48 → 57。
- 连接器/场景包目录：连接器（runtime/protocol/configSchema）与场景包
  （requires/workflows/policies）复用资产包注册；同一模板可安装多个工厂
  Profile，验证“第二工厂无分叉”。
- 资产一致性检查（TCK）：按连接器/场景包/模板/部署类型校验 Manifest。
- 工厂 Profile 回放：模板配置与 Profile 覆盖值合并，状态置为
  `replayed` 并写审计。
- 场景包安装门禁：安装前必须通过场景 TCK，失败返回 400 并保留审计。
- 舰队升级/回滚：`POST /api/scale/fleet/upgrade` /
  `/api/scale/fleet/rollback` 对组织可见 Factory Profile 批量变更状态并写审计。
- AsyncAPI/CloudEvents 事件目录：`contracts/events/event-catalog.yaml` 定义
  13 个事件类型与 13 条通道，`GET /api/events/catalog` 与
  `GET /api/events/catalog/:type` 提供只读 API，独立契约审计接入
  `standalone-check.sh`。
- Docker 运行时镜像携带 `/app/contracts`，事件目录在生产容器内可读。
- Helm 部署工厂：新增 `deploy/cloud/helm/ewoh` Chart，包含 Factory Values
  （工厂 ID/名称/升级环）、迁移 Job Hook、Deployment/Service/Ingress/HPA/PDB/
  本地 PVC 模板；Chart 不从 values 生成密钥。
- Helm 静态审计：`scripts/verify-helm-chart.js` 校验 Chart 元数据、values
  路径、模板清单与全部 `.Values.*` 引用；`npm run verify:helm` 与
  `test/contract/helm-chart.spec.ts` 纳入常规测试。
- Golden Factory Profile：`contracts/factory/golden-factory.yaml` 定义 7 个
  模块、3 个必需连接器与 4 个场景包；`POST /api/scale/golden-factory/install`
  一次完成模板发布、连接器发布、场景包 TCK 安装与工厂 Profile 安装/复用。
- Golden Factory 契约审计：`scripts/audit-golden-factory.js`（47 项检查）、
  `npm run contract:golden` 与 `test/contract/golden-factory.spec.ts`。
- Mapping DSL 与 Schema Registry：`contracts/mapping/mapping-schema.json`
  定义 `mappingId/name/version/source/target/rules` 契约，并提供
  `exoskeleton-telemetry-v1` 规范示例。
- Mapping 资产 API：`POST/GET /api/scale/mappings` 与
  `GET /api/scale/mappings/:id` 复用资产包注册表；TCK 增加 mapping 一致性
  检查（source/target/rules/schemaVersion）。
- Mapping 契约审计：`scripts/audit-mapping-contracts.js`（10 项检查）、
  `npm run contract:mapping` 与 `test/contract/mapping.spec.ts`。
- 升级环与 Fleet Ops：`fleet/upgrade` 与 `fleet/rollback` 支持按
  `dev/integration/shadow/pilot/small/full` 升级环分批执行，未指定环时保持
  全量操作兼容。
- Fleet 状态注册表：`GET /api/scale/fleet/status` 返回工厂 Profile 的环、
  状态、模板/资产包计数与环/状态分布。
- Support Bundle：`POST /api/scale/fleet/support-bundle` 生成脱敏诊断包
  （`includesSecrets: false`）并写审计。
- 舰队状态机契约：`contracts/state-machines/fleet.yaml` 冻结升级环与
  installed/replayed/upgraded/rolled_back 迁移关系。
- OTel 资源属性：`/metrics` 输出 `ewoh_resource_info`，携带工厂 ID、名称、
  升级环、发布版本与区域；环境契约贯通 Standalone、Compose、Kubernetes 与
  Helm。
- 部署工件校验升级到 66 项，覆盖 Compose 资源属性环境契约；Helm Chart
  静态审计 125 项。
- 兼容目录：`GET /api/scale/compatibility` 返回资产包与核心版本兼容矩阵，
  支持 `>=/<=/>/</=` 与空格 AND 范围；未声明范围的资产标记
  `unconstrained` 兼容。
- 策略引擎：`contracts/policy/policy-schema.json` 定义策略契约；
  `POST /api/policies/evaluate` 按 dot-path 规则求值，`GET /api/policies/examples`
  提供规范示例；`scripts/audit-policy-contracts.js` 纳入一键检查。
- 模板配置差异预览：`POST /api/scale/templates/:id/diff-preview` 只读合并
  模板默认配置与请求覆盖配置，返回 `added/changed/removed` 键差异，便于
  第二工厂安装前评估影响。
- 连接器运行时：`src/edge_platform/connectors/runtime.py` 提供 Manifest
  加载/校验、配置校验、健康检查、密钥脱敏与生命周期；新增
  `exoskeleton-frame` 与 `equipment-state` 样例连接器包。
- 工厂上线：`GET /api/scale/onboarding/checklist` 提供 F0-F6 步骤清单，
  `POST /api/scale/onboarding/run` 真实执行模板发布、连接器/场景包安装、
  Profile 安装、TCK 与 Support Bundle，并输出步骤级证据与审计。
- Scale Release 评审：`scripts/scale-release-review.js` 作为打包门禁，检查
  发布清单、包完整性、契约/文档/OpenAPI 与全部静态审计；已接入
  `scripts/package-release.sh` 与 `npm run release:review`。
- Workflow 引擎骨架：`contracts/workflow/workflow-schema.json` 定义
  角色化步骤流转；`POST /api/workflows/advance` 返回当前动作许可与
  角色过滤后的下一步；`mes-execution` 规范流程示例纳入契约审计。
- Feature Flag：`GET/PUT /api/system/feature-flags` 在
  `ewoh_system_config` 持久化组织级 `feature.*` 开关，写入限定
  `global_admin`，读取按 RLS 组织隔离。
- 边缘乱序/补传：`src/edge_platform/edge/backfill.py` 提供 `SequenceBuffer`，
  按序列号连续释放帧并拒绝重复/过期/超窗帧；补传后自动续传。
- 数字孪生资产包：`src/edge_platform/twin/package.py` 提供 Twin Manifest
  校验、标定健康检查与脱敏；新增离散机加工线/装配单元样例资产包。
- 伙伴影子交付：`GET /api/scale/onboarding/partner/checklist` 与
  `POST /api/scale/onboarding/partner/shadow-run` 复用真实 F0-F6 上线路径，
  配置标记 `partnerShadow` 并输出步骤级证据。
- Deployment TCK：`scripts/deployment-tck.js` 将部署工件（66项）、Helm Chart
  （125项）与 Scale Release 评审（24项）串成统一部署验收门禁；
  `npm run deployment:tck` 一键执行。
- 规模化运营前端：新增 `/scale` 页面，展示模板/Profile/资产/兼容目录，
  并支持从页面执行 F0-F6 工厂上线运行。
- ERP/MES 连接器 Profile：新增 `erp-mes-profile-1.0.0` Manifest，配置使用
  `secretName` 引用而非内嵌凭证，并纳入 Connector Runtime 测试集。
- 规模化指标：`GET /api/scale/metrics` 输出模板/Profile/资产/场景/连接器/
  映射计数、发布率、升级环分布与兼容性汇总。
- 场景包卸载：`POST /api/scale/scenario-packs/:id/uninstall` 将场景包置为
  `uninstalled` 并写审计，补齐安装/演示/验收/移除生命周期。
- 连接器 TCK：`scripts/connector-tck.py` 与 `make connector-tck` 执行 11 项
  Manifest/配置/健康/脱敏/乱序补传检查。
- 场景包 TCK：`scripts/scenario-tck.js` 与 `npm run scenario:tck` 将
  Golden Factory/策略/Workflow/Mapping/事件目录 5 个审计串成场景验收门禁。
- 第三工厂演练：E2E 从同一已发布模板仅凭配置安装第三个工厂 Profile，
  验证无代码分叉、配置持久化与组织隔离。
- 工厂差异回收：`POST/GET /api/scale/differences` 将工厂差异登记为
  `diff.*` 配置项并写审计，支持后续平台化回收。
- 差异解决：`POST /api/scale/differences/:key/resolve` 将已回收差异标记为
  `resolved` 并写审计。
- 跨租户 TCK：`scripts/cross-tenant-tck.sh`、`make cross-tenant-tck` 与
  `npm run cross-tenant:tck` 把 HTTP+PostgreSQL 组织隔离 E2E 串成门禁。
- 工厂差异界面：`/scale` 页面新增差异登记表单、状态徽标与逐行解决操作，
  接入真实差异 API。
- Workflow 实例：`POST/GET /api/workflows/instances` 与
  `POST /api/workflows/instances/:key/advance` 将实例持久化到
  `workflow.*` 配置键，角色门禁推进并写审计。
- Support Bundle 界面：`/scale` 页面一键生成脱敏诊断包并展示
  bundleId/工厂数/敏感信息状态。
- Fleet 升级环界面：`/scale` 页面展示环分布，并支持按环升级/回滚操作。
- Workflow 实例界面：`/scale` 页面支持启动、列表与角色推进 Workflow 实例。
- 场景包界面：`/scale` 资产表支持场景包安装/卸载操作。
- 运营能力包：新增 `/api/operations/*`（17 条路由）覆盖维保资产/任务/工装
  生命周期、工作中心能力开关、标准工时与人员效率，记录复用
  `ewoh_scheduler_config` 并保持 RLS 组织隔离与审计链。
- 维保闭环：资产 `active/maintenance_required/decommissioned`、任务
  `planned/in_progress/completed/cancelled`，任务完成自动刷新资产下次维保
  日期并记录结果/备件/历史。
- 工装校验：校准周期、上次/下次校准时间与校准历史，支持校准/报废操作。
- 工作中心配置：首检、投料、报工审核、交收、扫码、外骨骼、风险确认与
  工装点检八类功能开关按工作中心持久化。
- 标准工时与人员效率：按工作中心/工序登记标准分钟，实际报工自动计算
  偏差、效率与人员公平性标准差。
- 运营管理前端：新增 `/operations` 页面，包含总览、维保资产、维保任务、
  工装校验、工作中心、标准工时与人员效率七个视图并接入真实 API。
- Sparkplug B 连接器：`src/edge_platform/connectors/sparkplug.py` 提供
  `spBv1.0` 主题解析、纯标准库 protobuf 载荷解码、出生/死亡/会话/序号状态
  与统一遥测帧适配器；新增 `sparkplug-b-1.0.0` Manifest 并纳入连接器 TCK。
- 连接器 TCK 升级：`scripts/connector-tck.py` 由 11 项扩展到 17 项，覆盖
  Sparkplug 主题、载荷、规范帧与会话状态检查。
- OpenFeature 语义功能开关：`POST /api/system/feature-flags/evaluate` 支持
  按组织/工厂/升级环/角色进行定位评估，默认安全关闭并返回
  `reason/variant/targetingApplied` 评估原因。
- 系统管理页新增功能开关评估器：输入开关键、升级环、工厂 ID 与角色即可
  查看当前上下文下的开启状态与评估原因。
- 参数注册中心：新增 `/api/parameters/*`（8 条路由）支持
  `number/integer/string/boolean/json` 类型参数、范围/来源/有效期、
  数值/枚举/正则校验、审批门禁、版本历史与回滚，记录复用
  `ewoh_scheduler_config` 并保持 RLS 组织隔离与审计链。
- 系统管理页新增参数注册中心 UI：登记表单、行内更新、
  审批/回滚/停用操作与汇总统计均接入真实 API。
- AAS/IEC 63278 资产壳：新增 `src/edge_platform/aas/codec.py`，纯标准库实现
  AAS 3.0 JSON 子集解析/导出、AASX 类似 OPC 包导入导出、孪生子模型双向映射
  与敏感值脱敏；提供离散机加工线 AAS 示例。
- AAS TCK：`scripts/aas-tck.py` 与 `make aas-tck` 执行 7 项检查，覆盖
  样例解析、JSON 往返、孪生映射、AASX 往返与脱敏。
- OPA 风格策略即代码：新增 `src/edge_platform/policy/rego.py`，纯标准库实现
  Rego 子集解释器（package/default/allow/deny[msg]、input 路径、比较、
  `in`/`not` 与消息捕获），并新增 `contracts/policy/deploy-gate.rego`
  部署门禁策略。
- Rego 部署门禁接入：`make rego-tck`（4 项检查）、`scripts/deployment-tck.js`
  扩展为 4 道门禁，`scripts/standalone-check.sh` 纳入 Rego TCK。
- AAS 资产注册 API：新增 `/api/aas/assets`（4 条路由）支持 AAS 资产导入、
  列表、详情与孪生语义映射，记录复用 `ewoh_scheduler_config` 并保持
  RLS 组织隔离与审计链。
- 数据资产页新增 AAS 资产壳视图：JSON 导入表单、资产清单与语义映射查看器
  均接入真实 API。
- OPC UA 连接器：`src/edge_platform/connectors/opcua.py` 提供节点 ID 解析、
  数据点规范化、质量码映射与边缘适配器；新增 `opcua-generic-1.0.0`
  Manifest 并纳入连接器 TCK（21 项检查）。
- Modbus TCP 连接器：`src/edge_platform/connectors/modbus.py` 提供寄存器
  地址/功能码/缩放校验、规范化遥测帧与边缘适配器；新增
  `modbus-tcp-generic-1.0.0` Manifest 并纳入连接器 TCK（25 项检查）。
- HTTP/Webhook 连接器：`src/edge_platform/connectors/webhook.py` 提供载荷
  规范化、常量时间 HMAC 签名校验与边缘适配器；新增
  `http-webhook-generic-1.0.0` Manifest 并纳入连接器 TCK（29 项检查）。
- CSV/File 连接器：`src/edge_platform/connectors/csvfile.py` 提供表头映射、
  行数据规范化与批量入队适配器；新增 `csv-file-generic-1.0.0` Manifest
  并纳入连接器 TCK（32 项检查）。
- OTel 风格请求追踪：`TracingInterceptor` 为每个 HTTP 请求生成
  `traceId/spanId` 并返回 `x-trace-id` 响应头；`TracingService` 维护有界
  追踪缓冲，`GET /api/observability/traces` 提供只读查询。
- Support Bundle 追踪：`POST /api/scale/fleet/support-bundle` 携带最近 20 条
  脱敏请求追踪与 `traceCount`，诊断包可直接用于伙伴/支持排查。
- 系统管理页新增请求追踪视图：展示最近 50 条 trace 的方法、路径、状态、
  耗时、开始时间与错误信息，并按运营刷新周期自动更新。
- RC2 发布包重新构建：`scripts/package-release.sh` 重新生成
  `release/ewoh-0.6.0-rc2`（1315 文件）与 `SHA256SUMS.txt`，Scale Release
  Review 24/24 通过。
- 最终门禁扫描：逻辑备份/恢复、场景 TCK、部署 TCK、AAS TCK、Rego TCK、
  连接器 TCK 与跨租户 E2E 全部通过，作为本轮交付证据。
- Pilot 就绪检查：`scripts/pilot-readiness-check.sh` 与 `make pilot-readiness`
  提供可执行 Go/No-Go 门禁，明确列出容器工具、数据库、试点工厂、生产批准、
  培训、验收签署与真机配置等未决阻塞项。
- RC2 发布包再次更新：将 Pilot 就绪门禁与最新证据纳入
  `release/ewoh-0.6.0-rc2`（1316 文件），校验和重新生成。

### Changed
- `ewoh_telemetry.assist_level` 由 `varchar(50)` 改为 `real`，与规范数值口径一致。
- 边缘桥接脚本与建模采集脚本支持 `--org-id` 并透传 `X-Org-Id`。
- 组织层级解析改为 `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` 函数，鉴权阶段不再回退到主组织。

### Fixed
- 真机帧因扁平字段不匹配而 400 的问题。
- 公共 Ingestion 端点缺少租户上下文导致 RLS 写入失败的问题。
- 安全探针固定夹具 UUID 与种子组织冲突，清理时误删“集团A”等种子行的问题；
  探针夹具已改为随机 UUID。

### Security
- Ingestion 缺少 `X-Org-Id` 且未配置 `EWOH_INGEST_ORG_ID` 时拒绝请求。
- OpenAPI 为全部 7 条 Ingestion 路由增加 `X-Org-Id` 必填参数契约。
- 运行时角色通过 `SECURITY DEFINER` 查询组织层级，业务表 RLS 不被绕过。

## [0.6.0-rc1] - 2026-08-03

### Added
- 六类共享契约冻结：C1 数据、C2 API（106 条路由全量 OpenAPI）、C3 状态机、
  C4 安全、C5 UI、C6 DevOps，G2 门禁通过。
- 真实 HTTP + PostgreSQL E2E：11 条用例覆盖认证、RBAC、刷新令牌轮换/撤销、
  组织 A/B 隔离、控制/世界/审批持久化与系统配置组织隔离。
- 审批持久化：审批实例/步骤/操作映射到 `ewoh_event`、`ewoh_event_chain`、
  `ewoh_audit_log`，不新增物理表。
- 浏览器级 UI 回归：Playwright 覆盖登录、指挥中心、指挥地图、设备、告警。
- 发布准备：`scripts/standalone-check.sh` 一键检查、性能冒烟、
  `docs/delivery/release-manifest.yaml`。

### Changed
- RolesGuard 默认拒绝未声明角色的业务路由；refresh token 轮换与登出撤销。
- 系统配置唯一索引调整为 `(org_id, config_key)`；模拟器后台写库纳入 GUC 事务。
- 指挥地图回放改为真实快照投影；3D 模式按 mode 着色并支持 WebGL 降级。

### Fixed
- `QueryClientProvider` 缺失导致指挥地图/设备页白屏。
- `/api/world/replay` 时间参数序列化导致 500。
- 数据库 verify SQL 的 `policy_missing` 标量子查询缺陷。

### Security
- 刷新令牌不再可无限重放；登出会撤销服务端会话。
- 审计接口限制为安全/全局管理员；客户端登出同步调用服务端撤销。
- Python 静态安全扫描归零：bandit `-ll` 0 medium/high，ruff 0 错误。
- GitHub Actions 三工作流全绿：standalone/test/security，含 Docker 镜像构建。

## [Unreleased]

本次版本将现有单机演示原型升级为受控试点系统（spec 阶段 0 Task 2：建立工程基线）。

### Added
- 工程基线：新增 `pyproject.toml`、`requirements-dev.txt`、`.env.example`、`Makefile`，
  声明纯标准库零运行时依赖，统一 unittest 测试发现与 ruff/bandit 静态检查入口。
- 适配器标准化：定义统一适配层契约（`edge/protocol`、`edge/adapter`），支持
  `real` / `controlled_test` / `simulated` 三类数据源的可配置端口映射
  （`EWOH_ADAPTER_PORTS`），为真机接入与受控测试提供一致接口。
- 生产数据库：引入 `postgres` 作为可选生产后端（`EWOH_DB_BACKEND=postgres`），
  保留 SQLite 用于开发/单机；DB 仅接入内部网络，不直接对普通用户网开放。
- API 完善：补齐 OpenAPI 3.0 规范（`docs/api/openapi.yaml`），覆盖
  auth/me/devices/telemetry/events/tasks/query/audit/models/rules/scenario/reset 全部端点。
- 身份权限：引入认证后端选择（customer/oidc/local）、JWT 会话、角色化导出权限
  （`EWOH_EXPORT_ALLOWED_ROLES`）、登录失败锁定与会话超时。
- 审计：所有写操作与导出动作落入审计日志，可在 `GET /api/audit` 查询。
- 监控：定义系统/设备/推理/业务四级监控指标与告警处理流程（见 `docs/operations/`）。
- 备份恢复：定义数据库与证据数据的备份策略、保留窗口与恢复流程占位。
- 测试与故障注入：定义 13 层测试层级与 16 类故障注入清单（见 `docs/acceptance/`）。
- 现场试点分阶段：定义四区部署拓扑（`docs/deployment/`）与分阶段上线策略。
- Go/No-Go 门禁：定义 15 条上线门禁清单作为试点放行依据。
- CI/CD：新增 GitHub Actions（test/security/package）与 CODEOWNERS 安全边界审查。
- 安全策略：新增 `SECURITY.md`，明确平台安全边界声明与漏洞报告流程。
- 服务编排：新增 `docker-compose.yml`，定义 edge-gateway / ewoh-api / ewoh-adapter /
  ewoh-inference / postgres / redis / ewoh-logs 服务与内外网络隔离。

### Changed
- 项目版本由演示原型基线提升至 `0.6.0`，描述更新为「EWOH 受控试点系统」。
- 运行入口 `python -m edge_platform.run` 保持不变，新增 `--stub` 显式回退开关的工程化说明。

### Security
- 明确平台不得写入急停 / 限扭 / 关节实时控制 / 助力实时闭环 / 限速放宽 /
  异常退出保护 / 设备失联安全态 / 绕过本地安全检查的调试指令，这些保留在设备控制器。
- 默认不采集姓名 / 身份证 / 长期精确轨迹 / 视频 / 生理数据。
- 高频原始遥测保留 7-30 天，超期降采样或清除。
- 默认不开放公网，TLS 由 edge-gateway 终结。
