# ADR-065：Decision History 跨 kind 检索端点（NO-13p）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-048/057/059..064（kind #1-#8 写路径全收敛）、§12/§15/§18/§33

## 背景

Decision Catalog 8 类 kind 写路径已全部收敛（R-85 收口），但读面
分散：decision_records_json（ewoh_schedule_plan，kind 1/2/4/5/6）、
decision_json（ewoh_agent_approval kind 3 / ewoh_learning_proposal
kind 7 / ewoh_scheduling_policy kind 8）。§12 Decision History 与
§18 可解释性需要统一检索面：跨 kind 聚合查询 API（只读）。

## §29 十八问（实现前作答）

1. **Domain**：Decision History 检索（§12/§18 消费面）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （§31 单一实现——读面复用同一校验器，非法记录显式计数）。
3. **Authoritative Source**：四张表内的既有决策列（写路径唯一权威
   源，本端点零写入——不新建事实源，§3）。
4. **如何改变 Factory World**：零改变——只读聚合查询。
5. **Event**：无。
6. **谁消费**：审计/可解释性 UI（决策历史面板后续接入）。
7. **失败会怎样**：非法记录（validateDecision 失败）→ 显式
   skippedInvalid 计数跳过（§33 绝不静默丢弃/伪装）；未知
   kind/status 过滤器 → 400 显式拒绝（fail-closed）。
8. **离线会怎样**：云侧读；无外部依赖。
9. **重复消息会怎样**：读取幂等（同参数同结果；按 decidedAt 降序
   确定性排序，同时间戳按 decisionId 字典序稳定）。
10. **权限边界**：只读端点（dispatcher/workshop_lead 等既有角色
    可读；写权限不涉及）。
11. **租户边界**：orgId 取自请求 ctx（§15）——所有来源的记录按
    record.tenantId 过滤（plan 表无 org_id 列的显式边界——记录级
    租户过滤为唯一面）；org 作用域表（agent_approval/learning_
    proposal）同时按 org_id 列过滤（RLS + 应用双保险）；
    scheduling_policy org_id null（全局策略）不进入租户查询
    （显式边界，§33 不伪造租户）。
12. **安全风险**：无（只读；无 world 变更）。
13. **Human Approval**：不适用（只读）。
14. **如何解释 Decision**：返回契约形态完整记录（判定事实/证据
    链接原样透出，不做二次解释）。
15. **如何测试**：decision-history.service.spec（四表聚合 / 租户
    过滤 / kind+status 过滤 / 排序确定性 / 分页 cap / 非法记录显式
    计数 / 未知过滤器 400）。
16. **如何审计**：只读查询无审计写；记录本身携带 auditTrail。
17. **如何迁移**：无 DB 变更；OpenAPI +1 路径（gen-openapi 再生成
    client types + route-manifest 397→398）。
18. **如何回滚**：删除控制器方法 + yaml 路径即回滚。

## 决策

### 决策 1：GET /api/scheduler/decision-history（只读聚合）

Query：kind? / status? / limit?（缺省 50，cap 100）/ offset?。
响应：{ items: DecisionRecord[]（decidedAt 降序 + decisionId 字典
序稳定）, total, skippedInvalid, sources: { plans, agentApprovals,
learningProposals, policies } }——来源计数与非法跳过显式可审计。

### 决策 2：聚合四源 + 租户过滤显式边界

- ewoh_schedule_plan.decision_records_json（数组元素）——plan 表无
  org_id 列：按记录 tenantId 过滤为唯一面（显式边界）；
- ewoh_agent_approval / ewoh_learning_proposal：org_id = 当前 org
  且 decision_json.tenantId 一致（列过滤 + 记录过滤双保险）；
- ewoh_scheduling_policy：org_id = 当前 org 的行（全局策略 null 行
  不进入租户查询，显式边界）；
- 全部记录过 validateDecision（§31 单一校验器）：非法 → 显式
  skippedInvalid 计数（§33）。

### 决策 3：过滤器 fail-closed + 检索面板后续立项

kind/status 非封闭词表值 → 400（fail-closed 不猜测）；客户端决策
历史面板为后续 UI 轮次（端点先行，读面收口）。

## 后果

- 正：Decision History 统一读面（8 类 kind 跨四表聚合）；租户边界
  显式；非法记录显式计数（§33）；§12/§18 消费面收口。
- 负：无（只读 additive；OpenAPI +1 路径需再生成）。
- 无破坏性变更（无 DB/env 变更）。
