# RC4 候选版本产品化深化 Spec

## Why
将当前 0.6.0-rc4 候选版本从「核心实现完成」深化为可正式交付的产品级候选：仓库事实完全一致、界面达到产品化水平、移动现场作业真正易用、GitHub/证据/Gate/Agent 编排形成真实闭环、并可接受生产与真实多工厂验证。本轮不继续无边界增加业务功能。

## What Changes
- 新增权威事实采集与一致性 CLI（repository-facts schema），状态/版本/缺失 commit SHA/过期证据返回非零退出码，并接入 CI 与 release gate。
- 补齐 rc3、rc4 CHANGELOG 与 release notes；统一测试证据统计口径；清理 task-board/phase-state/gates/Next Waves 陈旧状态。
- 修复视觉资源链（Tailwind/CSS 加载、静态资源路径、CSP、截图时机），建立产品级设计系统（design token + 统一组件），引入视觉回归与 axe 无障碍门禁。
- 重构因果执行控制台信息架构（默认首页回答 Gate/阻塞/等待/过期证据/风险/最优行动/过载），不改变领域契约。
- 完成真实 GitHub Issue/PR/CI 同步闭环（权限探测→dry-run→人类批准→apply→幂等→补偿→reconciliation），保留离线文件模式。
- 拆分 MobileWorkbench 为独立领域模块，扫码/任务优先、单手操作、离线同步中心、冲突可解释、照片压缩与断点续传。
- 实现工厂上线可视化向导（F0-F6 分阶段、预检、dry-run、人类批准、安全回滚、自动计算实施指标）。
- 补充生产质量与持续观测（Docker/K8s/Helm 验证、备份恢复 RPO/RTO、24-72h 稳定性、压力测试、OTel 统一 trace、关键产品指标）。
- 每个波次结束输出：问题、代码改动、未完成项及原因、测试命令与结果、前后截图、关键 Diff、风险变化、Gate 状态变化、下一波次依赖、commit SHA。

## Impact
- Affected specs: 权威制品一致性、因果执行控制台、UX 统一、GitHub 同步、移动工作台、工厂上线、生产工程。
- Affected code: README、CHANGELOG、release/、openapi/、contracts/、tools/、ewoh-spark-app/、ewoh-feishu-app/、output/、.codex/artifacts/。
- 保持向后兼容；破坏性契约变更必须提供版本化迁移与回滚方案。

## 执行边界（必须遵守）
- 仓库文件仍为单一事实源；控制台不得成为第二套不可追踪事实源。
- 不得伪造真实工厂、伙伴交付、生产 SLO、人工批准或外部 GitHub 写入证据。
- 不得以生产 Stub、静态假数据或仅返回成功状态的占位实现冒充完成。
- 不得放宽组织隔离、RLS、审计、审批和高风险控制边界。
- 涉及生产环境、外部仓库写入和不可逆操作时，只实现到审批和安全执行入口，不得代替人类批准。
- 实现 Agent 不得自行验证自己的高风险任务。
- 外部生产与真实工厂条件未满足时，Pilot Readiness 必须继续显示 NOT READY。
- 每项自动修复必须产生可审查 Diff，不得静默覆盖源文件。

## ADDED Requirements

### Requirement: 权威事实一致性 CLI
系统 SHALL 提供 repository-facts 采集与一致性 CLI，对状态冲突、版本冲突、缺失 commit SHA、过期证据返回非零退出码，并输出可审查 Diff 而非静默覆盖。

#### Scenario: 版本冲突检测
- **WHEN** README/CHANGELOG/release-manifest/state 描述不一致的版本或阶段
- **THEN** CLI 返回非零退出码并列出冲突项与修复建议

#### Scenario: 过期证据
- **WHEN** 证据缺少 commitSha/branch/command/suite/environment/startedAt/completedAt/result/artifactChecksum/verifier/expiresAt 或已过期
- **THEN** CLI 返回非零退出码并标记对应项

### Requirement: 产品级设计系统与视觉门禁
系统 SHALL 在真实生产构建中正常加载 CSS/静态资源，提供统一 design token 与组件，并在视觉回归、资源 404、console error、未处理异常、serious/critical 无障碍问题上阻断测试。

#### Scenario: 生产构建样式加载
- **WHEN** 以生产构建运行登录页/指挥中心/因果控制台/Git 同步/移动工作台/站点准备页
- **THEN** stylesheet 数量与关键组件 computed style 符合预期，无资源 404、console error 或未处理异常

### Requirement: 真实 GitHub 同步闭环
系统 SHALL 在保留离线文件模式的前提下，通过权限探测、dry-run 计划、人类批准后再 apply，实现 WorkItem↔Issue 稳定映射、任务分支/commit/PR/review/CI/Gate 追踪链、幂等与重复提交保护、部分成功补偿与续传、API 限流退避、外部人工修改后的 reconciliation，并对冲突标红并创建补救任务。

#### Scenario: 未授权时不得登记 live sync passed
- **WHEN** 未获得真实 GitHub 授权
- **THEN** 不得把模拟结果登记为 live sync passed，同步状态保持 planned/approval_required

### Requirement: 移动工作台拆分与离线体验
系统 SHALL 将 MobileWorkbench 拆分为独立领域模块，页面组件不直接承载全部领域状态，采用扫码/任务优先、单手操作（触控目标 ≥44×44 CSS px）、离线同步中心（待同步/同步中/失败/冲突/已完成）、冲突可解释（本地/服务端/差异/建议）、照片压缩上传与断点续传。

### Requirement: 工厂上线可视化向导
系统 SHALL 提供 F0-F6 分阶段上线向导，含环境/数据库/设备/ERP/身份/域名/证书预检、Profile 差异预览、ERP/设备字段映射 dry-run、样例数据预览、正式应用前人类批准、故障安全回滚、每步自动生成证据，并自动计算分叉数/配置覆盖率/自定义映射数/实施工时/TCK 通过率。真实工厂证据不存在时页面必须明确显示「尚未验证」。

## MODIFIED Requirements
### Requirement: 因果执行控制台
重新设计信息架构，默认首页优先回答当前 Gate、阻塞交付任务、最长等待、即将过期证据、待人类决策风险、下一最优行动、过载 Agent/人员/资源；横向标签改为响应式侧边导航与命令面板；DAG 支持平移缩放/聚焦关键路径/阶段折叠/渐进加载/节点搜索/上下游追踪/异常回流高亮/布局保存；批量 Gate 操作先显示影响范围与缺失证据；高风险操作支持条件批准/驳回/撤销/回滚点；键盘快捷键不得绕过审批。

### Requirement: 测试与验收门禁
每波次至少运行 lint、typecheck、unit、contract、OpenAPI coverage、PostgreSQL integration、HTTP E2E、authenticated Playwright E2E、visual regression、accessibility、security、repository facts consistency、release manifest verification。活跃 API 不得出现 500；OpenAPI 与实际路由一致；生产构建 CSS/静态资源正常加载；关键桌面与移动流程有稳定截图；无 serious/critical 无障碍问题；所有证据绑定 commit SHA 与环境。

## REMOVED Requirements
无（本轮无删除需求）。