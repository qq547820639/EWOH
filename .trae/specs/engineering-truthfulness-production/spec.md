# 工程真实性收口与生产用户体验深化 — Product Requirement Document

## Overview
- **Summary**: 对 EWOH（工厂具身智能操作系统，`0.6.0-rc4`）开展新一轮"工程真实性收口与生产用户体验深化"。核心是从"演示性模块 + 手工维护的通过声明"转向"真实可复现的 Code Verified + 单一事实源 + 生产链路贯通"。本轮不新增演示功能，而是解决当前 HEAD 上真实存在的状态漂移、未贯穿运行时的能力、以及仍需刷新的工业现场/离线/可观测/上传体验。
- **Purpose**: 消除仓库状态漂移（代码/文档/任务/检查表/发布材料/CI 之间 HEAD SHA、测试数量、版本不一致），让门禁结果可复现、可机器验证，并把已存在但未接入运行时的能力（前端可观测性、离线幂等、上传安全、角色权限、数据可信度）真正接入生产链路。
- **Target Users**: 开发者、SRE、QA、试点工厂操作员/班组长/质检/设备/管理者用户。

## Goals
- **G1**: 当前 main HEAD 达到可复现的 Code Verified（干净 checkout 全绿、无静默 skip、无伪造通过）。
- **G2**: 建立单一事实源体系，消除仓库全部状态/版本/测试数量/HEAD 漂移；禁止在受 Git 管理的文档里手写 HEAD SHA 与测试数字。
- **G3**: 贯通前端可观测性——前端指标真实进入后端摄取 API 与可查询诊断页。
- **G4**: 强化离线队列端到端幂等——idempotencyKey 真正发送到后端并持久化，副作用只执行一次。
- **G5**: 重构 Service Worker 缓存/更新策略——不缓存敏感 API，安全更新与回滚。
- **G6**: 贯通上传安全链路——upload guard 从测试文件接入真实前后端。
- **G7**: 深化角色任务工作台——权限由服务端决定，行为级测试覆盖真实业务流程。
- **G8**: 扩大真实业务 E2E 与工业 UX 矩阵——多浏览器/多视口/弱网/离线/无障碍/低性能。
- **G9**: 性能与依赖可复现性——bundle 拆分、固定版本、SBOM、供应链检查、确定性构建。

## Non-Goals (Out of Scope)
- 不增加平台下发急停、限扭、关节控制、实时助力闭环等设备安全控制能力（保持只读监督定位）。
- 不把模拟/回放/陈旧/离线缓存数据展示为真实实时数据。
- 不破坏现有 PostgreSQL RLS、组织隔离、RBAC、审计链、状态机、幂等和事务边界。
- 不进行无必要的全量重写；优先复用既有组件、契约、状态模型、测试设施。
- 不通过删除测试、放宽断言、增加静默 skip 或关闭安全规则获得绿色结果。
- 不宣称 Production Ready 或 Pilot Ready（除非外部批准与真实环境证据齐备）。

## Background & Context
- 上一轮 `production-ux-deepening`（commit `5ddacdd`）已落地前端状态系统、离线队列、PWA、可观测性 lib、Playwright 6 工程矩阵、OpenAPI 生成器等。
- 但审计发现多处"存在但未贯通"：`observability.server` 无前端摄取、`uploadGuard` 仅存在于测试文件、`offlineQueue` 未发送 `idempotencyKey`、无队列 leader election、`audit-repo-facts.js` 硬编码 `TEST_COUNT_DRIFT`/`version`/HEAD。
- 环境限制：本机无 PG/Docker/kubectl/helm；`gh` 与 `pytest` PATH 缺（`python3 -m pytest` 可用）；非 Chromium 弱网依赖 CDP（Chromium-only）。这些是 BLOCKED_BY_ENVIRONMENT 项，需给出 CI 入口与复现命令。

## Functional Requirements

### Part 1 — 只读审计（审计先行）
- **FR-A1**: 输出当前 branch、完整 HEAD SHA、提交时间、各工具版本、GitHub Actions 状态、未提交文件、失败门禁及完整错误、文档/材料之间的状态冲突清单、本轮修改前测试与构建基线。
- **FR-A2**: 在审计完成前不得批量修改文件。

