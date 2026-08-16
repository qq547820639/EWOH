# 变更日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 1.1.0 规范，
并使用[语义化版本](https://semver.org/lang/zh-CN/) 2.0.0 进行版本管理。

## [Unreleased]

### Added
- **Model Training Policy v1（租户隔离强制，NO-13u，ADR-070，R-91，§15/§16/§33）**：
  - 仓库事实发现真实泄漏风险（retrain 无 org 过滤混合全租户反馈训练
    全局模型）→ v1 政策 = **租户作用域训练**（跨租户聚合显式 OFF，
    无授权/匿名化机制前禁止）；
  - modelId org 命名空间：`task-duration-empirical:<orgId>` /
    `:<orgId>:<taskType>`（orgIdFromModelId 解析；旧全局模型显式
    弃用不回填）；provider org 键控（orgModels + refreshForOrg；
    预测必须携带 task.orgId，缺 → 确定性基线显式 §33）；
  - `retrain(orgId)` / `hydrateFromRegistry(orgId)` 强制（缺 orgId
    → 400；feedback org_id 过滤）；controller 端点注入 userContext
    org；cardJson 携带 orgId 判定事实；
  - 测试：provider spec org 键控更新 + training spec 跨租户隔离
    + 缺 org 400（9 例）；default jest 266 suites 1976→**1978**
    tests；
  - 无 schema/OpenAPI/env 变更；§15/§16 机器强制收口（ADR-056/067
    遗留边界关闭）。
- **Exo Support Mode 观测边界复核与锁定（NO-13t，ADR-069，R-90，§7/§33）**：
  - 仓库事实复核：NY-EXO-A1 协议确认书 2.3 TELEMETRY 20B 布局无
    mode 字节（assist_pct 为助力强度连续量非模式分类）；IDENT/
    FAULT/HEARTBEAT 无 mode；VENDOR_TO_UNIFIED 无 mode 语义路径；
    UnifiedExoFrame 无 supportMode 字段——**阻塞仍成立**（厂商协议
    升级前不伪造观测）；
  - 机器锁定边界：test_ny_exo_a1_contract.py +3 例（TELEMETRY
    字段集锁定 / 统一语义帧无 support_mode / VENDOR_TO_UNIFIED
    无 mode 语义路径——协议升级触发失败即漂移信号）；pytest
    1340 passed/10 skipped 全绿（含 +3）；
  - assist_level 数值事实照常观测（与配置 mode 并列，不推导
    分类）；无实现变更（仅测试 + 文档）。
- **SimulationConsole 数据型页面渲染 smoke（NO-13s，ADR-068，R-89，§17/§18/§31/§33）**：
  - 提取 `SimulationRunList` 纯展示组件（rows/selectedRunId/
    onSelectRun props 零网络；控制台委托渲染行为逐字一致，
    data-testid 保留）；TONE_TEXT/TONE_BORDER 上移
    simulationConsoleLogic（§31 单一来源）；
  - 渲染 smoke 2 例（数据行契约字段透出 / 失败行 failureReason
    显式头条 + aria-pressed 选中态——R-87 模式推广）；client jest
    119→120 suites 968→**970** tests；
  - 数据型页面渲染 smoke 缺口第二项关闭；无 DB/OpenAPI/env 变更。
- **per-taskType 经验时长模型分组（NO-13r，ADR-067，R-88，§10/§21/§33）**：
  - modelId 词表：全局 `task-duration-empirical`（v1 语义不变）+
    分组 `task-duration-empirical:<taskType>`（taskType 为任务登记
    事实非猜测；无类型仅计全局）；
  - 预测两级回退显式：taskType 分组模型 → 全局模型 → 确定性基线
    （source/modelVersion 如实标注，§33 不静默）；
  - `retrain` = 全局 + 分组独立落版（每 modelId 版本链 supersede +
    递增；分组样本 < MIN_SAMPLES → 显式 skipped 不落版；cardJson
    携带 taskType 判定事实）；RetrainSummary.perTaskType additive；
  - `hydrateFromRegistry` 全量回填（isEmpiricalModelId 前缀过滤 +
    按 modelId 最新 active 重建分组映射，冷启动恢复分组训练态）；
  - 测试：empirical-duration-prediction.spec +2 例（分组优先 /
    两级回退）+ duration-model-training.service.spec +2 例（分组
    独立 modelId 链 + 不足跳过 / hydrate 映射重建）；default jest
    266 suites 1972→**1976** tests；
  - shadow-only 边界不变；无 DB/OpenAPI/env 变更；ADR-056 决策 3
    后续收口。
- **Decision History 控制台 UI（NO-13q，ADR-066，R-87，§17/§18/§33）**：
  - 数据型页面三层：`decisionHistoryLogic`（8 kind / 5 status /
    5 authority 标签 + 风险档 tone + 行模型——未知词表值原样透出
    不猜测 + sources 摘要）/ `DecisionHistoryTable`（纯展示，契约
    字段透出零网络）/ `DecisionHistoryConsole`（react-query 消费
    ADR-065 端点 + kind/status 过滤 + "加载更多"分页 +
    skippedInvalid 显式横幅（§33 非法记录绝不静默）+ 错误/空/
    加载态）；
  - `fetchDecisionHistory`（client/api/decisions.ts，类型复用
    @shared/decision §31）；路由 /decision-history + 侧边栏 nav 项
    （决策历史，dispatcher/workshop_lead/global_admin）；
  - 测试：decisionHistoryLogic.test 4 例 + DecisionHistoryTable
    .render.test 2 例（数据行透出 / 非法横幅 + 空态）；client jest
    117→119 suites 962→**968** tests；
  - 另修复 rule-based-scheduling-solver.spec 重放 deep-equal 的
    createdAt 墙钟 flake（strip 纳入 createdAt——测试确定性卫生）；
  - 无 DB/OpenAPI/env 变更；数据型页面渲染 smoke 缺口关闭。
- **Decision History 跨 kind 检索端点（NO-13p，ADR-065，R-86，§12/§15/§18/§33）**：
  - `DecisionHistoryService`：Decision Catalog 8 类 kind 跨四表统一
    读面（schedule_plan.decision_records_json + agent_approval /
    learning_proposal / scheduling_policy .decision_json）——记录级
    租户过滤统一面（plan 表无 org_id 列显式边界；org 作用域表
    org_id 列过滤 + 记录过滤双保险；scheduling_policy 全局 null 行
    不进入租户查询显式边界）；全部记录过 validateDecision（§31
    单一校验器），非法 → 显式 skippedInvalid 计数（§33 绝不静默
    丢弃）；decidedAt 降序 + decisionId 字典序稳定排序；limit 缺省
    50 cap 100；kind/status 过滤器 fail-closed（未知值 400）；
  - `GET /api/scheduler/decision-history`（只读；零写入零事件）；
    OpenAPI +1 路径（397→398 controllers / 588→590 spec）+ client
    types 再生成；
  - 测试：decision-history.service.spec 3 例（四表聚合 + 他租户
    剔除 + sources 扫描量审计 / kind+status 过滤 + fail-closed +
    cap + offset / 非法 skippedInvalid + 缺租户 400）；default jest
    265→266 suites 1969→**1972** tests、client jest 117/962 全绿；
  - 无 DB/env 变更；决策历史面板 UI 后续立项。
- **Policy Activation Decision 接线（NO-13o，ADR-064，R-85，§2/§8/§12/§18/§33）**：
  - `projectPolicyActivationDecision`：Decision Catalog kind #8——
    decisionId=`decision:policy:v<version>:activation` 确定性幂等
    （单记录列重复激活同 id 覆盖为最新决策，语义显式）；kind=
    policy_activation / status=executed / authority=human
    （approver 强制人审门）/ subject=policy:v\<v\> / riskLevel=
    'high' 类型推导规则锁测试（策略激活直接翻转生产调度行为）/
    requiresApproval=false（本记录即人审激活事实）/ selected.reason
    =[人审理由||'activated'] / approver 判定事实 / evidence=
    version:\<v\>；
  - `SchedulingPolicyService.activatePolicyVersion` active 翻转与
    decisionJson **同一 UPDATE 原子写**（reason 由
    SchedulerPlanApplicationService 透传 body.reason）+ savePolicy
    直接激活路径 INSERT 携带（reason 缺省 policy-save-activated）；
    投影缺口 log 显式留 NULL 不阻断激活主流程（§2/§33；全局策略
    orgId null 缺口显式边界——契约强制 tenantId 不伪造）；
  - standalone_054 原地加固（计数不变 74/77；旧行 NULL=未投影）：
    runner 全套注册 + check script 成对回滚 + CI step + state.json +
    schema-manifest new→altered；
  - 测试：decision-projection.spec +3 例（判定事实 / 缺省理由 +
    幂等 / 缺口显式）+ policy-version.spec +2 例（activate 行翻转
    decisionJson 落库 + validateDecision 门 / savePolicy 路径）；
    default jest 265 suites 1964→**1969** tests；
  - **Decision Catalog 8 类 kind 全收敛收口**（§12 Decision History
    全链覆盖：task_assignment / plan_approval / agent_approval /
    resource_reservation / dispatch / replan / learning_proposal_
    activation / policy_activation）；无 OpenAPI/env 变更。
- **Learning Proposal Activation Decision 接线（NO-13n，ADR-063，R-84，§2/§10/§12/§18/§33）**：
  - `projectLearningProposalActivationDecision`：Decision Catalog
    kind #7——decisionId=`decision:<proposalId>:activation` 确定性
    幂等（状态机单向转移）；kind=learning_proposal_activation；
    status 映射：approve→approved / reject→rejected / rollback→
    superseded（激活决策被回滚取代）；authority=human（三路径强制
    人审身份+理由）；subject=proposal:\<id\>；riskLevel='medium'
    类型推导规则锁测试（阈值激活间接触发调度建议面）；
    requiresApproval=false（本决策即人审事实）；selected：
    approve→opt:activate（缺省 approved）/ reject·rollback→
    opt:keep（必填理由事实）；approver 判定事实；evidence=
    proposal+kind 链接；
  - `approve`/`reject`/`rollback` 与状态终态**同一 UPDATE 语句**
    原子写 decision_json（standalone_053 原地加固，计数不变
    74/77；旧行 NULL=未投影）；投影缺口 log 显式留 NULL 绝不阻断
    提案主流程（§2/§33）；
  - 测试：decision-projection.spec +3 例（approve 判定事实 /
    reject·rollback 状态映射+理由强制 / 幂等 + 缺口显式）+
    learning-proposal.service.spec +3 例（三路径 decisionJson
    落库 + validateDecision 门）；default jest 265 suites
    1958→**1964** tests；
  - Decision Catalog kind #7 接线（§12 Decision History 覆盖学习
    提案激活全链；其余 1 类后续逐类收敛）；无 OpenAPI/env 变更。
- **Replan Decision 接线（NO-13m，ADR-062，R-83，§2/§8/§12/§18/§31/§33）**：
  - `projectReplanDecision`：Decision Catalog kind #6——
    decisionId=`decision:<planId>:replan` 确定性幂等（同一 planId 至多
    持久化一次）；kind=replan / status=proposed（新方案 shadow 待
    审批）/ authority=policy（触发链=政策驱动）/ subject=plan:\<id\> /
    riskLevel=触发类型推导规则锁测试（SAFETY_EVENT / ZONE_RESTRICTED
    →high；PERSON_UNAVAILABLE / DEVICE_OFFLINE→medium；其余→low）/
    requiresApproval=true / selected.reason=trigger:\<type\>:
    affected:\<n\> / evidence=run+trigger+affected+entity 链接 /
    auditTrail actor=policy:replan-trigger（自动触发不伪造 human
    身份）；
  - `replan-coordinator` persistPlan 后逐方案追加（handleTrigger +
    handleConflictBatch 双路径；投影缺口/追加失败 log 显式绝不阻断
    重排主流程，§2/§33；抑制路径（debounce/storm/low-improvement）
    不产生记录——事实一致）；
  - **§31 收口**：`decision-ledger.ts`（appendPlanDecisionRecords
    读-追加-回写单一实现）——plan.service（审批追加）+
    dispatch-coordinator（派工追加）+ replan-coordinator（重排追加）
    三处消费收敛（既有 spec 回归锁定）；
  - 测试：decision-projection.spec +3 例（判定事实 / 风险类型规则 /
    幂等 + 缺口显式）+ replan-decision-persistence.spec 2 例（kind
    #6 台账 + validateDecision 门 + 去抖幂等）；default jest 264
    suites 1953→**1958** tests；
  - Decision Catalog kind #6 接线（其余 2 类后续逐类收敛）；无
    DB/OpenAPI/env 变更。
- **Dispatch Decision 接线（NO-13l，ADR-061，R-82，§2/§12/§18/§33）**：
  - `projectDispatchDecision`：Decision Catalog kind #5——
    decisionId=`decision:<planId>:dispatch` 确定性幂等（double-
    dispatch CAS）；kind=dispatch / status=executed（执行步骤留痕）/
    authority=policy（派工链含政策门 SAFETY_BLOCK_DISPATCH /
    ADVISORY fail-closed / 快照新鲜度强校验）/ subject=plan:\<id\> /
    riskLevel=分配风险档聚合 max 规则（任一 high→high / 否则任一
    medium→medium / 否则 low——复用 ADR-048 决策 2 单条映射，聚合
    规则锁测试）/ requiresApproval=false（审批事实在 kind #2）/
    selected.reason=dispatched:\<count\>（真实派工数）/ evidence=
    outbox 事件 id 链接；
  - `DispatchCoordinator.dispatch` 事务末与 kind #4 记录**单次**
    读-追加-回写 decision_records_json（projectReservationDecision
    Records + appendDecisionRecords 重构；投影缺口/追加失败 log
    显式绝不阻断派工主流程，§2/§33）；getPlan 读回自动携带；
  - 测试：decision-projection.spec +3 例（判定事实 / 风险聚合 max
    规则 / 缺口显式）+ dispatch-integration.spec 主链路断言补强
    （kind #5 台账 + getPlan 读回携带）；default jest 264 suites
    1950→**1953** tests；
  - Decision Catalog kind #5 接线（派工链全链留痕：kind #2 审批 →
    kind #4 预占 → kind #5 派工；其余 3 类后续逐类收敛）；无
    DB/OpenAPI/env 变更。
- **Resource Reservation Decision 接线（NO-13k，ADR-060，R-81，§2/§12/§18/§33）**：
  - `projectResourceReservationDecision`：Decision Catalog kind #4——
    decisionId=`decision:<planId>:reservation:<assignmentId>:<reservationId>`
    确定性幂等（reservationId 单次生成 + double-dispatch CAS）；
    kind=resource_reservation / status=executed（执行步骤留痕非提议）/
    authority=rule_based（预占输入由 assignment 字段确定性推导）/
    subject=`resource:<type>:<id>` / riskLevel 复用 ADR-048 决策 2
    映射规则（§31 单一规则）/ requiresApproval=false（审批事实在
    kind #2）/ selected.reason=台账行唯一链接（reservationId:type:
    id:窗口）/ auditTrail actor=user:\<id\>|system:dispatch；
  - `DispatchCoordinator.dispatch` 预占循环收集真实 reserve() 结果 →
    **与派工同事务**读-追加-回写 decision_records_json（无第二事实源；
    投影缺口/追加失败 log 显式绝不阻断派工主流程，§2/§33）；
    getPlan 读回自动携带；
  - 测试：decision-projection.spec +3 例（判定事实 / 缺省 actor +
    幂等 / 缺口显式）+ dispatch-integration.spec 主链路断言补强
    （派工后方案决策台账含 kind #4 + getPlan 读回携带）；default
    jest 264 suites 1947→**1950** tests；
  - Decision Catalog kind #4 接线（§12 Decision History 覆盖派工
    预占全链；其余 4 类后续逐类收敛）；无 DB/OpenAPI/env 变更。
- **Agent Approval Decision 接线（NO-13j，ADR-059，R-80，§2/§11/§12/§18/§33）**：
  - `projectAgentApprovalDecision`：Decision Catalog kind #3——
    decisionId=`decision:<approvalId>:agent-approval` 确定性幂等
    （ADR-039 CAS 单次解析）；kind=agent_approval；status=approved/
    rejected（expired → rejected，reason=approval_expired）；
    authority 区分人工=human / TTL 超期=policy（不伪造 human 身份）；
    riskLevel 映射自 manifest.riskLevel 真实清单事实（critical 收敛
    high + evidence `manifest_risk:<level>` 留原始档）；
    requiresApproval=false（本决策即审批事实）；approver 判定事实
    （user:\<id\> / policy:agent-approval-ttl）；validateDecision 门；
  - `resolveApproval` 三路径（approved/rejected/expired）投影 +
    resolveRow 唯一权威写路径：decision_json 与解析终态**同事务原子
    落库**（standalone_052 原地加固，计数不变 74/77；旧行 NULL=
    未投影）；投影缺口/契约失败 log 显式留 NULL，绝不阻断审批主流程
    （§2/§33，与 ADR-057 同纪律）；
  - 测试：decision-projection.spec +5 例（kind #3 判定事实 / 驳回
    缺省理由 + 幂等 / expired policy / 风险映射规则 / 缺口显式）+
    agent.service.spec +3 例（approved/rejected/expired decisionJson
    落库 + validateDecision 门）；default jest 264 suites
    1939→**1947** tests；
  - Decision Catalog kind #3 接线（§12 Decision History 覆盖 Agent
    审批解析全链；其余 5 类后续逐类收敛；跨 kind 检索端点后续立项）。
- **MILP Scheduling Solver 接入（NO-13i，ADR-058，R-79，§8/§9/§31/§33）**：
  - `milp-scheduling-solver.ts`（HiGHS 1.15.2 WASM 真实 MILP 求解器，
    MIT，进程内无外部服务依赖；`highs` npm 依赖无传递依赖）——§8
    求解器阶梯第 4 类落地（CP-SAT / heuristic / rule-based / MILP）；
  - 语义（ADR-058 决策 1，§9 差异边界显式）：共享 CandidateEngine
    候选面（§31）→ 二元变量 + 联合行（每任务至多一候选 / 人员·设备
    重叠互斥 / 工位窗口容量（capacity K 大 M 线性化）/ DAG 闭包与
    时序冲突对）；目标 = 与 heuristic 同一 per-candidate 加性评分 +
    M·未分配罚（M=1+⌈Σcost⌉ 可证明"先最大化分配数、再最小化成本"）；
    heuristic=顺序贪心 vs MILP=联合精确最优（唯一差异边界）；
  - `solver.service` 路由 `policy.solverVersion='milp-v1'` 显式选择
    （不参与 CP-SAT 激活阶梯、无隐式回退；solverActivation.state=
    'MILP' 如实标记，SolverActivationState 联合 additive）；
    solverVersion='milp-v1' + solverStatus='OPTIMAL' 如实标记；
    HiGHS 非 Optimal/加载失败显式抛出（§33 不静默降级）；
  - 测试：milp-scheduling-solver.spec 9 例（真实 HiGHS 求解：最优性
    vs 穷举 / 容量冲突 / DAG 闭包·时序 / 工位容量互斥 / 重放
    deep-equal / 空任务 / WASM 失败显式抛出）；default jest
    263→264 suites 1930→**1939** tests；
  - OPEN-DECISIONS MILP 环境阻塞解除（ADR-053 决策 3 再评估）；剩余
    缺口 = CP-SAT 生产启用（部署环境，OPEN-DECISIONS 唯一项）；
    solver-pluggability 矩阵保持 Partial（§36 口径不提前升级）。
- **Plan Approval Decision 接线（NO-13h，ADR-057，R-78，§12/§18/§33）**：
  - `projectPlanApprovalDecision`：Decision Catalog kind #2——
    decisionId=`decision:<planId>:approval:v<version>` 确定性幂等；
    kind=plan_approval / authority=human + approver 判定事实 /
    riskLevel='high'（类型推导规则锁测试）/ requiresApproval=false
    （本决策即审批事实）/ selected.reason=审批理由（缺省结果动作词）；
  - `approvePlan` / `rejectPlan` 台账追加：审批决策以契约形态追加进
    `decision_records_json`（读-追加-回写 CAS；投影缺口/失败 log 显式
    绝不阻断审批主流程，§2 人审门语义不变）；getPlan 读回自动携带；
  - 测试：decision-projection.spec +3 例 + plan-decision-persistence
    .spec +2 例（approve 追加既有保留 / reject 追加）；
  - Decision Catalog kind #2 接线（§12 Decision History 覆盖求解提议
    + 人审结果全链；其余 6 类后续逐类收敛）；无 DB/OpenAPI/env 变更。
- **经验时长统计模型 + 模型重训/激活闭环（NO-13g，ADR-056，R-77，§10/§12/§33）**：
  - `empirical-duration-model`：真实执行反馈 → 非参数经验分布（median/p90
    最近秩百分位/count/spread；确定性可重放）；置信度由样本量与离散度
    真实推导（0.1..0.95）；样本 < 5 → `not_enough_data` 显式 OOD；
  - `EmpiricalDurationPredictionProvider` 替换 PREDICTION_PROVIDER
    （shadow-only 边界不变）：任务自带时长 = 任务级真实事实 → 确定性
    路径；已训练 → median + ml 来源 + 真实置信度；未训练 → 显式回退
    确定性基线（§33 绝不静默）；
  - `DurationModelTrainingService` 唯一权威写路径：真实反馈 → 训练 →
    `ewoh_model_registry` 落版（版本 = 既有最大数字版本 + 1，旧 active
    supersede）+ 内存刷新；冷启动 `hydrateFromRegistry` 回填；
    POST /api/scheduler/predictions/task-duration/retrain 显式触发
    （OpenAPI 397/588 零漂移）；
  - 测试：empirical-duration-prediction.spec 8 例 + duration-model-
    training.service.spec 5 例；default jest 261→263 suites
    1912→**1925** tests；无 DB/env 变更；
  - intelligence-l7-learning §36 升 **Implemented**（矩阵
    53/2/0/1→54/1/0/1——L7 四腿闭环：决策→结果 / 策略阈值 / Outcome
    标注 / 模型重训激活全部落地）；per-taskType 分组与跨租户训练政策
    为后续（显式边界）。
- **Console 手动主题切换 + 页面渲染测试补强（NO-13f，ADR-055，R-76，§17/§31/§33）**：
  - 主题偏好单一事实源（contrastMode：ThemePreference=system/dark/light，
    localStorage `ewoh.theme`——system 移除键显式默认；三态循环
    system→dark→light→system 纯函数锁定）；index.tsx 启动偏好感知
    （system 时媒体变化才重放，manual 忽略媒体变化）；
  - `ThemeToggle` 组件（图标+文字双重表达）+ Layout 侧栏接线——
    手动主题切换闭环（偏好持久化 + data-theme 即时同步）；
  - 页面渲染 smoke 补强：ThemeToggle 3 例 + Forbidden/NotFound 静态页
    2 例（MemoryRouter + auth mock）；client jest 115→117 suites
    952→**962** tests；walkthrough 三项缺口全部关闭——
    factory-operating-console §36 升 **Implemented**（矩阵
    52/3/0/1→53/2/0/1）；无 DB/OpenAPI/env 变更。
- **Factory Operating Console 深化（NO-13e，ADR-054，R-75，§17/§33）**：
  - 视口 culling 生产接线：`worldBoundsFromTransform` 变换数学纯函数
    （xMidYMid meet 居中偏移 + pan/zoom 屏幕↔世界映射；非法输入
    fail-safe 全量渲染）；FactoryMap `onTransform` 上报 +
    `onVisibleBoundsChange`（lastBounds 等值守卫防渲染循环）；
    CommandMapShell → store `viewport.visibleBounds` 唯一写点——
    pan/zoom → 世界可视范围 → 实体剔除进入生产调用链（此前纯函数/
    消费面/store 全备唯缺生产者断点）；
  - 深色模式半成品收口：index.tsx 启动 `applyDarkClass` +
    prefers-color-scheme 监听（tokens.css 暗色令牌生效，系统偏好跟随）；
  - 页面级渲染 smoke：MapViewport.render.test 3 例（模式分支/叠加层/
    接线面，renderToStaticMarkup 同栈）+ viewportCulling 变换数学
    5 例；client jest 114→115 suites 944→**952** tests；
  - factory-operating-console 证据深化（矩阵保持 Partial：手动主题
    切换 + 更广页面渲染覆盖为后续）；无 DB/OpenAPI/env 变更。
- **Rule-based Scheduling Solver（NO-13d，ADR-053，R-74，§8/§9/§18/§31/§33）**：
  - `rule-based-scheduling-solver.ts`：求解器插拔阶梯第 3 类——确定性
    L1 地板（任务序 due 升序→priority 降序→id 字典序 + first-eligible
    纯规则；共享 CandidateEngine 硬约束语义 §31；**不做软成本 argmin**
    （与 heuristic 8 权重优化的差异边界显式）；无可行/前置未就绪 →
    `UNASSIGNED_RULE_BASED` 显式（§33 不伪造分配）；统一评估器
    （P0-5）；status=shadow / solverStatus=`RULE_BASED` /
    solverVersion=`rule-based-v1` 如实标记（绝不冒充 heuristic/CP-SAT）；
  - 策略显式选择：`policy.solverVersion='rule-based-v1'` → solver.service
    路由（无隐式自动回退）；SolverStatus/SolverActivationState additive
    +RULE_BASED；
  - `rule-based-scheduling-solver.spec` 7 例（确定性重放 deep-equal /
    任务序 / priority tie-break / first-eligible+rejectedHard / DAG 前置
    UNASSIGNED / lockedAssignments 透传 / routeCost 映射）；
  - solver-pluggability 证据深化（矩阵保持 Partial：MILP 环境阻塞 +
    CP-SAT 生产启用待部署环境）；无 DB/OpenAPI/env 变更。
- **Canonical Exo Configuration Model 契约层（NO-13b，ADR-051，R-72，§3/§7/§33）**：
  - `contracts/exo/exo-config.schema.json` + `exo-config.test-vectors.json`
    （22 向量）：§7 Support Mode / Assist Profile / Fit / Calibration
    跨运行时契约——kind 封闭注册表（assist_profile/fit/calibration）；
    supportMode 封闭 8 类 v1 目录（vendor_specific 显式桶：
    vendorModeName 必填，未知厂商模式绝不静默改写）；calibrationKind
    封闭（zeroing/load_cell/imu）；status 按 kind 封闭；
  - 判定事实完整：assist_profile 必带 supportMode + effectiveFrom +
    superseded 必带 supersededBy + assistLevel∈[0,1]；fit 必带
    personId（person:）+ fittedAt + fitter；calibration 必带
    calibrationKind + result + calibratedAt/calibratedBy；时间不倒退；
    configId 前缀 `exo-config:` / exoId `device:` / tenantId 必填 /
    auditTrail 非空强制；
  - Python/TS 双实现锁步（`src/edge_platform/contracts/exo_config.py` +
    `ewoh-spark-app/shared/exo-config.ts`）；audit-domain-contracts
    exo-config 域独立 JS 仲裁 545→**581/581**；Golden 第 25 场景
    `exo_config_contract`（9 案例双执行器）；本机 pytest 23 例 +
    jest 8 例；
  - 台账（standalone_051）+ 边缘 Support Mode 观测 = NO-13c（§30
    先修契约再修实现；exoskeleton-domain-model 保持 Partial）；
    无 DB/OpenAPI/env 变更。
- **Exo Configuration 台账与写路径接线（NO-13c，ADR-052，R-73，§5/§7/§15）**：
  - `ewoh_exo_config` 台账（standalone_051，TENANT_SCOPED + RLS
    exo_config_org_isolation + 唯一 (org_id, config_id) + kind/status
    按 kind/support_mode/profile·fit·calibration 判定事实/时间 CHECK）；
    record_json = ADR-051 契约形态全量留痕；
  - `ExoConfigService` 唯一权威写路径：record（validateExoConfig 契约门
    fail-closed → 幂等（同 org+configId 返回既有行）→ insert + audit +
    目录事件 ExoConfigRecorded）；activateProfile（同 (org, exo, mode)
    既有 active CAS→superseded（supersededBy=新 id）→ 新 active）；
    list/get 租户作用域（§15）；
  - API：POST /api/exo/configs + GET /api/exo/configs + GET
    /api/exo/configs/:id + POST /api/exo/configs/:id/activate（OpenAPI
    再生成，路由审计零漂移）；事件目录 64→65（ExoConfigRecorded +
    channel exo.config_recorded + 双投影锁步）；
  - 边缘 Support Mode 自动观测 = NO-13d（NY-EXO-A1 协议 2.3 无 mode
    字节，§33 不伪造观测——显式边界）；exoskeleton-domain-model §36
    全绿升 **Implemented**（矩阵 51/4/0/1→52/3/0/1）；
  - 全 lockstep：迁移 + 回滚 + verify（10 自证拒绝 + 控制组）+ runner
    dispatch/verify handler/rollback 链 + CI 专属步骤 + check.sh 成对
    回滚 + state.json verification_state + **受管表 73 → 74**、
    verify 列表 67→68、reconcile spec 74、release-manifest gate 74。
- **执行反馈完成腿（NO-13a，ADR-050，R-71，§5/§20/§21/§33）**：
  - `recordActuals` 回填真实执行事实后追加状态推进：assignment
    dispatched→executing（actualStart）/ {dispatched,executing}→completed
    （actualEnd）——CAS 幂等 + `ewohAssignmentEvent` 事件留痕；
    task 经 `taskActionPath`（task.yaml 锁步图 BFS 最短合法链）逐动作
    `transitionTaskState`（每步 CAS + 审计）；
  - 边界显式：start 源集 assignment={dispatched}·task={dispatched,
    received}；end 源集 assignment={dispatched,executing}·task=
    {executing,received,paused}；exception 不隐式 resolve（dispatcher
    显式动作）；pending_dispatch 不收 start（乱序 skip+log）；终态
    no-op；无 start 观测时 dispatched→completed 单事件（不伪造中间态）；
  - 推进 summary additive 透出（advancedAssignments/advancedTaskSteps/
    skips）——失败只 log 不阻断反馈写入（§33 不吞异常）；
  - canonical-execution-model §36 全绿升 **Implemented**（矩阵
    50/5/0/1→51/4/0/1）；无 DB/OpenAPI/env 变更。
- **Canonical Execution Model 语义审计 + 跨运行时锁步（NO-12z，ADR-049，R-70，§3/§9/§31）**：
  - §9 审计确认 R-3 遗留已收口（边缘 ADR-029 task↔assignment 双向同步 +
    云侧 dispatch→transitionTaskState('dispatch')）；审计结论入档；
  - TS 任务状态机数据化为 `TASK_ACTIONS` / `TASK_NON_TERMINAL` /
    `TASK_TERMINAL` 契约消费面（行为逐字一致，task.service.spec 回归绿）；
  - 新增 `task-state-machine-contract.spec`（7 例）：task.yaml 逐条比对
    （无缺失/无契约外转换）+ 11 状态 × 14 动作穷举负例 + 检查器负测试
    + task-lifecycle 分类集合锁步——TS↔契约漂移构建期显式暴露
    （与 Python contract-state-machine 门禁同纪律）；
  - 三套执行词汇表（task 11 态 / AssignmentStatus 9 态 / execution
    词汇表）差异边界显式声明；执行反馈完成腿 NO-13a 立项
    （canonical-execution-model 保持 Partial）；
  - walkthrough R-3 行复核更正；无 DB/OpenAPI/env 变更。
- **Decision 契约生产投影接线（NO-12y，ADR-048，R-69，§3/§12/§18/§33）**：
  - `decision-projection.ts` 纯模块：DecisionTrace→DecisionRecord
    （ADR-047 契约形态）唯一投影点——kind=task_assignment / status=
    proposed / authority=optimization；decisionId 确定性幂等
    （`decision:<planId>:<taskId>`）；options←candidates（optionId 组合
    确定性推导；baseline reuse 快速路径 selected 补入保契约不变式）；
    selected.reason 非空过滤（空→显式缺口）；rejectedAlternatives←
    rejectedAlternatives+rejectedHard（空原因跳过，绝不伪造）；
  - riskLevel 映射自真实 route-graph 风险事实（high→high /
    medium→medium / null→low——null=路径无被标记高/中风险边，
    确定性映射锁测试，§33 非伪造）；requiresApproval=true 恒真
    （task_assignment 提议必经方案审批，§2 人审留痕）；
  - `persistPlan` 唯一投影点：生成记录必过 `validateDecision`（共享
    契约实现 §31）；缺口显式计数 `decisionProjectionIssues`
    （decision_tenant_unknown / decision_no_selected_reason /
    decision_no_trace / decision_invalid:<code>）——绝不静默丢弃；
  - standalone_050：`ewoh_schedule_plan` += `decision_records_json`
    JSONB（既有受管表原地加固，计数不变 73/76；runner/check script/
    CI/state.json/schema-manifest 全 lockstep）；persist→getPlan 读回
    一致；canonical-decision-model §36 全绿升 **Implemented**
    （矩阵 49/6/0/1→50/5/0/1）；
  - 测试：decision-projection.spec 7 例 + plan-decision-persistence
    .spec 3 例；无 OpenAPI/env 变更。
- **Canonical Decision Model 契约层（NO-12x，ADR-047，R-68，§2/§3/§18/§24）**：
  - `contracts/decision/decision.schema.json` + `decision.test-vectors.json`
    （23 向量）：Decision Catalog v1 封闭注册表（kind 8 类 / status 5 态 /
    decisionAuthority 5 类）；riskLevel 复用 risk 契约 SEVERITY_LADDER
    （§31 单一事实源，仲裁逐位比对）；
  - 判定事实完整：decisionId 规范前缀 `decision:` / subject 规范身份 /
    tenantId 必填 / requiresApproval 显式布尔 / selected.reason 非空强制 /
    selected∈options / options 内 optionId 唯一 / human 决策或
    approved·rejected 状态必带 approver / approver.at≥decidedAt /
    auditTrail 非空强制（actor 规范身份 + action 非空 + at ISO）；
  - Python/TS 双实现锁步（`src/edge_platform/contracts/decision.py` +
    `ewoh-spark-app/shared/decision.ts`）；audit-domain-contracts decision
    域独立 JS 仲裁 511→**545/545**；Golden 第 24 场景 `decision_contract`
    （9 案例双执行器）；本机 pytest 25 例 + jest 10 例；
  - DecisionTrace→DecisionRecord 生产投影为下一轮（NO-12y，§30 先修
    契约再修实现）；无 DB/OpenAPI/env 变更。
- **邮件 STARTTLS 升级（NO-12w，ADR-046，R-67，§20/§33）**：
  - SMTP 客户端机会式 STARTTLS（RFC 3207 子集）：凭据 + 明文 →
    STARTTLS（期望 220）→ `tls.connect({socket, servername})` 升级
    （secureConnect 等待 + 10s 超时）→ 重新 EHLO → AUTH LOGIN；
  - 服务器不支持（502）→ `smtp_auth_requires_tls`（与 v1 错误码
    兼容，客户端重试语义不变）；升级失败 → `smtp_starttls_failed`
    显式；无凭据明文不发起 STARTTLS（内网中继路径不变）；
  - 凭据安全不变式延续（AUTH 仅 TLS 后，绝不明文传凭据）；无新
    env 键（`EWOH_SMTP_SECURE=1` 隐式 TLS 语义保留）；
  - email-transport.spec 10→12 例（+STARTTLS 升级序 / 502 拒绝 /
    无凭据不发起）；default jest 250 suites / 1856 tests 全绿。
- **Record 化匹配收敛（NO-12v，ADR-045，R-66，§3/§30/§31）**：
  - capability-projection 增补 5 纯函数（capabilityNames /
    personSkillNames / deviceCapabilityNames / stationCapabilityNames /
    personCertificationExpiryMap——契约形态优先 + legacy 直呼同源投影
    回退，§31 单一语义）；
  - eligibility 技能/设备能力/工位能力匹配 + 证书到期事实改读契约
    形态（证书存在性保持 raw——certification 记录缺 issuer/expiry 被
    契约缺口丢弃是显式特性，改按记录存在性会改变语义）；求解器
    personBySkill/deviceByCapability 预筛索引 + candidate-engine/
    solver 上下文 stationCapabilityRecordsById 同步收敛；
  - 等价断言锁定（records 与 raw 语义逐字一致）；capability-projection
    .spec 14 例；default jest 250 suites / 1854 tests 全绿；
  - canonical-capability-model 证据深化（矩阵计数不变 49/6/0/1）。
- **Capability 契约消费方投影接线（NO-12u，ADR-044，R-65，§3/§30/§33）**：
  - `capability-projection.ts` 纯模块：人员技能/认证、设备能力、工位
    能力 → Canonical CapabilityRecord（ADR-043 契约）；certification
    缺到期事实 → `certification_missing_expiry` 显式缺口、数据源无
    issuer → 契约门拒绝后 `certification_missing_issuer` 显式缺口
    （绝不伪造，§33）、违规记录 `projection_invalid` 显式计数；
  - `buildSnapshot` 唯一投影点：WorldStateSnapshot 实体 +=
    `capabilityRecords` + 顶层 `capabilityProjectionIssues`（additive，
    世界契约自检不受影响）；能力事实首次以契约形态进入生产调用链；
  - 测试：capability-projection.spec 8 例；default jest 250 suites /
    1848 tests、client jest 114 suites / 944 tests 全绿；
  - canonical-capability-model 证据深化（矩阵计数不变 49/6/0/1）。
- **Canonical Capability Model 契约（NO-12t，ADR-043，R-64，§3/§4）**：
  - `contracts/capability/`（schema + 13 条共享向量）：CapabilityRecord
    ——kind（5 类）/providerType（7 类）封闭注册表 + name 开放词表
    （knownValues 平台已知值登记）+ certification issuer/expiresAt
    判定事实完整 + 时间不倒退 + subject 规范身份形状 + auditTrail 强制；
  - Python（`edge_platform/contracts/capability.py`）/ TS（`shared/
    capability.ts` + 8 例 spec）双实现语义逐项一致；audit-domain-contracts
    capability 域（**493→511/511**：schema 形状 + rules 实例 + 13 向量
    JS 仲裁 + 3 注册表跨语言锁步）；Golden 第 23 场景（7 案例双执行器）
    + pytest `test_capability_contract.py`（14 例）；
  - canonical-capability-model 升 Implemented（矩阵 **49/6/0/1**）；
    既有消费方（人员技能/认证、设备能力匹配、工位能力匹配）向契约
    逐点接线为后续轮次（§30 先契约后实现）。
- **审批前自动布局仿真预验证（NO-12s，ADR-042，R-63，§8/§13/§18）**：
  - `pre-approval-simulation.ts` 纯函数：方案分配 + 快照工位坐标 →
    人员移动图（按人分组 / plannedStart 排序 / 相邻异工位 = trips=1 边；
    缺 plannedStart/personId/stationId 与坐标 null 显式跳过计数，不伪造）；
  - `PlanService.approvePlan` 硬守卫通过后自动运行 layout 仿真
    （runId 确定性 `plan-approval:<planId>` 台账幂等；scenarioId=
    `plan:<planId>`）——结果入审批审计 `after.preApprovalSimulation` +
    `getPlan` 附 `preApprovalSimulation` 字段（台账回读），求解器
    walkingMeters 的独立确定性交叉可审计；
  - advisory 语义：仿真失败/未装配/无移动链 → error/skippedReason
    显式留痕，**绝不阻断审批**（§2 人工决策门）；SchedulingPlanV2
    加可选字段（additive）；scheduler.module += SimulationModule；
  - 测试：推导 7 例 + 服务接线 3 例；default jest 250 suites /
    1831 tests、client jest 114 suites / 944 tests 全绿；
  - intelligence-l6-simulation 证据深化（矩阵计数不变 48/7/0/1）。
- **邮件推送渠道（NO-12r，ADR-041，R-62，andon-loop 收口，§17/§20/§33）**：
  - `email-transport.ts` 标准库最小 SMTP 客户端（RFC 5321 子集：EHLO /
    AUTH LOGIN / MAIL FROM / RCPT TO / DATA+dot-stuffing / QUIT + 多行
    回复 + 10s 超时，无新依赖）；传输形态显式：无凭据=明文（内网中继）、
    带凭据必须 `EWOH_SMTP_SECURE=1` 隐式 TLS（非 TLS+凭据 →
    `smtp_auth_requires_tls` 绝不明文传凭据；STARTTLS 升级为后续演进）；
  - 派发器渠道注册表 `PUSH_CHANNELS=['lark','email']`（按启用集动态
    领取 + 逐行分派 + 单行失败独立）；`insertAndonNotifications` 三渠道
    同语义（app/lark/email，oee+ingest 共用 §31）；通知中心渠道标签
    += 邮件；env 7 键（env-inventory 117→124 PASS）；
  - 测试：email-transport 10 例 + dispatcher +3 例 + oee +1 例 +
    client 标签；default jest 248 suites / 1821 tests、client jest
    114 suites / 944 tests 全绿；
  - andon-loop 按 §36 升 Implemented（矩阵 **48/7/0/1**）。
- **边缘 AndonRaised 上行（NO-12q，ADR-040，R-61，§3/§6）**：
  - 边缘一等开灯 API `POST /api/andon/raise`（device: 规范身份 + 标题必填 +
    severity 封闭词表 + slaSeconds 校验 fail-closed；AndonRaised Catalog
    信封 source=edge:andon 经 STREAM_EVENTS → EventUplink 离线续传上行）；
  - 云侧 ingest 将边缘 AndonRaised 投影为 canonical andon evidence 形状
    （eventCode=ANDON / severity=normalizeEventSeverity / andonId /
    slaMinutes / escalationLevel / timeline——与 oee.openAndon 同形状，
    listAndons/transitionAndon/SLA 升级统一消费）+ 开灯通知经共享助手
    `insertAndonNotifications`（oee 与 ingest 共用，§31）；
  - 修复 registry POST 分发缺口（exo 绑定 API 从未经 HTTP 分发，直接
    handler 测试掩盖）+ dispatch 级回归锁定；测试：edge 9 例
    （unittest 954→963 OK）+ ingest +3 例（default jest 248 suites /
    1807 tests 全绿）；
  - andon-loop 缺口收窄为邮件 SMTP 渠道（矩阵计数不变 47/8/0/1）。
- **Agent 审批跨重启持久化（NO-12p，ADR-039，standalone_049，§11/§20）**：
  - `ewoh_agent_approval` 台账（TENANT_SCOPED + RLS agent_approval_org_isolation +
    唯一 (org_id, approval_id) + status/resolved/roles CHECK）——Agent 待批
    命令从进程内存迁至台账（ADR-030 决策 4 边界收口）：propose 落 pending、
    resolve 经 CAS 写 approved/rejected/expired + resolved_at/resolved_by/
    resolution_json（重复解析显式拒绝，§20）；待批清单/解析全部台账读，
    进程重启后审批不消失不失效（新服务实例解析既有待批已 spec 实证）；
  - 全 lockstep：迁移 + 回滚 + verify（4 自证拒绝 + 控制组）+ runner
    dispatch/verify handler/rollback 链 + CI 专属步骤 + check.sh 成对回滚 +
    state.json verification_state + **受管表 72 → 73**、verify 列表 66→67、
    reconcile spec 73；
  - AgentService 移除 ApprovalModule 内存状态机依赖（agent-policy-approval
    已知边界消除，矩阵计数不变 47/8/0/1）。
- **Shadow Plan 隔离 DB 纵深防御（NO-12o，ADR-038，standalone_048，§13）**：
  - `ewoh_schedule_plan` 新增 CHECK `chk_ewoh_schedule_plan_shadow_not_production`：
    `is_shadow=true` 行禁止生产状态（approved/dispatched/executing/completed
    + 遗留 confirmed/proposed）且禁止确认事实（confirmed_by/confirmed_at）——
    服务层 hard guard 之外的数据库兜底；
  - 全 lockstep：迁移 + 回滚 + verify（5 自证拒绝 + 2 控制组）+ runner
    dispatch/verify handler/rollback 链 + CI 专属步骤 + check.sh 成对回滚 +
    state.json verification_state + schema-manifest 原地加固注记
    （受管表计数 72 不变——既有表原地加固，无新表）；
  - simulation-production-isolation 升 Implemented（矩阵 **47/8/0/1**）。
- **Andon 通知推送渠道（NO-12n，ADR-037，R-58，§15/§17/§20）**：
  - `channel-dispatcher.service`：封闭渠道注册表 `PUSH_CHANNELS=['lark']`
    （只注册有真实投递实现的渠道，§33）+ 飞书自定义机器人 webhook 真实
    投递（fetch POST / 5s 超时 / 非 2xx 显式抛错）+ 15s 派发 tick 领取
    pending 推送行 CAS 写回 sent/failed（多实例防重复投递）+ 未配置
    webhook = 渠道显式禁用（不建 doomed 行）；
  - `POST /api/notifications/:id/retry` 人工重试（failed → pending；
    dispatcher/workshop_lead/global_admin；app 通知/非 failed 显式拒绝）；
  - oee `openAndon` + SLA 升级双触发点入通知（app 恒建 + lark 配置时建）
    + **§15 修复通知缺 orgId（孤儿行）**；
  - 审批控制台通知中心「推送状态（飞书）」分组（渠道标签 + 待投递/
    已投递/失败 + 重试按钮）+ `toNotification` 增补 sentAt/errorMessage；
  - env `EWOH_LARK_WEBHOOK_URL` / `EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS`
    （env-inventory 117/118 PASS）；OpenAPI +1 路由 392 零漂移；
  - 测试：dispatcher 11 例 + notification.service +5 例 + oee +2 例 +
    client 通知逻辑 +4 例；default jest 248 suites / 1802 tests 全绿、
    client jest 114 suites / 944 tests 全绿；
  - andon-loop 缺口收窄为邮件渠道（SMTP）+ 边缘 AndonRaised 上行。
- **仿真运行控制台（NO-12m，ADR-036，L6 生产消费面，§10/§13/§17）**：
  - `/simulation` 页面（决策支持组，dispatcher/workshop_lead/global_admin）：
    四类确定性评估器运行面板（What-if / 产能 / 布局 / 物料流）+ 基准快照
    引用 + 参数 JSON 编辑（示例模板预填）+ 本租户台账 30s 轮询 + 详情 /
    原始参数；
  - 纯逻辑 `simulationConsoleLogic`：四类参数预检（镜像评估器输入契约，
    服务端仍权威 fail-closed）+ 结果摘要（字段缺失显式 '—'、未知 kind
    原样透出）+ 运行列表行（状态文案/语调/失败理由头条）；18 例 node 测试；
  - `api/simulation.ts`（POST/GET /api/simulation/runs）+ queryKeys +
    导航/路由注册；client jest 113→114 suites / 923→941 tests；
  - intelligence-l6-simulation 升 Implemented（矩阵 **46/9/0/1**）。
  - 无 DB/契约/服务端变更（复用 ADR-025 SimulationRun 全资产）。
- **地图端执行偏差图层（NO-12k，ADR-035，R-6 收口，§17/§37）**：
  - 纯 VM `executionDeviationMapVM`（executions + 快照坐标 → 地图视图：
    deviated=deviationType 非空（含终态历史可见）/ ontrack=无偏差进行中；
    计划点=任务工位（回退 execution.stationId）、实际点=执行人当前位置
    （回退设备）；坐标缺失显式 null + missingCoordinates 禁止伪坐标；
    delta 按偏差类型取事实对 + 带符号 label；未知 deviationType 原样
    透出（§33 不静默））；13 例 node 测试。
  - `ExecutionDeviationLayer`（多通道视觉：空心方框=计划 / 实心圆点=
    实际 / 虚线=偏差 / 实线=进行中 + 偏差徽标 + title 全事实）；
  - executions 入 CommandMapAggregate（30s 轮询 enabled=有选中方案，
    React Query 与列表面板同缓存；executionsError 显式错误提示）；
  - `CommandMapLayer` += execution-deviation + `toggleLayer` 纯函数 +
    地图视口桌面端图层开关 chip 组（activeLayers 首次生产可操作）。
  - logistics-task-loop / closed-loop-execution-feedback 升 Implemented
    （矩阵 **45/10/0/1**）；无 DB/契约变更（纯 UI/VM 投影层）。
- **Outcome 标注面（NO-12j，ADR-034，§10 Level 7 模型腿前置）**：
  - `contracts/learning/outcome-annotation.schema.json` + 共享向量
    （8 条：targetType/outcomeKind 封闭注册表 + judgedBy/judgedAt 判定
    事实完整 + measured 有限数值（缺省=显式不携带）；Python/TS 双实现 +
    门禁 outcome_annotation 域（**493/493**）+ Golden 第 22 场景。
  - standalone_047 `ewoh_outcome_annotation`（TENANT_SCOPED RLS +
    target/kind/judger CHECK + 唯一 (org_id, annotation_id)；全 lockstep：
    受管表 71 → 72、verify 列表 65→66、回滚链、CI、state.json）。
  - 云侧 OutcomeAnnotationService（create 契约 fail-closed + annotationId
    幂等回读 / listByTarget / listRecent org 作用域）+ 目录事件
    OutcomeAnnotationRecorded（**63→64**）+ OpenAPI 3 路由 391 零漂移。
  - modelAccuracy 保持显式 unknown 直至真实可训练模型 + 最小样本门槛
    （§33 不造假——模型重训闭环随真实模型落地后立项）。
  - intelligence-l7-learning 缺口收窄为模型重训/激活（矩阵 44/11/0/1）。
- **边缘绑定事实→云 ExoSession 台账端到端（NO-12i，ADR-033，§7 收口）**：
  - 边缘一等绑定 API：`exo_binding` 存储表 + `POST /api/exo/bind|unbind`
    （规范身份 fail-closed / 活跃绑定唯一冲突显式 / 状态机 + ended_by
    必填）；6 例 unittest；
  - 绑定事实经既有事件骨干上行（ExoSessionStarted/Ended Catalog 信封 →
    EventUplink at-least-once 断点续传，无第二上传路径）；
  - 云侧 ingest 投影：ExoSessionService 应用层幂等（同 sessionId start
    回读 / 重复 end 原样返回；投影失败显式留痕不阻断事件主事实）；
    目录 payload 增补 startedAt/endedBy/actualEndAt（additive）；
  - worker-exoskeleton-loop 按 §36 升 Implemented（矩阵 **44/11/0/1**）。
- **外骨骼↔人员 Session 域模型（NO-12h，ADR-032，§7 一等实体绑定）**：
  - `contracts/exo/exo-session.schema.json` + 共享向量（9 条：status 状态机
    active→ended/aborted 终态 + 规范身份 device:/person: + 结束事实完整 +
    时间不倒退 + auditTrail）；Python/TS 双实现 + 门禁 exo 域
    （**479/479**）+ Golden 第 21 场景。
  - standalone_046 `ewoh_exo_session`（TENANT_SCOPED RLS + 部分唯一索引
    (org_id, exo_id) WHERE status=active——**一台外骨骼同时一个活跃会话
    机器强制** + 四类 CHECK；全 lockstep：
    受管表 70 → 71、verify 列表 64→65、回滚链、CI、state.json）。
  - 云侧 ExoSessionService（start 契约 fail-closed + 活跃冲突显式 /
    end/abort 状态机 + endedBy 必填 + list org 作用域）+ 目录事件
    ExoSessionStarted/Ended（**61→63**）+ OpenAPI 5 路由 388 零漂移。
  - worker-exoskeleton-loop 缺口收窄为边缘上行贯通（矩阵 43/12/0/1）。
- **Andon Loop 贯通（NO-12g，ADR-031，§6 Phase 6 Andon Loop）**：
  - 状态机单一事实源：`contracts/state-machines/alert.yaml` →
    `shared/alert-state-machine.ts` 锁定表 + 门禁
    `alert_state_machine_ts_vs_yaml`（**465→466/466**）；alert/andon
    双面复用（消除两份手写 switch，§31）；reopen 仅 safety_admin
    角色条件机器执行；
  - `AndonRaised` 目录事件真实产出（OEE openAndon：canonical
    eventType + envelope 嵌入 + level=规范词表 + slaMinutes 派生）；
    历史 'andon' 行查询侧过渡兼容；
  - shared/alert-state-machine.spec 7 例；oee spec 8 例（+AndonRaised
    产出 + reopen 角色强制）。
  - andon-loop 缺口收窄为通知推送渠道 + 边缘上行（矩阵 43/12/0/1）。
- **客户端审批控制台（NO-12f 收口，ADR-030 延续，§17 "是否批准？"）**：
  - `/approval-console` 页面：Agent 命令审批批准/驳回（过期显式禁用操作，
    §33）+ 调度审批展开详情按 pending step 批准/驳回（stepAction 真实
    闭环）+ 通知中心未读列表/标记已读（通知读写消费面）；
  - `src/api/approvals.ts`（6 API 函数）+ 纯逻辑 4 例（剩余时间格式化/
    两清单合并排序/过期显式禁用/通知分组）；
  - 路由 + 导航注册（dispatcher/workshop_lead/global_admin）；
  - client jest 110→**111 suites / 898→902 tests**；client tsc PASS。
  - agent-policy-approval 按 §36 升 Implemented（矩阵 **43/12/0/1**；
    已知边界=Agent 审批 pendingCommands 进程内存，ADR-030 决策 4）。
- **Agent 审批交互面（NO-12f，ADR-030，§17 人工审批闭环交互面）**：
  - 统一待批清单：`GET /api/approvals/pending`（调度审批持久化清单）+ 
    `GET /api/agents/approvals`（Agent 命令审批清单，过期显式标记绝不
    静默消失，§33）；
  - 通知闭环：审批创建即插 `ewoh_notification`（role 通知，externalRef=
    approvalId 可追溯）+ 新 Notification 模块（`GET /api/notifications`
    租户+角色作用域（无角色 fail-closed 不猜）/ `POST /api/notifications/
    :id/read` 幂等乐观已读）；ewoh_notification drizzle 补 org_id 映射；
  - 审批角色配置化：`EWOH_AGENT_APPROVAL_ROLES`（逗号分隔，默认
    workshop_lead；env-inventory 115/116 PASS）；
  - OEE 安灯通知 severity 'L2'→'high'（ADR-027 词表收口补漏）；
  - OpenAPI +4 路由 **383 零漂移**；agent.service.spec 21→24、
    notification.service.spec 5 例。
  - agent-policy-approval 缺口收窄为客户端审批 UI（矩阵计数不变）。
- **边缘任务↔派工状态机同步（NO-12e，ADR-029，R-3 收口，§3 任务事实单一化）**：
  - `execute()` 派工落账后同步推进 Task（pending_dispatch→dispatched，
    乐观锁 + TASK_TRANSITIONS 状态机校验 + 幂等跳过 + 任务缺失显式跳过）；
  - `update_task()` 推进任务 → 其派工沿同一状态机收敛（最短合法链补全，
    不回调任务防递归）；`set_assignment_status` 重构为共享转换器
    `_apply_assignment_transition`（消除内联重复）；
  - 同步失败显式留痕绝不静默（ADR-029 决策 4）；7 例新回归
    （test_task_assignment_sync）+ edge unittest **941→948**；
  - R-3 风险闭合（CR-EDGE-HYDRATE-COMPLETENESS）；logistics-task-loop
    缺口收窄为地图端偏差图层（矩阵计数不变）。
- **Edge→Cloud 指标上行（NO-12d，ADR-028，§19 观测腿补全）**：
  - 边缘 ewoh_* 18 家族入规范注册表（**15→33 家族**，labelKeys +=
    table/edge_id，connector_active_total += connector_id）——命名收敛
    不重命名（单一事实源，重命名会破坏本地 Prometheus 消费方）；
  - 边缘 `MetricsUplink`（周期快照 → 规范样本批次 POST
    /api/observability/edge-metrics；与 EventUplink 显式差异边界：指标
    为 latest-wins 快照不建磁盘队列，失败显式 logging/stats + 指数退避，
    exporter METRIC_DEFS 单一映射源）+ 8 例 unittest + 5 项 env 配置
    （env-inventory 114/115 PASS）；
  - 云侧 `EdgeMetricsService`（逐条 validateMetricSample fail-closed
    违规显式、per-org 有界 TTL 快照注册表、IngestGuard 机器通道）+
    导出面 org 作用域 + 上行健康 connector_* 家族计数（无新事件类型——
    指标批次非工业事实）；spec 7 例；
  - OpenAPI +1 路由 **379 零漂移**；Golden metrics 场景 +3 边缘案例
    （11 案例双执行器）。
  - observability 证据深化（矩阵计数不变）。
- **云侧严重度词表收敛（NO-02c-b，ADR-027，§3 Factory Truth 接线）**：
  - 同一 severity 列两套相反词表（边缘 L1=最严重 vs 云 UI L3=最严重）→
    唯一词表 Canonical Risk Ladder（critical>high>medium>low；无风险判定
    显式 `unknown`，§33 绝不伪装 normal）；
  - 12 个服务写入点按生产者意图逐类确定性迁移（ERP L1/L2→critical/high；
    信息性生命周期事件 L3→low；DeadLetter→medium；ingest 边缘事件→
    unknown；world 时间线标记→low）+ 入口归一化 `normalizeEventSeverity`
    （规范直通/L1-L3 映射/其余显式 unknown，与 `normalizeSeverity`
    fail-closed 分工：域契约校验拒绝、事件事实落账显式标记）；
  - 消费方收敛：priority-engine {critical,high,medium}=risky、supervisor
    critical/high、learning riskOutcomeRate canonical（过渡期 legacy
    UNION 注释兼容存量行）、gamification critical 风暴；
  - 客户端全量收敛：EventCenterPanel 筛选与徽章、Timeline/TimelinePanel
    配色（critical=红/high=橙/medium=黄/low=绿/unknown=灰）、AlertToast
    `aggregateL3`→`aggregateCriticalEvents`、DeviceConfigDrawer、perf fixture。
  - canonical-risk-model 按 §36 升 Implemented（矩阵 43/12/0/1）。
- **持续学习回路反馈腿 v2（NO-12b，ADR-026，§10 Level 7 + §12 反馈腿）**：
  - `contracts/learning/learning-proposal.schema.json` + 共享向量（kind 封闭
    注册表 v1=rule_threshold——只有具备确定性影子评估器的类型才允许注册 +
    thresholdRules 白名单（⊆ reasoning-trace 注册表，门禁交叉校验）+
    影子评估前置（无影子证据的激活在验证层被拒绝）+ 人审激活阶梯
    （approved 必须 approver+时间，§2 绝不隐式自动执行）+ rejected/
    rolled_back 理由强制）；Python/TS 双实现 + 确定性影子评估器
    （历史事实重放 fired 差集 + riskLevel 阶梯）+ 门禁 learning_proposal
    域（**465/465**）+ Golden 第 20 场景（8 契约 + 2 影子评估 + 1 状态机
    执行跨语言仲裁）。
  - standalone_045 `ewoh_learning_proposal`（TENANT_SCOPED RLS + kind/
    status/rule/parameter/values/shadow-gate/approval/rejection/rollback
    CHECK + 唯一 (org_id, proposal_id)；全 lockstep：
    受管表 69 → 70、verify 列表 63→64、回滚链、CI、state.json）。
  - 云侧学习提案运行时（propose 契约 fail-closed + 影子评估落账 +
    shadow/approve/reject/rollback 状态机 + getActiveThresholds 激活面）+
    **真实激活接线**：ReasoningService 评估时应用本租户 approved 提案的
    阈值覆盖（evaluateReasoningRules thresholds 参数，Python/TS 语义
    逐项一致；回滚即回落内置常量）；LearningProposalCreated/Resolved
    目录事件（**61/61**）+ OpenAPI 7 路由 378 零漂移。
  - intelligence-l7-learning 缺口收窄为模型腿（矩阵计数不变）。
- **Digital Twin 仿真体系（NO-12a，ADR-025，§13 数字孪生成体系）**：
  - `contracts/simulation/simulation-run.schema.json` + 共享向量（4 kind /
    4 status 封闭注册表 + isSimulation=true 隔离强制 + baseRef 可追溯 +
    completed/failed 终态契约）；Python/TS 双实现 + 四类确定性评估器
    （what-if 结论差集 / capacity 瓶颈 / layout 行程 / material-flow 载荷）
    + 门禁 simulation 域（**444/444**）+ Golden 第 19 场景。
  - standalone_044 `ewoh_simulation_run`（TENANT_SCOPED RLS + kind/status/
    is_simulation=true 表级 CHECK 隔离（§13 三层强制之 DB 层）+ completed/
    failed CHECK + 唯一 (org_id, run_id)；全 lockstep：
    受管表 68 → 69、verify 列表 62→63、回滚链、CI、state.json）。
  - 云侧 `simulation` 模块（run 契约 fail-closed / 评估器确定性执行 /
    completed|failed 终态落账）；SimulationRunCreated/Completed 目录事件
    （**59/59**）。
  - digital-twin-simulation 按 §36 升 Implemented（矩阵 42/13/0/1）。
- **Dead Letter 体系（NO-11a，ADR-024，§20 Reliability 收口）**：
  - `contracts/reliability/dead-letter.schema.json` + 共享向量（5 reason /
    3 status 封闭注册表 + envelope 快照必填 + 人审重放语义 + discard 理由
    强制）；Python/TS 双实现 + 门禁 reliability 域（**427/427**）+
    Golden 第 18 场景。
  - standalone_043 `ewoh_dead_letter`（TENANT_SCOPED RLS + reason/status/
    attempts/discard CHECK + 唯一 (org_id, letter_id)；全 lockstep：
    受管表 67 → 68、verify 列表 61→62、回滚链、CI、state.json）。
  - 云侧 `reliability` 模块（record 契约 fail-closed / 幂等 / 人审
    requeue（attempts+1，杜绝自动无限重试）/ discard 必带理由）；
    首个生产接线 = ingest 事件上行永久失败（envelope_invalid /
    unknown_event_type fail-closed 拒绝 → 死信）；DeadLetterRecorded
    目录事件（**57/57**）。
  - reliability-hybrid 按 §36 升 Implemented（矩阵 41/14/0/1）。
- **全链路 trace 贯通（NO-10a，ADR-022，§19 Observability trace 腿）**：
  - standalone_042 `ewoh_trace_span`（span 持久化追踪索引：7 天 TTL + 行上限
    bounded；trace_span_org_or_global 可见性策略（org lineage 或全局管理员，
    非 loose）；全 lockstep：受管表 66 → 67、verify 列表 60→61、回滚链、
    CI、state.json）。
  - HTTP traceId = §19 端到端 correlation id：事件信封 correlationId 六类
    规范生产者贯通（workorder/agent/knowledge/inference/reasoning/learning；
    非 HTTP 路径显式 null 绝不伪造）+ 审计 request_id 既有自动关联；
    缝合查询 GET /api/observability/traces/:traceId（spans + events + audit
    三面，§19「从一次用户操作追踪到…」查询面）。
  - Scheduler/Agent/Connector 指标体系留 NO-10b（observability 矩阵保持
    Partial 至指标腿成体系）。
- **持续学习回路 v1（NO-09a，ADR-021，Phase 12）**：
  - `contracts/learning/learning-evaluation.schema.json` + 共享向量（七项指标
    封闭注册表 + null 语义（无数据/显式 unknown，绝不伪造）+ period 契约 +
    basis 非空）；Python/TS 双实现 + 门禁 learning 域（**400/400**）+
    Golden 第 16 场景。
  - standalone_041 `ewoh_learning_evaluation`（TENANT_SCOPED RLS + 唯一
    (org_id, eval_id) + type/period CHECK；全 lockstep：受管表 65 → 66、
    verify 列表 59→60、回滚链、CI、state.json）。
  - 云侧 `learning` 模块（真实事实聚合：A2→A3 接受率 / KpiService 复用 /
    事件结局 / override 计数；modelAccuracy=unknown 显式声明；幂等重评估
    不重发事件）；LearningEvaluationRecorded 目录事件（**56/56**）；
    OpenAPI 3 路由。
  - continuous-learning 按 §36 升 Implemented（矩阵 39/16/0/1）。
- **独立工业推理层（NO-08b，ADR-020，Phase 8 Level 4）**：
  - `contracts/reasoning/reasoning-trace.schema.json` + 共享向量（六规则封闭
    注册表 / premises+evidenceIds 非空规范身份 / canonical severity 阶梯 /
    确定性置信度=1 / 空结论显式语义）；Python/TS 双实现（Python 含标准库
    规则评估器供跨语言仲裁）。
  - 门禁 reasoning_trace 域（**390/390**）+ Golden 第 15 场景
    `reasoning_trace_contract`（11 案例：8 契约仲裁 + 3 引擎执行跨语言仲裁，
    Python 2 tests / TS 16 tests）。
  - 云侧 `reasoning` 模块：确定性规则引擎（§18 模板渲染非 LLM 编造；输入
    fail-closed；trace 契约自检违规绝不返回；结论逐条 L4 InferenceResult
    台账落账——ADR-019 台账复用不新建表）；OpenAPI `/api/reasoning/*`
    2 路由（**358 零漂移**）；service spec 8 例 + shared spec 7 例 +
    pytest 11 例。
  - intelligence-l4-reasoning 独立推理层缺口闭合（矩阵证据深化）。
- **云侧推理结果运行时（NO-08a，ADR-019，Phase 8 深化）**：
  - standalone_040 `ewoh_inference_result`（TENANT_SCOPED RLS + 唯一
    (org_id, inference_id) + level/confidence/dataQuality/OOD 一致性 CHECK；
    全 lockstep：受管表 64 → 65、verify 列表 58→59、回滚链、CI、state.json）。
  - 云侧 `inference` 模块（record 契约 fail-closed / 创建幂等回读不重发事件 /
    list/get 租户作用域）；InferenceResultRecorded 目录事件（**55/55**，
    双运行时投影）；OpenAPI `/api/inference/results*` 3 路由（**356 零漂移**）；
    spec 10 例。
  - 首个真实生产接线：A2 建议流确定性规则基础 → L1 InferenceResult 台账
    （confidence=1 如实声明 + 快照完备度→dataQuality；LLM 文本增强继续由
    ReasoningResult 承载，两契约分工不混用）；ai.service.spec +3 例。
  - 修复 schema-manifest 结构漂移：032-040 的 8 张表条目自 Round 12 起误挂
    `additional_hardened_existing_tables` 段，已移回 `managed_tables`
    （computed=65 与 reconcile 口径一致；run_migrations 的 core 期望值与
    001 verify 列表 59 名对齐）。
- **Factory Knowledge System 运行时（NO-07b，ADR-018 Amendment 1，Phase 12 收口）**：
  - standalone_039 硬化既有 `ewoh_knowledge_entry`（ALTER 不新建同义表）：
    content→body 单一事实源 + 契约列（kind/scope/summary/source_evidence_ids/
    provenance/verified_by/valid_from/valid_to/audit_trail）+ scope-tenant
    一致性 CHECK（共享层 global/industry=哨兵 org
    00000000-0000-4000-8000-000000000000、租户层=真实 org）+ provenance
    CHECK + RLS `knowledge_entry_service_all`（替换遗留通用策略，租户行仅本
    租户可见、共享行全租户可读）+ UNIQUE (org_id, entry_id)；非法
    kind/scope/status、共享层落租户 org、private_operational 带 provenance
    由 verify 自证拒绝；全 lockstep（runner 映射 + 专用 verify handler +
    回滚链 + CI 步骤 + state.json 记录）。
  - 云侧 `knowledge` 模块（注册契约 fail-closed / 跨租户注册显式拒绝 /
    创建幂等回读不重发事件 / 检索五层阶梯（共享层 ∪ 本租户层，他租户行
    物理不可见）/ 共享检索仅 global+industry fail-closed（绝不越过
    private_operational）/ 状态转移 draft→verified 必须 verifiedBy、
    superseded 终态、共享层租户只读）；spec 13 例。
  - Knowledge Agent（ADR-016 Manifest 注册：role=Knowledge，L1 人审；
    契约命令注册表 +`register_knowledge`（schema/Python/TS lockstep 扩展）+
    新 Tool ×2；agent.service.spec +4 例，共 21 例）。
  - 事件目录 +KnowledgeEntryCreated（**54/54**，双运行时投影）；
    OpenAPI `/api/knowledge/*` 5 路由（**353 零漂移**）。
  - knowledge-system 按 §36 升 **Implemented**（矩阵 **38/17/0/1**）。
- **Factory Knowledge System 立项契约层（NO-07，ADR-018，Phase 12）**：
  - `contracts/knowledge/`（6 kind / 5 层 scope 有序阶梯 / 3 status 注册表 +
    证据链非空可追溯 + 五层租户语义 + provenance 声明（global/industry 必填、
    private_operational 禁止）+ 双时态 + auditTrail 强制）。
  - Python/TS 双实现 + 门禁 knowledge 域独立仲裁（**374/374**）+ Golden 第
    14 场景 + spec 6 例。
  - **矩阵 Missing 清零（37/18/0/1）**——56 项能力全部至少 Partial；
    cross-factory 知识隔离政策并入五层 scope 语义。
- **AgentTask 编排引擎运行时（NO-06f，AD-LC-026，Phase 9 主体收口）**：
  - standalone_038 `ewoh_agent_task`（TENANT_SCOPED RLS + 唯一 (org_id,task_id)
    + kind/priority/status CHECK；全 lockstep：manifest 63→64/66→67、
    verify 列表 57→58、回滚链、CI）。
  - `AgentOrchestratorService`：创建唯一入口（契约校验 + 依赖环 BFS 检测 +
    每角色并发预算上限 10 fail-closed + AgentTaskCreated 事件）；状态推进
    唯一写者（状态机 + DB CAS）；dispatch 依赖门控（依赖未 completed 拒绝）；
    终态 AgentTaskCompleted 事件 + 审计。
  - OpenAPI `/api/agents/tasks*` 6 路由（**348 零漂移**）；orchestrator
    spec 10 例；intelligence-l5-agentic 升 **Implemented**（矩阵 37/17/1/1）。
- **AgentTask 编排契约（NO-06e，ADR-017，intelligence-l5-agentic 立项）**：
  - `contracts/agent_task/`（3 kind / 4 priority / 6 status 注册表 +
    dependencies DAG 自引用拒绝 + assignedRole 与 agent-manifest 同源 +
    dueTime 时间语义 + budget/auditTrail 同规则）+
    `contracts/state-machines/agent-task.yaml`。
  - Python/TS 双实现 + 门禁 agent_task 域独立仲裁（**351/351**，含角色注册表
    交叉核对）+ Golden 第 13 场景 + shared spec 6 例。
  - 事件目录 +AgentTaskCreated/AgentTaskCompleted（53/53，双运行时投影）；
    intelligence-l5-agentic 矩阵 Missing→Partial（**36/18/1/1**）。
- **领域命令执行器与审批超时（NO-06d，AD-LC-024，Phase 9）**：
  - `create_work_order` 接入真实 WorkOrderService 权威写路径（载荷校验
    fail-closed；失败经 fallback 语义 delegateHuman→delegated 不假装执行）；
    `record_evidence` 落审计事实。
  - 审批超时语义（24h TTL，超期解析为拒绝留痕不无限悬挂）。
  - intelligence-l5-agentic 评估立项（多 Agent 结构化任务编排面，NO-06e
    契约先行）；agent.service.spec 17 例。
- **Agent 审批桥接与首个真实 Agent（NO-06c，AD-LC-023，Phase 9）**：
  - 审批桥接：needsApproval → 正式审批实例（复用 approval 状态机，
    roles=workshop_lead）+ 待执行命令登记；`resolveApproval` 批准→执行/
    驳回→拒绝闭环（批准仍受 budget/fallback 强制）。
  - FactorySupervisor L1 建议型端到端：世界状态 → 事实数字驱动的确定性建议
    → propose_plan → 审批（`/api/agents/supervisor/run`）。
  - Agent Policy TCK 决策表 10 例（等级×门控×预算×回退矩阵）；
    agent-runtime 升 Implemented、agent-policy-approval 升 Partial
    （矩阵 **36/17/2/1**）；OpenAPI 342 路由零漂移。
- **Agent Runtime 运行时（NO-06b，AD-LC-022，Phase 9）**：
  - standalone_037 `ewoh_agent_manifest`（TENANT_SCOPED RLS + 唯一
    (org_id,agent_id) + CHECK（**L4 由 DB 兜底排除**）；全 lockstep：
    manifest 62→63/65→66、verify 列表 56→57、回滚链、CI）。
  - 云侧 agent 模块：注册唯一入口（契约校验 + Tool 注册表 fail-closed +
    版本单调幂等）；执行强制（writeScope 白名单 / L0 advisory_only / L1
    一律人审 / L2-L3 approvalRequiredFor 门控 / budget-timeout 强制 /
    fallback 四策略显式语义）；AgentTaskProposed / AgentDecisionRecorded
    目录事件（51/51）+ 审计同源。
  - OpenAPI `/api/agents/*` 4 路由（340 零漂移）；agent.service.spec 10 例。
- **Agent Runtime 立项契约层（NO-06，ADR-016，Phase 9 启动）**：
  - ADR-016 目标架构：Agent 不得绕过系统架构（正式 Tools + 结构化 Command +
    World Model 依赖 + 禁止直连 DB）；Autonomous Level 显式阶梯 L0..L3
    （L4 永不允许，§2）。
  - `contracts/agent/`（agent-manifest.schema.json + test-vectors.json 15 条）：
    15 角色 / 12 作用域 token / 8 命令 / 风险等级 / 自治阶梯 / 回退策略六注册表
    ＋十六字段校验——L2/L3 必须显式审批、critical 仅 L0/L1、Safety 仅 L0/L1
    且写空、auditTrail 强制、budget/timeout 下界。
  - Python/TS 双实现 + 门禁 agent 域独立仲裁（**329/329**）+ Golden 第 12
    场景 `agent_manifest_contract`（双执行器）+ shared spec 6 例；
    agent-runtime 矩阵 Missing→Partial（35/17/3/1）。
- **Event Backbone 收口（NO-04c，AD-LC-020，Phase 4 主体完成）**：
  - 上行队列跨重启断点续传：`EventUplink` 侧车持久化（`<db>.uplink-queue.json`
    入队即落盘/原子替换/成功截断；加载损坏显式 ERROR 空队列启动）。
  - 云侧乱序/回放补全策略：事件行按 occurredAt 落库（createdAt=occurredAt），
    消费端按发生时刻排序；历史回放补全幂等接受 + isLate 标记不改写。
  - 时钟漂移运行态策略：flag-only 不修正（修正会制造第二事实源）。
  - `event-backbone` / `time-semantics` 按 §36 升 Implemented（矩阵 35/16/4/1）。
- **Edge→Cloud 事件上行通道（NO-04b，AD-LC-019，Phase 4 事件骨干）**：
  - 事件目录类型双运行时锁定投影（`shared/event-catalog.ts` +
    `contracts/event_catalog.py`，audit-event-catalog 集合核对，单一事实源）。
  - standalone_036 `ewoh_ingest_event_dedup`（TENANT_SCOPED RLS + 唯一
    (org_id,source,event_id) + is_late/clock_drift 时间语义列 + 重复插入自证；
    全 lockstep：runner/manifest/verify 列表 55→56/回滚链/CI）。
  - 云侧 `POST /api/ingest/events`：信封契约校验 + Catalog 白名单 fail-closed +
    传输级幂等去重（duplicate 不重复投递）+ 迟到/漂移随台账落库；OpenAPI
    336 路由零漂移。
  - 边缘 `EventUplink`（STREAM_EVENTS → 契约校验 → 批量上行 + 内存缓冲退避，
    at-least-once 由云端幂等去重兜底）；EWOH_EVENT_UPLINK_* 配置 +
    /api/status 健康。
  - edge unittest 932 OK、pytest 224 passed、ingest spec 21 例、truth 族全 PASS。
- **Event Backbone 第一批（NO-04a，AD-LC-018，Phase 4 启动）**：
  - 事件目录 +EntityDeclared/EntityStateObserved（49 messages / 49 channels，
    audit-event-catalog PASS）——实体声明/观测随事件骨干上行的事实载体。
  - 边缘 `TelemetryWorldProjector` 发射 Catalog 信封事件（ADR-009 契约校验
    fail-closed；落边缘事件库 + STREAM_EVENTS；声明/首观测各单次发射防风暴）。
  - 云侧 ingest 帧级时间语义：isLate（>10min 迟到标记不丢弃）/ clockDrift
    （越 5min 容忍界标记不重写）逐帧透出 + late_count/clock_drift_count
    批量聚合；同批次 DataQualityAlert (eventCode,device) 语义去重（防风暴）。
  - edge unittest 927 OK、pytest 224 passed、ingest spec 15 例、truth 族全 PASS。
- **感知自动接线（NO-03c，AD-LC-017，Phase 3 收口）**：
  - E-03 修复：config 驱动适配器工厂（`edge/adapter_factory.py`，EWOH_ADAPTERS
    四类 kind——ny_exo_a1/camera/environment/mes；未知 kind/参数/构造失败
    fail-closed；空列表=合法空管理器）；run.py 注册 + 启动输出每适配器 health，
    真实模式"永不产生遥测"的链路性失效终结。
  - `TelemetryWorldProjector`（`world_model/projection.py`）：订阅
    STREAM_TELEMETRY 自动投影进 ContractWorldStore——EWOH_WORLD_TENANT_ID/
    FACTORY_ID/KIND_MAP 三项缺一显式关闭（绝不猜测实体类别）；首帧
    declare_entity + 每帧 set_state + ENTITY_OBSERVED 因果事件；非契约
    source_type 拒绝计数；/api/status 暴露 world_projection 健康。
  - deploy/.env.example 增 4 项（audit-env-inventory 106/107 零漂移）；
    云侧联动评估：实体声明上行随 Phase 4 事件骨干走 envelope 事件，不新开
    旁路通道。edge unittest 925 OK、pytest 224 passed、truth 族全 PASS。
- **Entity Model 生产调用链收口（NO-03b 收口，ADR-015 Amendment 2，Phase 3）**：
  - 因果链实体引用强制规范身份（`build_shift_chain`/`ContractWorldStore.record_event`
    对 person_id/device_id/task_id/station_id/zone_id fail-closed，裸 ID 拒绝）。
  - 边缘世界模型六端点（`routes/replay.py`）：`/api/world/{snapshot,entities,states,
    replay,events,predictions}`——声明登记/状态写入（声明-状态机器互锁）/契约快照/
    时间轴回放/因果事件/短期预测；`server.Context` 注入 `world_store`（未装配一律
    503 fail-closed，绝不静默降级）。
  - 离线持久化：`run.py` 启动恢复 + 停机落盘 `<db>.worldstate.json`（状态+声明+
    因果事件整体序列化，失败显式 ERROR）。
  - Entity Contract 生成器 `scripts/gen-contract-registries.js`：schema 单一事实源
    生成 Python/TS 注册表代码块，`--check` 挂 `make truth-check`；
    audit-domain-contracts 独立仲裁双保险。
  - `canonical-entity-model` 按 §36 升 Implemented（矩阵 35/16/4/1）；
    edge unittest 912 OK、pytest 224 passed、truth 族全 PASS。
- **Entity Model 运行时接线（NO-03b，ADR-015 Amendment 1，Phase 3）**：
  - kind 前缀一致性机器规则（entityId kind 前缀 ∈ 45 类且等于声明 kind；
    身份专属 kind device/session 拒绝承载实体声明：kind_prefix_mismatch /
    kind_prefix_unknown）+ projectionDivision（stateProjectable 22 /
    identityOnly 2 / entityOnly 5）与 projectionBuckets（person/device/station/
    task，device 桶 = 遗留身份桶 + 设备类实体 kind）以 schema 实例值锁定；
    门禁 277→299/299（前缀仲裁 + 差集独立推导核对 + 投影桶双运行时一致）。
  - 边缘 `ContractWorldStore.declare_entity`（不可变字段/版本单调/来源不可回改/
    时间不回拨）+ set_state 交叉校验（entity_not_state_projectable /
    entity_type_mismatch / state_precedes_declaration）+ to_dict/from_dict
    持久化；Predictor 目标实体规范身份 fail-closed（夹具 4 处裸 ID 现代化）。
  - 云侧 `validateCloudWorldSnapshot` 改由投影桶校验（device 桶接受
    device/exo/machine/robot/agv/sensor）；Golden #11 扩至 9 案例双执行器。
- **Factory Entity Model 契约（ADR-015 / NO-03a，Phase 3 世界模型契约层）**：
  - `contracts/entity/`（entity-model.schema.json + test-vectors.json）：45 类
    entityKindRegistry 唯一权威清单 + EntityKind 常量 + EntityDeclaration
    字段契约；22（世界快照）⊆ 45（实体模型）由审计门强制；命名 `exo` 与
    Identity/World 一致（不引入 exoskeleton 别名）。
  - Python（`src/edge_platform/contracts/entity_model.py`，stdlib-only）+
    TypeScript（`ewoh-spark-app/shared/entity-model.ts`）同构锁定实现 +
    共享向量 + 门禁扩展（audit-domain-contracts 258→277 项 + entity 域 +
    entity_snapshot_subset 交叉校验）+ Golden Scenario 第 11 场景
    `entity_model_contract`（双执行器）+ shared spec 5 例。
- **ReasoningResult 生产接线（NO-08d，Phase 8 推理双契约收官）**：
  - `ark.service.ts` `buildReasoningResult`：Ark 文本结果 → Canonical
    ReasoningResult（level 按 kind 登记、modelVersion 缺省 unversioned 如实
    标注、confidence 必须 null + confidenceBasis uncalibrated、契约自检
    contract_violations 留痕）；chat/ask 透传 kind/inputVersion；旧字段
    ok/text/model/error 兼容保留。
  - `ai.service.ts` 建议/分析流附着 reasoning（成功解析/失败回退/解析失败三
    路径均留痕；规则模板回退不伪造）；AiSuggestion 增可选 reasoning 字段。
  - 测试：ark.service.spec +3 例、ai.service.spec 3 例；
    capability-matrix intelligence-l4-reasoning 升 Implemented（34/17/4/1）。
- **Level 4/5 文本结果元数据契约（ADR-014 / NO-08c，Phase 8）**：
  - `contracts/reasoning/`（reasoning-result.schema.json + test-vectors.json）：
    LLM/Ark 文本结果（建议/解释/分析/聊天）无标定置信度——confidence 必须 null
    （伪造数值拒绝 confidence_forbidden）、confidenceBasis 显式 uncalibrated、
    ok=false 必带 error、content 成功必填、subjectId null 合法或规范身份、
    evidence.generatedAt；与 InferenceResult（统计判定）显式分工。
  - Python（`src/edge_platform/contracts/reasoning_result.py`）+ TypeScript
    （`ewoh-spark-app/shared/reasoning-result.ts`）锁定实现 + 共享向量 + 门禁
    扩展（audit-domain-contracts 238→257 项）+ Golden Scenario 第 10 场景
    `reasoning_result_contract`（双执行器）+ shared spec 6 例。
- **Inference Result 生产接线（NO-08b，Phase 8）**：
  - 边缘 `pipeline._infer` 结果规范化：level（L1 规则/L2 模型）、input_version
    （模型卡 dataset_version，缺省 unversioned 如实标注）、subject_id
    （device:<id>，云端 identity mapping 解析）、ood_indicator（unknown 六路
    归一）；契约自检 validate_inference_result fail-closed 留痕
    （contract_violations 字段，不阻断推理主路）；旧字段兼容保留。
  - 云侧 Model Registry inputVersion 元数据对齐（cardJson.inputVersion，
    缺省不伪造）。
  - 测试：edge unittest 891→894（+3 wiring）；model.service.spec 3 例；
    capability-matrix intelligence-l2-ml 升 Implemented（33/18/4/1）。
- **Industrial Intelligence 契约层（ADR-013 / NO-08a，Phase 8 启动）**：
  - `contracts/intelligence/`（inference-result.schema.json + test-vectors.json）：
    Level 1-7 分层注册表 + 模型结果元数据必填（modelId/modelVersion/
    inputVersion）+ confidence∈[0,1] 越界拒绝 + OOD 六路封闭注册表
    flag↔reasons 双向一致 + **Unknown 合法化**（unknown 必带 OOD 理由）+
    dataQuality {good,degraded,invalid}（边缘窗口质量词表入契约）+
    evidence 窗口时间戳/isRule。
  - Python（`src/edge_platform/contracts/inference_result.py`）+ TypeScript
    （`ewoh-spark-app/shared/inference-result.ts`）锁定实现 + 共享向量 + 门禁
    扩展（audit-domain-contracts 216→238 项）+ Golden Scenario 第 9 场景
    `inference_result_contract`（双执行器）+ shared spec 6 例。
- **Golden Scheduler TCK 补全重排/反馈段（NO-07c，Phase 7 收官）**：
  - 共享场景 `execution_feedback_and_replan`（scheduler-workflow-golden.json
    第二场景）：执行反馈回流（真实 SchedulingFeedbackService.recordActuals 幂等
    覆盖）→ 事件驱动重排（PlanService.replan：版本+1、新 planId={planId}-R{v+1}、
    旧方案 superseded + supersededBy、**真实求解器**对新快照求解并 persistPlan）
    → 新版本审批收敛。
  - TS 执行器升级为真实求解器（solve→persistPlan→supersede 全真实）+ feedback/
    replan 操作处理器；Python 标准库状态机重放同步扩展；调度黄金 TCK 覆盖
    完整闭环（快照→候选→求解→审批→预约→派工→反馈→重排）。
- **Golden Scheduler Workflow TCK（NO-07b，Phase 7 工作流段）**：
  - 共享场景 `tests/golden-fixtures/scheduler-workflow-golden.json`
    （方案全生命周期）：审批 CAS 双校验（plan version / 快照新鲜度 →
    PLAN_STALE 拒绝且状态不变 + 观测型 stale_plan 通知）→ 审批收敛 →
    预约重叠冲突（RESOURCE_CONFLICT）→ 派工前置与收敛（dispatched +
    outbox assignment.dispatched / plan.dispatched）。
  - TS 执行器 `golden-scheduler-workflow.spec.ts`（3 例）：真实 PlanService /
    ResourceReservationService / DispatchCoordinatorService 在状态化 fake-db
    上执行（外设 mock 边界显式声明），结果制品漂移门禁。
  - Python 执行器 `tests/test_golden_scheduler_workflow.py`（3 例）：标准库
    状态机重放独立仲裁（不依赖 ortools/TS 运行时）；Makefile scheduler-golden
    扩至求解段 + 工作流段；CI 步骤更新。
- **Golden Scheduler TCK + 调度语义统一（NO-07，Phase 7）**：
  - heuristic 求解器补齐 NO-05c/05d 接线：枚举路径 eligiblePerson/eligibleDevice
    增 maintenance/qualityFindings、station 维护/质量封锁映射进 eligibility ctx；
    reuseBaseline 快速路径增三守卫（人员/设备/工位）——消除"快照带事实、
    求解器无视"的路径分叉。
  - 共享场景定义 `tests/golden-fixtures/scheduler-golden-scenarios.json`
    （skill 基线 / 维护封锁设备·人员 / 质量封锁工位四场景）+ TS 求解器
    `golden-scheduler-scenarios.spec.ts`（6 例，结果制品漂移门禁）+
    Python 标准库独立硬约束仲裁 `tests/test_golden_scheduler_scenarios.py`
    （3 例，不依赖 ortools）；Makefile `scheduler-golden` + CI 步骤。
  - `solver-maintenance-quality.spec.ts` 4 例 reuse 守卫回归；
    capability-matrix cross-language-scheduler-conformance 证据扩充。
- **Work Order 持久化与模块（ADR-012 / NO-05e-b，Phase 6 工单闭环收官）**：
  - 迁移 `db/migrations/standalone_035_work_order.sql`（+rollback+verify）：
    ewoh_work_order（TENANT_SCOPED、RLS work_order_org_isolation、
    type/origin/severity/status/completion/cancellation CHECK、
    唯一 (org_id, work_order_id)）；schema-manifest managed_count 60→61、
    001/standalone_001 verify 列表 54→55 lockstep；standalone-postgres-check.sh
    apply + 成对回滚链；CI standalone.yml 专用步骤。
  - 云侧 `server/modules/workorder/`：create（契约 fail-closed + ID 确定性推导 +
    唯一键冲突幂等回读）/transition（in_progress 起不可取消、completed/closed
    落 completedAt、cancelled 必带 reason）/list；WorkOrderCreated/Completed
    信封事件；9 例 spec。
  - maintenance/quality 服务委托 WorkOrderService（工单唯一权威写路径，消除
    双写）；OpenAPI +3 路由（audit 332→335 零漂移）。
  - **修复潜伏缺陷**：run_migrations.js 专项迁移（032/034/035）which 映射与
    专用 verify handler 缺失（命令在 read(undefined) 崩溃，CI 从未运行未提交
    改动故未触发）；standalone-postgres-check destructive rollback 链缺成对
    回滚（"回滚到 0 对象"断言必然失败）；001_verify.sql 孪生列表 51→55。
- **Canonical Work Order（ADR-012 / NO-05e-a，Phase 6 维护/质量工单闭环契约层）**：
  - `contracts/workorder/`（work-order.schema.json + test-vectors.json）：
    workOrderType {maintenance, quality_rework, inspection} + origin
    {maintenance_condition, quality_finding} 必填可追溯 + 六态生命周期
    （in_progress 起不可取消；completed/closed 必带 completedAt；cancelled 必带
    reason；severity 走 Risk 契约、subject 走 Identity 契约）。
  - Python（`src/edge_platform/contracts/workorder.py`）+ TypeScript
    （`ewoh-spark-app/shared/workorder.ts`）锁定实现 + 共享向量 + 门禁扩展
    （audit-domain-contracts 182→216 项）+ Golden Scenario 第 8 场景
    `workorder_loop`（双执行器）。
  - 事件目录 +2 类型：WorkOrderCreated / WorkOrderCompleted（47 messages /
    47 channels）。
  - 云侧事件发端：maintenance 转 work_order_created（带引用）/ quality
    disposition=rework（links[0] 为执行落点）→ WorkOrderCreated 信封事件；
    内部 workOrderId=wo:sha256(originKind:originId)[:12] 确定性推导
    （server/common/workorder-ids.ts），MES 工单号仅作 evidence alias。
- **Quality State 入调度（ADR-011 / NO-05d，Phase 6 Quality Incident Loop 收口）**：
  - `shared/quality.ts` 增 `QualityFindingProjection` + `qualityFindingsBlockDispatch`
    （critical/high 硬封锁、medium/low 仅事实可见、未知严重度 fail-closed 按封锁）；
    ResourceState / WorldStateSnapshot persons/devices/stations 增可选
    `qualityFindings` 事实视图（向后兼容）。
  - ResourceProjectionService `loadActiveQualityFindings()`：活跃发现
    （status ∈ {open, under_review}）按 links 中 station/device/person 规范身份
    附着（order/material/batch 不误锁）；质量事实不改变资源状态。
  - EligibilityService 增 `person/device/station_quality_blocked`（legacy L1-L3
    归一化触发；dispositioned/closed 即解除）；candidate-engine 建
    stationQualityBlockedById。
  - 测试：quality-projection.spec.ts 12 例；scheduler+shared 123 suites /
    883 tests 全绿。决策：docs/decisions/ADR-011 + 决策日志 AD-LC-006。
- **Identity §36 收口（NO-02d，Phase 2）**：canonical-identity-model 证据核实——
  Golden Scenario `identity_mapping_conflict`（Python/TS 双执行器共享）+
  scripts/reconcile-identity-legacy.mjs（UUIDv5 确定性、append-only、dry-run
  默认、CI 真实 PG 幂等链）均在，capability-matrix 摘要文本漂移修正。
- **Maintenance / Quality 生产接线 + 调度集成（ADR-010 / NO-05b + NO-05c，Phase 6）**：
  - 迁移 `db/migrations/standalone_034_maintenance_quality.sql`（+rollback+verify）：
    ewoh_maintenance_condition + ewoh_quality_finding（TENANT_SCOPED、RLS
    maintenance_condition_org_isolation / quality_finding_org_isolation、
    lifecycle 与 disposition-required CHECK）；schema-manifest managed_count
    58→60、001/standalone_001 verify 列表 52→54 lockstep；CI standalone.yml 步骤。
  - 云侧模块 `server/modules/{maintenance,quality}/`：create/list/transition 契约
    fail-closed + severity 归一化 + 生命周期顺序强制 + 信封事件落库
    （MaintenanceConditionDetected/Resolved、QualityFindingDetected/Dispositioned）；
    16 例 spec。
  - OpenAPI +4 路径（/api/maintenance/conditions{,…}、/api/quality/findings{,…}）
    + 8 schemas；route audit 326→332 零漂移。
  - NO-05c 调度集成：ResourceState / WorldStateSnapshot 增 maintenance 事实视图；
    ResourceProjection 状态收敛（critical→OFFLINE、其余→DEGRADED、绝不升级）；
    Eligibility 对活跃维护事实 fail-closed 拒派（person/device/station
    *_maintenance_blocked，人审解除）；11 例 spec。
  - 门禁：jest 全量 210 suites / 1441 tests 全绿；make truth-check、
    repo-facts 39/39（counts-generative 漂移修复）、feature-status 31/31、
    reconcile 6/6 全 PASS；capability-matrix maintenance-loop /
    quality-incident-loop 升 Implemented（32 Implemented / 19 Partial /
    4 Missing / 1 Prototype）。
- **Maintenance / Quality 契约层（ADR-010 / NO-05a，Phase 6）**：
  - `contracts/maintenance/` + `contracts/quality/`：MaintenanceCondition
    （conditionType 注册表 6 类 + 生命周期含 work_order 前置 + overdue 判定）与
    QualityFinding（findingType 注册表 5 类 + 处置生命周期 + disposition 必带决策
    accept/rework/scrap/return）；severity 走 Risk 契约、引用走 Identity 契约。
  - Python（`src/edge_platform/contracts/{maintenance,quality}.py`，零依赖）与
    TypeScript（`ewoh-spark-app/shared/{maintenance,quality}.ts`）锁定实现，
    消费同一份共享向量。
  - 门禁 `scripts/audit-domain-contracts.js` 增两域独立仲裁（182/182）；
    Golden Scenario 第 7 场景 `maintenance_quality_loop`（双执行器）；
    事件目录增补 MaintenanceConditionDetected/Resolved +
    QualityFindingDetected/Dispositioned（45 messages / 45 channels）。
  - 测试：tests/test_mq_contracts.py 7 例 + shared/maintenance-quality.spec.ts 3 例
    （pytest 218 passed / jest 1414 passed）；capability-matrix maintenance-loop
    升 Partial（30 Implemented / 21 Partial / 4 Missing / 1 Prototype）。
- **Phase 5 收尾与 Phase 6 启动（NO-05 / ADR-010）**：
  - 设备数据质量透出：`GET /api/devices/{id}/quality`（adapter DQ 计数器
    bad_crc/malformed/packet_loss/backfill/duplicates/dropped + 遥测质量分布
    storage.quality_stats）；`GET /api/status` 新增 `ingest_chain`
    {ok, adapters_registered, adapters_healthy, details}（无注册如实 false，
    防"真实模式空转"无感）。
  - ADR-010 Maintenance/Quality 领域模型决策（MaintenanceCondition 生命周期+
    逾期判定+维护状态入调度；QualityFinding 处置生命周期+质量状态入调度；
    Event→Outcome 闭环；事件目录 +4 类型计划）。
  - 测试：edge unittest 891 OK（+3 端点例）；capability-matrix
    device-discovery-health-dq 按 §36 升 Implemented
    （30 Implemented / 20 Partial / 5 Missing / 1 Prototype）。
- **Event Envelope 全链路接线（ADR-009 / NO-04b，Phase 4 收口）**：
  - 事件目录增补 6 类规则事件（DeviceLowBattery / WorkerHighLoad /
    WorkerPostureRisk / DeviceOffline / DataDegraded / DataQualityAlert），
    audit-event-catalog 41 messages / 41 channels（修复云侧规则引擎事件类型
    不在目录的既有漂移）。
  - 边缘 EventEngine 开事件产出信封（occurred/observed/received + schemaVersion +
    目录 eventType，EVENT_CODE_CATALOG_TYPE 映射）；既有字段兼容保留。
  - 云侧 rule-engine（RULE_EVENT_TYPE_MAP）/ ingest（DataQualityAlert）/
    identity 三条事件写路径收敛目录类型 + evidenceJson 内嵌 envelope 与
    envelopeSemantics（兼容层，不破坏既有列语义）。
  - shared/event-envelope.ts 新增 buildEventEnvelope / envelopeForEvidence。
  - 测试：edge unittest 888 OK（+2 wiring）；jest 1410 passed（+2 rule-engine
    envelope）；capability-matrix event-backbone / time-semantics 按 §36 升
    Implemented（29 Implemented / 21 Partial / 5 Missing / 1 Prototype）。
- **Canonical Event Envelope 契约（ADR-009 / NO-04，Phase 4 启动）**：
  - `contracts/events/envelope.schema.json` + envelope-test-vectors.json：
    16 字段信封（必填 eventId/eventType/schemaVersion/occurredAt/source）+ 确定性
    规则（时间三态漂移容忍 5min 标记 clockDrift 不改写 / 迟到 10min 标记 isLate
    不丢弃 / (source,eventId) 幂等去重 / actor-subject 规范身份 /
    eventType 必须命中事件目录）。
  - Python（`src/edge_platform/contracts/envelope.py`，零第三方依赖）与 TypeScript
    （`ewoh-spark-app/shared/event-envelope.ts`）锁定实现，消费同一份共享向量。
  - 独立仲裁门禁 `scripts/audit-event-envelope.js`（24 项断言：schema + 向量 JS
    重实现仲裁 + eventType 与 event-catalog.yaml 交叉校验 + 双运行时常量一致），
    挂 `make truth-check` 与新增 `make contract-envelope`，CI test.yml 新增步骤。
  - Golden Scenario 增补第 6 场景 `event_envelope_semantics`（双执行器扩展）。
  - 测试：tests/test_event_envelope.py + shared/event-envelope.spec.ts
    （pytest 211 passed / jest 1408 passed）。
- **Canonical World State 生产接线（ADR-008 / NO-03b，Phase 3 收口）**：
  - 云侧：`validateCloudWorldSnapshot` 快照构建自检（worldVersion / entityVersions
    规范身份键 / 实体规范引用 kind 匹配），collectState 附 `contractCheck`
    {valid, errors} + 失败 warn 留痕；WorldStateSnapshot/ResourceState 实体增可选
    `entityId`（person:/device:/station:/task: 规范身份引用，与原 id 并存），
    两路投影填充。
  - 边缘：`ContractWorldStore`（set_state 契约校验 fail-closed + 双时态/版本递增 +
    snapshot 自检 + 来源画像）进入真实装配链（production/development 均产出
    world_store 组件，real_components 快照含之）。
  - 测试：edge unittest 886 OK（+contract_world_store 8 例）；jest 1403 passed
    （+validateCloudWorldSnapshot 4 例 + entityId 投影 1 例）。
  - capability-matrix：factory-world-model / world-state-store-history 按 §36
    升 Implemented（27 Implemented / 23 Partial / 5 Missing / 1 Prototype）。
- **Canonical Factory World State 契约（ADR-008 / NO-03，Phase 3 启动）**：
  - `contracts/world/world-state.schema.json` + test-vectors.json：StateRecord
    双时态（[valid_from, valid_to) + sourceType real/simulated/derived +
    confidence [0,1] + version）+ 22 类实体注册表 + Snapshot（entityVersions 键
    必须规范身份）+ 确定性规则（区间不重叠 / 版本单调（快照单记录豁免）/
    模拟隔离 simulated 绝不参与 real 判定 / fail-closed）。
  - Python（`src/edge_platform/contracts/world.py`，零第三方依赖）与 TypeScript
    （`ewoh-spark-app/shared/world-contract.ts`）锁定实现，消费同一份共享向量。
  - 门禁 `scripts/audit-domain-contracts.js` 增 world 域独立仲裁（JS 重实现三套
    校验语义 + Python/TS 注册表一致），134/134。
  - Golden Scenario 增补第 5 场景 `world_state_projection_rules`（双执行器扩展）。
  - 测试：tests/test_world_contract.py + shared/world-contract.spec.ts
    （pytest 207 passed / jest 1398 passed）。
- **Canonical Contract Golden Scenarios 与 legacy reconcile（§26 / NO-02d，Phase 2 收口）**：
  - 共享场景定义 `tests/golden-fixtures/contract-golden-scenarios.json`（四域：
    身份映射冲突 fail-closed / legacy 严重度归一 / 脏空间类型拒绝 / 资源新鲜度
    fail-closed）+ Python（tests/test_golden_contract_scenarios.py）与 TS
    （shared/golden-contract-scenarios.spec.ts）双执行器；`make contract-golden` +
    CI test.yml 步骤（§26 每次架构变更重跑）。
  - `scripts/reconcile-identity-legacy.mjs`：legacy 设备 → identity_mapping 的
    append-only reconcile（ON CONFLICT DO NOTHING 绝不改写存量；确定性 RFC 4122
    UUIDv5 目标身份；dry-run 默认 + --apply 显式；幂等可重入）；CI standalone.yml
    真实 PG 验证 dry-run → apply → 复跑 planned=0。
  - capability-matrix：canonical-identity / risk / location / resource 四域按 §36
    判据升 Implemented（25 Implemented / 25 Partial / 5 Missing / 1 Prototype）。
- **Canonical Risk / Location / Resource 生产接线（ADR-007 / NO-02c-b）**：
  - Risk：规则引擎/ingest 写路径 severity 归一化（`normalizeSeverity`，
    L2→high/L3→medium，未知值 fail-closed 不落事件）；identity 事件 severity 收敛
    'low'；dashboard 统计口径 legacy+canonical 并集（存量/新量不漂移）。
  - Location：`SpatialEntityType = SpatialKind`（移除 `| string` 逃生舱）；
    ingestSpatialScan 拒绝非注册表 entity_type（fail-closed）；spatial 读边界
    校验存量脏行。
  - Resource：`ResourceState.status: ResourceStatus`（六态+UNKNOWN 锁定）；
    ResourceProjection `toCanonicalStatus` 显式归一（fault→DEGRADED/
    online→AVAILABLE/offline→OFFLINE/active→AVAILABLE/working→BUSY/
    unavailable→UNKNOWN，未知→UNKNOWN+warn 不猜测），覆盖 getUnifiedResourceState
    与 projectForSnapshot；eligibility/solver/conflict/前端消费点切换规范词表。
  - 回归：25 个调度 spec + 14 个 JSON fixture + benchmark 生成器词表规范化，
    jest 全量 202 suites / 1388 tests 全绿。
- **Canonical Risk / Location / Resource 契约（ADR-007 / NO-02c，Phase 2 收尾）**：
  - 契约层 `contracts/{risk,location,resource}/`：risk（severity 阶梯
    critical>high>medium>low + legacy 映射 L1→critical/L2→high/L3→medium +
    生命周期含复开边 + category 注册表）、location（空间类型封闭注册表 21 类 +
    坐标类型 FACTORY_CARTESIAN/WGS84/UNKNOWN + 记录校验：米制 +X 东 +Y 北 +Z 上、
    yaw [0,360)、WGS84 边界、UNKNOWN 禁止坐标冒泡）、resource（六态+UNKNOWN +
    FRESH/STALE/UNKNOWN + AUTHORITATIVE/DERIVED + 可用性 fail-closed
    「仅 AVAILABLE ∧ FRESH 可用」）。
  - Python（`src/edge_platform/contracts/{risk,location,resource}.py`，零第三方依赖）
    与 TypeScript（`ewoh-spark-app/shared/{risk,location,resource}.ts`）锁定实现，
    消费同一份共享测试向量（§31 跨语言一致性）。
  - 独立仲裁门禁 `scripts/audit-domain-contracts.js`（113 项断言：schema 形状 +
    向量 JS 重实现仲裁 + Python/TS 注册表与 schema 一致，有序注册表逐位比较），
    挂 `make truth-check` 与新增 `make contract-domain`，CI test.yml 新增
    「Domain 契约一致性门禁」步骤。
  - 测试：`tests/test_domain_contracts.py` 13 例 + `shared/domain-contracts.spec.ts`
    5 例（pytest 全量 200 passed）。
- **Canonical Industrial Identity 生产接线（ADR-006 / NO-02b）**：
  - 迁移 `standalone_032_identity_mapping`：`ewoh_identity_mapping`
    （TENANT_SCOPED：org_id NOT NULL + RLS `identity_mapping_org_isolation` +
    CHECK 约束 + 唯一业务键 (org_id, source_system, source_id)）+ 
    `ewoh_telemetry.entity_id`（additive 可空 + 索引）；成对 rollback +
    verify（表/RLS/策略/约束/自证）+ CI 迁移链（apply → verify → rollback → re-apply）。
  - 云侧 Identity 模块（`server/modules/identity/`）：注册幂等（同目标版本递增 /
    异目标 superseded + 新 active）、契约校验 fail-closed、解析走共享
    `resolveIdentityMapping`（active/时间窗口/ambiguous_identity）、
    `resolveBatch`（ingest 一次 IN 查询）、注册写 `EntityIdentityMapped` 事件
    （ewoh_event，org 归属）。
  - ingest 生产调用链：单帧/批量解析（`edge-device` 命名空间）→
    `ewoh_telemetry.entity_id`；未映射/无租户上下文 → NULL（legacy 行为不变）。
  - OpenAPI：`POST /api/identity/mappings`、`GET /api/identity/mappings`、
    `GET /api/identity/mappings/resolve` + 5 个 schema；gen:openapi 再生成；
    audit-openapi-routes 326 controllers / 0 漂移；route-manifest 再生成。
  - 治理接线：runner 注册 032 三命令；schema-manifest managed_count 57→58 +
    verify expected 列表 56→57 锁步；standalone-postgres-check 先应用 032；
    schema.ts 与迁移对齐（031 同纪律）。
  - 测试：identity.service.spec 8 例；ingest spec 补 IdentityService mock；
    audit-repo-facts 39/39（counts-generative 告警清零）。
- **Canonical Industrial Identity（ADR-006，Phase 2 首项）**：
  - 契约层 `contracts/identity/`：`identity.schema.json`（kind:value 语法 + 42 类封闭
    注册表 + 确定性规则，唯一事实源）、`identity-mapping.schema.json`（第三方 ID →
    规范身份映射记录：active/时间窗口/ambiguous_identity fail-closed）、
    `test-vectors.json`（43 valid / 15 invalid / 6 mapping 场景，跨语言共享向量）。
  - Python 实现 `src/edge_platform/contracts/identity.py`（零第三方依赖）与 TypeScript
    实现 `ewoh-spark-app/shared/identity.ts`：parse/format/解析映射/记录校验，语义逐项
    一致（内部 ID 必须 EWOH 生成，第三方 ID 仅 alias）。
  - 独立仲裁门禁 `scripts/audit-identity-contracts.js`（22 项断言：契约形状 + 向量
    JS 重实现仲裁 + Python KINDS / TS IDENTITY_KINDS 与 schema 注册表逐项一致），
    挂入 `make truth-check` 与新增 `make contract-identity`，CI test.yml 新增
    「Identity 契约一致性门禁」步骤；jest testMatch 纳入 `shared/**/*.spec.ts`。
  - 事件目录新增 `EntityIdentityMapped`（`com.ewoh.identity.mapped`，35 messages/35 channels）。
  - 测试：`tests/test_identity_contract.py` 18 例 + `shared/identity.spec.ts` 13 例
    （pytest 187 passed / shared jest 13/13）。
- **长期架构治理层（long-cycle-governance）**：
  - 新增长期 Agent 外置记忆 `docs/agent/project-state.yaml`（current_phase / 已完成 /
    部分 / 缺失能力 / 架构债 / 关键风险 / 迁移 / 下一目标 / 阻塞项 / 决策 /
    权威事实源 / 测试状态）+ 回合报告 `docs/agent/round-reports/2026-08-14-round-01.md`。
  - 新增 Phase 0/1 架构工件：`docs/architecture/current-state.md`、`target-state.md`、
    `domain-map.md`、`data-flow.md`、`runtime-map.md`、`decision-log.md`（决策日志索引，
    指向既有 docs/decisions/ 体系）、`docs/capabilities/capability-matrix.yaml`
    （56 项能力 × 状态词表 × 证据路径：21 Implemented / 28 Partial / 6 Missing /
    1 Prototype）、`docs/contracts/index.md`（契约权威源导航）。
  - 基线复测：仓库级 pytest 169 passed / 10 skipped；truth-feature-status 31/31；
    audit-repo-facts 39/39（本回合实测，与 feature-status.yaml 单一事实源一致）。
- **产品化深化批（close-loop-and-converge，路线图执行）**：
  - **执行反馈可视化（SchedulePanel）**：新增 `ExecutionDeviationList`——真实消费
    `GET /api/scheduler/executions?planId=`（计划 vs 实际 + 偏差事实），30s 轮询 +
    三态；`pickPreviousApprovedPlanId` 纯函数 + 「对比上一已批准方案」回看动作
    （值班员评估回退目标，复用 PlanCompare 端点，绝不兜底列表首个）。
  - **方案状态流转指示**：`planStatusStepVM` + `PlanStatusStepper` 组件——影子方案→
    已批准→已派工→执行中四步流转（done/current/todo），方案状态徽标同步中文化。
  - **L3 告警聚合去抖**：`alertToastLogic.aggregateL3` 按设备聚合近窗口事件，
    AlertToast 一张卡展示「设备 × N 条」+ 展开列表按设备分组（风暴不刷屏）。
  - **中文化残留清理**：churn→换人成本/换人、STALE CONTEXT→上下文已过期、
    seq→序号、asOf→截至。
  - **Pilot Soak 真值环境（文档+编排）**：`docs/operations/pilot-soak-runbook.md`
    （部署前 7 项检查 / 8 周 soak 协议 / 故障注入日历 / runtimeVerified 验收表）+
    `scripts/pilot-soak.sh`（本机 13 项检查 + 真实环境项如实 BLOCKED，退出码 0/1/2
    语义诚实，--report 输出小时摘要）。
- **治理收敛（converge）**：
  - **边缘 production RBAC 落地（R-1）**：`action_for_request(method, path)` 把请求
    映射为 9 动作矩阵；do_GET/do_POST/do_PATCH 在认证门禁之后按会话角色执行
    `is_allowed`（fail-closed，403 forbidden）——operator 不能建任务/改派工，
    viewer/data_analyst 不可读审计；development/simulation 保持离线演示语义；
    回归测试 9 例（`test_rbac_enforcement.py`）。
  - **边缘 hydrate 补齐（R-3）**：重启后恢复正式派工 `_assignments`（可查/可续
    状态流转）、执行反馈 `_feedback`（学习闭环）、active 预约
    （ReservationService.restore → confirm 冲突检测跨重启有效，防双预约）；
    存储行按模型字段过滤构造对象（额外列 recommended_by 等不再致恢复失败）；
    回归测试 2 例 + `SchedulerService.list_feedback`。
  - **云侧 N+1 消除（R-5）**：`listActivePlans`/`listRuns`/`getActivePlans` 的分配明细改为
    `inArray` 批量加载（`loadAssignmentsBatched`/`listPlansBatched`，原每方案
    1-2 次查询，且保留 per-plan 损坏跳过语义）；facade/runs-snapshot 表征测试 mock 同步。
  - **删除死脚手架**：`server/modules/hello`（整文件注释模板）移除。

### Fixed
- **全仓系统性走读整改（systematic-code-walkthrough-2026-08-14，P0×3 + P1×5）**：
  - **边缘 P0-1 静态目录穿越**：`server.py` 的 `translate_path` 覆盖丢失了标准库的 `..` 清洗，
    `GET /../../../demo.db` 可匿名读取仓库任意文件（含 110MB 全量数据库，运行时实测 200）。
    修复为镜像标准库语义（丢弃 `.`/`..` 段，绝不越出 STATIC_DIR），新增回归测试
    `test_server_patch_and_static_safety.py`（穿越/绝对路径/编码变体 → 404）。
  - **边缘 P0-2 do_PATCH 写路径无 production 门禁与审计**：`/api/tasks/{id}` PATCH 与 do_POST 不对称，
    production 匿名可写且不落审计。修复为复用 production 认证 fail-closed + 自动审计
    （action=PATCH …），`_flush_post_audit` 泛化支持任意方法；rate_limiter 同步覆盖 do_PATCH。
  - **云侧 P0-1 SSE 被全局拦截器破坏**：`OrgContextInterceptor` 用 `lastValueFrom(next.handle())`
    包裹 `@Sse` 无限流——永不 resolve，客户端收不到任何调度事件，且请求级事务/连接被占满
    （连接池 max=20）。修复：SSE 处理器（`SSE_METADATA`）直通不进事务（租户隔离由应用层
    orgId 过滤保证），新增直通单测（org-context.interceptor.spec.ts 6/6）。
  - **Simulator fail-closed（P1）**：`onModuleInit` 自动启动改为显式 `EWOH_SIMULATOR_ENABLED=1`
    才启动；`deploy/.env.example` 默认 `EWOH_SIMULATOR_DISABLED=1`（此前生产 standalone 会把
    仿真遥测写入真实表、破坏快照新鲜度 PLAN_STALE）。
  - **边缘安全 fail-closed 补全（P1×2）**：视觉理解出站地址 SSRF 防护——
    `ark_vision.describe_image` 新增 `validate_outbound_url`（仅公网 http/https，
    DNS 解析后拒绝环回/内网/链路本地/云元数据地址），请求级 base_url/image_url 覆盖
    无法再把服务端出站请求指向内部网络（保留云侧 Ark 配置代理功能）；
    `/api/command-map/stream` production 下要求有效 Bearer token（匿名订阅 401 fail-closed），
    development/simulation 保留离线演示直连；均带回归测试（内网地址拒绝/公网放行/
    端点 502/SSE 401/开发直连）。
  - **决策驾驶舱执行反馈闭环（P1，执行反馈断链修复）**：`SCHEDULING_FEEDBACK` 段由显式
    空态改为真实消费 `GET /api/scheduler/executions`（planned vs actual + deviation 事实）：
    汇总指标（执行中/完成/失败取消/按时完成率/平均延误）+ 最近 5 条执行事件（人员/任务/
    状态文案/偏差标签），30s 轮询 + 加载/错误重试/空态三态（空态文案如实说明"方案派工后
    显示执行进度"）。新增纯映射 `executionFeedbackVM.ts`（不重算任何资格/成本/硬约束，
    仅状态→文案映射）+ 单测 6 例 + render-only 静态约束；queryKeys 新增
    `schedulerExecutions(planId)`。client 测试 108 套件 / 886 通过。
  - **真机遥测动作分类恒 unknown（P0，E-01）修复——三层字段契约对齐**：
    NXP1 设备不提供 roll_deg/3D 角速度/3D 加速度，旧特征提取强制要求三者齐备 →
    `extract_features` 恒 None → 推理恒 unknown/data_quality + ACTION_ANOMALY_LOW_QUALITY
    持续误报。修复：`features._sample_values` 核心通道（pitch/torque/assist）与可选通道
    （roll/角速度/加速度，缺失维度聚合为 None）分离，标量角速度模长 `angular_velocity_dps`
    折算为 gyro_mag；`extract_features` 可选维度 None 不判 invalid；规则路径 None-safe
    （gyro/accel 缺失计 0）；`_infer` 对「模型 12 维契约 vs 设备通道子集」诚实降级规则路径；
    `_KEY_CHANNELS` 收敛为核心通道（可选通道缺失不再触发 sensor_channel_missing）。
    回归测试 10 例：`DeviceSubsetChannelTest`（8）+ `RealDeviceChainTest`（2，真机形状
    UnifiedExoFrame→frame_adapter→extract_features→walk/bend 标签端到端）。
  - **边缘存储索引补齐（E-08）**：inference(device_id, ts_end)、risk_event(start_time/status/device_id)、
    scheduling_request(status)、scheduling_plan(status)、world_state_snapshot(timestamp)——
    消除推理/事件/调度列表全表扫描的索引缺口（幂等 CREATE INDEX IF NOT EXISTS）。
  - **CP-SAT worker 时间基准与目标分解修复（P0×3，纯算术一致性，可单测）**：
    `to_relative_minutes` 统一模型时间基准——frozen/reservation/due/mustFinish
    原以 epoch 毫秒整除分钟（≈2.9e7）与相对分钟变量混入同一 AddNoOverlap/MaxEquality，
    导致预约/冻结约束对普通任务完全失效、lateness 恒 0、硬截止从不生效；
    `late_domain_upper` 修复 late 变量域溢出（原固定 horizon+10 上界被表达式越过
    → 模型不可满足）；objectiveBreakdown 由「输出权重值」改为输出求解出的真实分量
    （unassigned/lateness/stationWait/travel/churn 自然单位）。新增纯函数回归测试
    （test_cpsat_solver.py TestTimeBasisHelpers + test_cpsat_reservation.py 相对分钟语义）。
    注：无 ortools 环境仍以 UNAVAILABLE fail-closed 回退，真实求解验证留待部署环境。
  - **边缘调度只读边界 403（P1）**：readonly/advisory 模式下 POST /api/tasks 原 500、
    PATCH /api/tasks 原 400，现统一 `403 SCHEDULING_READ_ONLY`（与 plan confirm/execute
    一致），任务写路径如实告知「正式调度写权限归 NestJS 控制面」；回归测试 2 例。
  - **审计身份防伪造（P1）**：routes/scheduler.py、routes/world.py 的 actor/handler/author 由
    「客户端自报优先」改为「服务端 token 身份优先」（`_util.resolve_actor`），未认证才降级
    客户端字段（仅 development/simulation 演示便利）；新增回归测试。
  - **边缘采集链路机械缺陷（E-05/06/07/10/19）**：`UnifiedExoFrame` 新增 `sequence`/`backfill`
    采集溯源字段并全链路透传（frame_adapter → storage/规则层，契约测试同步扩展）；
    `PACKET_LOSS_BURST` 死规则改读生产字段 `packet_loss_pct`（兼容旧字段 0-1 换算）；
    TIME_SYNC_ANOMALY 跳过补传历史帧（重连补传不再误报）；firmware_version 透传恢复白名单校验；
    SEQ 丢包统计仅计实时 TELEMETRY 帧（IDENT/FAULT/BACKFILL 不再污染期望帧数）。
  - **飞书侧车（P1×3）**：健康探针如实报告——`syncAllToFeishu` 聚合子项失败
    （任一失败 → `recordFeishuSync(false, 首错)`，此前恒报 true）；`GET /api/feishu/report`
    改 POST（飞书建文档副作用归入写鉴权 fail-closed），README 同步；内置 web UI 处置表单
    与写鉴权脱节（永久 401/503）——顶栏新增「写权限」按钮（Bearer 头注入 + 401/503 可行动
    错误提示 + localStorage 持久），处置闭环恢复可用。
  - **测试红灯修复**：`stateCoverage.test.ts` 移除已删除孤儿页（Overview/Events）的期望
    （client 879/879 恢复全绿）。
  - **前端包体清理（P2）**：移除随 SPA 发布的死静态副本 `client/public/command_map`
    （232KB，生产 React CommandMap 不使用；历史原型保留在仓库根 `ui/command_map`），
    并修正 `app.tsx` 过期的「全屏 iframe」注释。
  - **文档/部署漂移**：README 路由口径 307/461 → 实测 323/481（唯一 323）并移除不存在的
    `GET /api/scheduler/weights` 行；`deploy/cloud/.env.compose.example` 版本 rc2 → rc4。

### Fixed
- **权威事实源收敛 + UX 缺口闭合（close-head-truth-ux-gaps）**：
  - **事实源假阴性修正**：`feature-status.yaml` 的 `decisionCockpit` 由「未实现」修正为已实现
    （CommandMap 决策驾驶舱 tab 已真实接线并调用后端 API），同步 README 能力状态清单。
  - **失效证据清理**：`schedulerV2` / `benchmarkScheduler` 引用已不存在的 `output/bench-*.json`
    替换为真实存在的基准文件。
  - **DB 受管表口径修正**：`schema-manifest.yaml` 与 `state.json` 的受管表数由 73 修正为 57
    （与 `managed_tables` 列表及 CHANGELOG/release-manifest 一致），`reconcile` dbConsistent 恢复 PASS。
  - **决策驾驶舱反馈诚实闭合**：调度反馈段由静默 `null` 改为显式「暂无调度反馈数据」空态。
  - **UX 缺口闭合**：状态色收敛至语义设计 Token；设备详情接入统一时间线；角色化 Quick Start 入口；
    清理未接线孤儿页（Overview/Events/CenterPlaceholder/ExamplePage）；修正 Alerts 离线横幅文案。
  - **代码质量债**：ingest 幂等查询 DB 失败由 fail-open 改为 fail-closed + 日志；work-orchestration
    死代码清理；audit 模块导入卫生；飞书 API 错误响应脱敏；跨工厂/CP-SAT 占位能力加 fail-closed 边界标注。

### Added
- **智能调度闭环补全（任务写路径接线 + 事件节流基础设施）**：
  - **任务写路径自动重排（10.1 关闭）**：TaskService 新增 `onTaskEvent` 回调注册表（task 模块零依赖，
    保持依赖叶子），TaskSchedulingBridge（scheduler 模块）注册回调 → `injectSchedulingEvent`
    （TASK_CREATED/TASK_UPDATED），fire-and-forget 不阻塞任务写路径；复用冷却去抖/级联/SAFETY 熔断。
  - **outbox 节流入队 `enqueueThrottled`（C4）**：合并窗口内同 eventType+entityId 的 pending 事件
    仅覆盖 payload（最终态合并），不新增行——resource.state_changed 等高频事件的事件风暴防护基础设施；
    合并不更新 sequence（无 SSE 缺口副作用），跨实体独立窗口。
  - 测试：task-scheduling-bridge（4）+ outbox-throttled（2）

### Fixed
- **运行时可用性收尾（走读报告 M1-M4 + L1-L3 全闭环）**：
  - **飞书 M1**：lark-cli spawnSync 加 20s 硬超时（防挂死永久阻塞事件循环），超时走 SIGTERM 错误路径。
  - **飞书 M2**：flushTelemetry 失败保留 buffer 重试（此前失败即清空 → 遥测数据丢失），
    成功移除已发送行 + 5000 条上限裁剪防无界增长；新增回归测试 2 例。
  - **边缘 M3**：`/api/status` 按 `_running` 状态如实报告（此前对象存在即报 healthy，未启动的
    inference/manager 冒充健康）；pipeline 补运行状态标记。
  - **边缘 L2**：演示 token 24h 过期 + 登录惰性清理（此前永不过期内存缓慢增长）。
  - **边缘 L3**：5 处静默 `except Exception: pass` 补日志（会话校验/body 排空/审计/模型信息/埋点）。
  - **飞书 L1**：卡片回调注释诚实化——仅支持事件订阅信封，旧格式 `{open_id, action}` 缺
    header.token 必然 401（安全边界，不提供无验签兼容路径）。
  - **M4**：legacy 入口启动打印装配差异警告（缺 12 模块 + metrics/ratelimit），引导 standalone。

### Added
- **智能调度 v0.7 第四批（Batch 10-11，调度闭环 + 前端结构 + 工程治理资产）**：
  - **影子评估自动化**：事件驱动 run 每 10 次自动对比候选策略（listVersions 找到 v+1）与活跃策略，
    结果写审计（scheduler.policy.shadow_eval），不激活任何候选（仅观测）。
  - **地图模式状态机**：新增 `map-mode-machine.ts` 纯函数模块（mode/level/replay 三态转换规则 +
    副作用映射），CommandMap 消费（handleViewOnMap 经状态机计算含 L3 联动）。
  - **地图着色纯函数抽取**：`entityColors.ts`（isExoDevice/getEntityColor/getDeviceColor/
    priorityLevelColor/resourceStatusColor），消除 FactoryMap 内联重复（走读 M 项）。
  - **工程治理资产**：`docs/decisions/OPEN-DECISIONS.md`（4 未决项：任务写路径接线/RLS 覆盖/
    CP-SAT 启用/lark-cli 异步化）；ADR-001（权重收敛）/ADR-002（事件驱动重排）/ADR-003（CP-SAT worker）；
    SECURITY.md 补充多租户隔离边界（RLS 白名单 vs 全局共享表）；verify 期望值来源注释；
    CI 增加 OpenAPI 路由零漂移门禁步骤。
- **智能调度 v0.7 第三批（Batch 8 剩余 + G5，边缘运行时与治理收敛）**：
  - **遥测帧格式对齐（H2 修复）**：新增 `edge/modeling/frame_adapter.py` 纯函数转换
    （分组帧 entity_id/event_time/pose/load → 扁平 device_id/timestamp/telemetry），
    `AdapterManager._read_loop` 插入转换（兼容双格式），消除生产路径 KeyError 隐患；
    与 inference features 消费键完全对齐。
  - **RLS 缓解**：`listRuns` 增加应用层 org 过滤（actor.primaryOrgId → 按 org 过滤运行历史，
    缺省不过滤向后兼容）；审计文档 `docs/reviews/rls-coverage-audit-2026-08-08.md`。
  - **verify 期望值去硬编码（G5）**：`run_migrations.js` 的 F61-02 域表计数从
    `schema-manifest.yaml` 派生（js-yaml），消除硬编码 6。
  - **迁移双基线收敛（8.2）**：`001_ewoh_managed_tables.sql` 头部标注 DEPRECATED（standalone 链唯一事实源）。
  - **双总线澄清（8.3 修正）**：确认 MessageBus（流式数据通道）与 EventBus（SSE 广播）职责分离，
    `kafka` 仅为兼容命名别名，无需统一（原 H1 判定修正并记录）。
- **智能调度 v0.7 第二批（Batch 5-9，实施计划 `docs/reviews/next-steps-implementation-plan.md`）**：
  - **权重体系收敛**：`SchedulingPolicyConfig` 新增可选 `weights` 段（workloadBalance/stationWait/changeCost/energy），
    `buildPolicy` 从配置读取（缺省保持现值 1/1/0.5/minBattery/30 向后兼容），策略调参不再需要改代码。
  - **SSE 去重有界化**：`seenEventIds` 改 LRU（5000 上限，超限淘汰最老一半），消除长期运行内存无界增长。
  - **设备能力匹配**：设备 `capabilities` 从型号派生（EXO-Pro → exo-lift）、任务 `requiredDeviceCapabilities`
    从 taskType 派生（搬运类 → exo-lift），资格/求解器能力约束首次真实生效。
  - **事件驱动级联**：`injectSchedulingEvent` service 层入口（事件 → 局部重排 → 世界状态路由/预占冲突
    scoped 级联重排，冷却去抖防风暴）；metrics 埋点（recordRun/recordFallback）。
  - **SAFETY_EVENT 派工熔断**：派工涉及安全阻断（L2/L3 open）人员/设备 → `SAFETY_BLOCK_DISPATCH` 拒绝下发。
  - **前端深化**：`execution.deviation` 事件失效 worldState（地图位置近实时）；冲突中心"定位地图"按钮
    （选中实体+收起面板）；覆盖面板候选资源选择器（按评分/技能/负荷排序，不可行候选含排除原因）。
  - **CP-SAT Worker 部署就绪**：`src/edge_platform/scheduler/cpsat/worker.py`（纯标准库 HTTP worker，
    POST /api/scheduler/v2/solve + health 探针）+ `deploy/cloud/Dockerfile.cpsat` + compose `cpsat` 可选服务
    （`deploy/cloud/docker-compose.standalone.yml` 内建 cpsat 服务，另提供独立
    `deploy/cloud/docker-compose.cpsat.yml` 仅启动 worker）；ortools 版本锁定 `==9.11.4210`
    （与 `src/edge_platform/scheduler/cpsat/requirements.txt` 一致）；
    ortools 缺失时如实返回 UNAVAILABLE 由云侧回退 heuristic。
- **智能调度 v0.7（四批增量，指挥地图 → 智能调度驾驶舱）**：
  - **任务派生建模**（`world-state.service.ts`）：`productionImpact`（priority 映射 urgent=1.0→low=0.1）、
    `safetyCritical`（taskType 白名单）、`candidateStations`（空间拓扑推导）从既有字段派生，无 schema 变更；
    PriorityEngine 生产影响因子首次真实生效。
  - **冲突增强**：新增第 13 类 `reservation_expiring`（预占 15min 倒计时预警）；
    `buildConflicts` 新冲突经 outbox 推送 `conflict.detected` SSE（内存去重防轮询重复推送）。
  - **事件驱动智能重排**：`POST /api/scheduler/events`（局部重排：影响分析→冻结无关任务→子图求解→熔断）；
    `POST /api/scheduler/feedback/actuals`（执行实际值回填，覆盖式更新幂等，回填后推送 `execution.deviation` SSE）；
    ingest 设备故障/离线转换自动触发 `DEVICE_OFFLINE` 重排（fire-and-forget，熔断不阻断真机接入）；

    `ReplanCoordinator.handleTrigger` 失败熔断（run 置 failed 不再卡 queued）。
  - **前端智能交互**（CommandMap）：新增「冲突中心」（13 类过滤/严重度排序/建议处置/三态）与「人工覆盖」
    （LOCK/EXCLUDE/PREFER/BOOST/LOCK_TIME → 重排 → before/after diff）；`useSchedulerStream` 消费
    `conflict.detected`/`execution.deviation` 实时刷新。
  - **OpenAPI 同步**：304 → 306 条路径零漂移；客户端 TS 类型重生成。
- **飞书侧车生产级加固 v1.1.0**（`ewoh-feishu-app`）：
  - **API 统一鉴权**：写操作 fail-closed（token 未配置 → 503，不匹配 → 401），Bearer/X-API-Key 双格式，常量时间比较。
  - **SQLite 落盘持久化**：默认文件库（WAL + busy_timeout）替代 `:memory:`，进程退出数据保留。
  - **webhook 业务幂等**：`webhook_dedup` 表 `(event_id, action_type)` 唯一约束，重复投递返回 `duplicated:true`；
    失败回滚可重试；closed 事件禁止再处置（409）。
  - **签名协议修复**：HMAC 时间戳按飞书协议用秒级字符串（原毫秒导致 encrypt_key 校验永远失败）。
  - **规则单一事实源**：规则引擎从 DB 加载（阈值可运行时调参）。
  - **启动不阻塞**：飞书集成延迟至 HTTP 就绪后初始化（lark-cli 不再阻塞 listen）。
- **AI 接入修复**：`ark.service.ts` 配置保存改用全局哨兵 org_id（原 INSERT 缺 org_id → NULL →
  `ON CONFLICT` 永不触发 → 无限插行且读取常拿到旧行，AI 接入整体失效）；`getConfig` 按哨兵精确读取 + 排序。

### Fixed
- **AI 接入失效**：`saveConfig` 未提供 `org_id` 列 → NULL → PG 唯一索引视 NULL 互不相等 →
  `ON CONFLICT (org_id, config_key)` 永不触发，每次保存插入新行；`getConfig` 无 org 过滤 + 无排序读取不确定行。
  修复为显式全局哨兵 `GLOBAL_ORG_SENTINEL`（固定 UUID）+ 按哨兵过滤 + `_updated_at desc` 排序。
- **Feishu webhook 签名**：HMAC source 使用毫秒时间戳（协议要求秒字符串），配置 encrypt_key 时签名永远不匹配。
- **Feishu 事件处置接口无鉴权**：`/api/events/:id/handle` 等写端点全站无鉴权，任何人可改事件状态。
- **Feishu 数据丢失**：SQLite `:memory:` 进程退出数据全丢，与 30s 全量同步设计矛盾。
- **调度 run 卡死**：`handleTrigger` 失败时 run 永远停留在 queued；现置为 failed 并记录日志。

- **角色工作台生产化深化与真实数据闭环**（`deepen-roleworkbench-production`）：
  - **数据库级列表查询**：`RoleWorkbenchService.getWorkbenchList` 改为真实 PostgreSQL 查询
    （参数化 WHERE 含强制 `org_id` / ORDER BY / LIMIT），删除 `.limit(5000)` 全表内存读取；
    稳定排序键 cursor 分页（`(sort, uniqueId)` 处理重复时间戳/优先级，无重复无遗漏）；
    页码模式单独准确 COUNT；`workbench-list-query.ts` 提供 cursor 编解码与稳定排序协议。
  - **占位业务数据消除**：`overdueInspections`/`dispositions`/`maintenanceTasks`/
    `capacityDegradation`/`riskTrend` 等改为真实 SQL 聚合或明确 `value/status/calculatedAt/
    dataRange/source` availability 表达（`no_data`/`not_configured`/`permission_denied`/
    `source_unavailable`/`stale`），前端 `workbenchDataStates.ts` 区分「真实为零」与「无数据」。
  - **保存视图 PostgreSQL 持久化**：`saved_views` 表 + `standalone_005_workbench_prod.sql`，
    org+owner 隔离、默认视图唯一、软删除；`PostgresWorkbenchViewStore` 为生产存储，
    内存实现仅作 test adapter。
  - **导出任务真实任务系统**：`workbench_export_tasks` 表 + `workbench-export-state.ts`
    状态机（queued/running/succeeded/failed/cancelling/cancelled/expired）、原子 claim
    （双 worker 不重复）、幂等、重试/退避、到期；`PostgresWorkbenchExportStore` 生产存储；
    审计日志记录谁/范围/记录数/文件大小/完成时间。
  - **发布真值**：`scripts/truth-status.js` 统一四态（NOT_RUN/FAILED/BLOCKED_BY_ENVIRONMENT/
    SUCCEEDED），`BLOCKED_BY_ENVIRONMENT` 不计为 PASS；Production Ready 由当前 SHA 门禁
    自动计算；`truth-gate.js` 对 STALE/SHA 漂移 fail-closed；镜像未构建时扫描不入 PASS。
  - **大数据量性能验收**：`scripts/perf/seed-workbench-data.js` + `workbench-benchmark.js` +
    `perf-gate.js` 生成 10k/100k 确定性数据并记录 p50/p95/p99、DB 执行/扫描/返回行数；
    `perf.yml` 接入 CI，超预算即失败。
  - **生产运行时门禁**：`runtime-gates.yml` + `verify-migration-prod.mjs` /
    `verify-backup-restore.mjs` / `verify-helm-runtime.sh` / `canary-deploy.sh` /
    `soak-load.js` / `container-image-gate.sh`；环境不可用项如实标 `BLOCKED_BY_ENVIRONMENT`
    并给出可复制命令。
  - **前端性能深化**：`bundle-budget.mjs` 首屏/异步 chunk 预算（首屏 175.09kB gzip < 460kB
    PASS；单异步 chunk 243.57kB < 520kB PASS）；`browser-metrics.mjs` 记录真实 LCP/INP/CLS。
  - 验收报告：`docs/reviews/deepen-roleworkbench-production-report.md`。

- 代码深化与用户体验闭环验收（全量门禁证据采集）：
  - **语义化设计系统**：`client/src/lib/designTokens.ts` + `client/src/tokens.css` 集中
    semantic design tokens（背景/表面/边框/文本、success/warning/danger/info、
    normal/degraded/offline/blocked/conflict/unknown、spacing/radius/typography/
    elevation/motion/z-index）；深色/高对比/prefers-reduced-motion 适配；
    `scripts/lint-design-tokens.mjs` 静态检查阻断业务页面新增未经批准硬编码样式值。
  - **统一对象时间线**：`server/modules/timeline/*` 统一时间线 DTO（鉴权+组织隔离），
    `GET /api/timeline/events`；`client/src/lib/timelineModel.ts` 客户端只消费统一 DTO；
    OpenAPI 契约注册（TimelineSource/PermissionVisibility/TimelineCredibility/
    TimelineEvidenceRef/TimelineEvent）。
  - **首次使用与样例工厂闭环**：角色化 Quick Start、可清除样例工厂、五分钟闭环引导
    （可跳过/恢复/重开+版本记录）、统一空状态与无权限/无设备/无数据/断连/同步中/
    初始化失败路径、匿名化产品事件。
  - **性能预算**：`client/src/lib/perfBudget.ts` + `scripts/bundle-budget.mjs` 真实
    预算门禁（首屏 JS 174.72kB gzip < 460kB；单异步 chunk 319.60kB < 520kB）。
  - **跨浏览器弱网与视觉回归**：可移植弱网注入（登录后断连/提交断连/离线队列重放/
    重复提交/冲突 409/SW 更新/刷新/多标签并发）；`ux009-weaknetwork.spec.js`；
    Linux Chromium 主金基线 + 本地 darwin 自检基线。
  - **前端资源生命周期统一**：`client/src/lib/runtimeLifecycle.ts` 统一 session/runtime
    生命周期（BroadcastChannel/WS/SSE/SW listener/timer/retry/AbortController/
    IndexedDB/Blob URL/event listener），覆盖卸载/登出/Token 失效/租户切换/角色切换/
    后台/网络恢复/SW 升级。
  - **安全扫描固定 CI**：Bandit 锁定 1.8.6（`security.yml` 实际运行+JSON 报告+
    `bandit-gate.py` 阻断未豁免 HIGH）、Gitleaks 秘密扫描（基线豁免历史遗留）、Node 生产
    依赖审计、SBOM（CycloneDX）校验、镜像漏洞扫描（Trivy，BLOCKED_BY_ENVIRONMENT）、
    suppressions 文件（带原因/责任人/到期）。
  - **真实运行门禁**：`docs/runtime-gates.md` 记录 PG migration 往返/HTTP+PG E2E/并发/
    备份恢复/Docker 健康的 CI 自动化与 Helm/soak 等 BLOCKED + 一键命令。
  - **错误与恢复体验**：核心页面 12 态一致 + 统一错误组件 `AppErrorState.tsx`
    （现象/影响/是否已保存/可执行下一步/可复制 trace|request id）。
  - 验收报告：`docs/reviews/code-deepening-ux-closed-loop-report.md`（修改内容/风险/
    文件清单/测试清单/验证命令/性能对比/无障碍跨浏览器/BLOCKED/技术债务/五级结论）。
  - **单一事实源**：`scripts/truth-manifest.js` + `scripts/truth-source.js` 由 CI 运行时读取
    `GITHUB_SHA`/`git rev-parse HEAD`，从 Jest JSON 自动取测试计数并生成 evidence manifest
    （evaluatedCommitSha/branch/buildVersion/environmentFingerprint/dependencyVersions/
    testStartedAt/testFinishedAt/verifier/workflowRunId/artifactDigest/expiration）；
    `version.json` 为唯一版本源头；`make truth-check` 漂移校验；漂移夹具与回归测试。
    `output/evidence-manifest.json` 为运行时/CI 派生产物不入库（避免自指失效与跨环境漂移）。
  - **前端可观测性贯通**：后端 `frontend-metrics` ingestion API（契约/DTO/校验/限流/组织隔离），
    前端批量发送/采样/失败退避/sendBeacon/离线暂存重放，发送成功前不清空本地；采集
    LCP/CLS/INP/TTFB/路由/API 延迟/失败率/白屏/异常/离线指标；关联 requestId/traceId/组织/页面/
    构建版本/设备类别并脱敏；后端摄取测试。
  - **离线队列端到端幂等**：所有离线写操作发送 `idempotencyKey`，后端持久化幂等结果、重复提交
    副作用只执行一次、不同 payload 拒绝；附件/action 同 IndexedDB transaction 与孤儿清理；
    多标签页 leader election；401 暂停引导重认证；409/412 冲突展示差异；真实加密与密钥生命周期。
  - **Service Worker 重构**：区分 app shell/静态资源/HTML/API/用户文件/鉴权/敏感响应；API 与
    敏感内容默认不缓存；新版本提示、「安全更新/稍后更新」、更新前保存草稿、上一稳定 shell 回滚。
  - **上传安全贯通**：服务端 magic bytes/真实 content-type/路径穿越/压缩包炸弹校验接真实入口；
    隔离区扫描状态；S3 签名 URL 组织边界；断点续传/取消/进度/失败恢复/requestId。
  - **角色任务工作台深化**：默认角色来自认证用户；服务端 RBAC 判定、不信任前端 role；行点击跳转
    具体实体；服务端分页/筛选/排序/导出（异步+进度+权限+到期+审计）；保存视图服务端持久化；
    危险操作影响预览/幂等确认/撤销；键盘/扫码/触摸/单手/手套输入。
  - **真实业务 E2E 与工业 UX**：`test/browser/ux009-uxindustrial.spec.js` 覆盖角色流程、会话过期、
    多标签登出、权限拒绝、跨租户、陈旧/部分失败、弱网/抖动/上传中断、浏览器关闭恢复、200% 缩放、
    键盘焦点、屏幕阅读器、reduced motion、高对比、触控目标、长时间运行/内存/队列堆积；跨浏览器
    （chromium/firefox/webkit/mobile/industrial-tablet）真实运行，非 Chromium 弱网用可移植
    `page.route` 网络注入。
  - **性能与依赖可复现性**：`bundle-budget.mjs` 真实 bundle 分析（main chunk 176.94KB gzip < 460KB）；
    路由懒加载避免首屏重模块；`check-licenses.mjs` 许可证扫描（0 强 copyleft）；SBOM（CycloneDX）；
    移除未使用高危依赖（xlsx/jspdf/html2canvas/echarts）并升级 axios/form-data/postcss；
    无 `@latest`、Actions 固定版本、确定性构建（CI 两次构建字节一致）。
- F61-01 单一事实源语义一致性：7 个版本化 JSON Schema、14 条跨文件语义规则、
  13 类漂移夹具检测；`audit-repo-facts.js --strict` 任一未豁免冲突即非零退出。
- F61-02 领域状态持久化（Code Complete / Runtime Verification Blocked）：
  6 张领域表 `ewoh_resource_locks` / `ewoh_handoffs` / `ewoh_git_sync_state` /
  `ewoh_evidence_metadata` / `ewoh_factory_replication_sessions` /
  `ewoh_idempotency_keys` 迁移（`standalone_004_ewoh_domain.sql`）与可逆回滚脚本；
  乐观锁 `version` CAS 列用于资源锁（holder+version 校验），其余事实由唯一约束/
  幂等键保证多实例安全；时间戳命名与 Drizzle Schema 对齐。
- `DomainPersistenceService` 作为持久化事实源，替换进程内 Map 单例；六类领域事实
  读路径以数据库为准，旧 Map/数组/JSON 仅作缓存或灾备副本。
- 事务边界：获取锁+审计、交接+责任转移、接受交接+状态更新、git-sync+证据、
  复制步骤推进+输出证据、幂等键+业务对象创建均置于显式 `db.transaction`，中途
  失败无部分写入。
- 多实例正确性：DB 时间 `now()`、唯一约束竞争锁、版本 CAS、过期锁安全接管、
  非持有者拒绝续租/释放、并发冲突返回明确错误。
- 代码层测试：`domain-persistence.service.spec.ts` 29/29 通过；真实 HTTP +
  PostgreSQL E2E 代码完整且标记 `BLOCKED_BY_ENVIRONMENT`（不伪造、不静默跳过）。
- CI 环境验证入口：GitHub Actions `standalone.yml` 提供 PostgreSQL Service Container，
  应用/验证/回滚/重放迁移、双实例并发（`scripts/verify-domain-concurrency.js`）、
  真实 HTTP E2E，并保存证据 artifact `f61-02-ci-evidence-<sha>`。

### Notes
- **F61-02 最终状态：`F61-02 Code Complete / Runtime Verification Blocked`**。真实
  HTTP + PostgreSQL E2E 因本地无 PostgreSQL / docker 暂阻塞，运行时门禁已移至 CI
  （`EWOH_E2E_RUNTIME_DATABASE_URL`）。在真实 E2E 解锁通过前不宣称 Production /
  Scale Ready，不启动 F61-03。

## [0.6.0-rc4] - 2026-08-04

### Added
- 仓库事实源一致性门禁：`scripts/audit-repo-facts.js` 校验 README 导航、CHANGELOG、
  发布清单、Task Board、门禁、OpenAPI 路由清单、数据来源词汇与错误契约；
  已接入 `scripts/standalone-check.sh` 与 `test.yml`（30/30 通过）。
- 统一错误契约补全：错误响应增加 `errorCode`、`requestId`、`retryable`、
  `recommendedAction` 与 `details`，`requestId` 与 Tracing 的 `x-trace-id` 关联。
- 数据来源词汇扩展为 `real / controlled_test / simulated / replayed / stale /
  offline`，OpenAPI 枚举同步；新增可复用 `DataSourceBadge`，设备页接入。
- `RequestDatabaseContext.runInTransaction` 复用活动请求事务，避免 Scheduler
  在 HTTP 事务内再开根事务连接。
- 移动工作台：SOP 说明展示、暂停/恢复、异常上报（写 `resultJson.exception`）、
  质检（新 `POST /api/mobile/.../quality`）、离线提示与失败重试入口。
- 全局 `ValidationPipe`（`APP_PIPE`）注册到 Legacy 与 Standalone 两个启动路径，
  `class-validator` 错误映射为统一 `fieldErrors` 与 `VALIDATION_ERROR` 422 响应。
- 指挥地图实体详情：人员档案（组织/岗位/班组/技能/风险/外骨骼）与设备档案
  （电量/固件/协议/故障/温度/最近通信），并展示关联告警、最近事件与处置入口。
- 移动工作台离线待同步队列：离线操作进入 `localStorage` 队列并显示待同步数量，
  恢复联网后按顺序自动提交；队列工具与单元测试覆盖。
- 控制指令状态守卫：终态（executed/timeout）禁止再次发送或回执，同一指令存在
  in-flight 尝试时禁止重复发送，终态尝试禁止重复回执；失败后仍允许重试发送。
- Work Orchestration 交接状态机：open → accepted/rejected → closed，非法跳转
  拒绝；门禁决定重复提交幂等，变更前决定写入 `gate-decision-history.json`。
- Scale 幂等守卫：已 installed/uninstalled 的场景包重复安装/卸载直接返回；
  fleet upgrade/rollback 跳过已处于目标状态的 Profile；已 resolved 的工厂
  差异重复解决直接返回。
- 本地真实 PostgreSQL E2E：HTTP + PostgreSQL 29/29 通过（embedded PG 17，
  `127.0.0.1:55432`），覆盖鉴权/RBAC、组织隔离、MES/OEE/ERP、Scale、
  参数、AAS、Work Orchestration 与幂等场景。
- 移动异常照片附件：异常上报表单支持选择 JPG/PNG/WebP 照片，先经
  `/api/files` 上传并把文件引用写入 `resultJson.exception.attachments`。
- PWA 可安装基础：`manifest.webmanifest` + 最小 Service Worker + 客户端注册，
  Standalone 页面可安装到移动端/工业平板；repo-facts 增加 PWA 资产门禁。
- 离线照片队列：离线异常照片以 Data URL 存入待同步队列（约 2MB 上限），
  恢复联网后先上传 `/api/files`，再把文件引用写入异常附件后提交。
- 发布验证证据：`RELEASE DRILL PASSED`（PG apply/verify/RLS/audit/rollback/
  rebuild + 全门禁 + E2E 29/29）；性能冒烟 4610 QPS / p95 26.83ms；
  `STANDALONE SECURITY VERIFY OK`。
- 浏览器证据：Playwright 对 Standalone `/login` 在移动端（390x844）与桌面端
  （1440x900）截图，输出到 `output/playwright/iteration-login-*.png`。
- 请求关联：TracingInterceptor 通过 `AsyncLocalStorage` 把 `requestId` 传给
  审计写入路径，`AuditLogEntry.requestId` 自动填充；repo-facts 增加
  `request_context_correlation` 门禁。
- 错误脱敏：`HttpException` 不再把原始响应对象序列化进 `details`；
  Site Readiness 解析失败只返回通用错误码，不泄露底层异常文本。
- 设备页加载状态：失败时显示可重试错误状态，并展示最近更新时间，避免把
  加载失败误渲染为“未找到设备”。
- 静态安全扫描本地可执行：`python3 -m bandit -r src/edge_platform -ll`
  扫描 28286 行，0 medium/high。
- 指挥地图查询状态：空间实体/世界状态/总览/环境任一查询失败时显示错误横幅
  与“全部重试”，不再静默渲染为空地图。
- 版本同步：Helm appVersion、Compose/K8s 默认值、运行时默认版本与相关测试
  从 `0.6.0-rc3` 提升到 `0.6.0-rc4`。
- 认证浏览器测试：新增 `npm run test:browser`，用真实 PostgreSQL fixture 启动
  Standalone，Playwright 完成 dispatcher 登录、指挥中心、指挥地图、移动工作台
  和风险告警渲染（4/4），截图到
  `output/playwright/browser-authenticated-command-center.png`。
- CI 接入：`standalone.yml` 在 E2E 后安装 Playwright Chromium 并运行
  `npm run test:browser`，推送/PR 都会执行认证浏览器流程。
- 交付文档同步：`acceptance-evidence.md` 与 `release-checklist.md` 记录 RC4
  本地门禁、E2E、浏览器、性能、安全和发布包证据。
- README 更新为全栈产品导航：Python 边缘平台、Standalone 云产品命令、
  Playwright 浏览器门禁与 `0.6.0-rc4` 发布包校验。
- Pilot 就绪门禁重跑：本地 7 项通过（含数据库验证/运行库连接），3 项因
  本机无 Docker/Kubectl/Helm 失败，5 项等待外部批准与现场输入。
- 运维备份/恢复门禁重跑：`standalone-ops-check.sh` PASSED，57 表逻辑备份、
  恢复到一次性数据库、行数校验与身份序列推进全部通过。
- P0 移动工作台硬化：工作台按 `assigned_person_id` + `org_id` 过滤并
  fail-closed；扫码支持工单/工序/设备/物料/批次/工位/工厂类型识别；
  异常附件服务端持久化；离线队列增加
  `local/queued/syncing/synced/failed/conflict` 状态，单项失败不再阻塞后续项；
  `worker` 角色开放移动工作台。
- Work Graph 证据绑定与失效：证据 Markdown 支持 front matter
  （`commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/
  verifier/expiresAt`），解析器自动推导并输出
  `valid/stale/expired/unbound` 状态；`--invariants` 检查孤立边、循环依赖、
  重复 ID 与无 Owner 任务。
- 新增 `tools/work-console` 一键阻塞诊断 CLI：回答当前卡点、原因、解除人、
  缺失证据与受影响任务；接入 `standalone-check.sh` 与 CI。
- 修正 Task Graph 依赖引用为真实节点 ID，消除 19 条孤立边；重新生成
  `output/work-graph.json`、`output/gate-decisions.json`、
  `output/git-sync.json` 并新增 `output/work-console.json`。
- 独立审查修复：worker 只能操作 `assigned_person_id` 归属自己的工序；
  离线冲突项提供丢弃入口且不再自动重放；CI 使用
  `work-indexer --strict --invariants`；扫码空请求体返回 400 而非 500。
- Onboarding F0-F3 真执行：F0 校验场地就绪证据，F2 发布并核验连接器，
  F3 安装并核验场景包，均写审计。
- 映射 Dry Run：`POST /api/scale/mappings/:id/dry-run` 对样本载荷执行规则，
  返回 `REQUIRED_FIELD_MISSING`/`TRANSFORM_ERROR` 并定位源字段与目标字段。
- 真实数据库验证：HTTP+PostgreSQL E2E 29/29 通过，认证浏览器流程 4/4 通过。
- 世界回放统一时间轴：`/api/world/replay` 合并任务/工序/物料/质检/告警泳道，
  新增事件前后对比接口与从回放创建跟进问题的审计链路。
- E-SOP：`/api/mes/sops` 支持版本注册、发布与 Diff；工序可绑定 SOP、强制
  步骤、必需工具/物料；开工与报工前强制签收并记录签名。
- 质检方案：`/api/mes/quality-schemes` 支持首检/巡检/终检方案注册、发布与
  自动匹配；质检接口强制必检项并校验结果一致性。
- 慢查询观测：数据库事务支持 `statement_timeout` 与慢事务阈值记录，新增
  `GET /api/observability/slow-queries` 与 `ewoh_slow_queries_total` 指标。
- 前端性能：页面路由改为 `React.lazy` 分块加载，Standalone 主包从约 2.3MB
  降至约 374KB；世界状态与回放请求支持 `AbortSignal` 取消。
- MES 角色工作台：`GET /api/operations/role-workbench` 聚合操作员、班组长、
  质检、设备与管理者视图，新增 `/role-workbench` 页面。
- 渐进列表：新增 `progressiveSlice/hasMoreItems/nextProgressiveLimit`，
  角色工作台大列表先渲染 50 条并支持“加载更多”。
- Pilot Go/No-Go 重跑：7 通过 / 3 失败（本机无 Docker/Kubectl/Helm）/
  5 待批准，结果仍为 NOT READY。
- 事件中心新增“回放上下文”：展示事发前/事发时/处置后的快照摘要。
- 编排控制台新增受写回与人工批准保护的 `POST /api/work/git-sync/apply`。
- 最终全量门禁重跑：`ALL STANDALONE CHECKS PASSED`（真实 PG E2E 33/33、
  浏览器 5/5、server 81/391、client 15/50、OpenAPI 253/253）。

## [0.6.0-rc3] - 2026-08-04

### Added
- 采用 Final 6.0 权威基线：`authoritative-plan-final6.txt` 入库，
  决策 D-033 记录；新增 EWOH Work Orchestration Control Plane 产品主线。
- C7 Work Graph / C8 Asset Catalog / C9 Factory Profile 契约：
  `contracts/work/work-graph.schema.json`、`contracts/work/artifact-paths.json`、
  `contracts/catalog/asset-catalog.schema.json`、
  `contracts/factory/factory-profile.schema.json` 及示例与严格审计脚本。
- Work Graph 文件化索引器：`tools/work-indexer` 将 `.codex/artifacts` 解析为
  `ewoh:///work-graph/v1`，含路径注册表、校验和、冲突检测与严格 CLI。
- Gate Engine：`tools/gate-engine` 分离规则状态与人类决定，G10-G13 默认
  要求人工批准。
- 资源锁与交接服务：`tools/resource-registry`、`tools/handoff-service`，
  锁/交接记录以文件形式落盘并受 `EWOH_WORK_WRITABLE` 门禁。
- Work Orchestration API：`/api/work/*` 提供 overview/graph/items/evidence/
  agents/gates/risks/resources/handoffs/catalog 以及资源锁、交接和门禁决定
  写接口；`openapi/work-orchestration.yaml` 契约。
- GitHub Issue/PR 同步（离线优先）：`tools/git-sync/` 生成
  `ewoh:///git-sync/v1` 计划，`GET /api/work/git-sync` 与控制台 Git 同步页
  展示 issue/PR 关联缺口；真实创建必须人工批准并显式启用。
- 工厂复制验收：`tools/factory-replication/` 与
  `contracts/factory/replication-report.schema.json` 校验“无核心分支、Profile
  回放、配置/资产满足率≥80%、定制≤20%、差异已解决”的验收规则。
- 场地就绪检查：`tools/factory-replication/site-readiness.js` 与
  `contracts/factory/site-readiness.schema.json` 校验第二/第三工厂上线前
  的设备台账、ERP 端点、网络批准、培训计划和数据保留证据。
- 控制台体验深化：因果 DAG 支持缩放/平移、节点搜索、门禁状态筛选、
  证据类型/结果筛选；后端 `/api/work/items` 与 `/api/work/evidence` 支持
  `q/limit/offset`，资源锁按 `expiresAt` 自动过期释放。
- 证据内容预览：`GET /api/work/evidence/:id/content` 提供最多 500 行的
  证据文件摘要，前端证据抽屉内置行内预览。
- 门禁批量记录：`POST /api/work/gates/batch-decision` 一次写入多个门禁的
  人工决定；资源锁列表显示到期倒计时。
- 工厂场地就绪控制台：`GET /api/work/site-readiness` 扫描
  `catalog/factory-sites/*.json`，控制台新增“场地就绪”页签展示
  Go/No-Go 汇总。
- 交接状态流转：`POST /api/work/handoffs/:id/state` 支持接收/拒绝/关闭，
  状态写回 Markdown 记录，交接页提供对应操作按钮。
- 前端测试门禁：`client/jest.config.cjs` 与 `npm run test:client`，7 套件 /
  25 测试纳入 `standalone-check.sh`；审计链新增 100 条连续追加压力用例。
- 发布版本提升至 `0.6.0-rc3`：Helm appVersion、Compose/K8s/Standalone 环境
  默认版本同步更新；`release/ewoh-0.6.0-rc3` 包含 Final 6 工具、目录、
  制品与控制平面源码，1537 个文件并生成校验和。
- React 执行控制台：`/work-orchestration` 页面提供因果 DAG、门禁、证据抽屉、
  Agent、风险、资源锁、交接和 Final 6 资产目录视图。
- Final 6 资产目录：Order-to-Delivery、移动 E-SOP、质量追溯、库存协同四个
  场景包 Manifest，ERP 订单/库存连接器 Manifest，ERP→EWOH 订单/库存映射。
- 部署环境契约：`EWOH_WORK_ARTIFACTS_DIR`、`EWOH_WORK_TOOLS_DIR`、
  `EWOH_WORK_WRITABLE` 贯通 Standalone、Compose、Kubernetes 与 Helm；
  Docker 运行时镜像携带 `catalog/`、`tools/` 与 `.codex/artifacts/`。
- 验证证据：`round69-final6-work-orchestration.md`；Jest 74 套件 / 331 测试，
  前端 7 套件 / 27 测试，E2E 29/29，OpenAPI 231/231，Work Graph 202 节点 / 0 冲突，
  Python unittest 667 / pytest 120 / ruff 通过，release-drill 全通过，
  PostgreSQL 17 DDL/RLS/审计/回滚/重建全通过，本地门禁扫描全通过，
  性能冒烟 1368 QPS / p95 74.80ms，备份恢复 57 表通过，
  Release Review 34/34。

## [0.6.0-rc2] - 2026-08-03

### Added
- 真机接入协议对齐：`UnifiedExoFrame.to_storage_dict()` 标准格式（`entity_id`
  与嵌套 `pose`/`load`/`device`/`quality`）全量映射到 Ingestion 网关。
- 机器对机器租户上下文：`X-Org-Id` 或 `EWOH_INGEST_ORG_ID` 建立请求级
  `app.current_org_id` GUC，Ingestion 落库遵循 RLS 组织隔离。
- 游戏化资源分配真实持久化 E2E：`ewoh_schedule_plan` 与
  `ewoh_schedule_audit` 均验证 org 归属。
- 新增 IngestService/IngestGuard/GamificationService 单元测试与
  edge bridge 契约测试。
- PostgreSQL 逻辑备份/恢复工具：`scripts/postgres-logical-backup.mjs`，
  支持全部 `ewoh_*` 表导出、恢复、行数比对与身份序列回填。
- 一键恢复演练：`scripts/standalone-ops-check.sh`，覆盖建库、Schema、
  逻辑备份、恢复、行数校验与恢复后写入冒烟。
- 运维手册补全：告警分级与处置 SOP、故障注入、恢复演练、应急停止、
  自动运维检查均从占位升级为可执行流程。
- 培训计划升级为可执行版本 v1.1：四类 Session、角色化练习、真机接入、
  运维恢复练习与讲师复核要求。
- Prometheus 指标端点 `GET /metrics`：HTTP 请求计数、活跃请求、进程运行
  时间、数据库就绪检查计数。
- 部署工件本地校验：`scripts/verify-deploy-artifacts.js` 检查 Kubernetes、
  docker-compose 与 Dockerfile，共 62 项检查。
- 采用 Final 4.0 权威基线：`authoritative-plan-final4.txt` 与
  `delivery/01_开发基线/...最新研究升级版_Final4.0.docx` 入库，Final 3.0 保留
  为历史基线。
- MES P0 生产执行闭环：工单创建/释放/开工/完工、工序
  开工/报工/审核/交收、投料消耗、质量检验与审计，映射到既有
  `ewoh_schedule_task` / `ewoh_schedule_task_step` / `ewoh_resource_binding` /
  `ewoh_event`，48 张受管表包装不变。
- OEE/安灯闭环：设备状态时序、OEE 计算与停机原因分布、安灯状态机、
  SLA 升级通知与审计，复用 `ewoh_event` / `ewoh_notification`。
- ERP 连接器：入站订单幂等并自动生成工单、出站消息队列与确认/失败状态、
  对账汇总，复用 `ewoh_event` / `ewoh_schedule_task` /
  `ewoh_schedule_task_step`。
- 质量追溯图：工单→工序→投料→质量检验的节点与关系图。
- 移动工作台 API：按人员列出待办工序、扫码查工单、移动端工序状态流转。
- 移动工作台前端页面：扫码查单、待办工序列表、开工/报工/审核/交收操作。
- 采用 Final 5.0 规模化复制版权威基线：
  `authoritative-plan-final5.txt` 与 `delivery/01_开发基线/...Final5.0.docx`
  入库，Final 4.0 保留为历史基线。
- 规模化内核：工厂模板注册/继承/生命周期、模板安装生成工厂 Profile、
  资产包注册；新增 `ewoh_factory_template` / `ewoh_factory_profile` /
  `ewoh_asset_package`，受管表 48 → 57。
- 连接器/场景包目录：连接器（runtime/protocol/configSchema）与场景包
  （requires/workflows/policies）复用资产包注册；同一模板可安装多个工厂
  Profile，验证“第二工厂无分叉”。
- 资产一致性检查（TCK）：按连接器/场景包/模板/部署类型校验 Manifest。
- 工厂 Profile 回放：模板配置与 Profile 覆盖值合并，状态置为
  `replayed` 并写审计。
- 场景包安装门禁：安装前必须通过场景 TCK，失败返回 400 并保留审计。
- 舰队升级/回滚：`POST /api/scale/fleet/upgrade` /
  `/api/scale/fleet/rollback` 对组织可见 Factory Profile 批量变更状态并写审计。
- AsyncAPI/CloudEvents 事件目录：`contracts/events/event-catalog.yaml` 定义
  13 个事件类型与 13 条通道，`GET /api/events/catalog` 与
  `GET /api/events/catalog/:type` 提供只读 API，独立契约审计接入
  `standalone-check.sh`。
- Docker 运行时镜像携带 `/app/contracts`，事件目录在生产容器内可读。
- Helm 部署工厂：新增 `deploy/cloud/helm/ewoh` Chart，包含 Factory Values
  （工厂 ID/名称/升级环）、迁移 Job Hook、Deployment/Service/Ingress/HPA/PDB/
  本地 PVC 模板；Chart 不从 values 生成密钥。
- Helm 静态审计：`scripts/verify-helm-chart.js` 校验 Chart 元数据、values
  路径、模板清单与全部 `.Values.*` 引用；`npm run verify:helm` 与
  `test/contract/helm-chart.spec.ts` 纳入常规测试。
- Golden Factory Profile：`contracts/factory/golden-factory.yaml` 定义 7 个
  模块、3 个必需连接器与 4 个场景包；`POST /api/scale/golden-factory/install`
  一次完成模板发布、连接器发布、场景包 TCK 安装与工厂 Profile 安装/复用。
- Golden Factory 契约审计：`scripts/audit-golden-factory.js`（47 项检查）、
  `npm run contract:golden` 与 `test/contract/golden-factory.spec.ts`。
- Mapping DSL 与 Schema Registry：`contracts/mapping/mapping-schema.json`
  定义 `mappingId/name/version/source/target/rules` 契约，并提供
  `exoskeleton-telemetry-v1` 规范示例。
- Mapping 资产 API：`POST/GET /api/scale/mappings` 与
  `GET /api/scale/mappings/:id` 复用资产包注册表；TCK 增加 mapping 一致性
  检查（source/target/rules/schemaVersion）。
- Mapping 契约审计：`scripts/audit-mapping-contracts.js`（10 项检查）、
  `npm run contract:mapping` 与 `test/contract/mapping.spec.ts`。
- 升级环与 Fleet Ops：`fleet/upgrade` 与 `fleet/rollback` 支持按
  `dev/integration/shadow/pilot/small/full` 升级环分批执行，未指定环时保持
  全量操作兼容。
- Fleet 状态注册表：`GET /api/scale/fleet/status` 返回工厂 Profile 的环、
  状态、模板/资产包计数与环/状态分布。
- Support Bundle：`POST /api/scale/fleet/support-bundle` 生成脱敏诊断包
  （`includesSecrets: false`）并写审计。
- 舰队状态机契约：`contracts/state-machines/fleet.yaml` 冻结升级环与
  installed/replayed/upgraded/rolled_back 迁移关系。
- OTel 资源属性：`/metrics` 输出 `ewoh_resource_info`，携带工厂 ID、名称、
  升级环、发布版本与区域；环境契约贯通 Standalone、Compose、Kubernetes 与
  Helm。
- 部署工件校验升级到 66 项，覆盖 Compose 资源属性环境契约；Helm Chart
  静态审计 125 项。
- 兼容目录：`GET /api/scale/compatibility` 返回资产包与核心版本兼容矩阵，
  支持 `>=/<=/>/</=` 与空格 AND 范围；未声明范围的资产标记
  `unconstrained` 兼容。
- 策略引擎：`contracts/policy/policy-schema.json` 定义策略契约；
  `POST /api/policies/evaluate` 按 dot-path 规则求值，`GET /api/policies/examples`
  提供规范示例；`scripts/audit-policy-contracts.js` 纳入一键检查。
- 模板配置差异预览：`POST /api/scale/templates/:id/diff-preview` 只读合并
  模板默认配置与请求覆盖配置，返回 `added/changed/removed` 键差异，便于
  第二工厂安装前评估影响。
- 连接器运行时：`src/edge_platform/connectors/runtime.py` 提供 Manifest
  加载/校验、配置校验、健康检查、密钥脱敏与生命周期；新增
  `exoskeleton-frame` 与 `equipment-state` 样例连接器包。
- 工厂上线：`GET /api/scale/onboarding/checklist` 提供 F0-F6 步骤清单，
  `POST /api/scale/onboarding/run` 真实执行模板发布、连接器/场景包安装、
  Profile 安装、TCK 与 Support Bundle，并输出步骤级证据与审计。
- Scale Release 评审：`scripts/scale-release-review.js` 作为打包门禁，检查
  发布清单、包完整性、契约/文档/OpenAPI 与全部静态审计；已接入
  `scripts/package-release.sh` 与 `npm run release:review`。
- Workflow 引擎骨架：`contracts/workflow/workflow-schema.json` 定义
  角色化步骤流转；`POST /api/workflows/advance` 返回当前动作许可与
  角色过滤后的下一步；`mes-execution` 规范流程示例纳入契约审计。
- Feature Flag：`GET/PUT /api/system/feature-flags` 在
  `ewoh_system_config` 持久化组织级 `feature.*` 开关，写入限定
  `global_admin`，读取按 RLS 组织隔离。
- 边缘乱序/补传：`src/edge_platform/edge/backfill.py` 提供 `SequenceBuffer`，
  按序列号连续释放帧并拒绝重复/过期/超窗帧；补传后自动续传。
- 数字孪生资产包：`src/edge_platform/twin/package.py` 提供 Twin Manifest
  校验、标定健康检查与脱敏；新增离散机加工线/装配单元样例资产包。
- 伙伴影子交付：`GET /api/scale/onboarding/partner/checklist` 与
  `POST /api/scale/onboarding/partner/shadow-run` 复用真实 F0-F6 上线路径，
  配置标记 `partnerShadow` 并输出步骤级证据。
- Deployment TCK：`scripts/deployment-tck.js` 将部署工件（66项）、Helm Chart
  （125项）与 Scale Release 评审（24项）串成统一部署验收门禁；
  `npm run deployment:tck` 一键执行。
- 规模化运营前端：新增 `/scale` 页面，展示模板/Profile/资产/兼容目录，
  并支持从页面执行 F0-F6 工厂上线运行。
- ERP/MES 连接器 Profile：新增 `erp-mes-profile-1.0.0` Manifest，配置使用
  `secretName` 引用而非内嵌凭证，并纳入 Connector Runtime 测试集。
- 规模化指标：`GET /api/scale/metrics` 输出模板/Profile/资产/场景/连接器/
  映射计数、发布率、升级环分布与兼容性汇总。
- 场景包卸载：`POST /api/scale/scenario-packs/:id/uninstall` 将场景包置为
  `uninstalled` 并写审计，补齐安装/演示/验收/移除生命周期。
- 连接器 TCK：`scripts/connector-tck.py` 与 `make connector-tck` 执行 11 项
  Manifest/配置/健康/脱敏/乱序补传检查。
- 场景包 TCK：`scripts/scenario-tck.js` 与 `npm run scenario:tck` 将
  Golden Factory/策略/Workflow/Mapping/事件目录 5 个审计串成场景验收门禁。
- 第三工厂演练：E2E 从同一已发布模板仅凭配置安装第三个工厂 Profile，
  验证无代码分叉、配置持久化与组织隔离。
- 工厂差异回收：`POST/GET /api/scale/differences` 将工厂差异登记为
  `diff.*` 配置项并写审计，支持后续平台化回收。
- 差异解决：`POST /api/scale/differences/:key/resolve` 将已回收差异标记为
  `resolved` 并写审计。
- 跨租户 TCK：`scripts/cross-tenant-tck.sh`、`make cross-tenant-tck` 与
  `npm run cross-tenant:tck` 把 HTTP+PostgreSQL 组织隔离 E2E 串成门禁。
- 工厂差异界面：`/scale` 页面新增差异登记表单、状态徽标与逐行解决操作，
  接入真实差异 API。
- Workflow 实例：`POST/GET /api/workflows/instances` 与
  `POST /api/workflows/instances/:key/advance` 将实例持久化到
  `workflow.*` 配置键，角色门禁推进并写审计。
- Support Bundle 界面：`/scale` 页面一键生成脱敏诊断包并展示
  bundleId/工厂数/敏感信息状态。
- Fleet 升级环界面：`/scale` 页面展示环分布，并支持按环升级/回滚操作。
- Workflow 实例界面：`/scale` 页面支持启动、列表与角色推进 Workflow 实例。
- 场景包界面：`/scale` 资产表支持场景包安装/卸载操作。
- 运营能力包：新增 `/api/operations/*`（17 条路由）覆盖维保资产/任务/工装
  生命周期、工作中心能力开关、标准工时与人员效率，记录复用
  `ewoh_scheduler_config` 并保持 RLS 组织隔离与审计链。
- 维保闭环：资产 `active/maintenance_required/decommissioned`、任务
  `planned/in_progress/completed/cancelled`，任务完成自动刷新资产下次维保
  日期并记录结果/备件/历史。
- 工装校验：校准周期、上次/下次校准时间与校准历史，支持校准/报废操作。
- 工作中心配置：首检、投料、报工审核、交收、扫码、外骨骼、风险确认与
  工装点检八类功能开关按工作中心持久化。
- 标准工时与人员效率：按工作中心/工序登记标准分钟，实际报工自动计算
  偏差、效率与人员公平性标准差。
- 运营管理前端：新增 `/operations` 页面，包含总览、维保资产、维保任务、
  工装校验、工作中心、标准工时与人员效率七个视图并接入真实 API。
- Sparkplug B 连接器：`src/edge_platform/connectors/sparkplug.py` 提供
  `spBv1.0` 主题解析、纯标准库 protobuf 载荷解码、出生/死亡/会话/序号状态
  与统一遥测帧适配器；新增 `sparkplug-b-1.0.0` Manifest 并纳入连接器 TCK。
- 连接器 TCK 升级：`scripts/connector-tck.py` 由 11 项扩展到 17 项，覆盖
  Sparkplug 主题、载荷、规范帧与会话状态检查。
- OpenFeature 语义功能开关：`POST /api/system/feature-flags/evaluate` 支持
  按组织/工厂/升级环/角色进行定位评估，默认安全关闭并返回
  `reason/variant/targetingApplied` 评估原因。
- 系统管理页新增功能开关评估器：输入开关键、升级环、工厂 ID 与角色即可
  查看当前上下文下的开启状态与评估原因。
- 参数注册中心：新增 `/api/parameters/*`（8 条路由）支持
  `number/integer/string/boolean/json` 类型参数、范围/来源/有效期、
  数值/枚举/正则校验、审批门禁、版本历史与回滚，记录复用
  `ewoh_scheduler_config` 并保持 RLS 组织隔离与审计链。
- 系统管理页新增参数注册中心 UI：登记表单、行内更新、
  审批/回滚/停用操作与汇总统计均接入真实 API。
- AAS/IEC 63278 资产壳：新增 `src/edge_platform/aas/codec.py`，纯标准库实现
  AAS 3.0 JSON 子集解析/导出、AASX 类似 OPC 包导入导出、孪生子模型双向映射
  与敏感值脱敏；提供离散机加工线 AAS 示例。
- AAS TCK：`scripts/aas-tck.py` 与 `make aas-tck` 执行 7 项检查，覆盖
  样例解析、JSON 往返、孪生映射、AASX 往返与脱敏。
- OPA 风格策略即代码：新增 `src/edge_platform/policy/rego.py`，纯标准库实现
  Rego 子集解释器（package/default/allow/deny[msg]、input 路径、比较、
  `in`/`not` 与消息捕获），并新增 `contracts/policy/deploy-gate.rego`
  部署门禁策略。
- Rego 部署门禁接入：`make rego-tck`（4 项检查）、`scripts/deployment-tck.js`
  扩展为 4 道门禁，`scripts/standalone-check.sh` 纳入 Rego TCK。
- AAS 资产注册 API：新增 `/api/aas/assets`（4 条路由）支持 AAS 资产导入、
  列表、详情与孪生语义映射，记录复用 `ewoh_scheduler_config` 并保持
  RLS 组织隔离与审计链。
- 数据资产页新增 AAS 资产壳视图：JSON 导入表单、资产清单与语义映射查看器
  均接入真实 API。
- OPC UA 连接器：`src/edge_platform/connectors/opcua.py` 提供节点 ID 解析、
  数据点规范化、质量码映射与边缘适配器；新增 `opcua-generic-1.0.0`
  Manifest 并纳入连接器 TCK（21 项检查）。
- Modbus TCP 连接器：`src/edge_platform/connectors/modbus.py` 提供寄存器
  地址/功能码/缩放校验、规范化遥测帧与边缘适配器；新增
  `modbus-tcp-generic-1.0.0` Manifest 并纳入连接器 TCK（25 项检查）。
- HTTP/Webhook 连接器：`src/edge_platform/connectors/webhook.py` 提供载荷
  规范化、常量时间 HMAC 签名校验与边缘适配器；新增
  `http-webhook-generic-1.0.0` Manifest 并纳入连接器 TCK（29 项检查）。
- CSV/File 连接器：`src/edge_platform/connectors/csvfile.py` 提供表头映射、
  行数据规范化与批量入队适配器；新增 `csv-file-generic-1.0.0` Manifest
  并纳入连接器 TCK（32 项检查）。
- OTel 风格请求追踪：`TracingInterceptor` 为每个 HTTP 请求生成
  `traceId/spanId` 并返回 `x-trace-id` 响应头；`TracingService` 维护有界
  追踪缓冲，`GET /api/observability/traces` 提供只读查询。
- Support Bundle 追踪：`POST /api/scale/fleet/support-bundle` 携带最近 20 条
  脱敏请求追踪与 `traceCount`，诊断包可直接用于伙伴/支持排查。
- 系统管理页新增请求追踪视图：展示最近 50 条 trace 的方法、路径、状态、
  耗时、开始时间与错误信息，并按运营刷新周期自动更新。
- RC2 发布包重新构建：`scripts/package-release.sh` 重新生成
  `release/ewoh-0.6.0-rc2`（1315 文件）与 `SHA256SUMS.txt`，Scale Release
  Review 24/24 通过。
- 最终门禁扫描：逻辑备份/恢复、场景 TCK、部署 TCK、AAS TCK、Rego TCK、
  连接器 TCK 与跨租户 E2E 全部通过，作为本轮交付证据。
- Pilot 就绪检查：`scripts/pilot-readiness-check.sh` 与 `make pilot-readiness`
  提供可执行 Go/No-Go 门禁，明确列出容器工具、数据库、试点工厂、生产批准、
  培训、验收签署与真机配置等未决阻塞项。
- RC2 发布包再次更新：将 Pilot 就绪门禁与最新证据纳入
  `release/ewoh-0.6.0-rc2`（1316 文件），校验和重新生成。

### Changed
- `ewoh_telemetry.assist_level` 由 `varchar(50)` 改为 `real`，与规范数值口径一致。
- 边缘桥接脚本与建模采集脚本支持 `--org-id` 并透传 `X-Org-Id`。
- 组织层级解析改为 `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` 函数，鉴权阶段不再回退到主组织。

### Fixed
- 真机帧因扁平字段不匹配而 400 的问题。
- 公共 Ingestion 端点缺少租户上下文导致 RLS 写入失败的问题。
- 安全探针固定夹具 UUID 与种子组织冲突，清理时误删“集团A”等种子行的问题；
  探针夹具已改为随机 UUID。

### Security
- Ingestion 缺少 `X-Org-Id` 且未配置 `EWOH_INGEST_ORG_ID` 时拒绝请求。
- OpenAPI 为全部 7 条 Ingestion 路由增加 `X-Org-Id` 必填参数契约。
- 运行时角色通过 `SECURITY DEFINER` 查询组织层级，业务表 RLS 不被绕过。

## [0.6.0-rc1] - 2026-08-03

### Added
- 六类共享契约冻结：C1 数据、C2 API（106 条路由全量 OpenAPI）、C3 状态机、
  C4 安全、C5 UI、C6 DevOps，G2 门禁通过。
- 真实 HTTP + PostgreSQL E2E：11 条用例覆盖认证、RBAC、刷新令牌轮换/撤销、
  组织 A/B 隔离、控制/世界/审批持久化与系统配置组织隔离。
- 审批持久化：审批实例/步骤/操作映射到 `ewoh_event`、`ewoh_event_chain`、
  `ewoh_audit_log`，不新增物理表。
- 浏览器级 UI 回归：Playwright 覆盖登录、指挥中心、指挥地图、设备、告警。
- 发布准备：`scripts/standalone-check.sh` 一键检查、性能冒烟、
  `docs/delivery/release-manifest.yaml`。

### Changed
- RolesGuard 默认拒绝未声明角色的业务路由；refresh token 轮换与登出撤销。
- 系统配置唯一索引调整为 `(org_id, config_key)`；模拟器后台写库纳入 GUC 事务。
- 指挥地图回放改为真实快照投影；3D 模式按 mode 着色并支持 WebGL 降级。

### Fixed
- `QueryClientProvider` 缺失导致指挥地图/设备页白屏。
- `/api/world/replay` 时间参数序列化导致 500。
- 数据库 verify SQL 的 `policy_missing` 标量子查询缺陷。

### Security
- 刷新令牌不再可无限重放；登出会撤销服务端会话。
- 审计接口限制为安全/全局管理员；客户端登出同步调用服务端撤销。
- Python 静态安全扫描归零：bandit `-ll` 0 medium/high，ruff 0 错误。
- GitHub Actions 三工作流全绿：standalone/test/security，含 Docker 镜像构建。

## [Unreleased]

本次版本将现有单机演示原型升级为受控试点系统（spec 阶段 0 Task 2：建立工程基线）。

### Added
- 工程基线：新增 `pyproject.toml`、`requirements-dev.txt`、`.env.example`、`Makefile`，
  声明纯标准库零运行时依赖，统一 unittest 测试发现与 ruff/bandit 静态检查入口。
- 适配器标准化：定义统一适配层契约（`edge/protocol`、`edge/adapter`），支持
  `real` / `controlled_test` / `simulated` 三类数据源的可配置端口映射
  （`EWOH_ADAPTER_PORTS`），为真机接入与受控测试提供一致接口。
- 生产数据库：引入 `postgres` 作为可选生产后端（`EWOH_DB_BACKEND=postgres`），
  保留 SQLite 用于开发/单机；DB 仅接入内部网络，不直接对普通用户网开放。
- API 完善：补齐 OpenAPI 3.0 规范（`docs/api/openapi.yaml`），覆盖
  auth/me/devices/telemetry/events/tasks/query/audit/models/rules/scenario/reset 全部端点。
- 身份权限：引入认证后端选择（customer/oidc/local）、JWT 会话、角色化导出权限
  （`EWOH_EXPORT_ALLOWED_ROLES`）、登录失败锁定与会话超时。
- 审计：所有写操作与导出动作落入审计日志，可在 `GET /api/audit` 查询。
- 监控：定义系统/设备/推理/业务四级监控指标与告警处理流程（见 `docs/operations/`）。
- 备份恢复：定义数据库与证据数据的备份策略、保留窗口与恢复流程占位。
- 测试与故障注入：定义 13 层测试层级与 16 类故障注入清单（见 `docs/acceptance/`）。
- 现场试点分阶段：定义四区部署拓扑（`docs/deployment/`）与分阶段上线策略。
- Go/No-Go 门禁：定义 15 条上线门禁清单作为试点放行依据。
- CI/CD：新增 GitHub Actions（test/security/package）与 CODEOWNERS 安全边界审查。
- 安全策略：新增 `SECURITY.md`，明确平台安全边界声明与漏洞报告流程。
- 服务编排：新增 `docker-compose.yml`，定义 edge-gateway / ewoh-api / ewoh-adapter /
  ewoh-inference / postgres / redis / ewoh-logs 服务与内外网络隔离。

### Changed
- 项目版本由演示原型基线提升至 `0.6.0`，描述更新为「EWOH 受控试点系统」。
- 运行入口 `python -m edge_platform.run` 保持不变，新增 `--stub` 显式回退开关的工程化说明。

### Security
- 明确平台不得写入急停 / 限扭 / 关节实时控制 / 助力实时闭环 / 限速放宽 /
  异常退出保护 / 设备失联安全态 / 绕过本地安全检查的调试指令，这些保留在设备控制器。
- 默认不采集姓名 / 身份证 / 长期精确轨迹 / 视频 / 生理数据。
- 高频原始遥测保留 7-30 天，超期降采样或清除。
- 默认不开放公网，TLS 由 edge-gateway 终结。
