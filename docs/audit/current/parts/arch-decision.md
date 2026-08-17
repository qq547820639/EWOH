# Canonical Decision 架构审计（arch-decision）

审计日期：2026-08-17。范围：ewoh-spark-app/server（NestJS + Postgres）、shared/decision.ts、contracts/decision/、src/edge_platform/contracts/decision.py、client 决策历史读面。只读取证，全部结论附 file:line（路径以 ewoh-spark-app/ 或仓库根缩写）。

核心问题：**Decision 仍是 Scheduler 私有实现，还是已成为多 Domain 公共事实？**

---

## 一、判定结论（一句话）

**Decision 已是事实上的跨域公共事实——契约三实现全局锁步、数据横跨 4 张表分属 scheduler/agent/learning 三域、agent 与 learning 两域反向 import scheduler 内的投影实现——但治理形态仍是 Scheduler 私有（唯一投影点/台账/历史服务物理托管在 `server/modules/scheduler/`），形成 agent→scheduler、learning→scheduler 的反向依赖，应提升为独立 Decision Domain。**

---

## 二、Decision 数据流图（写入者 → 存储 → 消费者）

### 2.1 契约层（已全局公共化）

| 层 | 位置 | 角色 |
|----|------|------|
| JSON Schema | contracts/decision/decision.schema.json:1-195（8 kind/5 status/5 authority，required 11 字段 :182-194） | 权威契约（ewoh:///decision/decision/v1） |
| TS 实现 | ewoh-spark-app/shared/decision.ts:13-96（DECISION_KINDS 等 4 注册表 + DecisionRecord 接口）+:138-255（validateDecision fail-closed） | server + client 共用（@shared/decision） |
| Python 实现 | src/edge_platform/contracts/decision.py:26-254（逐项镜像校验） | 边缘运行时契约 |
| 跨语言仲裁门 | scripts/audit-domain-contracts.js:1086-1219（schema/vectors 仲裁）+:1767-1770/1849-1852（TS↔Python 注册表逐位比对） | CI 门禁锁步 |
| 测试向量 | contracts/decision/decision.test-vectors.json（records 共享向量） | 三实现共用 |

风险阶梯单一事实源：risk 契约 SEVERITY_LADDER（decision.ts:41 import；decision.py:54；schema rules.riskLadderSharedWithRiskContract=true，schema.json:43，仲裁门 :1121-1123 逐位比对）——**契约层无漂移**。

### 2.2 存储层（4 张表，横跨 3 个域）

| # | 表.列 | kind | 所属域 | 定义 |
|---|-------|------|--------|------|
| S1 | `ewoh_schedule_plan.decision_records_json`（jsonb 数组） | 1/2/4/5/6（task_assignment、plan_approval、resource_reservation、dispatch、replan） | scheduler | server/database/schema.ts:704-708 |
| S2 | `ewoh_agent_approval.decision_json`（jsonb 单记录） | 3（agent_approval） | **agent** | schema.ts:999-1004 |
| S3 | `ewoh_learning_proposal.decision_json`（jsonb 单记录） | 7（learning_proposal_activation） | **learning** | schema.ts:1929-1934 |
| S4 | `ewoh_scheduling_policy.decision_json`（jsonb 单记录） | 8（policy_activation） | scheduler | schema.ts:2177-2182 |

### 2.3 写入者（6 条写路径，全部经 decision-projection 契约门 validateDecision）

| 写入者 | 域 | kind | 写位点 | 存储落点 |
|--------|----|------|--------|----------|
| PlanService.persistPlan | scheduler | task_assignment（N 条） | plan.service.ts:81 projectPlanDecisionRecords → :87-119 INSERT | S1 |
| PlanService.approve/reject | scheduler | plan_approval | plan.service.ts:368-372 → :381-404 appendPlanApprovalDecision（经 decision-ledger.ts:41-55 读-追加-回写） | S1 |
| DispatchCoordinator | scheduler | resource_reservation + dispatch | dispatch-coordinator.service.ts:409-442（与派工同事务）→ :469-501/:508-515（appendPlanDecisionRecords） | S1 |
| ReplanCoordinator | scheduler | replan | replan-coordinator.service.ts:751-781（handleTrigger）+:931-955（scoped replan，单事务 NEST-125） | S1 |
| AgentService（审批解析） | **agent** | agent_approval | agent.service.ts:16-19 **import '../scheduler/decision-projection'** → :510-515/:527-532 投影 + :556-584 resolveRow（CAS UPDATE） | S2 |
| LearningProposalService（激活/拒绝/回滚） | **learning** | learning_proposal_activation | learning-proposal.service.ts:15 **import '../scheduler/decision-projection'** → :159/:201/:243（与终态同 UPDATE 原子写） | S3 |
| SchedulingPolicyService（激活/直接保存激活） | scheduler | policy_activation | scheduling-policy.service.ts:305-330（savePolicy）+:428-442（activate，与 active 翻转同 UPDATE） | S4 |

