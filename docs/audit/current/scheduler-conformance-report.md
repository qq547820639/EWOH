# Scheduler Conformance Report — Golden 门禁与四求解器 Hard Constraint 一致性

> 生成时间：2026-08-18
> 数据来源：本机复跑 `make scheduler-golden` / `make contract-golden`（真实输出，见 `test-report.md`）；`tests/test_golden_scheduler_scenarios.py`、`tests/test_golden_scheduler_workflow.py`、`tests/golden-fixtures/scheduler-golden-scenarios.json`；修复证据 `parts/fixlog-schcore.jsonl`、`parts/fixlog-sched-tests.jsonl`、`parts/fixlog-schsvc.jsonl`。
> 说明：四求解器 = heuristic（canonical）/ rule-based / MILP(HiGHS WASM) / CP-SAT(worker，ortools 未部署默认 OFF，feature-status.yaml:72-97）。

---

## 1. Golden 门禁复跑结果（本机 2026-08-18 实跑）

| 门禁 | 命令 | 复跑结果 |
|---|---|---|
| Scheduler Golden TCK | `make scheduler-golden` | **6 passed** in 0.25s（test_golden_scheduler_scenarios.py 3 用例 + test_golden_scheduler_workflow.py 3 用例） |
| Contract Golden | `make contract-golden` | **330 passed** in 2.41s（golden 场景 + 域/identity/world/envelope/mq 契约 pytest） |

## 2. Golden Problems 覆盖的约束族

### 2.1 求解段（scheduler-golden-scenarios.json，4 场景）

场景清单（tests/golden-fixtures/scheduler-golden-scenarios.json）：
1. `skill_match_baseline`（正例：技能匹配基线分配）
2. `maintenance_blocked_device_fail_closed`（设备维护封锁 fail-closed）
3. `maintenance_blocked_person_fail_closed`（人员维护封锁 fail-closed）
4. `quality_blocked_station_fail_closed`（工位质量封锁 fail-closed）

Python 侧独立仲裁器（test_golden_scheduler_scenarios.py，标准库重实现、不依赖 ortools/不依赖 TS）覆盖的 Hard Constraint 约束族：

| 约束族 | 仲裁语义 | 代码锚点 |
|---|---|---|
| 技能/证书 | requiredSkills/requiredCertifications 全含才可派 | _check_assignment（missing_skill/missing_certification） |
| 人员可用性 | person.status 必须 AVAILABLE | person_unavailable |
| 连续负荷 | loadLevel > MAX_LOAD(0.9) 拒绝 | continuous_work_exceeded |
| 安全封锁 | safetyBlockedPersonIds 集合拒绝 | safety_blocked |
| 维护封锁（NO-05c） | 任何活跃维护事实 → 封锁 | _blocks() |
| 质量封锁（NO-05d） | critical/high 活跃质量发现封锁；medium/low 仅事实可见；**未知严重度 fail-closed 按封锁处理**（与 TS qualityFindingsBlockDispatch 一致） | _quality_blocks() / _normalized_severity |
| 设备能力 | 设备 online + battery ≥ MIN_BATTERY(15) | 设备分支 |
| 工位能力/禁入区 | station 能力校验；task.zoneId ∈ forbiddenZones 拒绝 | zone_forbidden |
| 人员不重复预订 | 同一人员不被重复分配 | 场景级断言 |

一致性机制：TS heuristic 产出的求解结果（scheduler-golden-results.json，漂移门禁）与 Python 独立仲裁对**同一世界状态**各自判定——"两个运行时对同一世界状态给出同一可行解，即跨语言一致性"（测试文件 docstring）。

### 2.2 工作流段（scheduler-workflow-golden.json，NO-07b）

Python 标准库重实现的工作流不变量（test_golden_scheduler_workflow.py docstring）：
- plan 版本 CAS；
- 快照新鲜度拒绝（stale snapshot → PLAN_STALE）；
- 审批后 assignment 状态收敛；
- 资源预约重叠冲突（capacity=1，_overlaps 区间判定）；
- 派工前置条件：approved + dispatched 状态收敛 + outbox 事件。

## 3. 四求解器 Hard Constraint 语义一致性 — 本轮收敛现状

本轮 R2 修复把 rule-based / MILP / CP-SAT 三个非 heuristic 求解器对 hard 约束的语义拉齐到与 heuristic 同源（修复前 rule-based/milp 会**静默忽略**全部输入约束，R2-SCH-003 违反"绝不静默忽略"契约）：

| 一致性维度 | before 状态 | after 收敛 | 证据 |
|---|---|---|---|
| 输入约束编译 | rule-based/milp 只接线快照侧 lockedAssignments，输入约束（LOCKED_PERSON/DEVICE/STATION/TIME/ASSIGNMENT、EXCLUDED/PREFERRED_RESOURCE、FORBIDDEN_ZONE、MIN_BATTERY、MAX_WORKLOAD、MANUAL_BOOST）静默忽略 | 新增共享约束编译器 compileConstraintOverrides；三求解器全量透传候选引擎；不支持类型显式 violations=UNSUPPORTED_CONSTRAINT（与 heuristic 同形，绝不静默失效） | R2-SCH-003，`__tests__/r2-sch-p1-regression.spec.ts`（真引擎 LOCKED/EXCLUDED/FORBIDDEN_ZONE/MIN_BATTERY 执行 + 无约束对照实验 + 未知类型显式上报 + milp IR 透传断言） |
| 资源占用顺延 | 候选池 startMs 固定 now+travel——生产路径同一人员第二个任务直接 time_conflict 拒绝 | startMs=max(最早开始下界+travel, 人员占用顺延, 设备占用顺延)；三引擎统一（heuristic 透传 booked、rule-based/milp 由 booked 槽位推 freeAtByResource） | R2-SCH-001，r2-sch-p1-regression 3 例 |
| 策略权重 | solveVariants A/B/C 变体权重缩放在候选引擎路径完全失效（三变体趋同） | CandidatePoolOptions.policy 覆盖注入，三引擎透传当前生效 policy（含变体缩放） | R2-SCH-002，B 变体 travel=C×1.5 端到端断言 |
| 任务终态过滤（CP-SAT） | 请求不过滤终态/不可调度任务且不传 status——completed/paused/received 任务可被 worker 重排 | SolverRequest 任务映射前置 TaskLifecycle.isSchedulable 过滤 + status 透传（shared SolverRequest.tasks 增可选 status，additive） | R2-SCH-004，cp-sat-contract.spec |
| 冻结面状态集（CP-SAT） | buildFrozenAssignments 用非契约 'started' 且缺 received/paused/exception | 改 TaskLifecycle.isLocked（与 R2-SCH-011 锁定状态集同源收口） | R2-SCH-016 |
| fast-path 复验（heuristic） | reuseBaseline 复验漏掉可用时间窗/维护窗/数据新鲜度/safetyCritical fail-close | 改用完整 eligibilityService.check（与枚举路径同判据），补齐 4h/4g/4f/5/11 维度 | R2-SCH-006，reuse-baseline-fastpath.spec |
| feasible 双源 | isFeasible 与 recordRun 判定不一致（SHADOW/compare 把带硬违例方案误标 feasible） | isFeasible 补 violation==0 判定，双源一致 | R2-SCH-019 |
| 风险等级 | assignment.riskLevel 折叠为 risk>0?'high'（medium 丢失） | CandidateRouteCost.riskLevel 原样透传（三引擎同源） | R2-SCH-017 |

求解器运行时防护同批加固：MILP HIGHS_OPTIONS 增 time_limit=10s（同步 WASM 不再可无限阻塞事件循环，超时显式抛出不伪造，R2-SCH-005）；CP-SAT 熔断 HALF_OPEN 并发探测限制（R2-SCH-020）。

边缘侧语义对齐：cpsat objective 软目标系数统一 int_coeff 整数化（×COEFF_SCALE，上界同乘刻度保证字典序支配，R2-ESC-001，fixlog-p1-closeout）。

## 4. ENVIRONMENT_BLOCKED 项（如实标注）

| 项 | 阻塞原因 |
|---|---|
| 真实 ortools CP-SAT worker 端到端求解验证 | 本机未安装 ortools（`python3 -c "import ortools"` 失败）；CP-SAT 按 feature-status.yaml:72-97 为 Prototype/EXPERIMENTAL、默认 OFF。CP-SAT 语义面仅能以请求契约/冻结面/回退路径的单测（cp-sat-contract.spec / cp-sat-fallback.spec）与 golden 共享场景覆盖 |
| TS 侧 golden 漂移门禁（golden-scheduler-scenarios.spec / golden-workflow 零漂移） | 属 Jest 套件，随 server 全量执行——本轮复跑 290 suites 中 289 过 1 失败，失败项为 openapi-route-parity（R2-SOP-006 新增路由未登记 spec，与本门禁无关；golden 相关 spec 未失败，见 `test-report.md`） |
| 迁移链真实空库验证（058/059/060） | 需 EWOH_PG_URL 真实 PostgreSQL；本机以 migration-fresh-install-check 静态模式覆盖（audit-regression-gates 主线 5 通过） |

## 5. 结论

- Golden Problems 当前以 4 个求解场景 + 工作流不变量集锁定 Hard Constraint 核心族（技能/证书、可用性、负荷、安全/维护/质量封锁、设备在线电量、工位能力、禁入区、不重复预订；工作流 CAS/新鲜度/审批收敛/预约冲突/派工前置）。本轮复跑 `make scheduler-golden` 6 passed、`make contract-golden` 330 passed，全绿。
- 四求解器 Hard Constraint 语义一致性经 R2-SCH-001/002/003/004/016/019 从"rule-based/milp 静默忽略约束"收敛为"共享编译器 + 同源候选语义 + 显式 UNSUPPORTED 上报"；heuristic 与 Python 独立仲裁的跨语言一致性由 golden 漂移门禁持续锁定。
- CP-SAT 真实求解验证与空库迁移链验证受环境限制（§4），已按 ENVIRONMENT_BLOCKED 登记，未以任何替代数字冒充。
