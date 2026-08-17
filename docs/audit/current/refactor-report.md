# Refactor Report — 二轮审计结构性修复清单

> 生成时间：2026-08-18
> 数据来源：`parts/fixlog-db-contracts.jsonl`、`parts/fixlog-p1-closeout.jsonl`、`parts/fixlog-sched-tests.jsonl`、`parts/fixlog-schcore.jsonl`、`parts/fixlog-schsvc.jsonl`、`parts/fixlog-nz.jsonl`、`parts/fixlog-ops.jsonl`、`parts/fixlog-srv-client.jsonl`、`findings.jsonl`（resolution_note）、`p2p3-dispositions.md`。
> 范围：本轮落地的**结构性**修复（语义/边界/门禁级），非逐 bug 清单。每项含动机/改动/验证，均转引自 fixlog 原文，无虚构成分。

---

## 1. 幂等占位式 exactly-once（R2-SDB-005，P2）

- **动机**：IdempotencyService 原实现为读-判-写（TOCTOU）：并发同键请求双双通过"读"阶段各自执行，幂等承诺失效（findings R2-SDB-005 root_cause："幂等实现为读-判-写（TOCTOU），未用『先占位后执行』模式"）。
- **改动**：IdempotencyStore 增可选 claim/release——DB 实现 `INSERT pending ON CONFLICT DO NOTHING`（占位先行、失败方不执行），内存实现 set-if-absent；execute/executeWithPayload 占位成功方执行、失败释放占位、并发方 awaitSettled 轮询读回终值（超时 409 IDEMPOTENCY_KEY_IN_FLIGHT 不重执行）；lookup 将 pending(null) 视为未决，防 null 假成功（parts/fixlog-db-contracts.jsonl R2-SDB-005）。
- **验证**：`npx jest idempotency.claim.spec.ts` 5/5 + 既有 service/payload spec 11/11。
- **文件**：server/modules/shared/idempotency.service.ts、db-idempotency.store.ts、test/unit/shared/idempotency.claim.spec.ts。

## 2. 幂等租户维度 060 迁移（R2-SDB-006，P2）

- **动机**：ewoh_idempotency_keys 幂等层设计早于多租户改造——表不在任何 org RLS 清单内（GLOBAL 表），服务层也未透传租户上下文（R2-SDB-006 root_cause）。
- **改动**：新增 `db/migrations/standalone_060_idempotency_org.sql`（+rollback +verify）：ewoh_idempotency_keys 增 org_id（DEFAULT 取 app.current_org_id GUC，无上下文回退默认 org）+ 唯一键收敛 `(org_id, scope, idempotency_key)` + RLS `idempotency_org_isolation`（org 匹配或全局管理员，无 NULL 放行）；runner 三键接入；schema.ts 映射 + manifest 登记。
- **验证**：runner `node --check` SYNTAX_OK；迁移/verify 空库链路执行属 ENVIRONMENT_BLOCKED（见 `test-report.md`）。

## 3. schema.ts ↔ 迁移漂移收敛（R2-SDB-001/002/003、R2-SOP-014、R2-DBM-002/003）

- **动机**：手维护的 drizzle schema.ts 与真实迁移脱水的三类漂移——单列 .unique() 残留（057 已是复合唯一）、NOT NULL 未回写、新迁移未接 runner（root_cause 均明示"手工增量维护遗漏/未按四步登记流程接入"）。
- **改动**：
  - R2-SDB-001：ewohDevice.deviceId 单列 .unique() 移除，uq_ewoh_device_org_device 复合唯一映射对齐；
  - R2-SDB-002：057 的 15 张调度域表 orgId 全部 .notNull() 且注释更新（逐表核对：schedule_plan/run/plan_assignment/constraint/conflict/route_cost_matrix/route_node/route_edge/resource_reservation/scheduling_policy/feedback/execution/kpi/policy_replay/policy_activation）；
  - R2-SDB-003：saved_views / workbench_export_tasks 复合唯一映射，单列 .unique() 残留移除；
  - R2-SOP-014：与 R2-SDB-001 同源（ops 批次先行落地，db 批次复核登记）；
  - R2-DBM-002：**058/059 补接入 runner**（FILES 键 + --apply/--rollback 命令映射 + SIMPLE_VERIFY_COMMANDS 登记 + 两个结构断言 verify 脚本）；
  - R2-DBM-003：manifest notes 追加 058/059/060 登记条目。