投影实现单一：decision-projection.ts 是全部 8 类 kind 的唯一 DecisionRecord 生产点（:65/:176/:288/:386/:476/:561/:641/:722 八个 project* 函数），全部以 validateDecision 收口（fail-closed，缺口显式 issues，§33 不静默不伪造）。台账追加单一：decision-ledger.ts:41-55（读-追加-回写，无 CAS——调用方事务语义保证，NEST-024 org 条件防跨租户追加）。

### 2.4 消费者（读面）

| 消费者 | 域 | 读位点 | 范围 |
|--------|----|--------|------|
| DecisionHistoryService | scheduler | decision-history.service.ts:119-130（S1）+:133-143（**S2，跨域读 agent 表**）+:146-154（**S3，跨域读 learning 表**）+:157-165（S4） | **四表全量聚合**（无 LIMIT 下推、内存排序分页 :168-176；validateDecision 双重校验 :96-108 + 记录级 tenantId 过滤 :104） |
| SchedulerController.getDecisionHistory | scheduler | scheduler.controller.ts:141-161（@Controller('api/scheduler') :56 → GET /api/scheduler/decision-history；kind/status fail-closed） | HTTP 读面；openapi/ewoh.yaml:6004 |
| PlanService.getPlan | scheduler | plan.service.ts:1075-1076（decisionRecordsJson 读回进 SchedulingPlanV2.decisionRecords，shared/scheduler.ts:1215-1225） | 方案详情附带 |
| 前端 DecisionHistoryConsole | client | client/src/pages/DecisionHistory/DecisionHistoryConsole.tsx:10/:35 → api/decisions.ts:25-41（GET /api/scheduler/decision-history；DecisionRecord 类型直接 import @shared/decision :2） | 决策历史页（路由 /decision-history，app.tsx:86） |
| 前端 CommandMap 决策上下文 | client | decisionContextVM.ts / decisionExplainVM.ts:7（import DecisionTrace from '@shared/api.interface'） | **不经 DecisionRecord**——消费求解内嵌 DecisionTrace（方案详情），与 Canonical 记录并行两套解释面 |

Python 边缘侧：src/edge_platform 仅持有校验契约（decision.py:102 validate_decision），**无生产写入**（grep 全 edge_platform 无 decision_record 构造位点）。

### 2.5 无关同名物（排除项）

- work-orchestration.service.ts:182-1366 GateDecisionRecord/GateDecisionHistory——文件型门禁决策，与 Canonical DecisionRecord 无关；
- modules/policy/policy.service.ts:121（Rego 求值 decision 字段）、mes.service.ts:622（请求体字段）——局部变量，非决策台账；
- modules/approval（工单/危险操作审批）——**零 Decision 消费**（grep 无命中）。

---

## 三、Scheduler 私有 vs 公共事实判定

