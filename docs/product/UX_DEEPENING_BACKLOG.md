# UX 深化 Backlog（用户体验统一 · 第四阶段）

> 项目：EWOH 工厂具身智能操作系统
> 版本：本文件覆盖 `latest-head-audit-and-deepening` 规格第四阶段（用户体验统一）的 13 项深化清单（3.1–3.13）。
> 原则：**只记录真实代码/测试证据，不伪造；依赖真实环境（PG/浏览器/真机/批准）的项明确标注。**
> 生成日期：2026-08-04。维护：EWOH 总控工程 Agent（独立审计视图）。

## 状态图例

- ✅ **已实现**：代码 + 类型检查 + 单测通过，可静态验证。
- ⚠️ **部分实现**：主体实现存在，但存在明确缺口或需真实环境复核。
- 🟡 **待真实环境**：实现存在，但需真实 PG/浏览器/真机/批准才能验收。
- 🔲 **未实现**：无实现或仅占位。

---

## 3.1 统一术语 / 状态机 / 权限 / 状态颜色 / 操作结果

- **角色**：所有最终用户（操作员/班组长/质检员/设备员/工艺员/工厂管理者/实施人员/项目 Owner）。
- **问题**：工业软件中同一对象在不同页面用不同术语（如"工单/任务/工序"）与不同颜色表达状态，导致跨页面认知偏差。
- **当前行为**：✅ 状态颜色与中文标签在 `RoleWorkbench.tsx`、`Devices.tsx`、`DataSourceBadge.tsx` 等组件内统一为 `hsl(220 14% …)` 色板并使用中文标签；`DataSourceBadge` 覆盖 real/simulated/controlled_test/replayed/stale/offline 来源类型的中文与颜色映射。
- **目标行为**：将术语/状态机/状态颜色/操作结果收敛为一份共享映射（单一事实源），供所有页面引用，避免各页面各自硬编码。
- **页面**：RoleWorkbench、Devices、MobileWorkbench、WorkOrchestration。
- **API 或状态机依赖**：MES 状态机（`nextStepStatus`/`nextWorkOrderStatus`）、`sourceType` 枚举。
- **优先级**：P1。
- **验收**：抽查 3 个核心页面，同一状态（如"进行中/待接单/已交接"）术语与颜色一致。
- **Playwright 场景**：`ux009` 断言状态文本与颜色；视觉回归（`playwright.visual.config.ts`）。
- **前后对比截图**：🟡 待真实浏览器录屏。

## 3.2 建立共享设计 Token 与组件 Schema

- **角色**：前端开发、设计系统维护者。
- **问题**：颜色/间距/圆角以字面量散落（`hsl(220 14% …)`、`p-4`、`rounded-lg`），无统一 Token 与组件契约，改造易漂移。
- **当前行为**：⚠️ 组件库 `client/src/components/ui/*`（Radix 封装）已提供按钮/表格/对话框/Skeleton 等基底；`QueryState`/`ErrorState` 提供统一状态组件；但颜色仍以 inline `hsl()` 字面量为主，无独立 Token 文件。
- **目标行为**：建立语义化设计 Token（颜色/间距/字号/圆角/状态色）与组件 Schema，供页面引用，支持高对比度与中文排版。
- **页面**：全局（AppShell、所有页面）。
- **API 或状态机依赖**：无（纯前端）。
- **优先级**：P1。
- **验收**：新增 Token 文件后，抽查 3 页无新增硬编码颜色字面量。
- **Playwright 场景**：`ux007` 无障碍 + 高对比度检查。
- **前后对比截图**：🟡 待真实浏览器。

## 3.3 每个页面完整处理九态（Loading/Empty/Partial/Denied/Offline/Conflict/Expired/Failure/Retry/Success）

