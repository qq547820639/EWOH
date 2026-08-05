# 生产化收口与用户体验深化 Spec

## Why
将当前 `main`（HEAD `5986564`，`0.6.0-rc4` 后续）从「核心实现 + F61-01/02」进一步收口为可交付生产候选：状态与证据完全一致、发布与仓库版本单一事实源、OpenAPI 契约自动化、统一页面状态与错误恢复、PWA 离线队列生产化、角色任务驱动体验、工业现场可用性、数据可信度与决策安全、可观测性安全性能，并诚实保留无法在当前环境验证的 `BLOCKED_BY_ENVIRONMENT` 项。

## 边界（必须遵守）
- EWOH 保持只读监督、风险分析和业务协同定位；**不得**增加平台下发急停、限扭、关节控制、实时助力闭环等设备安全控制能力。
- **不得**把模拟/回放/陈旧/离线缓存数据展示为真实实时数据。
- **不得**破坏现有 PostgreSQL RLS、组织隔离、RBAC、审计链、状态机、幂等和事务边界。
- 不进行无必要全量重写；优先复用现有组件、契约、状态模型和测试设施。
- **不得**通过删除测试、放宽断言、静默 skip 或关闭安全规则使门禁变绿。
- 无法在当前环境（无 Docker/kubectl/helm/真实 PostgreSQL/真实设备/现场输入）验证的项目，必须标记 `BLOCKED_BY_ENVIRONMENT`，提供可复现命令与 CI 入口，绝不伪造通过或静默跳过。

## 当前环境指纹（执行时记录）
- HEAD=`5986564`，branch=`main`，origin=`qq547820639/EWOH`
- OS=macOS 27.0, Node=v26.5.1, npm=11.17.0, Python=3.9.6
- Docker/Kubectl/Helm/psql=**缺失**（相关验证按 `BLOCKED_BY_ENVIRONMENT` 处理）

## What Changes
- 状态与证据收口：逐项复核 work-console/gate/graph 的 Review/Validation/Pending/Proposed/Refining/Done，补齐证据元数据，清除本机绝对路径。
- 发布与仓库一致性：统一根版本/Helm appVersion/Compose·K8s 默认版本/运行时版本/发布目录/CHANGELOG/前端可见版本；修复 `ewoh-spark-app` 模板名与版本残留，建立单一版本事实源；补写 `ewoh-spark-app/README.md`；审计未路由页面/Placeholder/Example/遗留目录；生产 fail-closed、开发 stub 醒目标记。
- OpenAPI 契约自动化：替换 `gen:openapi = UNSUPPORTED, SKIP`，基于 OpenAPI 生成 TS 类型与 API 客户端，CI 校验无漂移，补错误/分页/取消/幂等键/附件/离线同步契约测试。
- 统一页面状态与错误恢复：Skeleton/局部刷新/空数据/失败/部分失败/无权限/离线/陈旧缓存/后台同步/冲突/会话过期/服务降级；`errorCode/requestId/retryable/recommendedAction` 统一错误界面；可复制 requestId；范围化重试。
- PWA 与离线队列生产化：IndexedDB+Blob、schema version/迁移/容量/配额/压缩/加密/过期/损坏恢复、断点续传、queued/syncing/synced/failed/conflict/discarded 状态、冲突不自动覆盖、重启/崩溃/升级后恢复、SW 缓存版本/更新提示/回滚。
- 角色任务驱动体验：角色首页「当前最需要处理的事项」优先；给任务显示原因/优先级/截止/影响/责任人/下一步；跨实体跳转；全局搜索/命令面板；危险操作影响预览与二次确认；键盘/扫码/触摸/单手优化。
- 工业现场可用性与无障碍：Playwright 多项目矩阵（Chromium/Firefox/WebKit）；桌面/390×844 手机/工业平板/触摸/低性能；弱网/断网重连/慢接口/长跑；键盘/焦点/ARIA/对比度/200% 缩放/减少动画；触控目标适手套；高对比模式不单靠颜色；声音/震动反馈；视觉回归按浏览器/viewport/平台分基线。
- 数据可信度与决策安全：统一数据可信度组件扩展到指挥中心/地图/世界状态与回放/AI/排产/设备/告警/质检/报表/导出；显示来源类型/采集时间/最后同步/是否陈旧/离线缓存/模拟回放/完整性/置信度/决策允许性。
- 可观测性安全性能：Web Vitals/路由耗时/接口失败率/同步队列耗时/冲突率/白屏/未处理异常；requestId/traceId 串联；运维诊断页；令牌/会话/多标签审计；CSP/安全头/上传校验/S3 签名 URL；性能预算；长列表分页/虚拟化。
- 验证交付：运行全部门禁，记录证据；`docs/reviews/production-ux-deepening-report.md`；更新 Work Graph/Work Console/门禁/发布清单。