### Part 2 — 单一事实源（Truth Source）重构
- **FR-T1**: 由 CI 运行时读取 `GITHUB_SHA` / `git rev-parse HEAD`，生成结构化 evidence manifest（`evaluatedCommitSha`、`branch`、`buildVersion`、`environmentFingerprint`、`dependencyVersions`、`testStartedAt`、`testFinishedAt`、`verifier`、`workflowRunId`、`artifactDigest`、`expiration policy`）。
- **FR-T2**: 测试数量从 Jest JSON、Playwright JSON、pytest JUnit、OpenAPI 审计输出自动获取，禁止手写。
- **FR-T3**: 版本只允许一个规范事实源，其他文件由脚本生成或校验。
- **FR-T4**: phase-state、gates、release manifest、README 状态摘要由结构化事实生成。
- **FR-T5**: tasks 与 checklist 用同一份数据生成，禁止一份全勾选、一份全未勾选。
- **FR-T6**: 移除 `audit-repo-facts.js` 中写死的版本、测试套件数和测试用例数。
- **FR-T7**: 避免"提交文件中的 HEAD SHA 因本次提交本身而立即失效"的自指设计。
- **FR-T8**: CI artifact 保存不可变证据；仓库只保存规范、生成器和最近一次已发布版本签名摘要。
- **FR-T9**: 为上述机制补充漂移夹具与回归测试。

### Part 3 — 前端可观测性贯通
- **FR-O1**: 后端 frontend metrics ingestion API（OpenAPI 契约、DTO、校验、限流、组织隔离）。
- **FR-O2**: 指标批量发送、采样、失败退避、页面隐藏时 `sendBeacon`、离线暂存与重放；发送成功前不清空本地指标。
- **FR-O3**: 采集 LCP、CLS、INP、TTFB、路由耗时、API 延迟、API 失败率、白屏、未处理异常、离线同步耗时、冲突率。
- **FR-O4**: 关联 requestId、traceId、用户组织、页面、构建版本、设备类别。
- **FR-O5**: 对 URL、错误消息、用户输入、令牌、个人信息脱敏。
- **FR-O6**: OpenTelemetry 或等价 exporter。
- **FR-O7**: 可查询的运维诊断页（按 requestId/用户/组织/页面/时间）。
- **FR-O8**: Dashboard、SLO、告警阈值和 runbook。
- **FR-O9**: 单元/集成/浏览器/后端摄取测试。禁止默认静默丢弃全部指标。

### Part 4 — 离线队列端到端幂等
- **FR-Q1**: 所有离线写操作将 `idempotencyKey` 真正发送到后端。
- **FR-Q2**: 后端持久化幂等结果，重复提交返回第一次结果，不重复执行副作用。
- **FR-Q3**: 同一幂等键对应不同 payload 时明确拒绝。
- **FR-Q4**: 附件与 pending action 在同一 IndexedDB transaction 写入。
- **FR-Q5**: 删除/完成/冲突处理时清理孤儿附件。
- **FR-Q6**: 多标签页 leader election / lease，避免并发 flush。
- **FR-Q7**: 同一工单/步骤/实体的依赖顺序；不同实体之间允许受控并发。
- **FR-Q8**: 指数退避、抖动、最大重试次数、Retry-After 支持。
- **FR-Q9**: 401 时暂停队列并引导重新认证，认证恢复后继续。
- **FR-Q10**: 409/412 冲突展示本地值、服务端值、字段差异、时间、操作者。
- **FR-Q11**: 数据库损坏/升级失败/容量不足时提供导出、清理、恢复入口。
- **FR-Q12**: 敏感离线数据与照片真实加密（密钥生成、轮换、登出销毁、设备丢失策略）。
- **FR-Q13**: 迁移完成后安全清理遗留 localStorage 数据。
- **FR-Q14**: 端到端测试覆盖关闭页面/崩溃/重启/升级/断网/抖动/重复点击/附件中断/多标签页；验证副作用只执行一次。

### Part 5 — Service Worker 与更新体验
- **FR-SW1**: 区分 app shell、hash 静态资源、HTML、API、用户文件、鉴权响应、敏感响应。
- **FR-SW2**: API 与敏感内容默认不缓存。
- **FR-SW3**: 安装后不无提示立即接管正在工作的页面；新版本可用时提示用户。
- **FR-SW4**: 有未保存草稿/未同步操作时不得强制刷新；更新前保存草稿并展示影响。
- **FR-SW5**: 支持"稍后更新"与"安全更新"。
- **FR-SW6**: 前后端契约版本不兼容时 fail-closed；提供上一稳定 shell 的安全回滚。
- **FR-SW7**: 缓存容量与过期策略可测试。
- **FR-SW8**: 增加浏览器升级、离线升级、坏版本、多标签页测试。

