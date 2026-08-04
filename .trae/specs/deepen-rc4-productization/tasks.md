# Tasks

> 基于 `main`（HEAD `9fe8a8f`）执行「RC4 候选版本产品化深化」。按 W1–W7 波次推进。
> 原则：先只读审计（W1）后改码；每波次结束输出问题/代码改动/未完成项及原因/测试命令与结果/前后截图/关键 Diff/风险变化/Gate 状态变化/下一波次依赖/commit SHA。
> 边界：仓库文件为单一事实源；不伪造外部证据；不代替人类批准；实现 Agent 不得自批高风险；外部生产/真实工厂条件未满足时 Pilot Readiness 保持 NOT READY。

## W1：只读审计与事实一致性（先于任何修改）
- [x] Task W1.1: 记录执行环境与仓库指纹（branch=`main`、HEAD、时间、OS/Node/Python/DB/容器/依赖版本）
- [x] Task W1.2: 只读交叉核对 README/CHANGELOG/release/openapi/contracts/catalog/tools/ewoh-spark-app/ewoh-feishu-app/output/.codex/artifacts
- [x] Task W1.3: 产出《RC4 权威事实差异报告》`docs/reviews/RC4_AUTHORITATIVE_FACTS_GAP.md`
  - [x] 3.1 README 声明 rc4 但 CHANGELOG 是否完整记录 rc3、rc4
  - [x] 3.2 README/CHANGELOG/release-manifest/state/task-board/phase-state/gates 是否指向同一版本与阶段
  - [x] 3.3 已完成任务与未通过 Gate 的语义冲突
  - [x] 3.4 不同测试报告的测试数量是否用了不同命令/范围/环境
  - [x] 3.5 Next Waves/历史路线图/当前任务/已完成任务的陈旧内容
  - [x] 3.6 OpenAPI 路由数、数据库表数、Work Graph 节点数、场景包清单一致性
  - [x] 3.7 每份证据是否含 commitSha/branch/command/suite/environment/startedAt/completedAt/result/artifactChecksum/verifier/expiresAt
- [x] Task W1.4: 新增 repository-facts schema 与事实采集/一致性 CLI（状态/版本/缺失 commit SHA/过期证据返回非零退出码，输出可审查 Diff）
- [x] Task W1.5: 补齐 rc3、rc4 CHANGELOG 与 release notes；统一测试证据统计口径（完整/增量/专项套件）
- [x] Task W1.6: 清理 task-board/phase-state/gates/Next Waves 陈旧状态
- [x] Task W1.7: 事实一致性检查接入 CI 与正式 release gate
- [x] Task W1.8: 输出 W1 波次报告（发现问题/改动/未完成项/测试命令与结果/关键 Diff/风险与 Gate 变化/下一波次依赖/commit SHA）

## W2：视觉资源链修复与产品级设计系统
- [ ] Task W2.1: 诊断并修复视觉资源链根因（Tailwind/CSS 是否加载、静态资源路径/base URL/Content-Type/缓存/CSP、截图时机、被 tree-shaking 删除的 class、测试忽略资源加载失败）
- [ ] Task W2.2: 建立视觉质量门禁（页面 stylesheet 数量、关键组件 computed style；资源 404、console error、未处理异常导致测试失败）
- [ ] Task W2.3: 建立统一 design token（spacing/typography/radius/elevation/status/focus/motion）
- [ ] Task W2.4: 建立统一组件（AppShell/Sidebar/Topbar/Button/Input/Select/Table/Card/Badge/Tabs/Drawer/Dialog/Toast/Skeleton/EmptyState/ErrorState/PermissionState/OfflineState）
- [ ] Task W2.5: 对 390x844/768x1024/1440x900 视口运行视觉回归；对登录页/指挥中心/因果控制台/Git 同步/移动工作台/站点准备页生成基准截图
- [ ] Task W2.6: 引入 axe 无障碍检查，阻断 serious/critical；键盘焦点清晰；状态不只靠颜色表达；表单错误在字段附近且有可执行恢复建议
- [ ] Task W2.7: 所有页面实现 loading/empty/error/offline/permission-denied 状态
- [ ] Task W2.8: 输出 W2 波次报告（前后截图、关键 Diff、测试命令与结果、Gate 变化）

## W3：因果执行控制台 UX 深化
- [ ] Task W3.1: 默认首页优先回答当前 Gate/阻塞任务/最长等待/过期证据/待人类决策风险/下一最优行动/过载项
- [ ] Task W3.2: 响应式侧边导航 + 命令面板；全局搜索、保存视图、最近访问、URL 深链接
- [ ] Task W3.3: 预设视图（我的待办/阻塞项/待批准/证据过期/资源冲突）
- [ ] Task W3.4: DAG 平移缩放/自动聚焦关键路径/阶段折叠/渐进加载/节点搜索/上下游追踪/异常回流高亮/布局保存
- [ ] Task W3.5: 图节点可访问列表替代视图；证据抽屉（commit/PR/测试命令/环境/日志/截图/校验和/验证人/有效期）
- [ ] Task W3.6: 批量 Gate 操作先显示影响范围/缺失证据/不可执行原因；高风险操作支持条件批准/驳回/撤销/回滚点
- [ ] Task W3.7: Agent 页面（负载/失败率/等待时间/工具权限/预算/最近交接）；资源页面（锁持有者/到期时间/等待队列/安全释放）
- [ ] Task W3.8: 键盘快捷键（不得绕过审批）；大规模 Work Graph 性能基准
- [ ] Task W3.9: 输出 W3 波次报告（前后截图、关键 Diff、测试命令与结果、Gate 变化）

