# RC4 Code/UX Productization Gap Audit

> 审计对象：EWOH 仓库 `0.6.0-rc4` 真实代码。
> 审计方式：只读审计（未修改代码）。复核基于仓库文件、`.codex/artifacts` 产物、测试脚本与前端页面代码。
> 审计日期：2026-08-04。
> 结论：仓库自报已把大量能力推进到 rc4，但多处"已实现"停留在"通用渲染器/本地模拟/自报状态"，与工业 UX 产品化目标存在明确差距。本报告为后续 P0/P1 实施提供排序依据。

---

## 1. 已实现能力及代码位置

| 能力 | 代码位置 | 状态自报 |
|------|----------|----------|
| 错误契约（errorCode/requestId/retryable/recommendedAction/details） | `server/common/filters/exception.filter.ts`、`server/common/interfaces/api_response.interface.ts` | 已实现（自报） |
| 统一查询状态组件 | `client/src/components/QueryState.tsx` | 已实现 |
| 离线 pending 队列（localStorage 方案） | `client/src/lib/offlineQueue.ts` + `.test.ts` | 已实现（自报） |
| 附件 DataURL 转换 | `client/src/lib/attachmentDataUrl.ts` | 已实现 |
| 角色任务工作台（通用渲染器） | `client/src/pages/RoleWorkbench/RoleWorkbench.tsx` | 已实现（自报） |
| 因果执行控制台（单体） | `client/src/pages/WorkOrchestration/WorkOrchestration.tsx` | 已实现（自报） |
| 移动工作台 | `client/src/pages/MobileWorkbench/MobileWorkbench.tsx` | 已实现（自报） |
| 指挥地图 | `client/src/pages/CommandMap/CommandMap.tsx` | 已实现（自报） |
| Scale/Operations 页面 | `client/src/pages/Scale/Scale.tsx`、`Operations/Operations.tsx` | 已实现（自报） |
| 无障碍工具 | `client/src/lib/a11y.ts` + `a11y.test.ts` | 部分实现 |
| PWA service worker | `client/public/sw.js` | 已实现（自报） |
| 性能 smoke | `scripts/perf-smoke.js` | 已实现（自报） |
| 试点就绪检查 | `scripts/pilot-readiness-check.sh` | 存在，结果 NOT READY |
| 审计/OpenAPI/契约脚本 | `scripts/audit-repo-facts.js`、`scripts/standalone-check.sh`、`tools/work-indexer/`、`tools/work-console/` | 存在 |

## 2. 仓库自报证据 vs 独立复验结果差异

- 仓库自报（task-board / gates）：OpenAPI 248/248、E2E 33/33、server jest 81/391、client 15/50、work graph 252 items / 109 evidence / 0 冲突、G10-G13 仍 pending。
- 独立复验观察：
  - 上述数字多为仓库自报产物，`docs/delivery/acceptance-evidence.md` 区分了"本地/模拟/契约示例"与"真实环境"，但多数证据来源为本地 PostgreSQL、simulator、契约 fixture，**非真实工厂/真实设备/生产环境**。
  - `pilot-readiness-check.sh` 结果 NOT READY：7 passed / 3 failed（Docker/Kubectl/Helm 缺失）/ 5 pending 外部。
  - 前端"已实现"的页面多为通用渲染器，能力与"产品化"存在差距（见 §6）。
  - **差异结论**：仓库"通过"≠"产品化完成"≠"生产可用"。任务状态 Done 与 Gate 状态不一致（见 §3）。

## 3. 任务状态与 Gate 状态冲突

- task-board 中大量任务标记 `Done`，但关联 Gate 仍在 `Validation`/`Pending`（如 G7/G8/G9 标注 Validation，G10-G13 标注 Pending）。
- 特别是：G7 前端/指挥地图标注 `Validation`，但前端"产品化"能力（角色 schema、控制台模块化、离线持久化）实际存在缺口，不能仅凭 task-board Done 宣称完成。
- G10-G13 始终为 Pending，未取得真实环境证据与人类批准前，不得标记 Passed。

## 4. 生产环境与真实工厂外部阻塞项

- Docker / Kubectl / Helm 本地不可用（`pilot-readiness-check.sh` 3 项 failed）。
- 无真实工厂、真实设备、生产环境证据；当前为本地 PostgreSQL + simulator + 契约 fixture。
- ERP 连接、真实设备协议、业务签署、组织/身份映射均需现场与人/物证据。
- 这些阻塞项决定了 G10-G13 必须保持 Pending。

## 5. 超过 800 行页面或高耦合模块

| 文件 | 行数 | 问题 |
|------|------|------|
| `WorkOrchestration/WorkOrchestration.tsx` | 1403 | 单体型，10 个 tab 全部内联，逻辑高度耦合 |
| `Operations/Operations.tsx` | 1060 | 高耦合，通用渲染 |
| `MobileWorkbench/MobileWorkbench.tsx` | 951 | 高耦合，离线 + 步骤 + 扫描混在一起 |
| `Scale/Scale.tsx` | 807 | 接近阈值，高耦合 |
| `CommandMap/CommandMap.tsx` | 714 | 接近阈值 |

## 6. 原始字段、JSON、技术术语直接暴露给最终用户的页面

