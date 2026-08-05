# 代码深化与用户体验闭环 — Spec

> 基线：`main` 分支 HEAD `5a810c70960702201f5b870c35f5be58c5373e48`（2026-08-05 18:07:48 +0800）。
> 环境：macOS，Node v26.5.1，Python 3.9.6。工作树干净。
> 原则：以真实代码/测试/构建产物/可运行行为为准，不依赖文档“已完成”标记；不扩张业务领域、不重写架构、不破坏 API/DB/状态机/安全边界/审计语义；无真实环境必须标记 BLOCKED 并保留可复现命令与证据路径。

## Why

上一轮（`engineering-truthfulness-production`、`production-ux-deepening`）已建立错误状态、离线队列、可信度、可观测性、性能预算、安全扫描等基础，但存在以下未闭环的工程风险：

1. 设计值（颜色/间距/字号/圆角/阴影/动效）仍以 `hsl(220 14% …)`、`p-4`、`rounded-lg` 等字面量散落（见 [UX_DEEPENING_BACKLOG 3.2](file:///Volumes/Extra/CodeProj/EWOH/docs/product/UX_DEEPENING_BACKLOG.md)），无统一语义 Token，也无可阻断的硬编码静态检查。
2. 设备/告警/工单/命令/审批/人员/证据/系统事件各自拼装时间线，无统一对象时间线模型与统一 DTO。
3. 首次使用缺少角色化 Quick Start、可重复初始化且不污染正式数据的样例工厂、以及“五分钟完成闭环”引导；空状态未统一解释“现在是什么/缺什么/下一步可做什么”。
4. 性能预算虽已建立（见 [perfBudget.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/perfBudget.ts) 10 项、[bundle-budget.mjs](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/scripts/bundle-budget.mjs) 首屏 420+40kB），但仅首屏 JS 在构建期真实阻断，其余项多为 pending，未全部接入 CI 失败。
5. 弱网测试主要依赖 Chromium CDP 网络节流，未在 Firefox/WebKit 复用同一弱网场景。
6. 前端资源生命周期（BroadcastChannel/WS/SSE/SW listener/timer/retry/AbortController/IndexedDB transaction/Blob URL/event listener）缺少统一治理与“登出/租户切换/角色切换/后台/网络恢复/SW 升级”下的关闭与重建覆盖。
7. Bandit 已出现在 requirements-dev 描述中，但需确认是否真正运行并输出机器可读报告；Node 生产依赖审计/秘密扫描/SBOM/镜像漏洞扫描需统一接入质量门禁（含带原因/责任人/到期时间的 suppressions）。
8. 真实运行门禁（PG migration 往返、HTTP+PG E2E、并发/幂等/锁竞争、Docker/Helm install-upgrade-rollback、备份恢复、边缘断连/积压/重放、灰度回滚、soak）多数依赖真实环境，需明确 BLOCKED 并给一键命令。
9. 错误与恢复体验需逐页审计统一 loading/empty/partial/stale/degraded/offline/unauthorized/forbidden/conflict/error/recovery/success，且错误信息不得暴露原始堆栈/大段 JSON。

## What Changes

- 建立统一 semantic design tokens（背景/表面/边框/文本；success/warning/danger/info；normal/degraded/offline/blocked/conflict/unknown；spacing/radius/typography/elevation/motion/z-index），迁移既有页面与共享组件，支持深色/高对比/reduced-motion，并加静态检查阻断未经批准的硬编码样式值。
- 建立统一对象时间线数据模型与服务端统一 DTO，客户端只消费该 DTO，支持按对象/事件类型/风险等级/操作者/时间筛选、告警→决策→命令→执行→回执→复盘追踪、锚点链接/证据预览/复制标识/审计导出。
- 实现角色化 Quick Start、可重复初始化/可安全清除/不污染正式数据的样例工厂、五分钟闭环引导（可跳过/可恢复/可重新打开、记录版本避免重复弹出）、统一空状态与权限/设备/数据/断连/同步中/初始化失败处理路径、匿名化首次任务事件。
- 完成路由级懒加载/组件级拆分/按需加载，审计大表格/因果图/命令地图/时间线/证据预览的全量渲染，必要时虚拟化/增量/Worker/缓存/分层渲染；将性能预算写入 CI 并使其超预算即失败且输出可定位报告。
- 弱网测试改为可跨浏览器复用的代理/测试服务器场景（延迟/带宽/随机断连/超时/错误注入），固定 Linux Chromium 为主要视觉黄金基线，明确字体/浏览器/OS 差异策略，保留移动 Chrome/工业平板/reduced-motion。
- 统一 session/runtime 资源生命周期治理，覆盖组件卸载/登出/Token 失效/租户切换/角色切换/后台/网络恢复/SW 升级，并加登录-退出-重登/多标签退出/租户切换自动化测试。
- 将 Bandit（锁定版本）实际接入 CI 并输出机器可读报告；统一 Node 生产依赖审计/秘密扫描/SBOM/镜像漏洞扫描到质量门禁，建立带原因/责任人/到期时间的 suppressions 文件，高严重度阻断合并。
- 在可用 CI 环境自动化真实运行门禁；真实环境不可用项输出 BLOCKED + 一键命令 + 环境/预期证据，不使用 mock 替代。
- 逐页审计并统一错误与恢复体验（12 态），错误至少含现象/影响/是否已保存/可执行下一步/可复制 trace|request id，禁止暴露原始堆栈/大段 JSON/开发者内部文本。
- 全量验收（typecheck/lint/unit/integration/Python+Bandit/OpenAPI 生成校验漂移/DB migration 往返/Playwright 全矩阵/accessibility/weak-network/visual/production build/bundle/perf budget/Docker/Helm smoke/repo facts+work graph+evidence audit），并按五级结论如实输出。

## Impact

- 受影响规格能力：UX 统一（terminology/colors/tokens/九态）、可观测性、离线队列、性能工程、安全门禁、真实运行门禁、错误恢复。
- 受影响代码（主要）：
  - 客户端样式/设计系统：`ewoh-spark-app/client/src/{index.css,tailwind-theme.css,typography.css}`、`client/tailwind.config.ts`、`client/src/components/ui/*`、`client/src/components/*`、`client/src/pages/*`。
  - 统一时间线：`client/src/lib/*`（新增 timeline 模型）、`client/src/api/*`、服务端 DTO（`ewoh-spark-app/server/*`、`shared/api.interface.ts`）、`openapi/ewoh.yaml`、`contracts/artifact-schemas/*`。
  - 首次使用/样例工厂：新增 `client/src/components/onboarding/*`、`client/src/lib/sampleFactory/*`、后端样例初始化端点与守卫。
  - 性能：`client/vite.config.ts`（懒加载/拆包）、`scripts/bundle-budget.mjs`、`client/src/lib/perfBudget.ts`、`scripts/perf-bench.mjs`、CI workflows。
  - 弱网/视觉回归：`playwright.config.ts`、新增 proxy 注入工具与弱网场景、`playwright.visual.config.ts`、CI。
  - 资源生命周期：新增 `client/src/lib/lifecycle.ts`、AppContainer/离线/会话相关。
  - 安全 CI：`.github/workflows/security.yml`、`requirements-dev.txt`/`pyproject.toml`（Bandit 锁定）、新增 suppressions 文件、SBOM/secret 扫描。
  - 真实运行门禁：`db/runner/*`、`db/migrations/*`、`scripts/*-tck*`、`deploy/*`、CI。
  - 错误与恢复：`client/src/components/{ErrorState,QueryState,OfflineState,PermissionState}.tsx`、`client/src/lib/errorContract.ts`、各页面。
  - 文档/证据：`docs/reviews/*`、`CHANGELOG.md`、`output/*`。
- **BREAKING**：无预期破坏性 API/DB/状态机变化；新增统一时间线 DTO 与样例工厂以“新增能力”方式提供，保留既有接口兼容。

## ADDED Requirements

### Requirement: 语义化设计系统（Token）
系统 SHALL 提供集中式 semantic design tokens（background/surface/border/text；success/warning/danger/info；normal/degraded/offline/blocked/conflict/unknown；spacing/radius/typography/elevation/motion/z-index），并 SHALL 提供静态检查以阻断业务页面新增未经批准的硬编码样式值（颜色/间距/字号/圆角/阴影/动效/层级）。

#### Scenario: 页面迁移到 Token
- **WHEN** 共享组件与核心页面引用颜色/间距/字号/圆角/阴影/动效
- **THEN** 引用语义 Token 而非散落字面量；抽查核心页面无新增未批准硬编码值

#### Scenario: 深色/高对比/reduced-motion
- **WHEN** 用户切换深色模式、高对比模式或系统开启 prefers-reduced-motion
- **THEN** 页面正确适配；不改变既有风险颜色（normal/degraded/offline/blocked/conflict/unknown）的业务语义

### Requirement: 统一对象时间线
系统 SHALL 提供统一对象时间线数据模型与服务端统一 DTO，每条事件至少含 timestamp/actor/source/object type+id/action/previous state/current state/correlation|causation id/evidence/credibility/permission visibility；客户端 SHALL 只消费统一 DTO，禁止分别拼装不兼容时间线结构。

#### Scenario: 跨对象追踪与筛选
- **WHEN** 用户在时间线中按对象/事件类型/风险等级/操作者/时间范围筛选
- **THEN** 返回统一结构事件；可从告警追踪到决策/命令/执行/回执/复盘

#### Scenario: 锚点与审计导出
- **WHEN** 用户打开某条事件
- **THEN** 支持锚点链接、证据预览、复制标识与审计导出

### Requirement: 首次使用与样例工厂闭环
系统 SHALL 为管理员/调度员/工程师/现场操作员提供角色化 Quick Start，提供可重复初始化、可安全清除、不污染正式数据的样例工厂，提供“五分钟完成第一条闭环任务”引导（可跳过/可恢复/可重新打开、记录版本避免重复弹出），并统一所有空状态与无权限/无设备/无数据/连接中断/同步中/初始化失败的处理路径。

#### Scenario: 首次任务闭环
- **WHEN** 新用户完成登录并进入引导
- **THEN** 可完成第一条闭环任务；引导可跳过/恢复/重开；不重复弹出；样例数据可安全清除且不污染正式数据

#### Scenario: 匿名化产品事件
- **WHEN** 用户完成/放弃首次任务
- **THEN** 记录匿名化首次任务完成率、放弃步骤与失败原因，不采集敏感业务内容

### Requirement: 真实可阻断性能预算
系统 SHALL 建立并接入 CI 的性能预算（初始 JS、单异步 Chunk、首屏可交互、大表格操作、大图渲染、低端平板内存峰值、离线恢复与队列重放），超预算 CI 必须失败并输出可定位构建报告；对重型页面实施路由级懒加载/组件拆分/按需加载，并在必要时虚拟化/增量/Worker/缓存/分层渲染。

#### Scenario: 超预算阻断
- **WHEN** 某项预算实测超过 limit+tolerance
- **THEN** CI 失败并输出指向具体资源/测量的报告

#### Scenario: 重型页面优化
- **WHEN** 大型表格/因果图/命令地图/时间线/证据预览存在全量渲染
- **THEN** 采用虚拟列表/增量加载/Worker/缓存/分层渲染，避免全量渲染

### Requirement: 跨浏览器弱网与视觉回归
系统 SHALL 提供基于代理层或测试服务器的可跨浏览器复用弱网场景（延迟/带宽/随机断连/超时/错误注入），覆盖登录后断网/提交断网/离线队列重放/重复提交/冲突/SW 更新/刷新/多标签并发；固定 Linux Chromium 为主要视觉黄金基线，对字体/浏览器/OS 差异设置明确策略，不得通过无限提高容差掩盖真实回归。

#### Scenario: 弱网场景复用
- **WHEN** Chromium/Firefox/WebKit 运行同一弱网场景
- **THEN** 复用同一注入场景与断言，不依赖 Chromium-only CDP 节流

### Requirement: 前端资源生命周期统一
系统 SHALL 统一管理 session/runtime 资源（BroadcastChannel/WebSocket/SSE/SW message listener/timer/retry|backoff/AbortController/IndexedDB transaction|lock/Blob URL/document|window event listener），并在组件卸载/登出/Token 失效/租户切换/角色切换/后台/网络恢复/SW 升级时正确关闭或重建。

#### Scenario: 会话切换防泄漏
- **WHEN** 用户登录→退出→重新登录、多标签页退出、或租户切换
- **THEN** 旧会话资源被关闭/重建，不再接收消息或写入数据（自动化测试覆盖）

### Requirement: 安全扫描固定到 CI
系统 SHALL 在 CI 实际运行 Bandit（锁定版本）并输出机器可读报告，统一接入 Node 生产依赖审计、秘密扫描、SBOM 与镜像漏洞扫描到质量门禁，建立带原因/责任人/到期时间的 suppressions 文件，高严重度问题必须阻断合并；不得因扫描环境缺工具而将状态记为 PASS。

#### Scenario: 高严重度阻断
- **WHEN** Bandit/依赖/秘密/镜像扫描发现高严重度问题且无有效 suppression
- **THEN** CI 阻断，输出机器可读报告与定位

### Requirement: 真实运行门禁
系统 SHALL 在可用 CI 环境尽可能自动化 PG migration 往返、HTTP+PG E2E、并发/幂等/锁竞争、Docker 镜像启动健康检查、Helm install-upgrade-rollback+smoke、备份恢复/版本兼容、边缘断连/积压/重放/重复消息、灰度升级回滚、soak/load；真实环境不可用项 SHALL 输出 BLOCKED + 一键命令 + 所需环境变量/基础设施/预期证据，不得用 mock 替代。

#### Scenario: 真实环境不可用
- **WHEN** 某项门禁缺真实环境
- **THEN** 输出 BLOCKED，保留可复现命令、预期条件与证据路径，不宣称 Production Ready

### Requirement: 错误与恢复体验审计
系统 SHALL 逐页确保核心页面具备一致 loading/empty/partial/stale/degraded/offline/unauthorized/forbidden/conflict/error/recovery/success 状态；每个错误至少展示可理解现象/可能影响/是否已保存/可执行下一步/可复制 trace|request id；禁止向普通用户暴露原始异常堆栈、大段 JSON 或开发者内部错误文本。

#### Scenario: 错误信息要素
- **WHEN** 用户触发某操作失败
- **THEN** 错误提示含现象/影响/是否已保存/下一步/可复制 trace|request id，且不含原始堆栈/大段 JSON

## MODIFIED Requirements

### Requirement: 性能预算（扩展现有）
继承 [perfBudget.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/perfBudget.ts) 预算语义，将“单异步 Chunk 体积、首屏可交互、低端平板内存峰值、离线恢复与队列重放”纳入同一预算表并全部接入 CI 失败判定；保留现有 `limit + tolerance` 语义与 `pass/fail/pending` 状态。

### Requirement: 错误状态（扩展现有）
继承 [ErrorState/QueryState/OfflineState/PermissionState](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/components) 与 [errorContract.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/errorContract.ts)，将“partial/stale/degraded/recovery/success confirmation”纳入统一状态机并逐页审计覆盖。

### Requirement: 安全 CI（扩展现有）
继承 [security.yml / test.yml](file:///Volumes/Extra/CodeProj/EWOH/.github/workflows) 已有 npm audit/license/SBOM/ruff，将 Bandit（锁定版本）与秘密扫描、镜像漏洞扫描接入同一质量门禁，并建立 suppressions 文件。

## REMOVED Requirements

无（延续既有能力，不删除既有功能）。