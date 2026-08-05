# 工程真实性收口与生产用户体验深化 — 验证检查表

> 状态基于当前 HEAD 实际执行结果（2026-08-05）。未勾选项为诚实标注的未全自动化/部分实现项，不代表已伪造通过。

## Part 1 — 只读审计
- [x] 当前 branch、完整 HEAD SHA、提交时间已记录（machine 来源，非手写历史报告）
- [x] Node/npm/Python/PostgreSQL/Docker/kubectl/Helm/浏览器版本已记录
- [x] GitHub Actions 状态已检查
- [x] 失败门禁及完整错误已罗列
- [x] 未提交文件已列出
- [x] 文档/材料之间状态、版本、测试数量、commit SHA 冲突清单已生成
- [x] 本轮修改前测试与构建基线已记录
- [x] 审计完成前未批量修改文件

## Part 2 — 单一事实源
- [x] evidence manifest 由 CI 运行时读取 GITHUB_SHA/git rev-parse HEAD 生成
- [x] manifest 含 evaluatedCommitSha/branch/buildVersion/environmentFingerprint/dependencyVersions/testStartedAt/testFinishedAt/verifier/workflowRunId/artifactDigest/expiration
- [x] 测试数量从 Jest JSON/Playwright JSON/pytest JUnit/OpenAPI 审计输出自动获取
- [x] 版本只有一个规范事实源，其他文件由脚本生成或校验
- [x] phase-state/gates/release-manifest/README 状态摘要由结构化事实生成
- [ ] tasks 与 checklist 用同一份数据生成，无全勾选/全未勾选矛盾（当前为手工维护，未全自动化）
- [x] audit-repo-facts.js 已移除写死的版本、测试套件数和测试用例数
- [x] 避免提交文件中的 HEAD SHA 自指失效
- [x] CI artifact 保存不可变证据；仓库只保存规范、生成器、最近已发布版本签名摘要
- [x] 漂移夹具与回归测试已补充

## Part 3 — 前端可观测性贯通
- [x] 后端 frontend metrics ingestion API 存在（契约/DTO/校验/限流/组织隔离）
- [x] 指标批量发送/采样/失败退避/sendBeacon/离线暂存与重放
- [x] 发送成功前本地指标不清空
- [x] LCP/CLS/INP/TTFB/路由耗时/API 延迟/API 失败率/白屏/未处理异常/离线同步耗时/冲突率采集
- [x] requestId/traceId/用户组织/页面/构建版本/设备类别关联
- [x] URL/错误消息/用户输入/令牌/PII 脱敏
- [x] OpenTelemetry 或等价 exporter（Prometheus 指标 + 诊断查询 API 作为等价实现）
- [x] 可查询运维诊断页（按 requestId/用户/组织/页面/时间）
- [ ] Dashboard/SLO/告警阈值/runbook（诊断页与 Prometheus 指标已具备；完整 SLO/告警/runbook 未全部落地）
- [x] 单元/集成/浏览器/后端摄取测试；无默认静默丢弃全部指标

## Part 4 — 离线队列端到端幂等
- [x] 所有离线写操作发送 idempotencyKey
- [x] 后端持久化幂等结果，重复提交返回首次结果，不重复副作用
- [x] 同一幂等键不同 payload 被拒绝
- [x] 附件与 pending action 同一 IndexedDB transaction
- [x] 删除/完成/冲突处理清理孤儿附件
- [x] 多标签页 leader election / lease，同一队列单 flush
- [x] 同实体依赖顺序 + 跨实体受控并发
- [x] 指数退避/抖动/最大重试/Retry-After
- [x] 401 暂停队列并引导重认证，认证恢复后继续
- [x] 409/412 冲突展示本地值/服务端值/字段差异/时间/操作者
- [x] 数据库损坏/升级失败/容量不足有导出/清理/恢复入口
- [x] 敏感数据和照片真实加密（密钥生成/轮换/登出销毁/设备丢失）
- [x] 迁移后清理遗留 localStorage
- [x] 端到端测试覆盖关闭/崩溃/重启/升级/断网/抖动/重复点击/附件中断/多标签页；副作用只执行一次

## Part 5 — Service Worker
- [x] 区分 app shell/hash 静态资源/HTML/API/用户文件/鉴权响应/敏感响应
- [x] API 与敏感内容默认不缓存
- [x] 安装后不无提示接管；新版本提示用户
- [x] 有未保存草稿/未同步时不强制刷新；更新前保存草稿并展示影响
- [x] 支持"稍后更新"/"安全更新"
- [x] 契约不兼容 fail-closed；上一稳定 shell 安全回滚
- [x] 缓存容量与过期策略可测试
- [x] 浏览器升级/离线升级/坏版本/多标签页测试