- `RoleWorkbench.tsx`：用 `Object.keys(row)` 作为表头，`JSON.stringify(cell)` 渲染单元格（L176）——直接把原始字段名与对象 JSON 暴露给普通用户。
- `WorkOrchestration.tsx`：直接展示 `gateId`、`status`、`sourcePath`、`actorId`、`evidenceId`、`checksum` 等技术字段。
- `CommandMap.tsx`、`Operations.tsx`、`Scale.tsx`：同样存在 `Object.keys(row)` 表头与 `JSON.stringify(cell)` 单元格渲染。
- 技术术语（status/sourcePath/gateId/actorId/owner）未做中文业务标签映射。

## 7. 离线、附件、冲突、弱网和恢复风险

- 当前离线队列基于 `localStorage`（`offlineQueue.ts`，`PENDING_ACTIONS_STORAGE_KEY = 'ewoh.mobile.pending-actions.v1'`），**非 IndexedDB**。
- 风险：
  - localStorage 容量有限（~5MB），附件 DataURL 存储易超限，无容量管理/压缩/断点续传。
  - 无服务端 vs 本地"值级冲突"展示（仅 409 STATE_CONFLICT 标记，无"本地值/服务端值/差异/推荐选择"）。
  - 无自动保存草稿、断网状态中心、待同步数量面板、最后同步时间展示。
  - 无扫码枪键盘输入模式、无相机扫码、无声/震动反馈。
  - `sw.js` 提供基础缓存，但弱网/离线重启恢复能力未在页面层验证。
- 需据此实施 UX-003 的 IndexedDB 持久化升级。

## 8. 无障碍、性能、可观测性和测试覆盖差距

- 无障碍：`a11y.ts` 工具存在，但无自动化 axe 检查接入 Playwright/CI；无 WCAG 2.2 AA 扫描、无键盘操作/焦点管理/文本替代视图的系统性验证；核心流程 axe Critical/Serious 未扫描。
- 性能：`perf-smoke.js` 存在但无 CI 性能预算（首屏/大表格/大图/回放/离线队列/API p95/慢查询/低端平板）；无优化前后基准对比。
- 可观测性：有 OTel 请求追踪、慢查询 API，但前端页面级数据新鲜度/错误可观测展示不足。
- 测试覆盖：Playwright 覆盖少量成功路径（5/5 自报），未覆盖弱网/离线/冲突/多角色/多视口/视觉回归/无障碍；E2E 断言以 HTTP 为主，未断言最终用户可见状态/数据一致性。

## 9. P0/P1/P2 排序

- **P0（先行，阻断产品化）**：
  - UX-001 角色工作台产品化（消除原始 JSON 暴露）
  - UX-002 因果执行控制台模块化 + 性能基线
  - UX-003 移动工作台 Offline-first（IndexedDB 持久化）
  - UX-004 统一错误恢复体验
  - UX-005 Site Readiness 实施向导
- **P1（体验与工程化）**：
  - UX-006 全局应用外壳
  - UX-007 无障碍与设计系统
  - UX-008 性能工程
  - UX-009 端到端体验测试矩阵
  - UX-010 GitHub 与实时协作闭环
- **P2（后续）**：真实工厂/第二工厂验证、生产环境证据、业务签署、金标准验收。

## 10. 每项改动的依赖、代码所有权、风险与验收方法

| 改动 | 依赖 | 代码所有权 | 风险 | 验收方法 |
|------|------|-----------|------|----------|
| UX-001 角色工作台 | 后端 role aggregation | client `RoleWorkbench/` + server role API | 中途破坏现有数据展示 | 角色 schema 渲染 + 无原始 JSON + 单测 |
| UX-002 控制台模块化 | 现有 work API | client `WorkOrchestration/` 拆分 | 大图性能、回归 | 性能基线 + 拆分组件 + 单测/E2E |
| UX-003 离线升级 | IndexedDB 支持 | client `lib/offlineQueue.ts`、`MobileWorkbench/` | 数据丢失/冲突 | 刷新重启不丢 + 冲突可视 + 单测 |
| UX-004 错误恢复 | 现有错误契约 | client `components/` + 各页面 | 局部失败影响整页 | 统一错误组件 + 各页接入 + 单测 |
| UX-005 Site Readiness | 现有 site-readiness API | client `WorkOrchestration/` + server | 需审批才改生产 | F0-F6 向导 + 映射 dry-run + 单测 |
| UX-006 应用外壳 | 全局 context | client `components/Layout` + `app.tsx` | 导航回归 | 外壳组件 + 各页上下文 + 单测 |
| UX-007 无障碍 | 设计系统 | client 全局组件 | 核心流程回归 | axe 扫描 + 键盘走查 + 例外记录 |
| UX-008 性能 | 各页面 | client 全局 + server 分页 | 预算误报 | CI 预算 + 前后基准 |
| UX-009 E2E 矩阵 | 全部页面 | client `test/` + Playwright | CI 时长 | 覆盖矩阵 + 断言可见状态 |
| UX-010 Git Sync | 现有 git-sync | client `WorkOrchestration/` + server + `tools/git-sync/` | 误操作高风险 PR | 审批门禁 + 幂等 + 单测 |

---

## 附：审计脚本与证据

本报告为只读审计产物，未修改任何业务代码。后续实施将按 spec 顺序推进，并由独立验证 Agent 复核高风险任务（实现 Agent 不自我验证）。