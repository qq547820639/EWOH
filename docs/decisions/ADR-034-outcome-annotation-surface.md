# ADR-034：Outcome 标注面（Decision→Outcome 结构化事实，学习回路模型腿前置）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-021（学习回路 v1）、ADR-026（反馈腿 v2）、§10 Level 7、§12、§33

## 背景

学习回路模型腿（模型重训/激活闭环）的前置是 **outcome 标注面**：决策/
方案执行后需要结构化"实际结果如何"的事实（谁判定、结果类别、可测度量），
模型精度才有可计算的真值。现状：LearningEvaluation.modelAccuracy 恒为
null（显式 unknown——台账无 outcome 标注，§10 绝不伪造）。

本 ADR 交付标注面本身；**不假装模型重训存在**——仓库无真实可训练
统计模型（边缘为规则/启发式、云端为规则引擎 + LLM 文本），模型重训/
激活闭环随真实模型落地后立项（§33 不造假）。

## 决策

### 决策 1：OutcomeAnnotation 一等契约（canonical）

`contracts/learning/outcome-annotation.schema.json`：
- 字段：annotationId、targetType ∈ {plan, decision, proposal,
  agent_command}、targetId（非空规范身份或业务键）、outcomeKind ∈
  {success, partial_success, failure, invalid}、judgedBy（人工判定者）、
  judgedAt（ISO）、measured?（可测度量快照：delayMs / deviation /
  acceptance 等数值键，缺省=该标注不携带度量——显式缺省不猜测）、
  comment?、auditTrail；
- 机器规则：targetId 非空；measured 值必须有限数值；judgedBy 非空
  （判定事实完整，§33）；auditTrail 必须 true。

### 决策 2：持久化 standalone_047 ewoh_outcome_annotation（TENANT_SCOPED）

唯一 (org_id, annotation_id)（同标注幂等）；CHECK outcome_kind/
target_type；RLS outcome_annotation_org_isolation；他租户标注绝不可见。

### 决策 3：云侧 OutcomeAnnotationService（唯一权威写路径）

create（契约 fail-closed + annotationId 幂等回读）/ listByTarget /
listRecent（org 作用域）；事件 OutcomeAnnotationRecorded（63→64）。

### 决策 4：与学习指标的关系显式

modelAccuracy 保持 null（显式 unknown）直至：真实可训练模型存在 +
标注样本量达到最小门槛（ADR 后续定义）；标注面此刻起为模型腿提供
**可计算的样本事实**（§10 真值来源）。

## 后果

- 正：Decision→Outcome 结构化事实层落地——学习回路模型腿前置补全；
  标注可审计（judgedBy/judgedAt/auditTrail）；为 §10 modelAccuracy
  提供真实可计算路径。
- 负/边界：模型重训/激活闭环仍未实现（需真实模型，§33 不造假）；
  measured 度量键为开放数值键（v1 不封闭注册，随使用收敛）。
