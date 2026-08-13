# [close-head-truth-ux-gaps] 最新 HEAD 事实源收敛与 UX 深化 Spec

## Why

基于最新 HEAD（`7654045`，分支 `main`，版本 `0.6.0-rc4`）的全仓系统走读发现：调度域与边缘/飞书侧的工程质量已很高，但**代码层面的工作并未"全部实现"**，且存在「代码已完成却被权威事实源标为未完成」的假阴性、以及「证据/口径失效」的真假阳性，同时 UX 深化仍留有明确缺口。本规格一次性收敛这些矛盾并闭合剩余的用户体验缺口，使"任务板/事实源"与"真实代码"重新对齐。

## What Changes

- **事实源一致性收敛（消除假阴性与假阳性）**
  - 修正 `feature-status.yaml` 中 `decisionCockpit` 被错误标为全 false（代码已真实实现并接线）。
  - 修正 `feature-status.yaml` 中 `schedulerV2` / `benchmarkScheduler` 引用已不存在的 `output/bench-*.json` 失效证据路径。
  - 修正 `db/contracts/schema-manifest.yaml` 的 `managed_count` 与 `state.json` 的「73 张受管表」口径冲突（实际 managed_tables 列表 57 条），使 `reconcile` 的 `dbConsistent` 通过。
- **真正未完成功能的诚实闭合**
  - 为决策驾驶舱接线调度反馈 KPI（`DecisionCockpit.tsx` 的 `feedback: null` 补齐）。
  - 对依赖真实外部环境的占位能力（OIDC、跨工厂调度、CP-SAT Python optimizer、站点就绪、Git 同步）加显式 fail-closed 边界与「待接入」标注，**不伪造实现**。
- **UX 深化（用户明确关心的剩余缺口）**
  - 设计 Token 收敛（`UX_DEEPENING_BACKLOG` 3.2：颜色 inline `hsl()` 字面量 → 语义 Token）。
  - 关键对象统一时间线（3.7：工单/设备状态历史/责任人/关联证据）。
  - 首启引导 + 示例工厂 + 角色化 Quick Start（3.11）。
  - 清理孤儿/死页面（Overview/Events/Workers/CenterPlaceholder/ExamplePage）。
  - 修复 `Alerts.tsx` 离线横幅文案与真实行为（未接入离线队列）不一致。
- **代码质量债收敛（低风险高价值）**
  - 修复 ingest 幂等查询失败 fail-open（吞异常绕过幂等去重）改为 fail-closed + 日志。
  - 清理 work-orchestration 双 SSOT 死代码（`applyGitSyncDurable` 无效三元等）。
  - 修复 `src/edge_platform/audit/logger.py` 经 `stubs` 导入生产 Storage 的命名卫生。
  - 修复 `ewoh-feishu-app/server/api.js` 将 `e.message` 直返客户端的信息泄露。

## Impact

- 影响规格：权威事实源（feature-status、schema-manifest、state.json）、UX 深化 Backlog。
- 影响代码：`feature-status.yaml`、`db/contracts/schema-manifest.yaml`、`.codex/artifacts/state.json`、`ewoh-spark-app/client/src`（CommandMap/DesignToken/Timeline/Onboarding/孤儿页）、`ewoh-spark-app/server`（scheduler/ingest/work-orchestration）、`src/edge_platform`（audit）、`ewoh-feishu-app/server`（api.js）。
- 影响契约：不修改 OpenAPI/状态机/DB 迁移；仅修正声明性事实源与前端/服务实现。

## 边界（不可违反）

1. 先修正事实源与代码，不伪造外部环境依赖项（OIDC/跨工厂/真机/站点就绪/Git 连接器标 `Blocked by External Validation`）。
2. 不修改冻结的 OpenAPI 契约、状态机、DB 迁移 SQL 的语义。
3. 不扩围业务（不新增财务/ERP 总账等）。
4. 所有改动需通过 `truth-feature-status.js`、`reconcile-authoritative-artifacts.js`、前端 `type:check`/单测、后端单测。

## ADDED Requirements

