# Tasks — 二轮全仓逐行审计 + 架构收敛重构 + 全量回归

> 事实源：当前 HEAD `58b7819e` 真实代码（不信 README/旧报告/ADR/矩阵的声明，只作线索）。
> 原则：先登记后审计；发现即修（P0→P1→架构根因→P2→P3）；不削弱测试；ENVIRONMENT_BLOCKED 如实记录；禁止伪造 PASS/硬编码测试结果/吞异常/静默 fallback。

- [x] Task 1: Phase 0 — 基线冻结与文件覆盖账本
  - [x] 1.1 记录 HEAD SHA/分支/时间戳/环境版本（Python/Node/PG/容器）；声明排除项（release/、delivery/、output/、node_modules、binary、lock）并核查其是否被生产路径引用、release 快照与当前版本边界。
  - [x] 1.2 生成 `docs/audit/current/file-ledger.jsonl`：全部活跃工程文件逐条登记（path/classification/language/line_count/reviewed/reviewed_ranges/domain/runtime/entry_points/imports/exported_symbols/reads/writes/database_tables/events_consumed/events_emitted/contracts/security_boundaries/tenant_boundaries/failure_paths/tests/findings），初始 reviewed=false。
  - [x] 1.3 随各域审计推进回填账本；终态断言 active_unread_files=0、partial_review_files=0，产出 `coverage-report.md`（含域分布/行数/复审范围对账）。
- [x] Task 2: Phase 1 — 旧审计 Finding 回归验证（950 项）
  - [x] 2.1 解析 `docs/audit/2026-08-17-line-by-line-audit.md` §6 全部发现为机器可读输入。
  - [x] 2.2 全部 74 Critical + 161 High 逐项源码复验（对照整改 commit 58b7819e 及既有门禁），标记 FIXED_VERIFIED/STILL_PRESENT/PARTIALLY_FIXED/REGRESSED/NO_LONGER_APPLICABLE，写入 `old-finding-regression.yaml`（含证据 file:line）。
  - [x] 2.3 Medium/Low 按簇抽验 + 依赖既有 audit-regression-gates 门禁结果登记；STILL_PRESENT/REGRESSED 项转为新 finding 进入修复队列。
- [x] Task 3: Phase 2 — 分域逐行复审（新发现 → findings.jsonl）
  - [x] 3.1 `src/` 边缘平台逐行复审（Settings/RuntimeFactory/Adapter/Connector/EventBus/Storage/Inference/Rule/World Projection/Uplink/Scheduler Advisory；offline/reconnect/duplicate/late/out-of-order/clock drift/buffer full/restart/storage corruption/Cloud 不可达）。
  - [x] 3.2 `ewoh-spark-app/server/` 逐行复审（database/ + modules/ 全部 + common/ + 入口；重点：审批→重验证→预约→派工→执行→反馈链路的 CAS/事务/幂等/恢复/审计，double approval、double dispatch、parallel dispatcher、stale snapshot、outbox failure、duplicate command、late feedback）。
  - [x] 3.3 `ewoh-spark-app/shared/` 契约逐行复审 + `ewoh-feishu-app/` 复审。
  - [x] 3.4 `ewoh-spark-app/client/src/` 前端语义复审（Command Map/Scheduling/Approval Console/Decision History/Simulation/AI Decision：UNKNOWN≠AVAILABLE、STALE≠FRESH、Derived≠Authoritative；query key tenant scoping、缓存污染、SSE resync、optimistic update、error/stale 态）。
  - [x] 3.5 `db/`、`scripts/`、`tools/`、`tests/`、`deploy/`、`security/`、`.github/`、根配置逐行复审；>800 LOC 生产文件逐个做 cohesion/状态所有权/事务边界/fan-in/fan-out 裁决（不机械拆分）。
  - [x] 3.6 全部新发现按 P0~P3 写入 `findings.jsonl`（完整 18 字段），并同步回填账本 findings 字段。
- [x] Task 4: Phase 3 — 架构真实性与 Kernel 判定
  - [x] 4.1 产出 `repository-truth.md`：Directory/Runtime Entry/Dependency/Domain/Database/API/Event/Contract/Deployment/Test/CI 全图，每个构件标注 Production/Simulation/Development/Legacy/Prototype/Generated/Frozen/Dead。
  - [x] 4.2 World State 清点：edge world_model、cloud world、world-cursor、resource、scheduler world-state、resource-projection、Command Map 数据源、Agent/Simulation 读取路径——回答共几份 World、谁 authoritative、哪些 projection/derived，写 `architecture-before.md`。
  - [x] 4.3 Decision Kernel 判定：DecisionRecord/Projection/Ledger/History 及七类 Decision 是否仍为 Scheduler 私有；若已跨 Domain 消费则提升独立 Decision Domain（Context/Options/Selected/Authority/Policy/Reason/Evidence/Approval/Outcome linkage）。
  - [x] 4.4 Event Backbone 判定：outbox/pg notify/SSE/domain event/canonical event/Edge uplink 的归属；Scheduler 专属 Outbox 被多 Domain 依赖则抽共享 Backbone（统一 event_id/type/schema_version/tenant/factory/subject/actor/source/occurred_at/observed_at/received_at/correlation/causation/confidence/data_quality/payload/evidence）。
  - [x] 4.5 Edge/Cloud 权责、Agent Runtime（Manifest/Service/Orchestrator/Task/Tool/Approval 写路径受控）、Learning Kernel（tenant-scoped training/数据血缘/模型与特征版本/时间泄漏/shadow 隔离/回滚）、Industrial Intelligence（Observed/Derived/Inference/Reasoning/Recommendation 分层，UNKNOWN 合法）、Exoskeleton（Person→ExoSession→Exoskeleton 运行绑定；Fit/Calibration/Assist Profile/Support Mode/Battery/Health/Firmware/Sensor/Maintenance；禁间接猜测）逐项裁决并记入 before 报告。
