# ADR-040：边缘 AndonRaised 上行（andon-loop 边缘腿，R-61）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-031（Andon 状态机 + AndonRaised）、ADR-037（飞书推送）、
  ADR-033（边缘事实经事件骨干上行模式）、§3（Factory Truth）、§6（Phase 6）

## 背景

AndonRaised 此前只由云侧 OEE API 产出（开灯必须经过云端）；现场人员/
设备在边缘无法直接触发安灯——andon-loop 的边缘腿断裂（离线现场开灯
无路径）。边缘事件目录早已含 AndonRaised 类型、ingest 已能收任意目录
事件，缺的只是边缘生产面。

## 决策

### 决策 1：边缘一等开灯 API（POST /api/andon/raise）

`src/edge_platform/routes/andon.py`：deviceId 规范身份（device: 前缀）
fail-closed + title 必填 + severity 封闭词表（critical/high/medium/low，
缺省 high；未知词显式拒绝绝不静默改写）+ slaSeconds 正数校验
（缺省 900）→ AndonRaised Catalog 信封（source=edge:andon、
subject=deviceId、payload 含 level/assignee/slaSeconds/raisedAt）经
STREAM_EVENTS → EventUplink 上行（at-least-once + 离线断点续传）。
边缘不落本地安灯台账——云侧 ewoh_event 权威投影为唯一台账（§3
无第二事实源）。production 下需边缘认证（PUBLIC_POST_PATHS 仅
auth 端点，开灯是写操作）。

### 决策 2：云侧投影为 canonical andon evidence 形状

ingest 收到 edge 源 AndonRaised → ewoh_event 行投影为与 oee.openAndon
同形状：eventCode=ANDON、severity=normalizeEventSeverity(payload.level)、
title=payload.title、evidenceJson 含 andonId/deviceId/reason/slaSeconds/
slaMinutes/level/assignee/openedAt/escalationLevel=0/timeline[open] +
envelope 证据——listAndons/transitionAndon/SLA 升级对边缘开灯与云侧
开灯统一消费（单一事实层）。非 edge 源 AndonRaised 不投影（守卫边界）。

### 决策 3：通知闭环复用共享助手（§31）

开灯通知创建抽为 `insertAndonNotifications`（notification/andon-
notifications.ts：app 恒建 + lark 配置时建 + orgId 租户作用域）——
oee（云侧触发）与 ingest（边缘投影）共用同一语义；ingest 侧通知
失败显式留痕不阻断事件主事实。

### 决策 4：修复 exo POST 分发缺口（§30 边界）

registry ROUTE_TABLE 的 POST 列表此前未注册 handle_exo——Round 54
的绑定 API 从未经 HTTP 分发（直接 handler 测试掩盖）。本轮补注册
（+ dispatch 级回归测试锁定），并注册 handle_andon。

## 后果

- 正：安灯开灯可在边缘触发（离线队列兜底），云侧台账/状态机/SLA/
  推送全链复用既有闭环；andon-loop 缺口收窄为「邮件 SMTP 渠道」。
- 负：边缘新增一个写端点（认证保护 + 词表 fail-closed）。
- 无破坏性变更：ingest 非 edge 源路径逐字段不变（守卫边界 spec 锁定）。