- **角色**：所有最终用户。
- **问题**：页面在部分失败/离线/过期/冲突时可能卡死或静默失败。
- **当前行为**：✅ 抽查 `Devices`、`WorkOrchestration`（含 10 个子面板）、`RoleWorkbench` —— Loading/Empty/Error(Severity: Failure/Denied/Offline/Validation)/Success 均通过 `QueryState`/`ErrorState` 覆盖；Conflict 由 `WorkOrchestration` 冲突横幅与 `MobileWorkbench` 冲突解析覆盖；Partial 由分面板独立 `QueryState` 覆盖。本轮为 `Devices` 页补充 **Expired/Stale** 态（超过 2 个刷新周期显示"数据已过期"）。
- **目标行为**：每页九态全覆盖，过期/离线/冲突有明确提示与可恢复动作。
- **页面**：Devices、WorkOrchestration、RoleWorkbench、MobileWorkbench 等全部最终用户页。
- **API 或状态机依赖**：`parseError`/`ErrorKind`（permission/validation/connection/server/unknown）、`parseConflictPayload`。
- **优先级**：P0。
- **验收**：九态抽查清单逐格通过；`ErrorState` 对服务器/网络/权限分类呈现。
- **Playwright 场景**：`ux009` 网络断开/权限不足/会话过期/冲突。
- **前后对比截图**：🟡 待真实浏览器。

## 3.4 错误提示含发生了什么/为什么/是否已保存/下一步/可否重试或回滚

- **角色**：所有最终用户。
- **问题**：报错仅显示"操作失败"，用户无法判断是否已保存、下一步怎么做、能否回滚。
- **当前行为**：✅ `ErrorState` 输出错误码、请求 ID、信息、推荐操作，并提供"重试/返回安全状态/保存草稿/复制诊断信息"；`forceResolveStep` 冲突解析区分"本地变更仍无法应用，已保留服务端状态"。
- **目标行为**：所有错误提示统一包含"发生了什么/为什么/数据是否已保存/下一步/可否重试或回滚"。
- **页面**：全部最终用户页。
- **API 或状态机依赖**：`errorContract.ts`（errorCode/recommendedAction/requestId）。
- **优先级**：P0。
- **验收**：抽查 3 页错误文案含上述五要素。
- **Playwright 场景**：`ux009` 断言错误文案要素。
- **前后对比截图**：🟡 待真实浏览器。

## 3.5 角色化「下一步行动」首页（8 类角色）

- **角色**：操作员/班组长/质量员/设备员/工艺员/工厂管理者/实施人员/项目 Owner。
- **问题**：统一首页不贴合各角色关注的指标与待办。
- **当前行为**：✅ `RoleWorkbench.tsx` 为角色提供 KPI 卡片 + 列表聚合，支持空/加载/失败态。
- **目标行为**：按角色 Schema 呈现"下一步行动"（待办/审批/风险/告警），支持排序/筛选/保存视图/导出/下钻。
- **页面**：RoleWorkbench。
- **API 或状态机依赖**：后端 role aggregation（`/api/work/…` 聚合）。
- **优先级**：P1。
- **验收**：8 类角色各呈现对应 KPI 与待办；空/加载/失败态正确。
- **Playwright 场景**：`ux009` 登录不同角色断言首页内容。
- **前后对比截图**：🟡 待真实浏览器。

## 3.6 全局搜索与命令面板

- **角色**：所有用户。
- **问题**：跨对象检索需逐个页面进入，效率低。
- **当前行为**：✅ `components/app-shell/GlobalSearchCommand.tsx` 命令面板 + 全局搜索已实现。
- **目标行为**：覆盖任务/人员/设备/工单/批次/告警/证据/Gate 的全局检索与命令跳转。
- **页面**：AppShell（全局）。
- **API 或状态机依赖**：全局搜索 API（`/api/search` 或等价）。
- **优先级**：P1。
- **验收**：命令面板可检索并跳转多种对象。
- **Playwright 场景**：`ux009` 命令面板打开/检索/跳转。
- **前后对比截图**：🟡 待真实浏览器。

## 3.7 关键对象统一时间线/状态历史/责任人/关联证据

- **角色**：班组长、质管员、工厂管理者、项目 Owner。
- **问题**：工单/设备/批次等对象的历史分散，无法统一追溯。
- **当前行为**：⚠️ 因果控制台 `WorkGraphPanel` 支持节点证据抽屉、`GatesPanel` 支持门禁历史/撤销；工单/设备对象级统一时间线不完整。
- **目标行为**：关键对象统一时间线（状态历史/责任人/关联证据/变更）。
- **页面**：WorkOrchestration、工单/设备详情。
- **API 或状态机依赖**：`/api/work/gates/{id}/history`、审计日志。
- **优先级**：P2。
- **验收**：对象详情呈现状态历史与责任人。
- **Playwright 场景**：`ux009` 打开对象详情断言时间线。
- **前后对比截图**：🟡 待真实浏览器。