- [x] Task 5: Phase 4 — Canonical Contract 审计与修复
  - [x] 5.1 对照 §10 的 25 个契约域验证 JSON Schema/TS/Python/DB/OpenAPI/Frontend types 六方一致；发现重复手写语义优先单一事实源或生成机制；产出 `contract-parity-report.md`。
- [x] Task 6: Phase 5 — Scheduler Kernel 与 Solver Conformance
  - [x] 6.1 逐行跟踪 Trigger→Run Context→World Snapshot→Candidate→Eligibility→Constraint Loader/Compiler→Routing/Travel Cost→四 Solver→Objective→Plan/Compare→Override→Approval→Reservation→Dispatch→Execution→Feedback→Conflict→Replan→Policy→Metrics；核查 Hard/Soft 语义、确定性、fallback、timeout、infeasible、UNKNOWN、快照/策略版本新鲜度。
  - [x] 6.2 建立 Golden Scheduling Problems + Scheduler Constraint TCK（§14 全约束族 × Rule/Heuristic/MILP/CP-SAT；只要求 Hard Constraint 语义一致），接入 CI，产出 `scheduler-conformance-report.md`。
- [x] Task 7: Phase 6 — 修复与根因重构（与审计滚动进行）
  - [x] 7.1 P0 全部关闭（安全边界/跨租户/鉴权/物理执行/真相源），P1 全部关闭（契约语义漂移/事务完整性/调度语义分歧/Agent 授权/事件一致性/RLS/状态机绕过/幂等竞态）。
  - [x] 7.2 架构根因重构按 Task 4 裁决执行：World Kernel 收敛、Decision Domain 提升、共享 Event Backbone、Scheduler 去垄断化；重大重构附 ADR+Migration+Compatibility+Tests+Rollback；产出 `refactor-report.md` 与 `architecture-after.md`。
  - [x] 7.3 INV-001~INV-012 落地为 tests/scripts/CI gates（接入 Makefile 与 truth 体系）。
  - [x] 7.4 P2/P3 修复或带裁决记录终态（不悬挂"后续建议"）。
- [x] Task 8: Phase 7 — 数据库与租户隔离验证
  - [x] 8.1 空库全链 migration（fresh/upgrade/rollback）+ RLS/org NOT NULL/FK/UNIQUE/CHECK/Index/CAS fail-closed 验证。（静态链路全绿：runner 四步登记 058/059/060 + 顺序校验 + verify 结构断言 + schema.ts 逐表对账 15/15；真实空库执行 ENVIRONMENT_BLOCKED，见 test-report.md §3）
  - [x] 8.2 租户攻击矩阵（Org A/B/Global Admin/Dispatcher/Viewer/匿名 × read/write/update/delete/SSE/Outbox/World/Decision/Scheduler/Agent/Knowledge/Learning/Trace/Routes），应用层+DB 层双重验证，产出 `tenant-isolation-report.md`。
  - [x] 8.3 AuthN/AuthZ 与 Web/API 安全审计整改（§24/§25 全项），产出 `security-report.md`。
- [x] Task 9: Phase 8 — 全量回归
  - [x] 9.1 Python：lint/static/unit/contract 全量；TS：tsc -b、ESLint、Jest server+client。
  - [x] 9.2 契约与门禁：openapi:no-drift、contract-*（identity/domain/envelope/state-machine/golden/scheduler-golden）、truth-check、audit-regression-gates、新增 INV 门禁与 TCK 全绿。
  - [x] 9.3 迁移/租户/SSE/离线/恢复/性能 smoke/部署 TCK 能执行的全部执行；缺依赖记 ENVIRONMENT_BLOCKED；产出 `test-report.md`（含真实通过/失败/阻塞统计）。
- [x] Task 10: Phase 9 — 二次逐行复审
  - [x] 10.1 重扫全部受影响文件（修复+重构涉及处逐行），重跑旧发现回归、安全扫描、架构不变量扫描，确认无"修一个坏一个"；复核账本 reviewed 状态仍真实。
- [x] Task 11: Phase 10 — 最终交付
  - [x] 11.1 产出 `root-cause-analysis.md`、`final-assessment.md`（回答 §39 全部 20 问）及缺失的 current/ 报告文件（15 份齐）。
  - [x] 11.2 仅凭真实证据更新 `docs/agent/project-state.yaml`、`docs/capabilities/capability-matrix.yaml`、`feature-status.yaml`（Feature Truth 四态分离）。
  - [x] 11.3 排除调试残留，提交并推送 `origin/main`。

# Task Dependencies
- Task 1 最先（账本是全部域审计的载体）。
- Task 2、Task 3 可并行（Task 2 用旧清单，Task 3 按域推进）；Task 3 各子域可并行。
- Task 4 依赖 Task 1；与 Task 2/3 可并行推进（架构判定输入来自对应域复审结论时串行收口）。
- Task 5、Task 6 依赖对应域复审（3.1/3.2/3.3）有初步结论后即可启动，可与 Task 4 并行。
- Task 7 滚动进行：P0/P1 发现即可修（不等全部审计结束）；重构类依赖 Task 4 裁决。
- Task 8 依赖 Task 7 的 DB/安全相关修复落地。
- Task 9 依赖 Task 7/8 全部完成。
- Task 10 依赖 Task 9。
- Task 11 最后。