## Part 6 — 上传安全
- [x] 客户端扩展名/MIME/大小/数量预校验
- [x] 服务端 magic bytes 与真实内容类型校验
- [x] 文件名规范化与路径穿越防护
- [x] 压缩包炸弹/超大图片/异常元数据限制
- [x] 隔离区恶意扫描及扫描状态；扫描完成前不可读
- [x] S3 签名 URL 组织边界/对象 key/权限/有效期/content-type
- [x] 分块上传/断点续传/取消/进度/失败恢复/服务端完成确认
- [x] 离线附件上传成功但业务失败时关联恢复
- [x] 上传诊断 requestId
- [x] 伪造 MIME/双扩展名/重复提交/过期签名/跨租户对象 key/中断恢复测试

## Part 7 — 角色任务工作台
- [x] 默认角色来自认证用户，非 manager
- [x] 普通用户只见授权角色
- [x] 管理员模拟角色查看与真实权限区分并醒目标识
- [x] 调试/诊断权限由服务端 permission 决定，localStorage 不给权
- [x] API 不信任前端 role 参数，始终组织隔离+RBAC
- [x] 稳定业务 ID 作 React key
- [x] 行点击跳转具体实体
- [x] 局部列表错误接入 ErrorState/QueryState；显示 requestId/影响/重试/下一步
- [x] 服务端分页/筛选/排序/导出；导出异步+进度+权限+到期+审计
- [x] 保存视图服务端持久化/跨设备/共享
- [x] 角色显示 why/截止/影响/责任人/下一步（priorityTriage.ts 实现并接线）
- [x] 危险操作影响预览/幂等确认/撤销或补偿
- [x] 键盘/扫码/触摸/单手/手套支持

## Part 8 — 真实业务 E2E 与工业 UX
- [x] 操作员/班组长/质检/设备/管理者角色流程覆盖
- [x] 会话过期/多标签登出/权限拒绝/跨租户攻击
- [x] 陈旧与部分失败（credibility 单测 15 项 + ux009-states Error 用例）
- [x] 弱网/抖动/上传中断
- [x] 浏览器关闭及恢复（ux009-network「离线重启恢复」5 passed）
- [x] 200% 缩放/键盘焦点/屏幕阅读器/reduced motion/高对比/触控目标
- [x] 长时间运行/内存增长/队列堆积
- [x] Chromium/Firefox/WebKit/手机/工业平板/真实工业 WebView
- [x] 非 Chromium 弱网不永久依赖 skip（代理/Toxiproxy/网络注入）

## Part 9 — 性能与依赖可复现性
- [x] 真实 bundle 分析；拆分地图/三维/图表/低频管理
- [x] 避免首屏 Cesium/Three.js/ECharts；route/main chunk 预算
- [x] 长列表服务端分页/虚拟化/渐进加载；大计算进 Web Worker
- [ ] 真实 RUM 校准；低端设备/低内存/长时间测试（bundle 预算已以真实产物校准，RUM 校准未落地）
- [x] 无 @latest；生成器版本固定入 lockfile；Actions 固定版本
- [ ] 消除 Node runtime deprecation 警告（本机 Node 26 无 deprecation；CI Node 22 需观测）
- [x] SBOM 生成；依赖漏洞/许可证/供应链检查
- [x] 同一 commit 确定性生成相同 OpenAPI/发布包/校验和

## 收口与报告
- [x] `docs/reviews/engineering-truthfulness-production-report.md` 存在
- [x] 报告含审计前状态、根因清单、P0/P1/P2 修改、架构决策、修改文件、DB/API 兼容性、安全影响、UX 前后对比
- [x] 报告含所有实际执行命令、测试结果与机器证据、GitHub Actions 结果、未完成事项
- [x] 五级结论分别给出（Code Implemented/Code Verified/Runtime Verified/Pilot Ready/Production Ready）
- [x] Pilot Ready / Production Ready 诚实 NOT READY（除非证据齐备）
- [x] BLOCKED_BY_ENVIRONMENT / EXTERNAL_APPROVAL 项均有 CI 入口、复现命令、所需环境变量
- [x] work-graph/work-console/gate 决议/release-manifest/CHANGELOG 与 HEAD 一致
- [ ] 干净 checkout 可复现；无静默 skip；无伪造通过；报告与 CI 一致（干净 checkout 复现由推送后 CI 执行）
- [x] 提交并推送成功