# W3 波次报告：因果执行控制台 UX 深化

> 波次：W3（RC4 候选版本产品化深化）
> 时间：2026-08-04
> 分支：`main`；HEAD：`ac9ff88ca8535ef7606b75072bd6089be9331b0b`
> Owner：交互设计负责人 / 首席软件架构师 / 独立质量验证负责人
> 前置：W2（视觉资源链修复与设计系统）已完成

## 1. 发现的问题

| 编号 | 严重度 | 问题 | 处置 |
|------|--------|------|------|
| W3-1 | 高 | 执行控制台默认首页无法回答「当前 Gate / 阻塞项 / 最长等待 / 过期证据 / 待人类决策 / 下一最优行动 / 过载」 | 新增执行态势概览（W3.1） |
| W3-2 | 高 | 过多横向标签在窄屏可读性差，无命令面板、无全局搜索入口、无 URL 深链接 | 改为响应式侧边导航 + 命令面板 + 深链接（W3.2） |
| W3-3 | 中 | 无预设视图，用户无法快速聚焦「我的待办/阻塞/待批准/证据过期/资源冲突」 | 新增 6 个预设视图（W3.3） |
| W3-4 | 中 | DAG 缺阶段折叠、上下游追踪、异常回流高亮、自动聚焦关键路径、布局（含缩放）保存 | 补齐（W3.4） |
| W3-5 | 中 | 证据仅内联卡片，缺少完整元数据抽屉（commit/PR/测试命令/环境/校验和/验证人/有效期） | 新增 EvidenceDrawer（W3.5） |
| W3-6 | 中 | 批量 Gate 记录不展示影响范围/缺失证据/不可执行原因，存在盲目批量批准风险 | 新增 GateBatchPreviewDialog（W3.6） |
| W3-7 | 中 | Agent 页仅有基础字段，缺负载/失败率/等待/工具权限/预算/最近交接；资源页缺等待队列与安全释放提示 | 补齐（W3.7） |
| W3-8 | 低 | 控制台无快捷键（除 Cmd+K）；新增交互函数无语义级性能基线 | 新增快捷键与性能基准（W3.8） |

## 2. 完成的代码改动

- **W3.1 执行态势推导**：新增 `overviewModel.ts`（`deriveExecutionOverview`），从 WorkGraph 推导当前 Gate、阻塞任务、最长等待、过期/将过期证据、待人类决策风险、下一最优行动、人力/Agent 过载、资源冲突；`overviewModel.test.ts` 10 用例。
- **W3.1/W3.3 执行态势 UI**：新增 `ExecutionOverview.tsx`，默认首页展示「下一最优行动横幅 + 统计卡片 + 分区区块」，支持 6 个预设视图（总览/我的待办/阻塞项/待批准/证据过期/资源冲突）。
- **W3.2 导航与命令面板**：`WorkOrchestration.tsx` 改为响应式侧边导航（桌面垂直/移动横向滚动），新增 Cmd/Ctrl+K 命令面板，`tab` 落地 URL 深链接（`useUrlParam`）；`work.ts` 扩展 `WorkItem` 的 priority/dueAt/updatedAt。
- **W3.4 DAG 交互**：`graphLayout.ts` 新增 `groupStagesByWave`/`applyStageCollapse`/`isStageSummaryNode`/`traceUpstream`/`traceDownstream`/`exceptionBackflowNodes`；`WorkGraphPanel.tsx` 接入阶段折叠、上下游追踪、异常回流高亮、自动聚焦关键路径、布局（含缩放平移）保存/恢复；`graphLayout.test.ts` 补 7 用例。
- **W3.5 证据抽屉**：新增 `EvidenceDrawer.tsx`（右侧滑出），展示 commit/PR/测试命令/环境/产物/校验和/验证人/有效期/过期标识/未绑定提交标记；`EvidencePanel.tsx` 接入；`shared.tsx` `EvidenceRow` 向后兼容新增 `onSelect`。
- **W3.6 批量 Gate**：新增 `gateBatchModel.ts`（可执行性/缺失证据/影响范围推导）与 `GateBatchPreviewDialog.tsx`；`GatesPanel.tsx` 批量仅对可执行门禁生效，单条/撤销/历史保留。
- **W3.7 Agent/资源页**：新增 `agentsDerived.ts`（负载/失败率/等待/最近交接推导）；`AgentsPanel.tsx` 扩展列；`ResourcesPanel.tsx` 新增等待队列列与安全释放提示。
- **W3.8 快捷键与性能基准**：`WorkOrchestration.tsx` 新增数字 1-9 切换分区、`?` 快捷键帮助（注明不绕过审批）；`perf-bench.mjs` 新增 3000 节点规模下新交互函数性能基线。