### Part 6 — 上传安全贯通
- **FR-U1**: 客户端扩展名/MIME/大小/数量预校验。
- **FR-U2**: 服务端 magic bytes 与真实内容类型校验。
- **FR-U3**: 文件名规范化与路径穿越防护。
- **FR-U4**: 压缩包炸弹、超大图片、异常元数据限制。
- **FR-U5**: 隔离区、恶意文件扫描及扫描状态；扫描完成前不可被业务读取。
- **FR-U6**: S3 签名 URL 的组织边界、对象 key、权限、有效期、content-type 约束。
- **FR-U7**: 分块上传、断点续传、取消、进度、失败恢复、服务端完成确认。
- **FR-U8**: 离线附件上传成功但业务动作失败时的关联恢复。
- **FR-U9**: 上传诊断 requestId。
- **FR-U10**: 测试覆盖伪造 MIME、双扩展名、重复提交、过期签名、跨租户对象 key、中断恢复。

### Part 7 — 角色任务工作台深化
- **FR-R1**: 默认角色来自当前认证用户，不得默认 manager。
- **FR-R2**: 普通用户只能看到被授权角色。
- **FR-R3**: 管理员"模拟角色查看"与真实权限明确区分并显示醒目标识。
- **FR-R4**: 调试/诊断权限由服务端 permission 决定；localStorage 标志不能授予权限。
- **FR-R5**: API 始终执行组织隔离与 RBAC，不信任前端 role 参数。
- **FR-R6**: 使用稳定业务 ID 作为 React key。
- **FR-R7**: 行点击跳转到具体实体，而非同一静态路径。
- **FR-R8**: 所有局部列表错误接入统一 ErrorState/QueryState；错误显示 requestId、影响范围、安全重试、下一步。
- **FR-R9**: 分页/筛选/排序/大数据导出在服务端执行；导出为异步任务并显示进度、权限、到期时间、审计记录。
- **FR-R10**: 保存视图服务端持久化、跨设备同步、共享权限。
- **FR-R11**: 每个角色显示"为什么现在处理、截止时间、影响、责任人、推荐下一步"。
- **FR-R12**: 危险操作提供影响预览、幂等确认、撤销或补偿路径。
- **FR-R13**: 支持键盘、扫码枪、触摸、单手、工业手套操作。

### Part 8 — 真实业务 E2E 与工业 UX
- **FR-E1**: 覆盖操作员领任务/执行步骤/上传证据/离线/重连/冲突；班组长异常/转派/审批；质检不合格/返工/复检；设备告警与维护；管理者指标/追溯/导出；会话过期与重认证；多标签页登出同步；权限拒绝与跨租户攻击；陈旧与部分失败；弱网/抖动/上传中断；浏览器关闭及恢复；200% 缩放；键盘与焦点顺序；屏幕阅读器名称与状态播报；reduced motion；高对比（不只靠颜色）；触控目标适配手套；长时间运行/内存增长/队列堆积。
- **FR-E2**: 覆盖 Chromium、Firefox、WebKit、手机、工业平板和至少一类真实工业 WebView。
- **FR-E3**: 非 Chromium 弱网测试不能永久依赖 skip；应使用可移植代理、Toxiproxy、网络层故障注入或等价方案。

### Part 9 — 性能与依赖可复现性
- **FR-P1**: 真实 bundle 分析；拆分地图、三维、图表和低频管理功能；避免首屏加载 Cesium、Three.js、ECharts。
- **FR-P2**: 设置 route chunk 与 main chunk 预算；长列表服务端分页/虚拟化/渐进加载；大计算放 Web Worker。
- **FR-P3**: 用真实 RUM 数据校准预算；测试低端设备、低内存、长时间运行。
- **FR-P4**: 禁止命令与 CI 使用 `@latest`；固定所有生成器版本并写入 lockfile；GitHub Actions 固定明确版本或 commit SHA。
- **FR-P5**: 消除 Node runtime deprecation 警告；生成 SBOM；增加依赖漏洞、许可证、供应链检查。
- **FR-P6**: 验证同一 commit 可确定性生成相同 OpenAPI、发布包与校验和。

## Non-Functional Requirements
- **NFR-1**: 干净 checkout 可复现全部门禁（machine-verifiable evidence）。
- **NFR-2**: 无静默 skip、无伪造通过、无手工写死的 HEAD/测试数量。
- **NFR-3**: 报告状态与 CI 状态一致。
- **NFR-4**: 所有新增功能有行为级（非存在性）单元/集成/E2E 测试。
- **NFR-5**: 未完成现场事项显式标记 BLOCKED_BY_ENVIRONMENT 或 EXTERNAL_APPROVAL，并给出复现命令、所需环境变量、CI 入口。