- **验证**：schema↔057 迁移对账（15 表 orgId NOT NULL 全量核对通过，python 逐表扫描 15/15）；`node --check run_migrations.js` SYNTAX_OK。

## 4. Contract 双口径收敛 + 新增门禁（R2-CNT-001/002）

- **动机**：registry 型契约"schema const 声明与文档实例自相矛盾"且无自校验门禁（R2-CNT-001）；状态机"reopen 需求加入转移表时未同步 terminal 集合"，门禁只锁 transitions 与 TS 一致性、未校验结构不变量（R2-CNT-002）。
- **改动**：
  - world-state 契约 versionMonotonicity const 收敛为放宽口径（与 rules 实例逐字一致）；audit-domain-contracts **新增 `world_state_const_vs_rules_self_consistent` 门禁**防再漂移；
  - alert.yaml terminal 已为空集（NEST-626 批次，环状生命周期以转移表为准）；audit-domain-contracts **新增 `state_machine_terminal_no_outgoing_edge` 结构门禁，覆盖全部 7 个状态机 YAML**（terminal 状态不得有出边）。
- **验证**：`node scripts/audit-domain-contracts.js` → **584/584 PASS**（新门禁后总数，contract-parity-report 基线为 581/581）。

## 5. 状态机 terminal/转移语义收敛（R2-ESC-002/010 + R2-SCH-011/016）

- **动机**：边缘 confirm 的白名单校验与状态机转换表两处独立演化（shadow 可 confirm 进 approved 但转移表不允许）；confirm 与 reject/execute 状态校验不对称（R2-ESC-010）；锁定任务状态集三方漂移（world-state 缺 received/paused/exception、impact 层含非契约 in_progress、CP-SAT 用非契约 'started'）。
- **改动**：confirm 白名单收敛 PLAN_PENDING_REVIEW 并在写入前统一 validate_plan_transition；Scheduler.confirm 增当前状态校验（仅 SHADOW/PROPOSED 可确认，REJECTED/EXECUTED/CONFIRMED 终态拒绝——人工否决不可被 confirm 复活）；TASK_LOCKED_STATUSES 收敛 task-lifecycle 单一事实源（world-state/impact-analyzer/impact-propagation/CP-SAT buildFrozenAssignments 四处同源化）。
- **验证**：`pytest tests/r2_sched_semantics_test.py` 16 过（ESC-002/010/003/004 组）；`PYTHONPATH=src pytest src/edge_platform/tests/ tests/ -q` 1660 过 11 skip（fixlog 记录）；jest impact/world-state/cp-sat 契约 spec 全绿。

## 6. Control 链语义修正（R2-SMI-001/002/009 + 058 attempt 唯一）

- **动机**：control.yaml 声明的审批前转移链（pending_approval/approved/revoked）在代码路径不可达——高危物理指令审批闸门整体缺失（本轮唯一 P0，INV-005）；org 守卫粒度只到请求行缺 deviceId 归属；request 表漏行级乐观锁。
- **改动**：createRequest 按命令风险分级接入 ApprovalPersistenceService（高危 → pending_approval，审批 approved 后方允许 sendCommand）；deviceId 归属断言；请求行状态 CAS（fixlog-ctrl R2-SMI-001/002/009）。配套迁移 standalone_058 `uq_ewoh_control_command_attempt` 唯一约束（重试不重复发送的 DB 语义）+ runner 接入（§3 R2-DBM-002）。
- **验证**：server/modules/control/control.service.spec.ts（R2-SMI-001 审批链 / R2-SMI-002 deviceId 归属 / R2-SMI-009 请求行 CAS 用例）。

