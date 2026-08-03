# 0.6.0-rc4 代码深化 · 工业 UX 产品化 · 真实试点准备 Spec

## Why

EWOH 已将大量能力推进到 `0.6.0-rc4`（252 个 work item、109 条 evidence、OpenAPI 248/248、E2E 33/33、jest 81/391、client 15/50）。但许多页面仍是"通用 JSON/表格渲染器"或超大单组件（如 `WorkOrchestration.tsx` 约 1400 行、`RoleWorkbench.tsx` 直接暴露原始字段名与对象 JSON），离线方案停留在轻量 localStorage，无障碍与性能预算缺失，Git 历史与真实工厂证据被用作"已完成"名义。本轮目标不是继续无限加功能，而是把已实现核心能力打磨成操作员、质检员、计划员、厂长、实施顾问和项目 Owner 可稳定使用、可理解、可恢复、可验收的工业产品。

## What Changes

- **只读审计**：先产出 `docs/reviews/rc4-code-ux-productization-gap.md`，列出已实现能力、自报证据 vs 独立复验差异、任务/Gate 状态冲突、生产与真实工厂外部阻塞、超大页面、原始字段暴露、离线/恢复风险、可观测性/测试覆盖差距、P0/P1/P2 排序、每项改动的依赖/所有权/风险/验收。
- **UX-001 角色工作台产品化**：`RoleWorkbench` 从通用 JSON/表格渲染器升级为 Schema 驱动的角色工作台（操作员/质检员/计划员/班组长/厂长），中文标签、单位、时间、百分比、枚举格式化；禁止普通用户直接显示原始 JSON；KPI 定义/来源/更新时间/异常解释；排序/筛选/保存视图/导出/下钻；语义链接；角色快捷动作；空/加载/部分失败/权限不足状态；原始字段与 JSON 仅限开发者诊断模式。
- **UX-002 因果执行控制台模块化**：拆分 `WorkOrchestration` 单体型页面为 Work Graph / Gate / Evidence / Agent / Risk / Resource / Handoff / Catalog / Git Sync / Site Readiness 模块；URL 可恢复筛选/选中/图层/时间范围；关键路径/阻塞传播/失败回流/过期证据高亮；节点深链接；缩略图/可调面板/保存视图；键盘选择/移动/打开/返回；大图虚拟化或适配大型 DAG；Agent/CI/Git/Gate 增量刷新；Gate 决策影响预览；批准/驳回/条件批准/撤销/历史 Diff；所有写操作显示 actor/reason/source/timestamp/rollback point。先建大型图性能基线，再写入 CI 性能预算，必须报告实测数据。
- **UX-003 移动工作台 Offline-first**：从 localStorage 升级为 IndexedDB 持久化（任务/步骤/草稿/附件/同步状态）；图片压缩/容量限制/断点续传/失败重试；刷新重启不丢数据；本地 vs 服务端冲突检测与"本地值/服务端值/差异/推荐选择"展示；自动保存草稿；断网状态中心/待同步数量/最后同步时间；相机二维码/条码扫描；扫码枪键盘输入模式；成功/失败/重复声音震动反馈；大触控/横屏/低端平板适配；每个离线操作幂等键与完整审计；不得绕过质量/安全/权限/审批状态机。
- **UX-004 统一错误恢复体验**：全部最终用户页面统一使用现有错误契约（errorCode/recommendedAction/requestId/retry/返回安全状态/保存草稿/复制诊断信息/权限不足-业务校验-连接失败-服务器故障差异化表达）；局部失败不得导致整页不可操作。
- **UX-005 Site Readiness 实施向导**：现有列表升级为 F0-F6 引导流程；环境/工具自动探测；数据库/K8s/Helm/对象存储/真实设备检查；ERP/设备/组织/身份映射向导；Mapping Dry Run；导入前后差异预览；缺失证据/责任人/截止时间；自动修复建议（未经批准不改生产）；培训/生产批准/业务签署；导出可审计验收包/交接包/未决项清单。
- **UX-006 全局应用外壳**：组织/工厂/产线/环境切换；版本与数据新鲜度；在线/离线/降级状态；面包屑；全局搜索；命令面板；最近访问；收藏视图；未处理风险/审批/同步失败入口。所有页面明确当前操作对象与数据版本。
- **UX-007 无障碍与设计系统**：WCAG 2.2 AA 核心页面；完整键盘操作/清晰焦点/跳转主内容/非仅颜色表达状态/屏幕阅读器语义/对话框焦点管理/图表与 DAG 文本替代视图/高对比度/触控目标尺寸/自动化 axe；中文优先预留 i18n；核心流程无 Critical/Serious；无法修复项形成批准例外记录。
- **UX-008 性能工程**：CI 性能预算（首屏资源/路由切换/大表格/大型 Work Graph/世界回放/移动离线队列/图片处理/API p95/慢查询/低端平板）；服务端分页/虚拟列表/按需加载/路由预取/缓存/增量更新；优化前后重复基准数据。
- **UX-009 端到端体验测试矩阵**：扩展 Playwright/E2E 覆盖角色、登录/权限/会话过期、正常/弱网/离线、离线重启恢复、数据冲突、扫码/照片/E-SOP/质量处置、Gate 批准/条件批准/驳回/撤销、Handoff、Git Sync、Site Readiness、视觉回归、无障碍、桌面/平板/手机视口；不得只断言 HTTP 200，须验证最终用户可见状态/动作/数据一致性。
- **UX-010 GitHub 与实时协作闭环**：深化 Git Sync（WorkItem↔Issue/PR 映射、Dry Run/变更预览、冲突检测、CI 状态回写、审批后执行、失败补偿、重复事件幂等、Webhook/轮询增量同步、统一时间线）；未经批准不得创建/合并/关闭高风险 PR。
- **独立验证与验收**：由独立验证 Agent 执行，不得原实现 Agent 自签；运行 `standalone-check.sh`、`pilot-readiness-check.sh`、`audit-repo-facts.js --strict`、`work-indexer --invariants`、`work-console --strict`，以及 typecheck/lint/unit/E2E/Playwright/axe/OpenAPI/DB 新鲜/升级/RLS/回滚/安全/性能/视觉回归；输出 15 项最终交付物。

