# Tasks

> 基于 `main`（HEAD `5986564`）执行「生产化收口与用户体验深化」。按 W1–W8 波次推进。
> 原则：先只读审计（W1）后改码；环境缺失项标记 `BLOCKED_BY_ENVIRONMENT` 并给可复现命令与 CI 入口，绝不伪造通过或静默 skip。
> 环境指纹：macOS 27 / Node v26.5.1 / npm 11.17.0 / Python 3.9.6；**无 Docker/kubectl/helm/psql**。

## W1：只读审计、环境与证据基线（先于改码）
- [x] Task W1.1: 记录执行环境与仓库指纹（branch=`main`、HEAD SHA、时间、OS/Node/Python/DB/容器/依赖版本），写入波次报告
- [x] Task W1.2: 只读交叉核对 README/CHANGELOG/release/openapi/contracts/catalog/tools/ewoh-spark-app/ewoh-feishu-app/output/.codex/artifacts
- [x] Task W1.3: 审计 `output/work-console.json` 全部 Review/Validation/Pending/Proposed/Refining 状态项与证据元数据缺口（commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/verifier/expiresAt）
- [x] Task W1.4: 审计生成物中的开发者本机绝对路径（如 `work-console.json` 的 `sourceRoot=/Volumes/...`）与 DEVOPS 残留
- [x] Task W1.5: 运行可通过的全部门禁基线（Python unittest/pytest/ruff/bandit、服务端+客户端 typecheck/lint/Jest、OpenAPI 审计、repo-facts strict、Work Graph strict/invariants），记录基线
- [x] Task W1.6: 输出 W1 波次报告（差异清单、环境阻塞项、基线结果、commit SHA）

## W2：状态与证据收口
- [x] Task W2.1: 对照源码/测试/有效证据逐项复核 work-console 状态；仅当当前 HEAD 的代码+测试+证据同时满足才标 Done；否则区分 Code Implemented / Code Verified / Runtime Verified / Pilot Ready / Production Ready
- [x] Task W2.2: 为证据补充/刷新所有元数据字段；清除生成物本机绝对路径（改仓库相对/脱敏路径）
- [x] Task W2.3: 更新 `output/work-console.json`、`output/gate-decisions.json`、work-graph 状态；同步 task-board/phase-state/Next Waves
- [x] Task W2.4: 输出 W2 波次报告（状态迁移前后对比、证据元数据样本、commit SHA）

## W3：发布与仓库一致性
- [x] Task W3.1: 修复 RC4 发布材料版本/证据版本/描述不一致；统一根版本、Helm appVersion、Compose/K8s 默认版本、运行时版本、发布目录、CHANGELOG、前端可见版本
- [x] Task W3.2: 修复 `ewoh-spark-app/package.json` 模板名称（`fullstack-nestjs-template`→`ewoh-spark-app`）与独立版本（`2.2.5`→统一版本）残留，建立单一版本事实源
- [x] Task W3.3: 编写完整的 `ewoh-spark-app/README.md`（架构/环境要求/启动/测试/真实 PostgreSQL/浏览器测试/常见故障/安全边界）
- [x] Task W3.4: 审计未路由页面、Placeholder、Example、遗留目录、重复封装、无引用代码；安全删除或说明用途
- [x] Task W3.5: 生产/试点模式真实模块缺失时 fail-closed 禁止 stub 回退；开发模式 stub 醒目标记
- [x] Task W3.6: 输出 W3 波次报告（版本一致性 diff、README 成品、commit SHA）

## W4：OpenAPI 与前后端契约自动化
- [x] Task W4.1: 替换 `gen:openapi = UNSUPPORTED, SKIP`，基于当前 OpenAPI 生成可复现 TS 类型与 API 客户端
- [x] Task W4.2: 客户端不再重复手写契约中已存在类型；接入现有 API 封装
- [x] Task W4.3: CI 校验生成物无漂移（生成后 diff 非零退出）
- [x] Task W4.4: 补错误契约/分页/取消请求/幂等键/附件/离线同步相关类型测试
- [x] Task W4.5: 输出 W4 波次报告（生成器选择、生成物、漂移门禁、commit SHA）

## W5：统一页面状态与错误恢复体验
- [x] Task W5.1: 建立全局统一、可复用且有测试覆盖的页面状态系统（Skeleton/局部刷新/空数据/查询失败/部分失败/无权限/离线/陈旧缓存/后台同步/冲突/会话过期/服务降级）
- [x] Task W5.2: 路由加载不再只显示全屏「加载中…」；布局加载前后不明显跳动；查询失败不渲染为「没有数据」
- [x] Task W5.3: 保留最近一次成功数据时显示时间与陈旧状态；用 `errorCode/requestId/retryable/recommendedAction` 生成统一可操作错误界面；可复制 requestId；明确数据是否已保存/可安全重试/下一步
- [x] Task W5.4: 范围化重试（当前请求/失败项/全部重试），避免重复提交成功操作
- [x] Task W5.5: 为所有主要页面增加单元测试与浏览器测试
- [x] Task W5.6: 输出 W5 波次报告（组件清单、接入页面清单、测试结果、commit SHA）

