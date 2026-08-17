# EWOH 二轮全仓逐行审计 + 架构收敛重构 + 全量回归 Spec

> 基线：HEAD `58b7819e`（main，2026-08-17 08:51，"fix(audit): 2026-08-17 逐行审计 950 项发现全量整改"）。
> 前置事实：第一轮逐行审计（`docs/audit/2026-08-17-line-by-line-audit.md`，950 项发现）及其全量整改已完成并合入本 HEAD。
> 本轮性质：一次性执行任务（审计 → 验证 → 修复 → 重构 → 测试 → 二次复审 → 最终报告），不是规划任务。

## Why

第一轮审计整改后的代码从未被整体复审过：950 项修复是否真实落地、是否引入回归、架构声明（World/Decision/Scheduler/Event/Edge/Agent/Learning 各 Kernel 边界）是否与代码一致，均无证据。本轮以当前 HEAD 真实代码为唯一事实源，完成旧发现回归验证、新问题发现、根因级架构收敛重构与全量回归，使 EWOH 向 Factory Embodied Intelligence Operating System 的闭环收敛。

## What Changes

- 新建 `docs/audit/current/` 审计体系：文件账本 `file-ledger.jsonl`、发现清单 `findings.jsonl`、旧发现回归 `old-finding-regression.yaml` 及 15 份报告（见 ADDED Requirements）。
- 对第一轮 950 项发现逐项源码复验（Critical/High 全量逐项，Medium/Low 按簇抽验+门禁验证），标记 FIXED_VERIFIED / STILL_PRESENT / PARTIALLY_FIXED / REGRESSED / NO_LONGER_APPLICABLE。
- 在当前 HEAD 上重新逐行审计全部活跃工程文件，新发现按 P0~P3 分级登记并修复（P0/P1 本轮必须关闭）。
- 架构真实性验证与必要重构：
  - World State 数量/权威源清点；若多 Domain 各自拼装世界事实 → 收敛为 Factory World Kernel + Projection（Scheduler/Map/Agent/Simulation/Analytics 只读投影）。
  - Decision 若已被多 Domain 消费仍为 Scheduler 私有实现 → 提升为独立 Decision Domain（Context/Options/Selected/Authority/Policy/Reason/Evidence/Approval/Outcome 全记录）。
  - Scheduler 专属 Outbox 若已被多 Domain 依赖 → 抽出共享 Event Backbone（统一 event envelope 字段）。
  - Agent 写路径必须走 Structured Command → Domain Kernel → Policy → Approval → Execution；禁止直写生产表。
  - Exoskeleton：Person→ExoSession→Exoskeleton 运行绑定模型；无事实则 UNKNOWN，禁止由 assist_pct 等间接字段猜测 support mode。
- 建立 Scheduler Constraint TCK：Golden Problems（worker/device/station 冲突、skill/certification、battery/fatigue、safety zone、maintenance/quality block、DAG、time window、route、locked/excluded/preferred resource）在 Rule/Heuristic/MILP/CP-SAT 四求解器上运行；不要求同计划，但 Hard Constraint 语义必须一致。
- 架构不变量 INV-001~INV-012 落地为测试/脚本/CI 门禁。
- 数据库迁移从空库全链验证（fresh/upgrade/rollback、RLS fail-closed、org NOT NULL、复合租户唯一约束）。
- 租户隔离攻击性测试（Org A/B、Global Admin、Dispatcher、Viewer、匿名；覆盖 read/write/SSE/World/Decision/Agent/Learning 全资源面）。
- 安全审计与整改（AuthN/AuthZ、Web/API 攻击面、前端语义 truthful 显示、Edge 鉴权面）。
- 全量回归：Python（lint/static/unit/contract）、TS（tsc/ESLint/Jest server+client）、OpenAPI drift、全部 contract/truth/audit 门禁、迁移链、跨租户 TCK、SSE/离线/恢复测试。
- 二次逐行复审全部受影响文件 + 重跑旧发现回归 + 不变量扫描。
- 仅凭真实证据更新 `docs/agent/project-state.yaml`、`docs/capabilities/capability-matrix.yaml`、`feature-status.yaml`（Implemented/Tested/Deployable/ProductionEnabled 严格分离，无生产运行证据不得置 productionEnabled=true）。
- 完成后直接提交并推送 `origin/main`（项目既定约定）。

**BREAKING**：允许（必要时）改 Contract、改数据库（只增迁移不改历史名）、移动目录、删除 Legacy/重复实现；重大重构须附 ADR + Migration + Compatibility + Tests + Rollback 说明。

## Impact

- Affected specs（能力域）: Canonical Contracts、Factory World Kernel、Decision Kernel、Scheduling Kernel、Execution Kernel、Event Backbone、Edge Runtime、Industrial Intelligence、Agent Runtime、Learning Kernel、Exoskeleton Domain、Database/RLS、Tenant Isolation、AuthN/AuthZ、Web/API Security、Frontend Semantics、CI Gates。
- Affected code: `src/`（边缘平台）、`ewoh-spark-app/server/`、`ewoh-spark-app/client/src/`、`ewoh-spark-app/shared/`、`ewoh-feishu-app/`、`db/`、`scripts/`、`tools/`、`tests/`、`deploy/`、`security/`、`.github/`、根配置（Makefile/pyproject.toml/package.json/feature-status.yaml/version.json）。
- 排除逐行重复审计：`release/`、`delivery/`、`output/`、build artifacts、generated bundle、`node_modules`、binary assets、lock 文件；但必须检查其是否被生产路径引用、release 快照与当前版本边界是否明确。

