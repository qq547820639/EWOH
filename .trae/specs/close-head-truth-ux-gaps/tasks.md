# Tasks

> 基于最新 HEAD（`7654045`，分支 `main`，`0.6.0-rc4`）的走读结论，分五个阶段收敛「事实源一致性」「真实缺口闭合」「UX 深化」「代码质量债」并验证。
> 边界：不伪造外部环境依赖；不改冻结契约；不扩围业务；每阶段以可执行验证收口。
> 状态：全部 5 个 Phase 已实施并验证通过。

## Phase 1：权威事实源一致性收敛（消除假阴性与假阳性）
- [x] Task 1.1: 修正 `feature-status.yaml` 的 `decisionCockpit` 字段为与真实代码一致
  - [x] 1.1.1 将 `implemented/tested/deployable` 改为 true（依据 `panels/DecisionCockpit.tsx`、`DecisionCockpitWorkspace.tsx`、`CommandMapShell.tsx` 接线与 `decision-cockpit-render-only.test.ts`）
  - [x] 1.1.2 补 evidence 数组（真实存在的代码与测试文件路径）
  - [x] 1.1.3 同步 README「能力状态清单」中 decisionCockpit 整行为「是/是/是/否/否/是」
- [x] Task 1.2: 清理 `feature-status.yaml` 中失效的 evidence 路径
  - [x] 1.2.1 将 `schedulerV2`、`benchmarkScheduler` 引用的 `output/bench-*.json`（4 个不存在文件）更新为真实的 `benchmark-scheduler-2026-08-07T14-39-03-704Z.json` 或删除
  - [x] 1.2.2 交叉核对其余 feature 的 evidence 是否指向真实文件
- [x] Task 1.3: 统一 DB 表口径（`managed_count` 与受管表列表）
  - [x] 1.3.1 核实 `schema-manifest.yaml` 的 `managed_tables` 实际条目数（57）与 `additional_hardened_existing_tables` 的语义
  - [x] 1.3.2 将 `managed_count` 与 `.codex/artifacts/state.json` 的「73 张受管表」修正为 57，并注明口径定义
- [x] Task 1.4: 跑 `truth-feature-status.js` 与 `reconcile-authoritative-artifacts.js` 验证
  - [x] 1.4.1 `node scripts/truth-feature-status.js` 无 decisionCockpit WARN（最终 31/31）
  - [x] 1.4.2 `node scripts/reconcile-authoritative-artifacts.js` 的 `dbConsistent` 与 evidence 路径检查通过（最终 6/6）

## Phase 2：真正未完成功能的诚实闭合
- [x] Task 2.1: 决策驾驶舱接线调度反馈 KPI
  - [x] 2.1.1 定位 `DecisionCockpit.tsx` 的 `feedback: null`，确认 CommandMap 上下文未接入 SchedulingFeedback，改为显式空态
  - [x] 2.1.2 无数据时展示「暂无调度反馈数据」空态，而非静默 null
  - [x] 2.1.3 补充/更新对应单测（decision-cockpit-render-only 测试通过）
- [x] Task 2.2: 占位能力 fail-closed 边界标注（不伪造）
  - [x] 2.2.1 `src/edge_platform/spatial/multi_factory.py` 的 `CrossFactorySchedulerStub` 加「仅 V2.0 骨架，禁止生产派工」门禁注释/断言
  - [x] 2.2.2 `src/edge_platform/scheduler/optimizer.py` 的 `CpSatOptimizer` 占位明确回退贪心并记录日志
  - [x] 2.2.3 前端 SiteReadiness / GitSync 占位项显式标注「待后端/现场接入」状态（不新增假实现）

## Phase 3：UX 深化（闭合 Backlog ⚠️ 项）
- [x] Task 3.1: 设计 Token 收敛（Backlog 3.2）
  - [x] 3.1.1 盘点核心页 inline `hsl()` 状态色字面量（RoleWorkbench/Devices/CommandMap）
  - [x] 3.1.2 收敛为 `lib/designTokens.ts` + `tokens.css` 语义 Token 引用
  - [x] 3.1.3 跑 `designTokens.test.ts` 与 `lint-design-tokens.mjs`
- [x] Task 3.2: 关键对象统一时间线（Backlog 3.7）
  - [x] 3.2.1 为设备详情接入统一时间线（状态历史/责任人/关联证据），复用 `components/ui/Timeline.tsx` 与 `lib/timelineModel.ts`
  - [x] 3.2.2 后端缺数据时给出明确空态
- [x] Task 3.3: 首启引导 + 示例工厂 + 角色化 Quick Start（Backlog 3.11）
  - [x] 3.3.1 补角色化 Quick Start 入口（复用 `OnboardingQuickStart.tsx` 与 `Scale.tsx` onboarding）
  - [x] 3.3.2 示例工厂/演示数据入口接线（不新增假后端数据）
- [x] Task 3.4: 清理孤儿/死页面
  - [x] 3.4.1 删除未接线的 `Overview/Events/Workers/CenterPlaceholder/ExamplePage`
  - [x] 3.4.2 删除前确认无 import 引用（含 `Overview.tsx` 的死链 `/events`、`/workers`）
- [x] Task 3.5: 修复 `Alerts.tsx` 离线横幅文案与真实行为不一致
  - [x] 3.5.1 使文案与 `transitionMutation`（直接请求）一致
  - [x] 3.5.2 修正 `pendingCount` 语义

## Phase 4：代码质量债收敛（低风险高价值）
- [x] Task 4.1: ingest 幂等查询 fail-open 修复
  - [x] 4.1.1 `ingest.service.ts` 中 `isDuplicateRawRef`/`entityExists` 在 DB 失败时从 fail-open 改为 fail-closed + 日志/指标
- [x] Task 4.2: work-orchestration 死代码清理
  - [x] 4.2.1 清理 `applyGitSyncDurable` 无效三元（`created ? result : result`）等死代码
- [x] Task 4.3: 导入卫生修复
  - [x] 4.3.1 `src/edge_platform/audit/logger.py` 改为直接 `from edge_platform.edge.storage import Storage`
- [x] Task 4.4: 飞书错误脱敏
  - [x] 4.4.1 `ewoh-feishu-app/server/api.js` 不再把 `e.message` 直返客户端，返回通用 INTERNAL，详情进日志

## Phase 5：验证与收口
- [x] Task 5.1: 全量静态与单测验证
  - [x] 5.1.1 前端 `type:check:client` + 后端 `type:check:server` 通过
  - [x] 5.1.2 `python -m pytest tests/ -q` 通过（161 passed, 10 skipped）
  - [x] 5.1.3 `truth-feature-status.js` 31/31 + `reconcile-authoritative-artifacts.js` 6/6 + `openapi:no-drift` 通过；后端 ingest 测试 5 passed；前端相关 37 套件 303 测试通过
- [x] Task 5.2: 文档收口
  - [x] 5.2.1 更新 README 能力状态清单与 CHANGELOG（记录本次事实源收敛与 UX 缺口闭合）

# Task Dependencies
- Phase 1 优先于一切（事实源修正后再改码，避免在错误基准上改）。
- Task 1.4 依赖 Task 1.1–1.3。
- Phase 2/3/4 可并行（互相独立模块），但均依赖 Phase 1 完成（以修正后的事实源为准）。
- Task 5.1 依赖 Phase 1–4 全部完成。
- Task 5.2 依赖 Task 5.1。
