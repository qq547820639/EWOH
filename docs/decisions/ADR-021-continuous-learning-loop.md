# ADR-021：Continuous Learning Loop v1（Decision→Outcome 回流评估）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-013/014/019/020（智能分层与台账）/ ADR-004（调度反馈）/
  ADR-009（Envelope）/ Phase 12（Continuous Learning）
- 驱动：NO-09a（Round 41，Phase 12 目标：Decision → Outcome 映射与学习回路）

## 背景

§28 Phase 12 要求持续计算 Recommendation Acceptance / Plan Success Rate /
Task Delay / Risk Outcome / Human Override Rate / Model Accuracy /
Scheduler Quality 并形成真实 Learning Loop。现状：
- 事实输入已齐备：调度反馈表（standalone_010：accepted/override_count/
  planned-vs-actual）、A2→A3 建议-方案链（ewoh_ai_suggestion.plan_content）、
  KpiService（Delivery/Stability/Solver 聚合，ewoh_scheduling_kpi 幂等持久化）、
  事件表（severity/status）、推理台账（standalone_040，Round 39/40）；
- 但无**跨域学习评估层**：七项指标没有统一快照/持久化/事件，Decision→
  Outcome 映射不成体系；capability-matrix `continuous-learning` 因此 Partial。

## 决策

### 决策 1：学习评估 = 每 (org, 周期) 的七项指标快照（新契约）

`contracts/learning/learning-evaluation.schema.json`（v1.0.0，meta-contract
同风格）：
- **metricRegistry（七项封闭注册表，§28 一一对应）**：
  recommendationAcceptanceRate / planSuccessRate / taskDelayP95Ms /
  riskOutcomeRate / humanOverrideRate / modelAccuracy / schedulerQualityRate；
- **evaluationTypeRegistry**：periodic / on_demand；
- **指标语义（机器规则）**：metrics 必须覆盖全部七键；每值 number|null；
  null 仅两种合法语义——无数据（窗口内零事实）或显式 unknown（如
  modelAccuracy：推理台账尚无 outcome 标注，v1 恒定 null，§10 unknown 是
  合法结果，绝不伪造）；周期语义 periodEnd ≥ periodStart；basis 非空
  （事实来源声明，§3 可追溯）；auditTrail 必须 true。
- Python/TS 双实现 + 共享向量 + audit-domain-contracts learning 域 +
  Golden 第 16 场景（同既有契约域纪律，§31）。

### 决策 2：七项指标的 v1 事实来源（真实事实，null 不伪造）

| 指标 | 事实来源 | 无数据语义 |
|---|---|---|
| recommendationAcceptanceRate | ewoh_ai_suggestion：窗口内 plan_content 非空行数 / 总行数（A2 建议 → A3 方案 = 接受） | null |
| planSuccessRate | KpiService delivery.completionRate（复用真实聚合） | null |
| taskDelayP95Ms | KpiService delivery.latenessP95Ms（复用） | null |
| riskOutcomeRate | ewoh_event：窗口内 severity∈{L1,L2} 且 status∉{open} 行数 / L1-L2 总行数 | null |
| humanOverrideRate | ewoh_scheduling_feedback：sum(override_count) / 窗口内行数 | null |
| modelAccuracy | **v1 恒 null（显式 unknown）**——推理台账尚无 outcome 标注；待 L7 二期引入结果标注面 | null（unknown） |
| schedulerQualityRate | KpiService solver.heuristicFallbackRate（求解质量代理，复用） | null |

### 决策 3：持久化 = standalone_041 `ewoh_learning_evaluation`

TENANT_SCOPED RLS（learning_evaluation_org_isolation，GUC idiom）+ CHECK
（evaluation_type ∈ 注册表 / period_end ≥ period_start）+ UNIQUE
(org_id, eval_id)（evalId 由 (type, periodStart) 确定性推导
`le:{type}:{periodStart}`——同一周期幂等重评估不重复发事件）。
完整快照落 result_json（审计同源）；metrics/basis 落 jsonb 列
（Phase 12 趋势查询面）。**观测层定位**：与 standalone_010 同原则——学习
评估绝不自动回写生产调度规则/策略（v1 observational；任何策略变更走
人审 + 策略激活链，§2 安全边界）。

### 决策 4：事件 = LearningEvaluationRecorded（目录 55→56）

`com.ewoh.learning.evaluation_recorded`，channel
`learning.evaluation_recorded` + 双运行时投影。幂等重放不重复发事件
（与 035/039/040 同语义）。

### 决策 5：云侧 `learning` 模块 = 唯一权威评估入口

LearningService.evaluate(orgId, period)：真实事实聚合（KpiService 复用 +
直读建议/事件/反馈表）→ 契约校验 fail-closed → 幂等落账 → 事件；
list/latest 租户作用域；OpenAPI 3 路由。跨租户不可见（RLS 双保险）。

### 决策 6：学习回路闭环边界（v1 观察，v2 反馈）

v1 只形成"Decision→Outcome→评估快照→事件→可查询趋势"链路（Sense→
Understand 收敛）；把评估结论自动作用于策略/模型重训/调度参数属于
Phase 12 二期（需要 outcome 标注面 + 影子评估 + 人审激活阶梯——与 CP-SAT
激活阶梯同原则，绝不隐式自动执行）。

## 后果

- 正面：七项学习指标成为跨域统一快照（可审计/可重放/可趋势）；Phase 12
  Learning Loop 主体成形，continuous-learning 按 §36 升 Implemented
  （矩阵 39/16/0/1）；为二期（outcome 标注/影子评估/人审激活）铺设事实层。
- 代价：新契约 + 新表 + 新模块；评估调用产生台账行。
- 无破坏性变更（全 additive）。

## Rejected Alternatives（否决方案）

1. **直接把 KPI 表当学习评估**：scheduler KPI 是调度域聚合，学习评估是
   跨域七指标快照（含建议接受/风险结局/模型精度），语义与所有权不同。
2. **自动把评估结论回写策略**：违反 §2 人审边界与 010 观测原则；v1 显式
   观察层，反馈闭环二期 + 人审。
3. **modelAccuracy 用代理值填充**：伪造事实（§33）；null/unknown 显式
   声明（§10）。
4. **评估不入契约**：七项指标语义（名称/空值语义/周期规则）若不进契约，
   跨运行时与 UI 将各自解释——违反 §3/§30。