## W6：PWA 与离线队列生产化
- [x] Task W6.1: 较大离线数据与照片从 localStorage/Data URL 迁移到 IndexedDB+Blob
- [x] Task W6.2: schema version/迁移/容量限制/配额预警/压缩/加密/过期清理/损坏恢复机制
- [x] Task W6.3: 断点续传或安全分块上传；queued/syncing/synced/failed/conflict/discarded 状态及更新时间
- [x] Task W6.4: 单项失败不阻塞其他项；冲突项不自动覆盖服务端，支持对比/重试/放弃/人工解决
- [x] Task W6.5: 页面关闭、崩溃、设备重启、应用升级后未同步数据恢复
- [x] Task W6.6: Service Worker 缓存版本/更新提示/旧版本清理/安全回滚
- [x] Task W6.7: 测试断网/弱网/网络抖动/重复提交/上传中断/令牌过期/存储配额不足/版本升级
- [x] Task W6.8: 输出 W6 波次报告（存储架构、状态机、测试结果、commit SHA）

## W7：角色任务驱动体验 + 数据可信度 + 工业无障碍
- [x] Task W7.1: 角色首页「当前最需要处理的事项」优先；任务显示原因/优先级/截止/影响/责任人/下一步
- [x] Task W7.2: 告警/设备/人员/工单/工序/质量问题/回放事件跨实体跳转；全局搜索/命令面板（遵守组织隔离与角色权限）
- [x] Task W7.3: 危险/不可逆/可能重复操作提供影响预览与二次确认；高频安全操作减少确认但保留状态机与幂等；键盘/扫码/触摸/单手优化
- [x] Task W7.4: 统一数据可信度组件扩展到指挥中心/地图/世界状态与回放/AI/排产/设备/告警/质检/报表/导出（来源/采集时间/最后同步/陈旧/离线缓存/模拟回放/完整性/置信度/决策允许性）
- [x] Task W7.5: Playwright 多项目矩阵（Chromium/Firefox/WebKit）；桌面/390×844/工业平板/触摸/低性能/弱网/断网重连/慢接口/长跑
- [x] Task W7.6: 键盘/焦点/焦点陷阱/ARIA/屏幕阅读器/对比度/200% 缩放/减少动画；触控目标适手套；高对比模式不单靠颜色；声音/震动反馈；视觉回归按浏览器视口平台分基线
- [x] Task W7.7: 输出 W7 波次报告（角色工作台、可信度组件、无障碍/矩阵测试结果、commit SHA）

## W8：可观测性、安全、性能与最终交付
- [x] Task W8.1: 前端 Web Vitals/路由耗时/接口失败率/同步队列耗时/冲突率/白屏/未处理异常采集；requestId/traceId 串联浏览器/API/DB/审计/支持包；运维诊断页
- [x] Task W8.2: 审计令牌存储/刷新轮换/登出撤销/会话超时/多标签同步/离线会话；离线缓存与照片敏感数据保护
- [x] Task W8.3: 检查 CSP/安全响应头/上传 MIME·扩展名·内容校验/文件大小/恶意文件隔离/S3 签名 URL；主要页面性能预算；长列表服务端分页/虚拟化
- [ ] Task W8.4: 运行并记录全部门禁；对环境缺失项标记 `BLOCKED_BY_ENVIRONMENT`（真实 PostgreSQL HTTP E2E、多实例并发、Docker/K8s/Helm、备份恢复、发布演练、视觉回归 CI 等给可复现命令与 CI 入口）
- [ ] Task W8.5: 编写 `docs/reviews/production-ux-deepening-report.md`（HEAD SHA 与环境/已完成事项/验证结果/性能与体验前后对比/安全影响/DB 与 API 兼容性/未完成外部事项/Code·Runtime·Pilot·Production Ready 四级结论）
- [ ] Task W8.6: 更新 Work Graph、Work Console、门禁决定与发布清单；更新 CHANGELOG
- [ ] Task W8.7: 提交并推送到 `main`

# Task Dependencies
- W1 全部前置（先只读审计后改码）
- W2 依赖 W1（证据基线）；W3 依赖 W1 与 W2（一致性基线）
- W4 依赖 W1（OpenAPI 现状）；W5 依赖 W3（版本/README）与 W4（客户端契约）
- W6 可与 W5 并行（独立模块）；W7 依赖 W5（页面状态系统）与 W6（离线/索引）
- W8 依赖 W2–W7 全部完成
- 高风险/收口任务（状态证据、版本一致性、OpenAPI 契约、数据可信度）由独立验证 Agent 复核，不由实现 Agent 自签