## Constraints
- **Technical**: Node 26.5.1 本机 / CI Node 22；Python 3.9.6 本机 / CI 3.11；PostgreSQL 17（CI Service Container）；macOS arm64 本机。
- **Environmental**: 本机无 PG/Docker/kubectl/helm/gh/bandit；`python3 -m pytest` 可用。凡依赖这些的验证均为 BLOCKED_BY_ENVIRONMENT，需通过 CI 执行。
- **Business**: 外部生产批准（G10-G13）、双工厂复制、培训、签署属 EXTERNAL_APPROVAL，代码面无法推动。
- **Dependencies**: 复用既有 `openapi-typescript`、Jest、Playwright、semantic-rules engine、work-indexer/work-console/gate-engine。

## Assumptions
- 上一轮已提交的 `production-ux-deepening` 能力（前端状态系统、离线队列 lib、PWA、可观测性 lib、Playwright 矩阵、OpenAPI 生成器）保留并作为本轮基础。
- 本轮聚焦"贯通运行时的行为正确性"，而非新增演示页面。

## Acceptance Criteria

### AC-T1: 单一事实源（程序化）
- **Given**: CI 运行 `make truth-check`（或等价）。
- **When**: 生成 evidence manifest 并跑漂移夹具。
- **Then**: manifest 的 `evaluatedCommitSha`/测试数量来自 live 输出；audit 无漂移；无手工写死数字。
- **Verification**: `programmatic`

### AC-T2: 版本单一事实源（程序化）
- **Given**: 仓库声明版本。
- **When**: 运行版本校验脚本。
- **Then**: 所有派生文件（README/CHANGELOG/manifest/gates/前端）与单一源头一致。
- **Verification**: `programmatic`

### AC-O1: 前端指标进入后端（程序化）
- **Given**: 运行前端并产生指标。
- **When**: 调用 ingestion API。
- **Then**: 后端任务持久化，诊断页可查询；发送成功前本地指标不清空。
- **Verification**: `programmatic`

### AC-Q1: 离线幂等一次副作用（程序化）
- **Given**: 同一 idempotencyKey 重复提交不同 payload。
- **When**: 后端处理。
- **Then**: 第二次返回第一次结果，副作用仅执行一次；不同 payload 被拒绝。
- **Verification**: `programmatic`

### AC-Q2: 多标签页单 flush（程序化）
- **Given**: 多个标签页同时离线同步。
- **When**: 队列 flush。
- **Then**: 同一队列仅一个 leader flush，无并发重复副作用。
- **Verification**: `programmatic`

### AC-SW1: 敏感 API 不缓存（程序化）
- **Given**: SW fetch 拦截。
- **When**: 请求 API/鉴权/敏感响应。
- **Then**: 默认 network-only，不写入缓存。
- **Verification**: `programmatic`

### AC-U1: 上传安全链路接入（程序化）
- **Given**: 上传入口。
- **When**: 客户端与服务端校验执行。
- **Then**: 伪造 MIME/双扩展名/路径穿越/压缩炸弹被拒绝；扫描完成前不可读。
- **Verification**: `programmatic`

### AC-R1: 权限由服务端决定（程序化）
- **Given**: 前端伪造 role 参数。
- **When**: 调用 API。
- **Then**: 服务端按 RBAC 判定，伪造 role 无效。
- **Verification**: `programmatic`

### AC-E1: 真实业务 E2E（程序化/human）
- **Given**: 认证浏览器测试套件。
- **When**: 执行角色业务流程。
- **Then**: 关键流程通过；跨浏览器矩阵有机器证据。
- **Verification**: `programmatic` + `human-judgment`

### AC-P1: 可复现性（程序化）
- **Given**: 同一 commit。
- **When**: 两次构建 OpenAPI/发布包。
- **Then**: 生成相同产物与校验和；无 @latest；Actions 固定版本。
- **Verification**: `programmatic`

### AC-FINAL: 五级结论分级（human）
- **Given**: 本轮结束。
- **When**: 输出报告。
- **Then**: Code Implemented / Code Verified / Runtime Verified / Pilot Ready / Production Ready 分别给出，Pilot/Production 保持诚实 NOT READY（除非证据齐备）。
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否有可用的真实工业 WebView 环境（本地/CI）用于 FR-E2？若无则标记 BLOCKED_BY_ENVIRONMENT。
- [ ] 前端指标后端如无既有多租户持久化表，是否允许新增表（不破坏 RLS）？默认允许，但需保持组织隔离。
- [ ] 是否已有 OpenTelemetry 后端 collector 端点？若无，exporter 输出到本地文件/日志 + 诊断 API 作为等价实现。