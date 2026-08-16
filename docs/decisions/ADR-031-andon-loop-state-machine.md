# ADR-031：Andon Loop 贯通 —— 状态机单一事实源 + 目录事件产出

- 状态：Accepted
- 日期：2026-08-16
- 关联：§6 Phase 6（Andon Loop）、ADR-009（事件目录）、ADR-027（词表）、§31

## 背景

Andon 闭环现状（matrix andon-loop Partial）：

- OEE 有处置面（open/acknowledge/process/close/reopen + SLA 升级通知），
  但状态转移是**手写 switch**（nextAndonStatus / nextAlertStatus 两份，
  alert 与 andon 各一份——§31 重复实现）；
- contracts/state-machines/alert.yaml 定义了权威状态机（含角色条件），
  但 TS 侧无消费、无门禁交叉核对（agent-task 已有同纪律先例）；
- 事件目录有 AndonRaised（andonId/level/slaMinutes），但**没有任何
  生产者**——Andon 开灯不产出目录事件（ADR-009 目录语义落空）。

## 决策

### 决策 1：alert.yaml 成为 alert/andon 处置状态机唯一事实源（TS 锁定表 + 门禁）

新增 `shared/alert-state-machine.ts`：转换表与 alert.yaml 逐条一致
（open→acknowledged→processing→closed；closed→reopened(safety_admin)；
reopened→acknowledged/processing）+ `alertStateTransitionAllowed(from, to,
actorRole?)`（reopen 必须 safety_admin——角色条件进入机器执行）；
alert.service 与 oee.service 的两份手写 switch 收敛为该模块（§31）；
`scripts/audit-domain-contracts.js` 新增
`alert_state_machine_ts_vs_yaml` 门禁（解析 alert.yaml 与 TS 表交叉核对，
角色条件一致），挂 truth-check + CI。

### 决策 2：Andon 开灯产出 AndonRaised 目录事件

OEE openAndon 收敛：ewohEvent.eventType='AndonRaised'（canonical，
历史行 'andon' 由查询侧 IN ('AndonRaised','andon') 过渡兼容）；
信封事件（buildEventEnvelope，catalog type=AndonRaised，subject=andonId）
嵌入 evidenceJson（与既有生产者同纪律）；payload：andonId=eventId、
deviceId/stationId 透传、level=canonical severity（ADR-027 词表）、
slaMinutes=ceil(slaSeconds/60)、occurredAt=openedAt。

### 决策 3：角色条件机器执行（轻量 v1）

按 alert.yaml：reopen 仅 safety_admin（actor.role 不符 → Forbidden 显式）；
其余动作维持既有 authenticated 处置（handler 语义在 v1 映射为
dispatcher/workshop_lead/device_ops 任一——不做更细拆分，yaml 条件
记录在案）。

### 决策 4：SLA 升级通知沿用 ewoh_notification（Round 50 闭环），

不再新增事件类型（升级是派生事实）；响应/解决耗时与升级级别留在
evidenceJson.timeline（可审计）。

## 后果

- 正：Andon 状态机单一事实源（yaml→TS 锁定表→门禁）；目录事件首次
  有真实生产者；词表随 ADR-027 收敛；reopen 角色条件机器强制。
- 负/边界：handler 角色 v1 不做细分（决策 3）；历史 'andon' 行过渡
  兼容查询（真实 PG 首推后按需 backfill 收紧）。
