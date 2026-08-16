# ADR-046：邮件渠道 STARTTLS 升级（email-transport 渠道演进，NO-12w）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-041（邮件推送渠道 v1 边界）、§20（可靠性）、§33（禁止行为）

## 背景

ADR-041 的 SMTP 客户端 v1 传输形态显式记录边界：带凭据必须
`EWOH_SMTP_SECURE=1` 隐式 TLS（465），未实现 STARTTLS 升级——
587 端口（STARTTLS 主流）的凭据投递不可用。NO-12w 完成渠道演进。

## 决策

### 决策 1：机会式 STARTTLS（RFC 3207 子集）

- `SmtpConnection` 增补 `startTls()`（tlsActive 可变）；
- 会话流程：EHLO →（凭据 + 明文）STARTTLS（期望 220）→ TLS 升级
  （`tls.connect({ socket, servername })`，secureConnect 等待，10s
  超时）→ 重新 EHLO → AUTH LOGIN；
- 服务器不支持（502）→ 显式 `smtp_auth_requires_tls`（与 v1 错误码
  一致，客户端重试语义不变）；升级失败（超时/握手错误）→
  `smtp_starttls_failed:<reason>` 显式；
- 无凭据明文投递不发起 STARTTLS（内网中继路径不变）。

### 决策 2：凭据安全不变式保持

AUTH 仅在 TLS 保护（隐式或升级）后发送；任何路径下明文传凭据都被
显式拒绝——v1 的 fail-closed 不变式延续（§33）。

### 决策 3：配置面 additive（无新 env 键）

`EWOH_SMTP_SECURE=1` 语义保留（隐式 TLS 直连）；默认（空）升级为
「明文 + 机会式 STARTTLS」。无新环境变量、env-inventory 双向校验不变。

## 后果

- 正：587 端口凭据投递可用（STARTTLS 主流形态）；错误码兼容
  （smtp_auth_requires_tls 不变）；协议层 spec 锁定 STARTTLS 序
  （EHLO→STARTTLS→EHLO→AUTH）。
- 负：连接器复杂度增加（socket 升级管理；upgrade 后重新 attach
  数据/错误处理器）。
- 边界：STARTTLS 升级的真实服务器互操作待部署环境实证（协议序以
  注入连接器锁定，与 v1 同边界）。