## 7. 调度域事务/幂等边界收口（R2-SCH-014、R2-SSV-03/10/11/16、R2-SAM-005/006/007）

- **动机**：多写路径半状态风险——replan 的 persistPlan 与约束落库/supersede 分离两事务；shadow plan 落库与 isShadow 标记两步分离；policy activate/rollback check-then-update 无 CAS；conflict 转移无状态谓词；KPI persist 并发双行；exo 会话/配置三处主事实与事件非同事务。
- **改动**：persistPlan 移入同一 runInTransaction（RequestDatabaseContext 嵌套复用）；shadow plan 标记并入同一事务（无事务上下文时补偿删除）；activate 叠加 active=false 谓词 + RETURNING 行数校验（0 行 409 POLICY_CONCURRENT_ACTIVATION），rollback 先 CAS 置 ROLLED_BACK；conflict 改 UPDATE...RETURNING 单语句状态机；KPI persist 改 db.transaction + pg_advisory_xact_lock(org|periodStart) + 23505 冲突兜底转 update；exo start/terminate recordEvent 挪入同一 db.transaction、activateProfile supersede 循环并入同一事务。
- **验证**：`__tests__/r2-ssv-regression.spec.ts` 各组、plan-persistence/golden-scheduler-scenarios（replan 链路）、exo-session/exo-config spec（17/8 tests）全绿。

## 8. 求解器约束语义统一（R2-SCH-003/001/002，四求解器一致性详见 `scheduler-conformance-report.md`）

- **动机**：rule-based/milp 静默忽略全部输入约束（LOCKED_*/EXCLUDED/FORBIDDEN_ZONE/MIN_BATTERY/MAX_WORKLOAD），违反"绝不静默忽略"契约；候选池 startMs 固定 now+travel 无资源占用顺延；变体权重在候选引擎路径失效。
- **改动**：新增**共享约束编译器 compileConstraintOverrides**（constraints.ts，unsupported 列表显式返回）；三求解器统一消费同一候选顺延（earliestStartMs/人员/设备 booked 顺延）与 policy 注入（opts.policy ?? getActivePolicy()）。
- **验证**：`__tests__/r2-sch-p1-regression.spec.ts`（真引擎 LOCKED/EXCLUDED/FORBIDDEN_ZONE/MIN_BATTERY 执行对照实验 + 未知类型显式上报 + B 变体 travel=C×1.5 端到端断言）。

## 9. 测试基建：fake-db WHERE 语义（R2-SPT-003）

- **动机**：scheduler 测试 fake-db 的 update() 忽略 WHERE 谓词——CAS 语义在单测层从未被真实承载（恒真风险，NESP-017 同型蔓延）。
- **改动**：fake-db update() 实现 where 谓词匹配语义（drizzle eq/and/or/isNull 嵌套递归求值，适配 StringChunk.value=string[] 形态）；dispatch CAS 由 and(planId, status='approved') 谓词真实承载；新增 r2-fake-db-where.spec 5 用例。
- **验证**：`npx jest server/modules/scheduler/__tests__/ -q`（fixlog 记录：104 套件 818 用例全过，含 golden-workflow 零漂移门禁）。

## 10. 其余结构性收口（择要）