### Requirement: 决策驾驶舱事实源对齐
系统 SHALL 将 `feature-status.yaml` 的 `decisionCockpit` 字段修正为与真实代码一致（`implemented/tested/deployable` 按真实实现与测试证据填写），并同步 README 能力状态清单。

#### Scenario: 消除假阴性
- **WHEN** 审计发现 `DecisionCockpit.tsx` 已被 `CommandMapShell.tsx` 的 `decision` 标签页接线并调用真实后端 API
- **THEN** `feature-status.yaml` 不再将其标为全 false，README 能力表同步为「是/是/是」。

### Requirement: 证据与口径一致性
系统 SHALL 移除或更新指向不存在文件的失效证据路径，并统一 `managed_count` 与受管表列表口径，使 `reconcile-authoritative-artifacts.js` 的 `dbConsistent` 与证据路径检查通过。

#### Scenario: 失效证据清理
- **WHEN** evidence 引用 `ewoh-spark-app/output/bench-*.json` 等已删除文件
- **THEN** 更新为真实存在的 `benchmark-scheduler-2026-08-07T14-39-03-704Z.json` 或删除该证据项。

#### Scenario: DB 表口径对齐
- **WHEN** `schema-manifest.yaml` 的 `managed_count`（73）与实际 `managed_tables` 列表长度（57）不一致
- **THEN** 统一为一个可复算口径，`reconcile` 的 dbConsistent 返回 true。

### Requirement: 决策驾驶舱反馈接线
系统 SHALL 为决策驾驶舱接线调度反馈 KPI，使 `DecisionCockpit.tsx` 不再以 `feedback: null` 空态呈现。

#### Scenario: 反馈展示
- **WHEN** 用户打开决策驾驶舱
- **THEN** 反馈段展示真实 planned-vs-actual 调度 KPI（或后端无数据时给出明确的「暂无反馈数据」空态，而非静默 null）。

### Requirement: 占位能力诚实边界
系统 SHALL 对依赖真实外部环境的占位实现（OIDC、跨工厂调度、CP-SAT Python optimizer、站点就绪探测、Git 同步）显式标注 fail-closed 边界与「待接入」状态，不冒充已完成。

#### Scenario: 防误接线
- **WHEN** 生产路径尝试使用 CrossFactorySchedulerStub / CpSatOptimizer 占位
- **THEN** 明确回退或抛错并记录日志，绝不静默产出误导性结果。

### Requirement: UX 剩余缺口闭合
系统 SHALL 闭合 `UX_DEEPENING_BACKLOG` 中标记为 ⚠️ 的部分实现项（3.2 设计 Token、3.7 对象统一时间线、3.11 首启引导/示例工厂），并清理未接线的孤儿页面。

#### Scenario: 设计 Token 收敛
- **WHEN** 页面存在 inline `hsl()` 状态色字面量
- **THEN** 收敛为 `lib/designTokens.ts` + `tokens.css` 的语义 Token 引用，核心 3 页（RoleWorkbench/Devices/CommandMap）无新增硬编码状态色。

#### Scenario: 对象统一时间线
- **WHEN** 用户打开工单/设备详情
- **THEN** 呈现统一状态历史、责任人、关联证据（或后端缺数据时给出明确空态）。

#### Scenario: 孤儿页清理
- **WHEN** 页面未被路由/导航引用（Overview/Events/Workers/CenterPlaceholder/ExamplePage）
- **THEN** 删除或接线，消除死代码与错误链接。

### Requirement: 代码质量债收敛
系统 SHALL 修复已识别的吞异常 fail-open 点、死代码、导入卫生与信息泄露问题。

#### Scenario: 幂等 fail-closed
- **WHEN** ingest 的 raw_ref 幂等查询在 DB 失败时返回 `false` 导致去重失效
- **THEN** 改为显式降级并记录日志/指标，保持 fail-closed 语义（DB 不可用时拒绝重复写入而非静默放行）。

## MODIFIED Requirements

### Requirement: 上一轮 UX 迭代产物（保持）
上一轮已实现并标记 ✅ 的 UX 项（九态、错误五要素、角色首页、全局搜索、因果图、移动 E-SOP、离线冲突闭环、无障碍、性能基线）保持有效，本规格不重复开发，仅补齐 ⚠️ 项与事实源一致性。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。
