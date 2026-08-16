# ADR-039：Agent 审批跨重启持久化（standalone_049，ADR-030 决策 4 收口）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-016（Agent Runtime）、ADR-017（AgentTask 编排）、
  ADR-030（审批交互面，决策 4 已知边界）、§11（Agent 架构）、§20（可靠性）

## 背景

ADR-030 决策 4 显式记录了一个已知边界：Agent 待批命令（pendingCommands）
与审批实例（ApprovalService.instances）均为进程内存——进程重启后待批
清单清空、审批实例失效（客户端批准/驳回 → approval_not_found）。
这违反 §20（可靠性）与 §11（Agent 审计链不可丢失）：人工审批是
§2 六步链的关键门，门的待决状态不应随进程重启消失。

## 决策

### 决策 1：ewoh_agent_approval 台账 = 待批事实唯一权威源

standalone_049 新建 TENANT_SCOPED 台账（org_id NOT NULL + RLS
agent_approval_org_isolation + UNIQUE (org_id, approval_id) +
status ∈ {pending,approved,rejected,expired} CHECK + pending ⇔
resolved_at IS NULL CHECK + roles_json 数组 CHECK）：

- propose：INSERT pending 行（agentId/command/payload 快照/
  roles 快照）——通知与决策事件不变；
- resolve：台账行读（跨重启可见）→ TTL 判定（>24h → expired +
  拒绝留痕）→ 批准走 executeAuthorized（budget/timeout/fallback
  仍强制）→ CAS 写终态（WHERE status='pending' RETURNING；
  未命中 = 已解析，显式 approval_already_resolved，§20 幂等）；
- listPendingApprovals：台账 org 作用域读，过期显式标记（§33）。

### 决策 2：移除内存双轨（§31 无重复事实源）

AgentService 删除 pendingCommands Map 与 ApprovalService 依赖
（approvalId 直接 UUID 生成）；AgentModule 移除 ApprovalModule
import——审批状态机实例不再复制待批事实，台账是唯一来源
（scheduler 审批仍走 approval-persistence 事件链，两域互不干扰）。

### 决策 3：verify 自证（4 拒绝 + 控制组）

非法 status / approved 无 resolved_at / roles_json 非数组 /
重复 (org_id, approval_id) 必须被 DB 拒绝；合法 pending 行可写
（随后删除）。

## 后果

- 正：人工审批门跨重启持久（§20）；agent-policy-approval 已知边界
  消除（ADR-030 决策 4 收口）；审批决议（resolved_at/resolved_by/
  resolution_json）成为可审计事实。
- 负：新增受管表（72→73）；propose/resolve 各多一次 DB 往返
  （台账 CAS 语义，量级可忽略）。
- 无破坏性变更：响应形状（approvalId/agentId/command/payload/
  roles/createdAt/expiresAtMs/remainingMs/expired）与客户端逐字段
  一致；旧内存态随重启自然失效（无迁移数据需回放——进程内未决议
  审批在重启时本来就会丢失，本 ADR 从源头消除该窗口）。