## Impact

- **Affected specs**：`build-embodied-factory-os`、`deepen-embodied-factory-os`、`build-controlled-pilot-system`、`build-real-device-platform`（保持 C1-C9 契约、组织隔离、RLS、审计链、状态机、安全边界）。
- **Affected code**：`ewoh-spark-app/client/src/pages/RoleWorkbench/`、`pages/WorkOrchestration/`、`pages/MobileWorkbench/`、`components/`、`lib/`、`app.tsx`、`hooks/`；`ewoh-spark-app/server/`（错误契约、Git Sync、Site Readiness、审计）；`scripts/`、`tools/`、`docs/`、`openapi/`、`contracts/`。
- **Gates 影响**：G0-G9 保持/回退门禁不得回退；G10-G13 未取得真实环境证据与人类批准前不得标记 Passed。

## 边界（不可违反）

1. 先只读审计，再修改代码。
2. 不得仅依据 task-board Done 宣称产品完成。
3. 不得伪造测试、真实设备、真实工厂、业务签署或生产环境证据。
4. G10-G13 未取得真实环境证据与人类批准前不得标记 Passed。
5. 保持 C1-C9 契约、组织隔离、RLS、审计链、状态机与安全边界。
6. 实时安全控制继续留在本地控制器，AI/云端服务不得承担。
7. 工厂差异必须进入模板/Profile/Mapping/Connector/Policy/Scenario Pack，不得用客户专属核心分支解决。
8. 不得静默修改共享契约/数据库结构/OpenAPI；任何变更须提供兼容性说明、迁移、回滚与独立验证。
9. 仓库文件及 Git 历史仍是编排状态权威事实源；控制台不得成为第二套不可对账事实源。
10. 实现 Agent 不得自行验证自己负责的高风险任务。

## ADDED Requirements

### Requirement: 只读审计报告
系统 SHALL 产出 `docs/reviews/rc4-code-ux-productization-gap.md`，包含 10 项审计内容（已实现能力、自报 vs 复验差异、任务/Gate 冲突、外部阻塞、超大页面、原始字段暴露、离线/恢复风险、可观测性/测试覆盖、P0/P1/P2 排序、每项改动的依赖/所有权/风险/验收）。

#### Scenario: 审计完成
- **WHEN** 用户发起本轮迭代
- **THEN** 生成审计报告并提交，且大规模修改代码前完成审计

### Requirement: UX-001..UX-010 产品化能力
系统 SHALL 实现上述十项 UX 能力，逐项满足其明细子项。

### Requirement: 独立验证与验收
系统 SHALL 由独立验证 Agent 运行 5 个只读脚本 + 全套工程检查，并产出 15 项最终交付物，明确区分 已实现/仓库报告通过/独立复验通过/需要真实环境/需要人类批准。

#### Scenario: 验收标准
- **WHEN** 所有实现完成并通过独立验证
- **THEN** 满足 12 条验收标准（普通角色不暴露原始字段、离线数据刷新重启不丢、冲突可看可处理、高风险写入有理由/影响预览/审计/回滚、Work Graph 约定规模可交互且提交实测、核心页面纯键盘、无 Critical/Serious axe、新增 API 入 OpenAPI/契约、新增状态入状态机/审计/错误契约、门禁不回退、不把模拟复制说成真实复制、不把本地通过说成生产通过）

## MODIFIED Requirements

### Requirement: 现有错误契约统一使用
复用现有 `exception.filter.ts` / `api_response.interface.ts` / `ErrorResponse`，在全部最终用户页面统一展示 errorCode/recommendedAction/requestId/重试/返回安全状态/保存草稿/复制诊断信息。

## REMOVED Requirements

### Requirement: 普通用户页面直接暴露原始对象 JSON
**Reason**: 违背工业 UX 产品化目标，暴露技术细节与内部字段。
**Migration**: 改为 Schema 驱动 + 中文业务标签；原始字段与 JSON 仅限有权限的开发者诊断模式。

### Requirement: 超大单体页面累积所有逻辑
**Reason**: `WorkOrchestration.tsx` 等单页不可维护、不可恢复、不可测试。
**Migration**: 拆分为独立模块组件，支持 URL 恢复、深链接、保存视图与增量刷新。