# Checklist — 二轮全仓逐行审计 + 架构收敛重构 + 全量回归

## 覆盖账本
- [x] `docs/audit/current/file-ledger.jsonl` 覆盖全部活跃工程文件，字段完备（含 reviewed_ranges/domain/entry_points/reads/writes/events/contracts/tenant_boundaries/failure_paths 等）
- [x] active_unread_files = 0 且 partial_review_files = 0（无未真实读取即标 reviewed=true 的文件）
- [x] `coverage-report.md` 与账本/域分布对账一致；排除项（release/delivery/output/node_modules/binary/lock）已声明且核查过生产引用与版本边界

## 旧发现回归
- [x] 74 Critical + 161 High 逐项源码复验完成，`old-finding-regression.yaml` 每项含终态标记与 file:line 证据
- [x] Medium/Low 按簇抽验 + 门禁佐证登记；STILL_PRESENT/REGRESSED/PARTIALLY_FIXED 全部转为新 finding 并处理

## 新发现与修复
- [x] `findings.jsonl` 全部发现含 18 字段（id/severity/domain/file/lines/title/description/evidence/root_cause/impact/exploit_or_failure_scenario/recommended_fix/status/fix_commit_or_files/tests）
- [x] P0 unresolved = 0（安全边界/跨租户/鉴权绕过/物理执行/真相源损坏类全关闭）
- [x] P1 unresolved = 0（契约漂移/事务/调度语义/Agent 授权/事件一致性/RLS/状态机/幂等全关闭）
- [x] P2/P3 修复或带裁决记录终态，无悬挂"后续建议"
- [x] 无已知跨租户泄漏、无已知鉴权绕过、无已知不安全物理执行、无已知契约语义 split-brain

## 架构
- [x] `repository-truth.md` 含 11 类图（Directory/Runtime Entry/Dependency/Domain/Database/API/Event/Contract/Deployment/Test/CI），构件均标注 Production/Simulation/Development/Legacy/Prototype/Generated/Frozen/Dead
- [x] World State 数量/权威源/projection 判定有代码证据；多源拼装已收敛为 Factory World Kernel + 只读 Projection（`architecture-before.md`/`architecture-after.md` 齐备）
- [x] Decision 归属裁决落地（Scheduler 私有 or 独立 Decision Domain），决策记录含 Context/Options/Selected/Authority/Policy/Reason/Evidence/Approval/Outcome
- [x] Event Backbone 归属裁决落地（共享或 Scheduler 专属有据），事件 envelope 字段完备
- [x] Agent 写路径全部走 Structured Command → Domain Kernel → Policy → Approval → Execution，无直写生产表/绕 RBAC/RLS/审批路径
- [x] Learning 无跨租户训练数据污染，shadow/production 隔离，模型/特征版本与血缘可溯
- [x] Exoskeleton 为运行绑定模型（Person→ExoSession→Exoskeleton），无 assist_pct 猜 support mode，无事实即 UNKNOWN
- [x] INV-001~INV-012 全部落地为 tests/scripts/CI gates 并在 CI 上下文可执行、当前全绿
- [x] 重大重构附 ADR+Migration+Compatibility+Tests+Rollback；`refactor-report.md`/`root-cause-analysis.md` 齐备

## 数据库与租户
- [x] 空库全链 migration（fresh/upgrade/rollback）执行通过；RLS fail-closed、org NOT NULL、复合租户唯一约束、FK/CHECK/Index/CAS 验证（静态链路 + verify 断言全绿；真实空库执行 ENVIRONMENT_BLOCKED 如实登记 test-report.md §3）
- [x] 租户攻击矩阵（Org A/B/Global Admin/Dispatcher/Viewer/匿名 × 全资源面）通过，`tenant-isolation-report.md` 有证据
- [x] AuthN/AuthZ 与 Web/API 安全（§24/§25 全项）审计整改完成，`security-report.md` 有证据

## 前端语义
- [x] Command Map/Scheduling/Approval/Decision History/Simulation/AI Decision 无"造事实"显示（UNKNOWN≠AVAILABLE、STALE≠FRESH、Derived≠Authoritative）
- [x] query key 租户隔离、缓存污染/SSE resync/optimistic update/error/stale 态检查完成

## 测试与二次复审
- [x] Python lint/static/unit/contract 全绿；tsc -b 0 错误；ESLint、Jest server+client 全绿
- [x] openapi:no-drift、contract-* 门禁族、truth-check、audit-regression-gates、Scheduler Constraint TCK、INV 门禁全绿
- [x] 缺依赖项如实记 ENVIRONMENT_BLOCKED（不记 pass），`test-report.md` 统计真实
- [x] 二次逐行复审完成：受影响文件重扫 + 旧发现回归重跑 + 安全/不变量扫描重跑，无回归引入
- [x] `contract-parity-report.md`、`scheduler-conformance-report.md`、`final-assessment.md`（含 §39 20 问）及 current/ 15 份交付文件齐全

## Feature Truth 与交付
- [x] `project-state.yaml`/`capability-matrix.yaml`/`feature-status.yaml` 仅凭真实证据更新，Implemented/Tested/Deployable/ProductionEnabled 四态严格分离
- [x] 无伪造 PASS、无硬编码测试结果、无吞异常/静默 fallback 掩盖问题、无 simulation 冒充 real
- [x] 调试残留已排除，全部改动已提交并推送 origin/main
- [x] tasks.md 全部勾选