| 维度 | 事实 | 判定 |
|------|------|------|
| 契约 | contracts/decision/ + shared/decision.ts + decision.py 三实现 + CI 仲裁门；client 直接 import DecisionRecord | **全局公共** |
| 数据 | 4 表分属 scheduler（2）/agent（1）/learning（1）三域；8 类 kind 中 2 类（agent_approval、learning_proposal_activation）的**权威写路径在非 scheduler 域服务内** | **跨域公共** |
| 写实现 | 唯一投影 decision-projection.ts、唯一台账 decision-ledger.ts **物理托管在 modules/scheduler/**，被 agent/learning 跨模块文件级 import（agent.service.ts:16-19、learning-proposal.service.ts:15） | **私有托管 + 跨域借用**（反向依赖） |
| 读实现 | 唯一跨 kind 读面 DecisionHistoryService 在 scheduler，**反向跨域直读 agent/learning 两表**（decision-history.service.ts:133-154）；端点挂 scheduler 路由下 | **私有托管 + 跨域读** |
| 模块装配 | AgentModule imports SchedulerModule（agent.module.ts:21）、LearningModule imports SchedulerModule（learning.module.ts:17）——两个非 scheduler 域对 scheduler 的模块级依赖（部分动因即 decision-projection 无独立可引模块） | **域间耦合** |

**裁决**：Decision 的契约与数据早已溢出 Scheduler 边界（跨域消费位点见 §四），但代码治理（投影/台账/历史/端点）仍寄居 Scheduler，制造了 agent→scheduler、learning→scheduler 两条本可避免的反向依赖。**已满足提升独立 Decision Domain 的全部证据条件。**

---

## 四、跨域消费位点清单（生产/消费级，非契约共享）

| # | 位点 | 方向 | 证据 |
|---|------|------|------|
| 1 | AgentService import scheduler 投影并写 agent 表 | agent→scheduler（代码）+ agent 域产决策 | agent.service.ts:16-19、:510-532、:556-584 |
| 2 | LearningProposalService import scheduler 投影并写 learning 表 | learning→scheduler（代码）+ learning 域产决策 | learning-proposal.service.ts:15、:159/:201/:243 |
| 3 | DecisionHistoryService 直读 ewoh_agent_approval.decision_json | scheduler→agent（表） | decision-history.service.ts:133-143 |
| 4 | DecisionHistoryService 直读 ewoh_learning_proposal.decision_json | scheduler→learning（表） | decision-history.service.ts:146-154 |
| 5 | AgentModule/LearningModule imports SchedulerModule（模块级耦合，含决策投影借用动因） | agent/learning→scheduler（模块） | agent.module.ts:21、learning.module.ts:17 |
| 6 | client（非 scheduler 前端域）import @shared/decision DecisionRecord 消费四表聚合结果 | client→契约+跨三域数据 | client/src/api/decisions.ts:2/:36 |

**跨域消费位点合计：6 处**（其中代码级反向 import 2 处、跨域表读 2 处、模块依赖 1 组、前端跨域消费 1 处）。

---

## 五、九要素 × 八类 kind 字段完备性矩阵

九要素→字段映射：Context=subject/tenantId/snapshotRef；Options=options；Selected=selected；Authority=decisionAuthority；Policy=policyVersion；Reason=selected.reason；Evidence=evidence；Approval=requiresApproval+approver；Outcome=outcomeRef。✓=必有；△=条件性；✗=未写。（7 类任务点名 kind + scheduler 自有的 task_assignment 共 8 类，逐一对照 decision-projection.ts 投影产物。）

| 要素 | task_assignment | plan_approval | agent_approval | resource_reservation | dispatch | replan | learning_proposal | policy_activation |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Context.subject/tenantId | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Context.snapshotRef | △ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Options | ✓ 真实候选 | ✓ 合成双选 | ✓ 合成双选 | ✓ 合成双选 | ✓ 合成双选 | ✓ 合成双选 | ✓ 合成双选 | ✓ 合成双选 |
| Selected | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Authority | ✓ optimization | ✓ human | ✓ human/policy | ✓ rule_based | ✓ policy | ✓ policy | ✓ human | ✓ human |
| **Policy（policyVersion）** | △ trace 有才带 | **✗** | **✗** | **✗** | **✗** | **✗** | **✗** | **✗**（版本仅内嵌 subject） |
| Reason（selected.reason） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Evidence** | **✗** | **✗** | ✓ manifest_risk+command | ✓ assignment/task | ✓ count+outbox | ✓ run/trigger/affected/entity | ✓ proposal/kind | ✓ version |
| Approval（requiresApproval/approver） | ✓ true / N-A | ✓ false+approver | ✓ approver | ✓ false（审批在 #2） | ✓ false | ✓ true 待审 | ✓ approver | ✓ approver |
| **Outcome（outcomeRef）** | **✗** | **✗** | **✗** | **✗** | **✗** | **✗** | **✗** | **✗** |

证据行号：task_assignment decision-projection.ts:134-153（evidence 未设；snapshotRef :151、policyVersion :149 条件性）；plan_approval :194-211（无 evidence/policyVersion/outcomeRef；审批前仿真结果未链接）；agent_approval :319-343（evidence :338-341；TTL 路径 authority=policy 却无 policyVersion）；resource_reservation :411-428（evidence :408-409）；dispatch :500-517（evidence :493-498；authority=policy 无 policyVersion）；replan :584-604；learning_proposal :674-692；policy_activation :739-757。

**九要素缺口汇总**：
1. **Outcome 断链（8/8 全缺）**：outcomeRef 零写入。契约显式放行（schema.json:50 `outcomeLinkOptional: true`），但「决策→结果」闭环实际不存在——learning 的 outcome-annotation、scheduling-feedback、dispatch 后执行反馈均未回填 outcomeRef。
2. **Policy 缺失（7/8 缺）**：policyVersion 仅 task_assignment 条件携带；plan_approval/dispatch/replan 等写路径明明持有策略版本事实（ewoh_schedule_plan.policyVersion 列存在，plan.service.ts:99）却未投影。
3. **Evidence 缺失（2/8 缺）**：task_assignment（求解证据在 trace 但未搬入）、plan_approval（审批前仿真 preApprovalSimulation 未入证据）。
4. **Context 浅表（7/8 无 snapshotRef）**：除 task_assignment 条件携带快照版本外，其余 kind 无决策时世界快照引用，回放语境依赖宿主表旁证。
5. Options 真实性分层：仅 task_assignment 携带真实多候选项（含 score/reasons）；其余 7 类均为「合成双选」（opt:approve/opt:reject 等二元占位）——契约合法但解释价值有限。

**契约一致性核实**：schema.json 与 decision.ts 与 decision.py 三方 required 字段、封闭注册表、approver 判定（human 或 approved/rejected 必带 approver，时间不倒退）、selected∈options、auditTrail 非空——逐项一致（decision.ts:98-110 ↔ schema.json:182-194 ↔ decision.py:64-76），且有 CI 仲裁门（audit-domain-contracts.js:1086-1219）与共享向量。唯一形态差异：schema 对 decidedAt 仅 `type:string` 无 format 约束（schema.json:93-95），ISO 可解析性由 TS/Python 实现层收紧——实现收紧方向，无漂移风险。

---

## 六、提升独立 Decision Domain 的建议边界与迁移路径

### 6.1 边界（迁什么/不迁什么）

迁入新 `server/modules/decision/`（DecisionModule）：
- decision-projection.ts（8 个 project* 纯函数——域投影算子，天然无状态）；
- decision-ledger.ts（S1 台账读-追加-回写）；
- decision-history.service.ts + 独立 DecisionController（GET /api/decision-history）。

不迁（维持现状）：
- 契约层 @shared/decision + contracts/decision/ + decision.py（已全局公共，零改动）；
- 4 张宿主表的 decision_json/decision_records_json 列（就地 additive，避免大迁移；decision 记录与宿主业务行同事务原子性是当前设计优点——resolveRow/激活翻转/派工事务均依赖此）；
- 各域服务保留「投影调用 + 同事务落库」的写路径形状（仅改 import 路径 `../scheduler/decision-projection` → `../decision/decision-projection`）。

### 6.2 迁移路径（三步，每步独立可发布）

1. **代码归位（低风险）**：新建 DecisionModule，move 三个文件，agent.service.ts:16-19 与 learning-proposal.service.ts:15 改 import；SchedulerModule 改为 re-export 兼容；端点 /api/scheduler/decision-history 加 @Controller 别名双路由过渡（openapi/ewoh.yaml:6004 同步双路径），前端 api/decisions.ts:36 切新路径。消除 2 条跨域代码反向依赖与 1 组模块级耦合。
2. **读面治理（中风险）**：DecisionHistoryService 四表全量内存排序（decision-history.service.ts:119-176，无 LIMIT 下推——数据增长后全表扫描风险）改为各表先 SQL 过滤/限流再聚合，或维护物化视图；skippedInvalid/sources 语义保持。
3. **可选终态（按需）**：若跨域 kind 继续增长（第 9+ 类），评估统一 `ewoh_decision` 独立台账表（写入经 DecisionModule 单一入口，宿主行仅留 decisionId 引用），换取统一分页/索引与 outcome 回填的单一落点；当前 8 类规模下非必需。

### 6.3 若维持现状的裁决依据（反方陈述）

当前唯一投影点 + 唯一台账 + CI 契约门已保证「单一实现」纪律（§31），跨域 import 是纯函数借用、无运行时耦合；4 表就地存储换来与宿主业务状态的原子一致性。若组织判定「Scheduler 是 Decision 的第一公民宿主、agent/learning 借用可接受」，则维持现状的最低整改为：① agent/learning 的 import 至少收敛为经 index barrel；② 补 §五 的 policyVersion/evidence 缺口；③ decision-history 读面加下推限流。但「agent 域数据由 scheduler 域服务直读聚合」的边界倒挂（§四 #3/#4）在域自治标准下仍构成提升依据。

---

## 七、关键风险登记

| 风险 | 证据 | 影响 |
|------|------|------|
| decision-history 全量拉取内存分页 | decision-history.service.ts:119-176（四表无界 SELECT） | 数据量增长后延迟/内存劣化 |
| S1 台账读-追加-回写无 CAS | decision-ledger.ts:41-55（注释自认，靠调用方事务） | 并发追加竞态窗口（当前由派工 CAS/单事务封堵） |
| Outcome 断链 8/8 | §五.1 | 决策质量复盘（learning 闭环）缺结果锚点 |
| 两套前端解释面并行 | decisionExplainVM.ts:7（DecisionTrace）vs DecisionHistoryConsole（DecisionRecord） | 解释口径可能漂移 |