## Impact
- Affected specs: 权威制品一致性、UX 统一、OpenAPI 契约、移动工作台、PWA/离线、工业可用性、可观测性、发布一致性。
- Affected code: `ewoh-spark-app/`、`openapi/`、`output/`、`release/`、`deploy/`、`scripts/`、`.github/workflows/`、`CHANGELOG.md`、`README.md`、`docs/reviews/`。
- 保持向后兼容；破坏性契约变更必须提供兼容层、迁移说明与回归测试。

## ADDED Requirements

### Requirement: OpenAPI 契约自动生成与漂移门禁
系统 SHALL 基于当前 OpenAPI 生成可复现的 TypeScript 类型与 API 客户端，替换 `gen:openapi = UNSUPPORTED, SKIP`；客户端不得重复手写已存在于契约中的请求/响应类型；CI SHALL 校验生成物无漂移。

#### Scenario: 生成与漂移检测
- **WHEN** 运行 `gen:openapi` 后再次生成
- **THEN** 生成物与已提交版本一致，否则 CI 非零退出

### Requirement: 统一页面状态系统
系统 SHALL 提供可复用且有测试覆盖的页面状态系统，覆盖 Skeleton/局部刷新/空数据/查询失败/部分失败/无权限/离线/陈旧缓存/后台同步/冲突/会话过期/服务降级；查询失败不得渲染为「没有数据」；保留最近一次成功数据时须显示时间与陈旧状态；使用后端 `errorCode/requestId/retryable/recommendedAction` 生成可操作错误界面。

### Requirement: 离线队列与冲突处理
系统 SHALL 将较大离线数据和照片迁移到 IndexedDB+Blob；支持 schema version/迁移/容量/配额预警/压缩/加密/过期清理/损坏恢复；断点续传；显示 queued/syncing/synced/failed/conflict/discarded 状态及更新时间；单项失败不阻塞其他项；冲突项不得自动覆盖服务端数据，支持对比/重试/放弃/人工解决；页面关闭、崩溃、设备重启和应用升级后未同步数据可恢复。

### Requirement: 角色任务驱动首页
系统 SHALL 让每个角色首页首先展示「当前最需要处理的事项」而非模块列表；为任务显示原因/优先级/截止时间/影响范围/当前责任人/建议下一步；支持从告警/设备/人员/工单/工序/质量问题/回放事件直接跳转处理上下文；提供全局搜索或命令面板，结果遵守组织隔离与角色权限。

### Requirement: 工业现场无障碍与浏览器矩阵
系统 SHALL 提供 Playwright 多项目矩阵（Chromium/Firefox/WebKit），覆盖桌面/390×844 手机/工业平板/触摸/低性能/弱网/断网重连/慢接口/长跑；检查键盘导航/焦点可见性/焦点陷阱/ARIA/屏幕阅读器/对比度/200% 缩放/减少动画；触控目标适手套；高对比模式不单靠颜色；扫码成功/关键失败/离线保存提供可配置声音或震动反馈；视觉回归按浏览器视口平台分基线。

### Requirement: 数据可信度组件扩展
系统 SHALL 将数据可信度组件扩展到指挥中心/地图/世界状态与回放/AI/排产/设备/告警/质检/报表/导出；按场景显示来源类型/采集时间/最后同步/是否陈旧/是否离线缓存/是否模拟或回放/完整性/置信度/是否允许据此执行正式业务决策；不得让模拟/回放/陈旧数据只靠不明显角标区分。

### Requirement: 生产 fail-closed 与开发 stub 标记
系统 SHALL 在生产和试点模式下真实模块缺失时 fail-closed，禁止自动回退 stub；开发模式允许使用 stub，但必须醒目标记。

## MODIFIED Requirements
### Requirement: 版本单一事实源
统一根版本、Helm appVersion、Compose/K8s 默认版本、运行时版本、发布目录、CHANGELOG 与前端可见版本；修复 RC4 发布材料中版本、证据版本与描述不一致；修复 `ewoh-spark-app/package.json` 模板名称（`fullstack-nestjs-template`）与独立版本（`2.2.5`）残留。

### Requirement: 证据完整性
为证据补充/刷新 commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/verifier/expiresAt；清除生成物中的开发者本机绝对路径（如 `work-console.json` 的 `sourceRoot`），改为仓库相对路径或脱敏路径。

## REMOVED Requirements
无（本轮不删除公开契约与能力；仅修复/收口）。