## ADDED Requirements

### Requirement: 文件覆盖账本
系统 SHALL 在 `docs/audit/current/file-ledger.jsonl` 为每个活跃工程文件登记一条记录，字段至少含 path/classification/language/line_count/reviewed/reviewed_ranges/domain/runtime/entry_points/imports/exported_symbols/reads/writes/database_tables/events_consumed/events_emitted/contracts/security_boundaries/tenant_boundaries/failure_paths/tests/findings。未真正读取的文件不得 reviewed=true。终态必须 active_unread_files=0、partial_review_files=0，并产出 `coverage-report.md`。

#### Scenario: 账本完备
- **WHEN** 审计阶段结束
- **THEN** 全部活跃文件在账本中且 reviewed=true，coverage-report.md 与实际一致

### Requirement: 旧发现回归验证
系统 SHALL 在 `docs/audit/current/old-finding-regression.yaml` 对第一轮 950 项发现逐项标记终态；全部 Critical 与 High 必须逐项源码复验。

#### Scenario: 发现回归
- **WHEN** 复验发现 STILL_PRESENT / PARTIALLY_FIXED / REGRESSED
- **THEN** 登记为新 finding 并按优先级修复，P0/P1 本轮关闭

### Requirement: 新发现登记与修复
系统 SHALL 在 `docs/audit/current/findings.jsonl` 按 P0_CRITICAL/P1_HIGH/P2_MEDIUM/P3_LOW 登记全部新发现，字段含 id/severity/domain/file/line_start/line_end/title/description/evidence/root_cause/impact/exploit_or_failure_scenario/recommended_fix/status/fix_commit_or_files/tests。发现问题后直接修码/重构，不等确认。

#### Scenario: P0 发现
- **WHEN** 出现安全边界越界/跨租户泄漏/鉴权绕过/错误物理执行/真相源损坏等 P0
- **THEN** 立即整改并在二次复审中复验

### Requirement: 架构真实性验证与 Kernel 收敛
系统 SHALL 产出 `repository-truth.md`（Directory/Runtime Entry/Dependency/Domain/Database/API/Event/Contract/Deployment/Test/CI 全图，并标注 Production/Simulation/Development/Legacy/Prototype/Generated/Frozen/Dead）、`architecture-before.md`/`architecture-after.md`、`root-cause-analysis.md`。World/Decision/Event 需回答"共有几份、谁 authoritative、哪些是 projection"；职责混乱即重构为目标 Kernel 边界（World/Decision/Scheduling/Execution/Intelligence/Agent/Learning/Integration-Edge）。

#### Scenario: World 多源
- **WHEN** 多个 Domain 各自重新拼装世界事实
- **THEN** 收敛为 Factory World Kernel 单权威源 + 只读 Projection

### Requirement: Scheduler Constraint TCK
系统 SHALL 建立 Golden Scheduling Problems 与 Scheduler Constraint TCK，覆盖 §14 全部约束族，Rule/Heuristic/MILP/CP-SAT 四求解器 Hard Constraint 语义一致，产出 `scheduler-conformance-report.md`。

### Requirement: 架构不变量门禁
系统 SHALL 将 INV-001~INV-012 实现为 tests/scripts/CI gates（单一写控制面、Agent 禁直写生产表、Simulation 禁入真实真相、租户行禁 NULL org 绕过、高危物理指令须审批、Decision 须证据、Derived 不得自称 authoritative、LLM 不替代硬约束校验、过期快照禁派工、外骨骼实时控制留本地、云不绕过本地安全控制器、默认禁跨租户训练数据）。

### Requirement: 数据库与租户隔离验证
系统 SHALL 从空库执行完整 migration 链（fresh/upgrade/rollback），验证 RLS/org NOT NULL/FK/UNIQUE/CHECK/Index/CAS 与 fail-closed；构建 Org A/B + Global Admin + Dispatcher + Viewer + 匿名攻击矩阵验证无跨租户泄漏，产出 `tenant-isolation-report.md`。

### Requirement: 安全审计报告
系统 SHALL 按 AuthN/AuthZ（JWT/refresh/session/offline/Edge/RBAC/审批权/Feishu 校验/Agent 权限）与 Web/API 攻击面（SSRF/XSS/SQLi/命令注入/路径穿越/重定向/原型污染/上传/凭据泄漏/CORS/CSP/TLS/Trust Proxy/限流/SSE DoS）完成审计整改并产出 `security-report.md`。

### Requirement: 全量回归与二次复审
系统 SHALL 执行 §33 列出的全部可执行测试（依赖缺失记 ENVIRONMENT_BLOCKED，不得记 pass），随后对全部受影响文件二次逐行复审并重跑旧发现回归/安全扫描/不变量扫描，产出 `test-report.md`、`refactor-report.md`、`final-assessment.md`（回答 §39 的 20 个问题）。

### Requirement: Feature Truth 更新
系统 SHALL 仅依据真实证据更新 `project-state.yaml`/`capability-matrix.yaml`/`feature-status.yaml`，Implemented/Tested/Deployable/ProductionEnabled 严格分离；无真实生产运行证据不得改变 production 状态。

## MODIFIED Requirements

### Requirement: 提交与推送
完成全部整改与验证后，排除调试残留文件，直接提交并推送 `origin/main`（沿用项目既定约定，不需用户再次确认）。

## REMOVED Requirements

（无——本轮不移除任何既有需求；删除 Legacy 代码属于实施手段而非需求移除。）