## 3. 未完成项及真实原因

- **真实浏览器截图**：本波次以逻辑/类型/单测/性能验证为主，未在本机跑真实浏览器截图。执行控制台页面截图验证依赖真实后端与 Playwright 视觉基线，属 W7 生产复验范围（外部环境验证，不伪造结果）。
- **大规模 DAG 在真实浏览器渲染帧率**：性能基线为 node 环境纯函数实测；浏览器端窗口化渲染帧率需真实浏览器/低端平板，属 W7 生产质量验证。
- **审批烟囱闭环**：批量/单条 Gate 写操作仍依赖后端 `recordGateDecisions`/`revokeGateDecision` 真实生效，本波次未在真实后端上端到端验证，属 W4 真实 GitHub 闭环与 W7 范围。

## 4. 测试命令和结果

| 命令 | 结果 |
|------|------|
| `npx tsc --noEmit -p ewoh-spark-app/tsconfig.app.json` | 通过（0 错误） |
| `npx jest --config ewoh-spark-app/client/jest.config.cjs ewoh-spark-app/client/src/pages/WorkOrchestration/` | **27/27 通过**（overviewModel 10 + graphLayout 12 + graphText 5） |
| `npx eslint ewoh-spark-app/client/src/pages/WorkOrchestration/*.tsx` | 通过（0 错误） |
| `node ewoh-spark-app/scripts/perf-bench.mjs` | 成功，输出 `output/perf-bench.json` |
| `node ewoh-spark-app/scripts/perf-budget.mjs` | **PASS 2 / FAIL 0 / pending 8**（work-graph 3000 节点布局 8.5ms，预算 450ms） |
| 新增函数 3000 节点性能基线 | traceUpstream 36ms / traceDownstream 43ms / exceptionBackflow 0.65ms / stageCollapse 0.14ms，均远低于预算 |

## 5. 前后截图

- 本波次以逻辑与交互能力深化为主，未在本机生成真实浏览器截图。视觉基线沿用 W2 已在 `output/playwright/` 与 `ewoh-spark-app/output/` 的 6 页 × 3 视口截图；执行控制台新增区块的视觉基线留待 W7 生产复验抓取。

## 6. 关键 Diff

- `overviewModel.ts`：新增 `deriveExecutionOverview` 推导 7 项执行态势问题。
- `ExecutionOverview.tsx`：新增执行态势首页 + 预设视图。
- `WorkOrchestration.tsx`：响应式侧边导航 + 命令面板 + 快捷键 + URL 深链接。
- `graphLayout.ts`：新增阶段折叠/上下游追踪/异常回流纯函数。
- `EvidenceDrawer.tsx` / `GateBatchPreviewDialog.tsx` / `agentsDerived.ts` / `gateBatchModel.ts`：新增证据抽屉、批量 Gate 预览、Agent 派生指标、Gate 可执行性模型。
- `perf-bench.mjs`：新增 3000 节点交互函数性能基线。

## 7. 风险变化

- **风险下降**：控制台默认首页可回答核心执行问题，降低「无法定位阻塞/最长等待/待批准」的运营风险；批量 Gate 增加影响范围与缺失证据预览，降低盲目批量批准风险；证据抽屉提升可追溯性。
- **风险持平**：真实浏览器性能帧率、真实后端审批写、真实 GitHub 同步仍待 W4/W7 验证；不因本波次放宽边界。

## 8. Gate 状态变化

- W3 波次验收入口：lint / typecheck / unit / 性能预算通过；OpenAPI 契约、数据库、安全边界、证据 schema 均未改动，无新增破坏性变更。
- 完成度结论维持 **A（核心实现完整，但不具备生产/规模复制）**，因真实 PostgreSQL E2E、容器部署、真实设备、真实审批写与真实工厂仍待外部条件验证。

## 9. 下一波次依赖

- **W4（GitHub 同步闭环）** 依赖 W1 事实一致性、W2 设计系统与 W3 审批确认组件（`WriteConfirmDialog`/`GateBatchPreviewDialog` 可复用为 apply 审批入口）。
- **W5（移动工作台重构）** 与 W3 并行，不依赖本波次。
- **W7（生产复验）** 依赖 W3 的视觉基线补抓与真实浏览器性能验证。

## 10. 对应 commit SHA

- `d011284` — W3.1-W3.3 执行态势概览 + 预设视图 + 响应式导航/命令面板
- `04adfc4` — W3.4-W3.7 DAG 交互 + 证据抽屉 + 批量 Gate + Agent/资源页深化
- `ac9ff88` — W3.8 快捷键 + 大规模 Work Graph 性能基准