# ADR-037：Andon 通知推送渠道（飞书 webhook，R-58）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-030（in-app 通知闭环）、ADR-031（Andon 状态机与 AndonRaised）、
  §15（多租户）、§17（操作台）、§20（可靠性）、§33（禁止行为）

## 背景

Andon 处置闭环（ADR-031）在开灯/SLA 升级时只产生 in-app 通知
（channel=app），现场人员离开应用即失联——andon-loop 缺口
「通知推送渠道（飞书/邮件未实现）」。ewoh_notification 表自
ADR-030 起已备 channel/scheduledAt/sentAt/errorMessage 列，
推送腿从未接线。另发现既有通知插入缺 orgId（§15 缺陷：租户
作用域查询按 orgId 过滤，缺 orgId 的通知是永远不可见的孤儿行）。

## 决策

### 决策 1：飞书自定义机器人 webhook 为第一真实渠道（无 SDK/无新依赖）

`channel-dispatcher.service`：封闭注册表 PUSH_CHANNELS=['lark']——
只注册有真实投递实现的渠道（§33/§36：邮件 SMTP 未实现不入表）。
投递 = 纯 HTTPS POST（fetch + 5s 超时 + 非 2xx 显式抛错），
`EWOH_LARK_WEBHOOK_URL` 未配置 = 渠道显式禁用（log + 不建
doomed 行），绝不静默假装投递。

### 决策 2：投递状态落在权威通知行（pending → sent/failed）

- 派发器每 `EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS`（默认 15s）
  领取 channel='lark' 且 status='pending' 且到 scheduledAt 的行
  （批量 ≤50），逐行投递后 CAS 写回（WHERE status='pending'
  RETURNING）——CAS 未命中 = 他实例已投递，跳过（§20 防重复投递）；
- 失败 → status='failed' + errorMessage（异常原因显式留痕，
  §33 不吞异常）；单行失败不影响其余行；
- 重试 = 人工端点 POST /api/notifications/:id/retry
  （dispatcher/workshop_lead/global_admin）：仅 failed 推送行
  可重置为 pending（app 通知/非 failed 显式拒绝）。自动退避重试
  列（attempts）留作后续（standalone_049 候选，需迁移）。

### 决策 3：开灯与 SLA 升级双触发点入通知（app 恒建 + lark 配置时建）

oee.openAndon 与 transitionAndon（SLA 升级）统一经
createAndonNotifications：app 行恒建（既有语义），lark 行仅当
webhook 已配置时建（不建 doomed 行）；**修复缺 orgId 缺陷**
（插入带 actor.primaryOrgId，§15 租户作用域；通知是派生事实，
externalRef 指向 Andon 事件主事实）。

### 决策 4：通知中心扩展推送状态面

客户端审批控制台通知中心新增「推送状态（飞书）」分组：渠道标签 +
待投递/已投递/投递失败（失败带 errorMessage）+ 重试按钮；纯逻辑
notificationChannelLabel/notificationState（未知渠道原样透出，
§33 不当作正常）。服务端 toNotification 增补 sentAt/errorMessage
（additive）。

### 决策 5：不新增契约/事件/迁移

推送是投递运行时关切，事实层仍为 ewoh_notification（已备列）+
AndonRaised 事件；无 Python 双实现 → 无跨语言 test-vectors
（§31 无重复语义）。webhook 为平台级配置（租户级 webhook
配置为后续增强，随渠道注册表演进）。

## 后果

- 正：安灯开灯/SLA 升级可直达飞书群（真实投递链路 + 失败显式 +
  人工重试）；§15 通知租户作用域缺陷修复（孤儿行消除）；
  andon-loop 缺口收窄为「邮件渠道 + 边缘 AndonRaised 上行」。
- 负：新增 15s 派发 tick（无待发行时零外呼）；webhook 平台级
  单地址（多租户共址为已知边界）。
- 边界：推送仅信息面（§2 无执行语义）；飞书 webhook 失败只影响
  通知投递，绝不回写 Andon 主事实状态。
