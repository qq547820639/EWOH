# ADR-041：邮件推送渠道（标准库 SMTP 客户端，andon-loop 收口）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-037（推送渠道派发器）、ADR-040（边缘安灯上行）、
  §17（操作台）、§20（可靠性）、§33（禁止行为）

## 背景

andon-loop 剩余唯一缺口 = 邮件推送渠道（飞书 webhook 已闭环 R-58，
边缘上行已闭环 R-61）。ewoh_notification 已备 channel 列与 sentAt/
errorMessage 投递状态；需为 channel='email' 提供真实投递实现
（§33 只注册有真实投递的渠道）。

## 决策

### 决策 1：标准库最小 SMTP 客户端（无新依赖）

`notification/email-transport.ts`：RFC 5321 子集（EHLO / AUTH LOGIN /
MAIL FROM / RCPT TO / DATA+dot-stuffing / QUIT；多行回复解析；10s
超时）。传输形态 v1（显式边界，ADR 记录）：
- 无凭据 = 明文连接（内网中继合法场景）；
- 带凭据 = 必须 `EWOH_SMTP_SECURE=1` 隐式 TLS（465 常用）——
  非 TLS + 凭据 → 显式 `smtp_auth_requires_tls`（绝不明文传凭据）；
- STARTTLS 升级为后续演进（通道升级随渠道注册表演进）。

### 决策 2：渠道启用判定 = 配置完整性（fail-closed）

`isEmailPushEnabled()` = host/from/to 任一缺失或 port 非法 → false
（不建 doomed 行）；派发器渠道注册表扩为 `PUSH_CHANNELS=
['lark','email']`，领取条件 `inArray(channel, enabledChannels)`
（按渠道启用集动态收敛）；逐行按 channel 分派（lark webhook /
email SMTP），单行失败独立（既有 CAS 语义不变）。

### 决策 3：通知创建共享助手扩展 email

`insertAndonNotifications`（oee + ingest 共用，§31）在 app/lark 之外
增加 email 行（配置时建）——开灯与 SLA 升级三渠道同语义。

### 决策 4：配置面 + 客户端渠道标签

env 7 键（EWOH_SMTP_HOST/PORT/SECURE/USER/PASS/FROM/TO，全部
deploy/.env.example 文档化 + env-inventory 双向校验）；通知中心
推送状态面渠道标签 += 邮件（封闭注册表，未知渠道原样透出）。

## 后果

- 正：andon-loop 三腿齐备（状态机 + 飞书推送 + 邮件推送 + 边缘上行
  + canonical 投影）——按 §36 升 Implemented（矩阵 47/8/0/1→48/7/0/1）。
- 负：SMTP 客户端为最小实现（STARTTLS/多行 DATA 边界显式）；真实
  SMTP 服务器投递待部署环境实证（协议层 spec 以注入连接器锁定序）。
- 无破坏性变更：lark 路径逐字段不变（回归 spec 锁定）。