| 项 | 动机→改动 | 验证 |
|---|---|---|
| R2-SOP-003/059 | spatial_entity 全局唯一→(org_id, entity_id) 复合唯一迁移（清理历史重复→drop 单列→建复合，含 rollback） | sensor-scan-org-conflict.spec |
| R2-SOP-004 | IngestGuard per-key org 绑定（INGEST_API_KEY_<ORG_ID>；越出绑定域 403 INGEST_ORG_MISMATCH；constant-time 全程） | ingest-guard-keybinding.spec |
| R2-SSV-12 | station advisory lock 失败由"warn+继续"改 fail-closed 503（超卖窗口收敛） | capacity-aware-reservation.spec |
| R2-SNZ-013 | parameters writeParameter onConflictDoUpdate 补 setWhere CAS（(config_value->>'version'/'status' 谓词），并发双 approve/rollback 互覆关闭 | tsc+目标套件回归 |
| R2-SNZ-008 | dead-letter requeue 投递失败补偿 CAS（requeued→pending 回退，消除黑洞） | dead-letter spec 9 用例 |
| R2-SSV-06/20 | conflictId 统一 SHA-256 48-bit 折叠单一实现；FB-/EVT-/RPL-/KPI- ID 簇统一 randomUUID | r2-ssv-regression / conflict spec |
| R2-SCH-005/012/015 | MILP time_limit=10s + 冲突对分组去重（替代 O(V²)）；A* 二叉最小堆；routeEdgeTaskIndex 倒排索引化 | milp/routing/world-state spec |
| R2-MSC-002 | sw.js contract-version fail-closed 门（major 不符拒绝激活 + EWOH_SW_ROLLBACK 通知） | 5 分支手工验证（fixlog 记录） |

---

## 11. 未执行的 ADR 级巨重构（如实说明）

**本轮无 ADR 级巨重构执行。** 两类裁决不本轮落地：

### 11.1 四项 SYSTEMIC_REFACTOR_RULING（p2p3-dispositions.md，resolution_note 原文摘录）

| ID | 内容 | 不执行理由（resolution_note 摘要） | 缓解 |
|---|---|---|---|
| R2-ESC-007 | edge execute 逐条派工无整体回滚 | 事务边界重塑属系统性重构（派工/任务状态/事件三写路径一致性协议），单迭代改写破坏面大于收益 | 058 attempt 唯一约束 + SDB-005 占位式 exactly-once + 重放仲裁可检测部分提交；极端中断需人工对账（已知限制） |
| R2-ESC-009 | 申诉通道纯内存无持久化 | 新增持久化表需完整迁移/RLS/契约/前端链路（同 046 exo_session 量级） | 申诉数据当前仅 simulation/评估场景消费，无生产依赖方；待该域产品化时随决策记录落地 |
| R2-INF-002 | TS 全库 strict 翻转 | 继承平台 preset（@lark-apaas）strict:false，翻转需平台层配合且预计数百处修正 | 关键安全路径（租户谓词/CAS/fail-closed）已有运行时防御+测试覆盖；登记为平台依赖项 |
| R2-SAM-008 | 七处"主事实 insert+recordEvent"非同事务（系统性） | 本轮已修最关键三处（ExoSession start/terminate/activateProfile，R2-SAM-006/007）；剩余四处逐处事务语义需对账事件消费方幂等性，不批量改写 | 事件消费方均为幂等回读+audit 补偿路径，丢失不产生错误状态只损失观测 |

### 11.2 两项多 Kernel 巨文件 ADJUDICATED（parts/fixlog-ops.jsonl）

- **R2-SOP-012**：work-orchestration.service.ts（1592 LOC ≥6 职责）确认为多 Kernel，按"先内聚分组再动"不强拆；本轮仅做不破坏行为的最小收敛（R2-SOP-001 requireActorOrgId 接线、R2-SOP-017 读回退显式化）；拆分方案（WorkGraphReadService/GateDecisionService/ResourceLockService/HandoffService/GitSyncService）作后续 ADR 立项。
- **R2-SOP-013**：scale.service.ts（1720 LOC ≥7 职责）同裁决；本轮先收敛其放大出的租户谓词缺陷面（R2-SOP-008/009/010 全部修复）。

**结论**：本轮结构性修复集中在**幂等/事务/租户谓词/状态机单一事实源/契约门禁**五个纵深面，共新增 2 个 audit-domain-contracts 结构门禁（world_state_const_vs_rules_self_consistent、state_machine_terminal_no_outgoing_edge）、3 个迁移（058 接入/059/060）、1 个共享约束编译器；域形态级重构（Decision 提升、Event 骨干抽取、巨文件拆分、strict 翻转）全部经裁决不在本轮执行，理由与缓解已逐项登记。
