# [latest-head-audit-and-deepening] Spec

## Why

当前仓库基于最新 HEAD（`e432f36`，分支 `codex/ewoh-iteration-2026-08-04`）完成了上一轮 UX 产品化。但「任务板 Done ≠ 功能完成」，必须以当前 HEAD、实际代码、可执行测试、OpenAPI、数据库生成器、部署工件和独立验证证据为唯一判断基础，开展一次「代码完成度独立审计 + 产品化深化 + 用户体验优化」。防止历史文档假设、防止重复开发、防止把模拟演练描述成真实验收。

## What Changes

- 第一阶段：独立完成度审计，产出 `docs/reviews/LATEST_HEAD_AUDIT.md`。
- 第二阶段：权威制品一致性 + Work Graph 治理（版本化 Schema、制品注册表、解析器、自动对账 CLI、pre-commit/CI 门禁）。
- 第三阶段：深化因果执行控制台（只读优先，再受控写回；高风险写入由人类 Owner 批准）。
- 第四阶段：用户体验统一（术语/状态机/权限/设计 Token；每页 9 态处理；角色首页；全局搜索；E-SOP 移动深化）。
- 第五阶段：场景包与连接器深化（Order-to-Delivery、移动 E-SOP、质量追溯、库存/采购、设备/OEE、ERP/MRP/WMS 连接器 TCK）。
- 第六阶段：生产工程深化（可重复安装、DB 升级/回滚/备份/恢复、边缘断网/重连/重放、监控/SLO、SBOM/供应链安全、密钥/审计/脱敏、Runbook）。
- 最终结论只能从 A–E 五档中选择一个并给出证据，禁止模糊措辞。

## Impact

- 影响规格：全部既有 EWOH 能力（totality 审计）。
- 影响代码：`scripts/`、`tools/`、`server/`、`client/`、`ewoh-feishu-app/`、`src/edge_platform/`、`openapi/`、数据库迁移、`docs/`。
- 影响契约：OpenAPI、数据库 Schema Manifest、状态机、Gate 契约、共享契约（不得静默修改）。

## 边界（不可违反）

1. 先只读审计，再修改代码。
2. 禁止将任务板 Done 直接视为完成。
3. 不伪造测试、真实设备、真实工厂、业务签署或生产环境证据。
4. 不静默修改冻结的核心对象、状态机、安全边界和共享契约。
5. 实现 Agent 不得自行批准自己的高风险任务。
6. 不把模拟工厂演练描述成真实工厂验收。
7. 不把 EWOH 扩张成财务总账、应收、应付或完整 ERP。
8. 仓库文件与 Git 历史仍是权威事实源；控制台不得成为第二套不可对账事实源。
9. 实时安全控制继续留在本地控制器，不由 AI/云端承担。
10. 工厂差异进入模板/Profile/Mapping/Connector/Policy/Scenario Pack，不进入客户专属核心分支。
11. 缺少环境、真实设备、真实工厂、密钥或人工批准时，标记为 `Blocked by External Validation`，不得伪造结果。

## ADDED Requirements

### Requirement: 独立完成度审计（第一阶段）
系统 SHALL 基于当前 HEAD 与真实可执行证据，输出 `docs/reviews/LATEST_HEAD_AUDIT.md`，包含环境指纹、HEAD、实际命令、通过/失败/跳过、代码与测试证据路径、Gate 状态、权威制品冲突、未完成任务、高中低风险与建议实施顺序。

#### Scenario: 审计对象
- **WHEN** 对 T101–T114 逐项审计
- **THEN** 每项判定为 Verified Complete / Implemented but Unverified / Partial / Missing / Blocked by External Validation 之一，并给出代码/接口/测试/运行证据/commit SHA 关联。

### Requirement: 权威制品一致性（第二阶段）
系统 SHALL 提供版本化 Work Graph JSON Schema、制品路径注册表、Markdown/JSON/YAML 解析器与转换器，以及自动对账 CLI。

#### Scenario: 对账失败
- **WHEN** 关键字段缺失、冲突、非法依赖或状态倒退
- **THEN** CLI 返回非零退出码，输出明确 Diff 与修复建议，禁止自动静默修复权威源文件。

#### Scenario: Evidence 完整性
- **WHEN** 登记 Evidence
- **THEN** 必须包含 workItemId、commitSha、environment、dependencyFingerprint、result、producedAt、expiresAt、verifier、checksum。

### Requirement: 因果执行控制台深化（第三阶段）
系统 SHALL 提供非静态 DAG 的因果执行控制台，支持项目/客户/工厂/版本/Gate 切换、泳道、条件/证据/审批/回流/版本派生边、关键路径与阻塞传播、自然语言阻塞解释、节点证据抽屉、Agent/资源/权限/Handoff 视图、审批工作流。

#### Scenario: 写操作
- **WHEN** 用户修改 UI 状态
- **THEN** 生成可审计事件或 Git 提交；所有高风险写入必须由人类 Owner 批准；先只读，再受控写回。

### Requirement: 用户体验统一（第四阶段）
系统 SHALL 在每个页面完整处理 Loading/Empty/Partial/Denied/Offline/Conflict/Expired/Failure/Retry/Success 九态，错误提示包含发生了什么/为什么发生/数据是否已保存/下一步做法/可否重试或回滚，并建立角色化「下一步行动」首页、全局搜索与命令面板、统一时间线与状态历史。

#### Scenario: 移动 E-SOP
- **WHEN** 操作员在移动端执行 E-SOP
- **THEN** 扫码优先、单手操作、大触控、工业手套可用、离线缓存、同步状态明确、冲突可解释、支持步骤签收/附件/质检/异常/外骨骼确认；禁止静默覆盖解决离线冲突。

### Requirement: 场景包与连接器深化（第五阶段）
系统 SHALL 深化 Order-to-Delivery、移动 E-SOP、质量追溯、库存/采购、设备/OEE 场景包，并统一实现 ERP/MRP/WMS 连接器（Canonical Model、映射模板、游标、幂等、重放、补偿、死信、限流、数据质量、可观测性、Connector TCK）。

#### Scenario: 连接器
- **WHEN** 接入真实连接器
- **THEN** 不引入客户名称/客户专属字段判断/长期客户分支；核心服务保持中立。

### Requirement: 生产工程深化（第六阶段）
系统 SHALL 提供并验证可重复安装、DB 升级/回滚/备份/恢复、边缘断网/重连/重放/远程升级、监控/Tracing/SLO/错误预算、SBOM/供应链安全、密钥/审计/脱敏、长稳与大数据测试、批量升级/灰度/暂停/回滚、Runbook 与可验证回滚点。

### Requirement: 完成定义（Done 条件）
每个任务 SHALL 同时满足：代码实现、编译/Lint/类型检查、单元测试、集成或 E2E、UI 有 Playwright、安全边界测试、OpenAPI/DB/共享契约无未批准差异、文档与 Runbook、Evidence 登记并绑定 HEAD SHA 与环境指纹、独立验证 Agent 验证、明确回滚方案、对应 Gate 计算（G10+ 不得代替人类批准）。

## MODIFIED Requirements

### Requirement: 上一轮 UX 迭代产物（保持）
上一轮 UX-001..010 已实现能力保持有效；本规格不重复开发，只做证据补齐、测试补齐与追踪补齐。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。