# ADR-030：Agent 审批交互面 —— 待批清单 / 通知闭环 / 角色配置化

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-016（Agent Runtime）、NO-06c/06d（审批桥接 + 超时语义）、§2、§17、§33

## 背景

NO-06c 已落地审批桥接（Agent L1/L2/L3 写命令 → 正式审批实例 → 批准/
驳回闭环）与 Policy TCK；NO-06d 已落地审批超时语义（24h TTL 超期解析为
拒绝留痕）。但交互面仍缺三块：

1. **待批清单**：审批实例（调度侧 event 持久化、Agent 侧内存桥接）没有
   查询面——值班长无法知道"现在有谁在等我批准"（§17 操作台必须回答
   "是否批准？"）；
2. **通知闭环**：审批创建只停留在内存/事件表，无 in-app 通知
   （ewoh_notification 表有写入（OEE 安灯）却无查询端点——通知只有写没有读）；
3. **审批角色硬编码**：roles=['workshop_lead'] 写死在 agent.service。

## 决策

### 决策 1：统一待批清单（调度审批 + Agent 审批双查询面）

- `GET /api/approvals/pending`：调度侧审批（ApprovalPersistenceService
  持久化在 ewoh_event(eventType=approval_instance, status=pending)）按
  租户列出（org_id 过滤 + 最近创建优先）；
- `GET /api/agents/approvals`：Agent 命令审批待批清单（ApprovalService
  内存实例 + pendingCommands 载荷），逐条计算 `expired`（24h TTL，与
  NO-06d 同常量）与剩余时间——**过期是显式状态**，绝不从清单里静默消失
  （§33：未知/过期当 pending 隐藏 = 违规）。

### 决策 2：通知闭环 = ewoh_notification 读写闭环

- Agent 审批创建时插入 ewoh_notification（recipient_type=role、
  recipient_id=审批角色、channel=app、severity=high、externalRef=
  approvalId）——通知指向真实审批实例（可追溯，§3）；
- 新增 `GET /api/notifications`（租户 + 角色作用域：recipient_type=role
  且 recipient_id ∈ 调用者角色集合，状态过滤）+ `POST /api/notifications/
  :id/read`（标记已读，租户作用域乐观更新）——通知首次获得读面；
- ewoh_notification 的 drizzle 映射补齐 org_id 列（既有 SQL 表有
  org_id NOT NULL DEFAULT GUC，drizzle 侧补映射以便租户过滤，写入仍由
  DB 默认填充——不改变写入路径）。

### 决策 3：审批角色配置化（部署默认 + 租户内不变）

`EWOH_AGENT_APPROVAL_ROLES`（逗号分隔，默认 workshop_lead）：Agent
审批实例的 roles 与通知 recipient 由此派生（部署级默认；租户级角色
配置随 §34 问题驱动后议——不为无消费方的问题造配置系统）。

### 决策 4：Agent 待批清单的持久化边界显式

Agent pendingCommands 为进程内存（与 ApprovalService 一致）；进程重启
后清单清空、审批实例失效——本 ADR 显式记录该边界，与审批实例持久化
统一为后续轮次（需 pendingCommands 落库 + 幂等重建，不在本轮无
消费方证据前提前造表）。

## 后果

- 正：待批清单 + 通知读写闭环 + 角色配置化——人工审批交互面具备服务端
  完整查询能力；通知 severity 词表随 ADR-027 收敛（OEE 安灯通知
  'L2'→'high' 一并修复）。
- 负/边界：Agent 审批清单不跨重启（决策 4）；通知无推送通道（channel=app
  in-app 查询面，飞书/邮件推送随问题驱动）。