## W4：真实 GitHub Issue/PR/CI 同步闭环
- [ ] Task W4.1: 权限与 Token capability probe；dry-run 同步计划；人类批准后 apply
- [ ] Task W4.2: WorkItem↔Issue 稳定映射；任务分支/commit/PR/review/CI/Gate 追踪链
- [ ] Task W4.3: 幂等键与重复提交保护；部分成功后的补偿与续传；API rate limit 与退避
- [ ] Task W4.4: 外部 Issue/PR 被人工修改后的 reconciliation；冲突标红并创建补救任务，不静默覆盖
- [ ] Task W4.5: 同步状态机（planned/approval_required/applying/partially_applied/synced/conflicted/failed/retrying）
- [ ] Task W4.6: 为权限不足/仓库保护规则/PR 冲突/CI 失败/网络中断编写 E2E
- [ ] Task W4.7: 未获真实授权时不得登记为 live sync passed
- [ ] Task W4.8: 输出 W4 波次报告（关键 Diff、测试命令与结果、Gate 变化、真实授权状态）

## W5：移动工作台重构
- [ ] Task W5.1: 拆分领域模块：task-inbox/task-detail/barcode-scan/esop-runner/production-report/quality-inspection/exception-report/photo-evidence/offline-queue/sync-center/device-permissions/handoff-and-signoff
- [ ] Task W5.2: 页面组件不直接承载全部领域状态；用 reducer/状态机/领域 hooks；网络/离线存储/摄像头/UI 分层
- [ ] Task W5.3: 扫码优先与任务优先；单手操作；触控目标 ≥44×44 CSS px；自动带入工厂/工位/设备/任务/批次上下文
- [ ] Task W5.4: 离线同步中心显示待同步/同步中/失败/冲突/已完成；失败记录可查看原因/编辑/重试/安全丢弃
- [ ] Task W5.5: 冲突界面展示本地版本/服务端版本/差异/建议动作；照片上传前压缩、显示进度、失败重试/断点续传
- [ ] Task W5.6: 摄像头与存储权限被拒时提供替代输入；PWA 更新不中断未同步数据
- [ ] Task W5.7: 对断网/弱网/重复点击/应用重启/Token 过期/设备时间错误做 E2E
- [ ] Task W5.8: 登录页/扫码页/任务页/E-SOP/质检/异常/同步中心生成手机截图；测量并优化报工/质检/异常上报步骤与时间
- [ ] Task W5.9: 输出 W5 波次报告（前后截图、关键 Diff、测试命令与结果、Gate 变化）

## W6：工厂上线与复制体验
- [ ] Task W6.1: F0-F6 分阶段进度；环境/数据库/设备/ERP/身份/域名/证书预检
- [ ] Task W6.2: 阻塞项显示责任人/修复命令/重新检测按钮；Profile 差异预览；ERP/设备字段映射 dry-run
- [ ] Task W6.3: 样例数据与转换结果预览；正式应用前人类批准；失败后安全回滚；每步自动生成证据
- [ ] Task W6.4: 自动计算核心代码分叉数/配置覆盖率/自定义映射数/实施工时/TCK 通过率；真实工厂证据不存在时显示「尚未验证」；不得用夹具/模拟证据冒充第二/第三真实工厂
- [ ] Task W6.5: 输出 W6 波次报告（前后截图、关键 Diff、测试命令与结果、Gate 变化）

## W7：生产质量与持续观测 + 最终复验
- [ ] Task W7.1: Docker/Kubernetes/Helm 真实 runner 验证；安装/升级/灰度/失败回滚/数据库迁移演练；备份恢复与 RPO/RTO 测量
- [ ] Task W7.2: 24-72h 稳定性测试；大规模数据/Work Graph/证据/离线队列压力测试
- [ ] Task W7.3: 网络分区/消息重复/乱序/延迟/设备离线/时钟漂移测试；SBOM/依赖漏洞/镜像签名/制品校验和/密钥轮换
- [ ] Task W7.4: OpenTelemetry 前后端统一 trace；关键产品指标（页面错误率/Web Vitals/操作完成时间/扫码成功率/离线队列重放成功率/Git 同步成功率/Gate 等待时间/证据过期率/工厂复制配置覆盖率）；不采集不必要敏感数据
- [ ] Task W7.5: 独立验证 Agent 复核全部 Done 定义；RC4/下一候选版本差距报告
- [ ] Task W7.6: 更新任务依赖图、CHANGELOG/release notes、生产部署与回滚手册、真实工厂验证待办、独立验证报告、.codex/artifacts
- [ ] Task W7.7: 输出 W7 波次报告与最终交付（差距报告/依赖图/代码与迁移/完整测试证据/桌面平板手机截图/生产手册/真实工厂待办/独立验证报告/更新 artifacts）

# Task Dependencies
- W1 全部前置（先只读审计后改码）
- W2 依赖 W1（事实基线）；W3 依赖 W2（设计系统/视觉门禁）
- W4 依赖 W1（事实一致性）与 W2（设计系统）
- W5 可与 W3/W4 并行（独立模块）
- W6 依赖 W1（事实基线）与 W2（设计系统）
- W7 依赖 W2–W6 全部完成
- 高风险任务（事实一致性、GitHub 同步 apply、生产工程、工厂上线）由独立验证 Agent 复核，不由实现 Agent 自签