## 3.8 因果图缩放/聚焦关键路径/折叠低优先级/保存个人视图/大图虚拟化/键盘导航/高对比度

- **角色**：工厂管理者、项目 Owner、实施人员。
- **问题**：大型 DAG 难以阅读与定位关键路径。
- **当前行为**：✅ `WorkGraphPanel` 提供图表缩放、关键路径/阻塞高亮、节点详情、键盘选择；`buildGraphLayout` 3000 节点实测 10.472ms（PASS 预算）。
- **目标行为**：支持聚焦关键路径、折叠低优先级、保存个人视图、大图虚拟化、键盘导航、高对比度。
- **页面**：WorkOrchestration → WorkGraphPanel。
- **API 或状态机依赖**：Work Graph 数据（`queryKeys.workGraph`）。
- **优先级**：P2。
- **验收**：性能预算项 PASS；关键路径高亮可定位。
- **Playwright 场景**：`ux009` 大图滚动/缩放/键盘导航。
- **前后对比截图**：🟡 待真实浏览器。

## 3.9 移动 E-SOP 深化（扫码优先/单手/大触控/离线缓存/同步状态/冲突可解释/步骤签收/附件/质检/异常/外骨骼确认）

- **角色**：操作员、班组长、质检员。
- **问题**：移动端在车间弱网/离线环境下需可靠执行 E-SOP。
- **当前行为**：✅ `MobileWorkbench.tsx` + `useOfflineWorkbench.ts` 实现 IndexedDB 离线缓存、幂等队列、冲突解析、附件、质检、异常；✅ 本轮闭合 **G4 离线冲突强制解析闭环**（后端 `serverValue`+幂等 `force-resolve` 端点，前端实际调用）。
- **目标行为**：扫码优先、单手/大触控/工业手套适配、离线缓存、同步状态明确、冲突可解释、步骤签收/附件/质检/异常/外骨骼确认。
- **页面**：MobileWorkbench。
- **API 或状态机依赖**：`/api/mobile/workbench/orders/{id}/steps/{stepId}/force-resolve`、`/api/mes/work-orders/{id}/steps/{stepId}/force-resolve`。
- **优先级**：P0。
- **验收**：离线冲突解析闭环（单测覆盖 force-resolve 4 场景）；真机流程待真实设备。
- **Playwright 场景**：`ux009` 移动端离线/重启/冲突/扫码/照片。
- **前后对比截图**：🟡 待真机/浏览器。

## 3.10 禁止静默覆盖解决离线冲突

- **角色**：操作员、班组长、现场管理员。
- **问题**：离线写回冲突时，若静默覆盖本地或服务端状态会造成数据丢失。
- **当前行为**：✅ 后端 `forceResolveStep` 状态机权威、绝不绕过；`resolution:'local'` 重新走合法状态机，仍冲突则 `applied=false` 并保留服务端状态（`LOCAL_CONFLICT_PERSISTS`）。前端 `resolveConflict` 在离线时提示"无法提交冲突解析，请恢复网络后重试"，且明确提示"已保留服务端状态"。
- **目标行为**：所有冲突解决必须显式选择（本地/服务端/手动），禁止静默覆盖，且全程审计。
- **页面**：MobileWorkbench。
- **API 或状态机依赖**：`forceResolveStep`（幂等）、`parseConflictPayload`。
- **优先级**：P0。
- **验收**：单测覆盖 4 场景（server 保留且幂等 / local 重放成功 / local 仍冲突保留服务端 / 非法 resolution 拒绝）。
- **Playwright 场景**：`ux009` 冲突时显式选择并断言服务端状态未被静默覆盖。
- **前后对比截图**：🟡 待真实浏览器。

## 3.11 首次使用引导/示例工厂/演示数据/角色化 Quick Start

- **角色**：实施人员、新用户、项目 Owner。
- **问题**：新工厂上线缺少引导与演示数据，上手成本高。
- **当前行为**：⚠️ `Scale.tsx` 提供 F0–F6 工厂规模化引导（`/api/scale/onboarding/run`）；角色化 Quick Start、示例工厂/演示数据包不完整。
- **目标行为**：首次使用引导 + 示例工厂 + 演示数据 + 角色化 Quick Start。
- **页面**：Scale / 新用户首页。
- **API 或状态机依赖**：`/api/scale/onboarding/run`。
- **优先级**：P2。
- **验收**：新用户可一键进入示例工厂并完成角色化走查。
- **Playwright 场景**：`ux009` 首启引导流程。
- **前后对比截图**：🟡 待真实浏览器。

## 3.12 响应式/可访问性/中文排版/超长文本测试

- **角色**：所有用户，含无障碍需求用户。
- **问题**：工业平板/低端设备与中文长文本在窄屏下排版可能溢出。
- **当前行为**：✅ `ux007` 无障碍（键盘/焦点/aria/高对比度/触控尺寸）已实现并有 axe 自动化；`Devices` 表格 `overflow-x-auto` 处理超长文本。
- **目标行为**：响应式多视口、无障碍、中文排版、超长文本不溢出。
- **页面**：全局。
- **API 或状态机依赖**：无。
- **优先级**：P1。
- **验收**：axe 无 Critical/Serious；多视口视觉回归通过。
- **Playwright 场景**：`ux007` 无障碍 + `ux009` 多视口。
- **前后对比截图**：🟡 待真实浏览器。

## 3.13 前端性能基线并防回归

- **角色**：前端开发、性能守护者。
- **问题**：缺乏可重复性能基线，回归难发现。
- **当前行为**：✅ `ux008` 性能基线报告（10 维度预算表，PASS 2：graph layout 10.472ms / offline queue 19.994ms，pending 8 待真实环境）；`client/src/lib/perfBudget.ts` + `scripts/perf-budget.mjs` 接入判定。
- **目标行为**：CI 性能预算门禁，防回归。
- **页面**：全局。
- **API 或状态机依赖**：`perf-budget.mjs`（CI）。
- **优先级**：P1。
- **验收**：预算项 PASS 或明确 pending；CI 接入。
- **Playwright 场景**：`ux008` 性能基线脚本。
- **前后对比截图**：🟡 待真实浏览器。

---

## 汇总

| 条目 | 状态 | 优先级 |
|------|------|--------|
| 3.1 统一术语/状态机/颜色 | ✅ 已实现（扎根） | P1 |
| 3.2 设计 Token / 组件 Schema | ⚠️ 部分实现 | P1 |
| 3.3 每页九态 | ✅ 已实现（本轮补 Devices 过期态） | P0 |
| 3.4 错误提示五要素 | ✅ 已实现 | P0 |
| 3.5 角色化首页 | ✅ 已实现 | P1 |
| 3.6 全局搜索/命令面板 | ✅ 已实现 | P1 |
| 3.7 对象统一时间线 | ⚠️ 部分实现 | P2 |
| 3.8 因果图增强 | ✅ 已实现 | P2 |
| 3.9 移动 E-SOP 深化 | ✅ 已实现（本轮闭合 G4 冲突闭环） | P0 |
| 3.10 禁止静默覆盖冲突 | ✅ 已实现（本轮 G4） | P0 |
| 3.11 首启引导/示例工厂 | ⚠️ 部分实现 | P2 |
| 3.12 响应式/无障碍/中文排版 | ✅ 已实现 | P1 |
| 3.13 性能基线防回归 | ✅ 已实现（8 项待真实环境） | P1 |

> 说明：本 Backlog 为深化与缺口闭合视图，不扩围业务。所有"🟡 待真实环境"项依赖真实 PG/浏览器/真机/人工批准，未伪造结果。
> 相关证据：`docs/reviews/LATEST_HEAD_AUDIT.md`（第 13 节 Phase 3 G4 闭环）、`docs/reviews/ux008-performance-baseline.md`、`docs/reviews/ux007-a11y-exceptions.md`。