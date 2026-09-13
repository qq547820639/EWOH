# EWOH Production Runbook

> 基于生产验收（2026-08-08，commit a931759）整理。适用于 Pilot/Canary 阶段。

## 生产事实

```
Production Canonical Solver: HeuristicSchedulingSolver
CP-SAT: OPTIONAL / EXPERIMENTAL（未部署 OR-Tools，NOT PRODUCTION READY）
Edge Runtime: edge_platform.runtime（EWOH_RUNTIME_MODE=production 真实装配，fail-fast）
数据库: PostgreSQL 17（schema 事实源 db/migrations standalone_*）
```

## Startup

### Edge Runtime（Python）

```bash
# 真实装配；任何装配失败 fail-fast（不进入 stub）
EWOH_RUNTIME_MODE=production EWOH_DB_PATH=/data/ewoh/edge.db python3 run.py --port 8765
# 验证：/api/status 的 rule_version 应为 risk-rule-v0.2（真实规则引擎，非 stub）
```

> **禁止 `EWOH_EDGE_SCHEDULING_WRITE=1`（决策项 2 / T4 收敛配套）**
> 正式调度（方案确认/派工）的写权限归 NestJS 控制面。Edge 侧该开关在生产
> 模式（非 simulation/development/test）置 1 → **启动即抛配置错误（fail-closed，
> run.py `ensure_scheduling_write_permitted`），禁止静默降级为 advisory**。
> 部署清单/环境模板不得包含该变量；如需 Edge 参与调度演练，仅允许
> simulation 模式。

### API（NestJS standalone）

```bash
EWOH_DEPLOY_TARGET=standalone \
DATABASE_URL=postgresql://ewoh_api:...@postgres:5432/ewoh \
JWT_SECRET='<32+ chars>' \
INGEST_API_KEY='<key>' \
node dist/server/main.js
# 缺 DATABASE_URL / JWT_SECRET(<32) / INGEST_API_KEY(production) → 启动失败（fail-closed）
```

### Feishu App

```bash
FEISHU_SIMULATOR_ENABLED=false FEISHU_VERIFICATION_TOKEN='<token>' node server/index.js
# 生产禁止 simulator（需 FEISHU_SIMULATOR_ENABLED + ALLOW_SIMULATOR_IN_PRODUCTION 双开关）
```

## Shutdown

- Edge/API：SIGTERM 优雅退出（Flush 遥测缓冲、停止轮询、关闭连接）。
- Feishu：SIGINT/SIGTERM → 停 simulator → 停轮询 → flush 遥测 → 关 HTTP → 关 DB。

## Migration

```bash
node db/runner/run_migrations.js --apply-standalone
node db/runner/run_migrations.js --verify-standalone
node db/runner/run_migrations.js --apply-standalone-users
node db/runner/run_migrations.js --apply-standalone-runtime-role
node db/runner/run_migrations.js --seed-standalone-admin
```
（compose migrate job 已封装此顺序；禁止用 delivery/release SQL 初始化。）

## Rollback

- 迁移回滚：`--rollback-standalone*` 系列。
- 应用回滚：回退镜像到上一版本（迁移向后兼容，先 verify 再回滚）。

## Health Check

- `/health/live`：进程存活（不碰 DB）。
- `/health/ready`：**校验 DB 可达**（select 1），DB 不可达返回 503 —— 作为就绪门禁。
- Edge `/api/status`：services.adapters/inference 应 healthy；rule_version 应为 risk-rule-v0.2。

## Logs

- Edge：stdout `[EWOH]` 前缀 + X-Request-ID 关联。
- API：NestJS logger；关键动作（dispatch/reservation/plan）写 ewoh_audit_log + ewoh_schedule_audit。
- Feishu：`[feishu]` / `[sync]` / `[rules]` 前缀；**不打印 base_token**（已修复）。

## 后台 Worker（幂等提醒/导出）

进程内定时任务，`setInterval` + tick 重入保护 + 单次失败只留痕不退出（`timer.unref()`，
不阻塞进程退出）。**多实例安全**：写入的通知/导出任务都由确定性 id + 唯一约束去重
（`notification_id`），重复 tick 只累加 `duplicates`，不会重复打扰现场。

| Worker | 作用 | 开关（默认值） | 幂等键 |
|---|---|---|---|
| `ApprovalExpiryWorkerService` | 执行边界授权到期提醒（剩余 ≤2h / 已过期 ≤24h） | `APPROVAL_EXPIRY_WORKER_DISABLED` / `APPROVAL_EXPIRY_WORKER_INTERVAL_MS`（5 分钟） | `NTF-EXPR-<审批号>-<桶>[-user-<收件人>]-<渠道>` |
| `ExoSessionReminderWorkerService` | 外骨骼会话主动提醒（超过预计结束 +15 分钟 / 连续佩戴 ≥4h） | `EXO_SESSION_REMINDER_WORKER_DISABLED` / `EXO_SESSION_REMINDER_WORKER_INTERVAL_MS`（10 分钟） | `NTF-EXO-<会话号>-<桶>[-user-<收件人>]-<渠道>` |
| `AndonSlaWorkerService` | 安灯**超时未接手**升级（>1×SLA → L1 班组长+调度；>2×SLA → L2 追加安全员） | `ANDON_SLA_WORKER_DISABLED` / `ANDON_SLA_WORKER_INTERVAL_MS`（5 分钟） | `NTF-ANDON-<安灯号>-<sla_breach_l1\|l2>-<role\|user>-<收件人>-<渠道>` |
| `DataQualitySweepWorkerService` | 数据质量**待核实**提醒（open `DataQualityAlert` → 点名责任人/角色） | `DATA_QUALITY_SWEEP_WORKER_DISABLED` / `DATA_QUALITY_SWEEP_WORKER_INTERVAL_MS`（10 分钟） | `NTF-DQ-<告警号>-<quality_alert\|quality_aging>-<role\|user>-<收件人>-<渠道>` |
| `WorkbenchExportWorkerService` | 工作台导出任务推进 | `WORKBENCH_EXPORT_WORKER_*` | `workbench_export_tasks.task_id` |

**运维注意（2026-09-11 实测教训）**：后台 worker 没有 HTTP 请求上下文，
`RequestDatabaseContext` 会回落根句柄 → **没有 `app.current_org_id` GUC** →
启用 RLS 的业务表（如 `ewoh_exo_session`）会把行全部挡住，表现为"接口上提醒正常、
定时 worker 静默 0 提醒"。因此后台跨租户扫描必须：

1. 经**受控的 SECURITY DEFINER 函数**拿租户清单（只返回 org_id，不返回业务明细），
   例如 `ewoh_active_exo_session_orgs()`、`ewoh_open_andon_orgs(interval)`、
   `ewoh_open_quality_alert_orgs(interval)`；
2. 对每个租户 `requestDatabaseContext.runInTransaction(buildGucSettings(systemCtx), …)`
   再读明细/写通知——租户隔离在真正读写数据的那一步照旧生效。

手动触发（只读扫描，不改变业务状态）：
`POST /api/approvals/authorizations/expiry-sweep`（safety_admin/global_admin）、
`POST /api/exo/sessions/reminder-sweep`（workshop_lead/safety_admin/global_admin）、
`POST /api/data-quality/gap-sweep`（workshop_lead/safety_admin/global_admin）。

### 外骨骼"佩戴人更正"（NO-43a，现场核实后的唯一正确动作）

现场收到 `NTF-EXO-…-telemetry_wearer_mismatch…`（或页面 `/exo` 上该会话标红
"佩戴人与遥测不符（需核实）"）时，处理顺序是**先核实、再择一**：

| 现场核实的结论 | 应该做的动作 | 为什么 |
|---|---|---|
| 确实是遥测指名的那个人在戴（会话登记错了人） | `POST /api/exo/sessions/{sessionId}/correct-wearer { personId }`（页面：「按遥测佩戴人更正」） | 交接语义：旧会话带理由收工并留痕、为新佩戴人开新会话；否则真实佩戴者没有会话，"佩戴中"资格判定与偏差复盘全都失真 |
| 会话登记的人没错，是遥测/工牌串了 | 不改会话；结束或继续会话，并把核实说明写进结束理由 | 缺证据或证据矛盾时**不能替任何人下结论**；更正不是"纠错按钮" |
| 人已经走了、没正常收工 | 「核实并收工」或「中止」 | 这两个动作同样把依据写进结束事实 |

操作要点：

0. **谁能做**：更正经口限定 `workshop_lead` / `safety_admin` / `global_admin`
   （现场账号调用返回 403）。理由：收工只终结自己的事实，更正会替**另一个人**建立"正在佩戴"，
   影响其资格判定与偏差统计——这属于班组长的核实职责。
1. **平台不会自动调用更正经口**：遥测只是证据，`needsHumanCheck` 只是"请人看一眼"；
   `activity_only` / `stale_telemetry` / `no_telemetry` 这些"没指名别人"的判定在页面上
   **不提供**更正动作（缺证据 ≠ 事实）。
2. **更正是交接，不是改字段**：旧会话永久保留（`reason` + `recordJson.correctedTo`），
   新会话 `recordJson.correctedFrom`。要回答"谁戴过、谁核实的、依据什么"，只能靠两侧都留。
3. **设备不会因更正自动交回**：更正后新会话仍占用设备，收工必须按常规流程结束新会话
   （否则这台外骨骼会一直显示"佩戴中"并阻塞后续派工）。
4. **执行边界照旧**：新佩戴人若与设备上的在飞任务受派人不符 → 409 `EXO_SESSION_TASK_CONFLICT`；
   会话已非进行中 → 409 `EXO_SESSION_NOT_ACTIVE`；佩戴人没变 → 400 `EXO_SESSION_WEARER_UNCHANGED`。
5. **排障**：更正是**单事务**（CAS 结束 + 锁设备行 + 开新会话），若返回 409
   "在更正过程中被并发终结"，说明有人同时收工——刷新页面后按最新状态重新判断即可，
   不会有半成品（事务已回滚）。

## 设备责任人（NO-49a）：提醒该叫谁

安灯（开灯 / 升级）提醒的收件人 = **设备责任人（点名到人）** + 角色兜底。责任关系用
`/api/devices/:deviceId/responsibilities` 维护（写权限：班组长/安全员/管理员）：

| 动作 | 行为 | 失败语义 |
|---|---|---|
| `POST {personId, responsibility}` | 同一职责**换人**：旧行停用（保留历史）+ 新行启用，同一事务 CAS | 设备不在台账 → 404（不建影子设备）；并发被改 → 409；同人重复设置 → 幂等 |
| `DELETE .../:responsibility` | 收回当前持有人（写审计） | 本来就没有 active 持有人 → 409（不静默当成功） |
| 提醒路由 | **本班责任人 → 全天责任人** + 角色兜底 | 责任人没有绑定账号 → `unresolvedResponsiblePersons`；**只登记了别的班次** → `outOfShiftResponsiblePersons`（不发提醒，避免叫到已下班的人）；当前班次未知 → 按全天兜底并标 `shiftUnknown` |

**页面入口**（NO-50a）：设备台账 `/devices` → "责任人"列 → 「设置」。
已登记显示"姓名（职责）等 N 项"，未登记显式写"未登记责任人（提醒只能发到角色）"；
页面顶部汇总"未登记责任人的设备 N 台"，用来发现"提醒发不到人"的缺口。

现场排查要点：

1. 提醒没叫到人 → 先查该设备有没有 active 责任关系（`GET`）、**这条关系属于哪个班次**
   （空串=全天），再查责任人有没有绑定登录账号（没有绑定只会进缺口清单，不会发出去）；
   夜班常见的坑是"只登记了白班责任人"——那属于本班缺口（`outOfShiftResponsiblePersons`），
   提醒会退回角色兜底；
2. 缺口清单出现在**安灯升级扫描结果**里（`POST /api/oee/andons/sla-sweep` 的
   `unresolvedResponsiblePersons`）以及服务日志；
3. 换人是**保留历史**的：旧行 `active=false` 且带停用时间/停用者，审计可回答"当时谁负责"。

## 交接班前的责任人核对（NO-52a）

交接班时系统会算一份**接班人核对快照**（`GET /api/device-responsibilities/coverage`），
并随交接记录落库（`responsibility_snapshot_json`）：

| 字段 | 含义 | 现场怎么用 |
|---|---|---|
| `covered` / `gaps` | 本班有/没有人负责的设备数（本班或全天责任人算覆盖） | 交班前把 `gaps` 里的设备补齐责任人，或写进交接遗留事项 |
| `uncovered` | 一条责任关系都没登记的设备数 | 结构性问题，按设备台账逐台补 |
| `devices[].outOfShift` | 只有别的班次责任人（附具体班次） | 说明"白班有人、夜班没人"，不是含糊的"无人负责" |
| `shiftUnknown` | 当前班次解析不到（没匹配到班次定义） | **不要**按默认班处理：先补齐班次定义 |

两点口径（与提醒路由**故意不同**，别混）：

1. 核对回答"**有没有人负责**"（不要求责任人已绑定登录账号）；
   提醒路由回答"**发不发得出去**"（无账号 → `unresolvedResponsiblePersons`）。
2. 快照是**交接时刻**的状态，不会随后续改动重算——审计问的是"当时知不知道"。

## 通知的终态语义（NO-44a）

通知是**派生事实**，它有两个互不替代的终态维度：

| 维度 | 字段 | 含义 | 谁写 |
|---|---|---|---|
| 看过 | `status='read'` + `read_at` | 人打开看过了（可能还没处置） | 现场/班组长点"标记已读" |
| 了结 | `status='resolved'` + `resolution` / `resolved_at` / `resolved_by` / `resolution_ref` | 主事实被处置（会话收工/中止/按实际佩戴人更正），提醒随之关闭 | 平台在**处置的同一事务**里写入 |

运维要点：

1. **已处置 ≠ 已读**：`markRead` 不会把 `resolved` 降级成 `read`（否则"依据哪次处置了结"会丢失）。
2. **升级/回滚注意**：`standalone_081` 回滚会丢掉已写入的处置痕迹（通知本身仍在），已上线环境不建议回滚。
3. **排查"提醒没关"**：确认处置动作确实发生（会话已 `ended`/`aborted`，或更正经口返回 201），
   并确认该提醒的 `external_ref` 等于会话号、通知号以 `NTF-EXO-` 开头——
   不满足这两条的提醒**按设计不会被处置关闭**（例如推送投递失败 `failed`，那是运维事件）。
4. **排查"提醒消失了"**：`GET /api/notifications?status=resolved` 能查到全部已处置提醒
   （含处置人/时间/指向），它们不会从未过滤的列表里消失。

处置码一览（封闭词表，按主事实命名空间化）：

| 处置码 | 含义 | 谁写入 |
|---|---|---|
| `session_ended` / `session_aborted` | 外骨骼会话收工 / 中止 → 该会话提醒关闭 | 会话处置（同一事务） |
| `session_corrected` | 会话按实际佩戴人更正（交接）→ 旧会话提醒关闭，指向新会话 | 更正经口（同一事务） |
| `approval_expired` | 授权已失效 → "即将失效"催促的前提消失（`expired` 桶仍待办） | 到期扫描 `system:expiry-sweep` |
| `approval_superseded` | 同一对象重新申请并通过 → 旧审批的到期提醒了结，指向新审批 | 审批决策（同一事务） |
| `andon_cleared` | 安灯被**关闭**（处置终态）→ 开灯/SLA 升级提醒了结 | 安灯状态机（同一事务） |
| `andon_cleared`（同上，含升级提醒） | 升级提醒（`sla_breach_l1/l2`）同样随关灯了结 | 安灯状态机（同一事务） |
| `data_quality_confirmed` | 人核实"数据可信" → 待核实提醒了结；confirmed 同时按 ADR-031 合法链 `open→acknowledged→processing→closed` 了结同源告警 | 数据质量判定（与判定主事实**同一事务**） |
| `data_quality_contested` | 人判定"**数据不可信**，相关决策需复核" → 提醒同样了结，但告警**保持 open 继续可见**（不是"没事"） | 数据质量判定（同一事务） |
| `agent_approval_decided` | Agent 待批命令已被人处理（批准/驳回） | Agent 审批台账（同一事务） |
| `agent_approval_expired` | Agent 待批命令超时作废（24h TTL） | Agent 审批台账（同一事务） |

补充口径（NO-47a）：

- 安灯升级桶：`sla_escalation` = 有人接手但**接晚了**；`sla_breach_l1/l2` = **没人接手**
  （状态仍是 `open`），由 `AndonSlaWorkerService` 每 5 分钟扫一次并按 SLA 倍数分档；
  两个来源互不覆盖，且都随关灯进入 `andon_cleared`。
- 安灯的 `acknowledged` / `processing` **不**关闭提醒——那时告警仍然有效，只是有人接手了；
  只有 `closed` 才落 `andon_cleared`；`reopened` 是**新事实**（需要重新处置），不复活旧提醒。
- Agent 待批命令的提醒随"人处理 / 超时作废"了结，两种码可区分（超时不是"没人管"的糊涂账）。
- 数据质量待核实提醒：只有 `requiresHumanVerification` 的告警码才打扰人
  （`ENTITY_NOT_FOUND` / `CLOCK_DRIFT` / `BATTERY_OUT_OF_RANGE` / `QUALITY_DEGRADED` /
  `DUPLICATE_RECORD`）；低风险计数类不叫人。收件人 = 责任人（班次感知：本班优先 →
  全天兜底 → **他班只报缺口**）+ 角色兜底，缺口在扫描结果里显式列出、不阻塞叫角色。
  扫描**只读业务事实**（不改告警状态、不写 evidence），只写提醒与
  `data_quality.notify_sweep` 审计。
- 所有提醒的通知号都是**确定性**的（族表见 `shared/notification-metrics.ts` 的
  `NOTIFICATION_ID_FAMILIES`），并由契约门禁强制：随机 id 既不幂等也无法被治理度量归类。

注意：`approval_superseded` 的候选集是"同一对象、更早通过、**且仍挂着待办提醒**"的审批
（直接从通知表反查）。因此：

- 手工把提醒标记**已读**不会让它被"取代"关闭（它本来就不是待办）；
  已读行的状态永不被改写，只会在其审批因**其它待办提醒**成为候选时补写处置四列
  ——审计要能区分"看过"与"了结"，两者不能互相覆盖。
- 想彻底清理历史噪音，正确做法是**重新申请并通过**（真实闭环），
  而不是批量置读：置读不会产生处置依据。

## 订单链、执行对账与经验回流（NO-57a/b/c）

- **订单链**：`GET /api/world/order-chains?limit=20`（可选 `orderNo`）。链路 = 订单（未完工 ERP_ORDER）→
  任务/工序（订单号 = 排产任务号；工序数来自 `ewoh_schedule_task_step`）→ 物料（MRP 缺口行）。
  **缺口词表封闭**：`task_link_missing` / `steps_missing` / `material_link_missing` / `due_at_missing`——
  页面逐单显示；出现词表外的缺口 = 契约漂移，须先修契约。
  排序为**逾期优先 → 期限升序 → 订单号**。排障：某单显示"没有排产任务"时先查
  `ewoh_schedule_task.schedule_task_id` 是否等于订单号（MES 建单会自动相等）。
- **预计 vs 实际对账**：`GET /api/scheduler/planned-vs-actual?windowDays=30`。读执行事实给出
  可比覆盖率、绝对偏差中位/均值/P90、超时-提前-准时计数、不可比分类与偏差类型分布。
  **样本不足（可比 < 5）时比率字段为 null**——页面显示"证据不足，不给偏差比率"，
  不要把它读成 0%；读取触顶时 notes 会说明"不是全体"。
- **经验回流**：行动项完成后自动写知识条目（`kind=process_knowledge`、`scope=factory`），
  条目号写回 `outcome_ref`。行动项上 `outcome_ref` 为空 = **未回流**（页面显示"未回流"，
  不表示没做完）。回流失败只留痕、不阻断"已完成"；知识契约要求**规范身份证据**
  （`event:`/`task:`/…），没有规范证据时**不建条目**（不造没有证据的知识）。

## 环境多源与两类"催办"（NO-56b）

- **环境多源（区域级）**：`ewoh_environment` 的温度/振动/噪声/空气质量按**观测绑定实体**聚合成区域主体
  （`station:<工位>` / `area:<实体>`）。同一通道：多台一致 → 代表值（均值）+ 极差；**多台不一致 →
  冲突且代表值置空**（不取平均掩盖分歧）；只有一台 → `single_source`（没有第二个独立源确认）。
  超过关注阈值（温度 35°C / 振动 8 / 噪声 85 / 空气质量 150）时**只报事实**，页面写明
  "是否停工由现场按规程决定"——平台不替现场下停机结论。
- **感知融合源期望按主体类型**：人员主体期望 UWB/外骨骼/视觉/工位/任务；区域主体期望环境/视觉/工位。
  把两套混在一起会让人员级融合永远"缺环境源"而永久降级（NO-56b 修正）。
- **数据质量"再催一次"**：告警超过 24 小时仍未了结 → 补发 `quality_aging` 桶提醒
  （与"刚发生"那条同告警号、同收件人，只有桶不同 → 两条确定性通知号）；人工判定时两条一起落终态。
  排查"为什么同一条告警有两条提醒"时，看通知号里的桶即可区分。
- **行动项逾期主动叫人**：`POST /api/learning/actions/overdue-sweep`（班组长/安全员/管理员）+
  后台 worker（30 分钟一次；`IMPROVEMENT_ACTION_OVERDUE_WORKER_DISABLED=1` 关闭）。
  收件人 = **负责人账号**（经受控函数从 person 反查）+ 班组长兜底；负责人没绑账号 →
  结果里的 `unresolvedOwners` 如实列出（**不假装已经叫到**）。
  完成/放弃/拒绝时提醒落 `action_completed` / `action_dropped`（与主事实同一事务）。
  排障：worker 依赖 `ewoh_improvement_action_orgs()`（迁移 090）取租户清单——
  后台没有 GUC，直查业务表会被 RLS 全挡（表现为"worker 静默 0 条"）。

## 多源感知融合怎么读（NO-56a，§5）

班次工作台的「感知融合」卡片回答：**人在哪个工位、姿态如何、这个结论可信吗**。

- **融合一次**：`POST /api/perception/fusion/sweep`（班组长/安全员/管理员；窗口/桶默认 5 分钟）。
  读窗口内的真实观测：定位行（`ewoh_world_state` 带 `locator`）、相机 person 检测行（带 `camera_id`）、
  外骨骼遥测（`ewoh_telemetry.entity_id` = 佩戴人）、工位/相机实体、在飞任务（任务上下文）。
  **只读感知事实**，只写 `ewoh_perception_fusion` 快照与审计；快照号确定性 → 重复扫描幂等。
- **五条可解释规则**（页面上逐条有留痕）：①UWB 与视觉同工位才算"交叉验证一致"；
  ②不一致**记录冲突而不是丢掉某一源**（各源取值都列出）；③视觉缺失 → 继续推断但降级；
  ④任一源缺失 → 置信度按缺失权重下降，**不中断输出**；⑤低置信度或有冲突 →
  `strongAdviceAllowed=false`，**上游不得据此生成强建议**。
- **置信度怎么读**：它是"可用源权重和 / 应有源权重和"（含质量×新鲜度×源置信度系数），
  **不是概率**——页面与服务端 `confidence.basis` 都写明这一点，不要拿它当置信概率。
  无可用源时显示"证据不足（不给分）"，**不显示 0%**。
- **排障口径**：
  · 某主体只有外骨骼没有定位 → `partial` + 缺 `uwb`（不是"人不在"）；
  · 视觉 track 未绑定主体 → 计入 `unmatchedVisionDetections`（平台不按"最像的人"分配）；
  · 坐标超出工位半径（默认 5m）→ 工位置空并计入 `stationUnresolved`（不猜最近工位）；
  · 相机未绑定工位（缺坐标）→ 视觉只贡献"有人"，不提供工位信号（冲突也无从产生）；
  · 观测超过 TTL（定位 60s / 外骨骼 120s / 视觉 60s / 工位 300s / 任务 900s）→
    进 `excludedSources` 且**不参与融合**，页面逐条显示原因。
- **与摄入的关系**：融合只认落库的观测。若外骨骼源一直"缺失"，先查摄入映射
  （`pose.pitch_deg` 与帧内 `entity_id` 曾在此静默丢失，NO-56a 已修）与设备台账。

## 改进行动项怎么用（NO-55a）

学习控制台的「改进行动项」把**复盘经验条目与缺口**变成有人负责的行动（与阈值提案并列：
行动项改做法、提案改参数）。

- **扫描**：`POST /api/learning/actions/scan`（班组长/安全员/管理员；可传 `{retrospectiveIds:[...]}`
  只扫指定复盘）。**已发布**复盘的 warning/critical 经验与缺口才立项——info 级只作记忆保留
  （不把每条总结都变成待办）；**草稿复盘不扫**。扫描只读复盘记录。
- **接受**：必须给**负责人 + 期限 + 验收判据**（`POST …/:actionId/accept`）。平台不替现场承诺期限；
  建议类型只是建议，人可在接受时改（改后 `kindSource=human`）。
- **完成**：必须写**结果说明**（`POST …/:actionId/complete`），对着验收判据说清楚做了什么。
- **拒绝/放弃**：必须给理由（`POST …/:actionId/decision`，`rejected`（未接受时）或 `dropped`（已接受后））。
- **交接要点**：`GET /api/learning/actions/overdue` 给出"已接受 + 到期已过"的清单——
  交接班时应先看这一行（逾期 ≠ 未开始，要问的是"卡在哪"）。
- **幂等与人的决定**：行动项号是确定性的（`ACT-<lesson|gap>-<复盘号>-<标题slug>`），重复扫描只刷新
  来源事实；责任/期限/完成/拒绝痕迹**永不覆盖**。
- 排障：扫描后一条都没有时先看扫描摘要行（读了几篇已发布复盘 / 经验几条 / 缺口几条）——
  **"没有待办"要能追到"读了什么"**；注意单次扫描有条数上限（10 条，按优先级），
  复盘很多时用聚焦扫描。

## 迁移链自检：全新库全链 apply + 全量 verify（NO-53a）

`make migration-fresh-chain`（需 `EWOH_PG_URL` owner 连接串 + `EWOH_API_DATABASE_PASSWORD`）
会在**临时库**上顺序执行全部迁移并逐条跑 verify，然后与 `db/migration-verify-baseline.txt`
比对：

- 输出 `apply PASS` = 迁移链能在空库从零装起来（这是"能不能上线"的硬前提）；
- `verify N/M PASS` + 基线清单 = 数据契约自检结果；基线**只许缩小**，
  出现基线外的新失败即非零退出（回归即失败）；
- 脚本自动建/删临时库：**不要**把 `EWOH_PG_URL` 指向正在服务的库——迁移中的
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` 会与运行中的 API 争锁（实测 deadlock detected）。

已知失败原因分三类（详见基线文件逐条注释）：psql 专属语法（node runner 无法执行）、
早期 verify 探针与**后续迁移收紧的 CHECK 约束**不匹配、身份域 uuid 与业务域 varchar 混用。
修好一项就从基线删一行（脚本会提示 `FIXED`）。

## 运行记忆信号怎么读（NO-54a）

学习控制台的「运行记忆信号」卡片把三类**已落库的运行记忆**变成候选：
提醒治理积压（某类提醒长期没人了结）、数据质量待核实积压、执行偏差复发。

- **扫描**：`POST /api/learning/signals/scan`（班组长/安全员/管理员；`windowDays` 默认 30）。
  **只读业务事实**——不改告警、不改偏差、不改提醒，只写信号台账与 `learning.signal_scan` 审计。
- **信号 ≠ 提案**：扫描永远不会创建提案，也不会激活任何策略。信号只是"带证据的候选"：
  实测快照 + 证据引用（含时间）+ 样本量 + 可信度 + 方向（放宽/收紧/待查）+ 假设/预期影响/风险。
- **样本不足不下结论**：`confidence = null` 时页面写"样本不足，不给结论"，
  且这类信号**不能**生成提案（契约与 DB CHECK 双兜底）。
- **人点"生成提案"**：目标阈值**由人填写**（平台只给方向）。服务端会重新读取当前生效阈值，
  与信号扫描时基线不一致 → 409「信号依据已过期」——这是防止拿过期依据改策略的闸门，
  不是故障：**重新扫描**后再提案。生成出的提案仍走影子评估 → 人审激活阶梯。
- **忽略必须给理由**：忽略后重复扫描**不会**覆盖这个决定；若条件恶化（严重度升级），
  会产生**新的信号号**（"变严重了"是新事实，不会被旧的忽略吞掉）。
- 排障：信号列表为空时先看扫描摘要行（读了提醒 N 条 / 未了结质量告警 N 条 /
  待核实提醒 N 条 / 偏差对象 N 个）——**"没有信号"要能追到"读了什么"**。

## 提醒治理怎么读（NO-46a）

`GET /api/notifications/metrics?days=30`（班组长/安全员/管理员）返回**只读**聚合，
用来回答"这套提醒机制现在健康吗"。读法：

| 指标 | 含义 | 看见什么要处理 |
|---|---|---|
| `dispositionRate` | 已处置 / 扫描条数（样本 <3 → `null` = 证据不足） | 长期偏低说明提醒产生了但没人了结 |
| `medianTimeToResolveMs` | 从提醒产生到了结的中位时长（只统计可比样本） | 中位 > 一个班次：处置链路太长或提醒发错了人 |
| `aging` | 仍待处理提醒的账龄分布 | "超过 24 小时"占比高 = 现场在忽略提醒 |
| `byKind` | 按提醒类型的计数与时长 | 某类型持续高位 → 去看该类型的主事实（设备/会话/授权） |
| `topSources` | 反复出现的主事实 Top 5 | 同一台设备/同一张授权反复报警 = 根因未解，不是提醒问题 |
| `totals.failedDelivery` | 推送投递失败条数 | 有值时去通知中心"推送状态"分组人工重试 |

三条口径（不要误读）：

1. **作用域与通知列表一致**：看到的是"你可见且能处理"的提醒，不是全租户全量；
2. **可比样本**：缺时间戳/时间倒流的行计入 `notComparable`，不参与时长统计；
3. **`truncated=true`** 时结论只覆盖已取到的 2000 行，不代表全体。

## 执行机构（AGV/PLC）运维（NO-59b）

**装配**（`EWOH_ADAPTERS`，无硬件时用回环模拟器）：

```json
[{"kind":"agv","deviceId":"AGV-01","sourceType":"simulated","stationId":"ST-1","batteryPct":88}]
```

**日常读面**：
- `GET /api/actuators`：清单（设备信息 + 健康 + 统一状态 + 命令词表/授权要求）；
- `GET /api/actuators/{deviceId}`：单台状态 + 最近 10 条命令（含被拒原因）；
- 设备台账 `GET /api/devices?category=agv`：执行机构作为设备可见（能力 `transport.move` /
  `observe.actuator_state` / `observe.position` 可人工停用）。

**命令面（两道闸门）**：
1. 边缘 RBAC：`POST /api/actuators/{deviceId}/commands` 属 `manage_devices`；
2. 平台授权号：高危命令（`dispatch_task`/`resume`/`clear_fault`）必须带
   `control:`/`approval:`/`plan:`/`task:` 前缀的授权号，否则 **403 `authorization_required`**；
   形状非法 → **400 `authorization_ref_invalid`**。`stop` 是安全动作：**不要求授权号**、
   故障态也允许（安全停机不被审批链卡住）。

**排障对照**（HTTP → 原因）：
- 404 `unknown actuator`：设备未注册（不是"空闲"）；
- 503 `transport_offline`：适配器未启动/真实链路断开（先看 `GET /api/status` 的 adapter health）；
- 409 `device_fault:<CODE>`：设备故障态拒绝新任务 → 现场处理后在平台走 `clear_fault`（需授权）；
- 400 `unknown_command_key`：命令不在封闭词表内。

**审计**：命令的**接受与拒绝**都写 `actuator.command`（含命令/授权号/结果/原因）；
状态上行落 `ewoh_world_state.state_json.actuator`（位置/电量/故障/当前任务/**最后授权号**），
可用 `GET /api/devices/{id}` 与指挥地图核对"设备为什么在动"。

**接入真机**：实现 `ActuatorTransport`（`send`/`recv`/`close`，Modbus/TCP、OPC-UA、厂商 API、
网关字节流任一）并在配置注入；适配器判定顺序、审计与结果契约不变。上车前先跑
`pytest src/edge_platform/tests/test_actuator_adapter.py` 与 `make e2e-edge`。

## 命令下行与回执（NO-60a）

**现场网关**（常驻；`--once` 用于排障与 e2e）：

```bash
python3 tools/edge_control_agent.py --device AGV-01 --interval-sec 2 \
  --platform-url http://<平台>:3100 --ingest-key "$INGEST_KEY" --org-id <org>
```

**平台侧读面**：`GET /api/control/requests/{requestId}` 给出 `{request, status}`——`attempts[]`
里每条命令带 `payload`（去哪）与终态（`sent → gateway_received → executed|failed`）；
`ewoh_control_result` 把"投递确认"（`gateway_ack`）与"执行回执"（`command_receipt`）分开存。

**排障对照**：
- 命令一直 `sent`：边缘代理没跑/平台不可达（代理日志 `pending_failed:0`）→ 检查网络与密钥；
- 命令 `gateway_received` 但无终态：回执未送达 → 检查代理日志里的 `receipt_status`；
- 命令 `failed` + `GATEWAY_REJECTED`：边缘拒绝投递（授权号不匹配/未知命令/设备故障）——
  `ewoh_control_command.error_message` 里有原因；
- 重复 ack：第二次返回 `alreadyAcked=true`（正常，边缘 at-least-once）；对已终态命令 ack → 409。

**授权边界**：授权号由平台按 `control:<requestId>` 签发，边缘**不接受**任何其它形状；
高危命令（`dispatch_task`/`resume`/`clear_fault`）在平台必须先过审批（与边缘同一份词表）。

## 搬运任务派给执行机构（NO-61a）

**前置条件（缺一不可）**：
1. 执行机构**持续上行状态帧**（`POST /api/ingest/actuator`）：设备遥测新鲜度 **60s**
   （`DEFAULT_FRESHNESS_POLICY['device:telemetry']`），过期即判 OFFLINE → 候选出现
   `device_offline`，调度**不会派工**（fail-closed，不是缺陷）；
2. 设备台账有该能力：类别 `agv` 自带 `transport.move`（执行类，high 风险）+ `observe.actuator_state`；
   能力被人为停用则不参与匹配（`disabledCapabilities`）；
3. 电量已知：状态帧带 `battery_pct` → 投影到 `ewoh_device.battery_pct`
   （空电量会让候选恒 `battery_unknown`，本轮修的就是这条）；
4. 任务要求 `requiredDeviceCapabilities: ["transport.move"]`，并走任务状态机进入 `pending_dispatch`
   （`draft` 不参与排程）。

**排障对照**：
- 候选里没有 AGV → 看设备是否在册（`GET /api/devices?category=agv`）与能力状态；
- 候选里 AGV 恒不合格：`device_offline`（新鲜度过期）/ `battery_unknown`（帧没带电量）/
  `route_infeasible`（人-工位路由不可行，与 AGV 本身无关）；
- **方案批不下来（409 PLAN_STALE）**：设备新鲜度 60s，而大库单次求解可能数分钟 →
  方案到达时快照已失效（平台**正确拒绝**，语义不放宽）。第 62 轮起处置是**可解释 + 一键重排**：
  1. 审批页会摊开**差异明细**（`GET /api/scheduler/plans/{planId}/staleness` 或 409 体里的
     `error.planStaleness`）：哪些实体版本变了、哪些预占增删了，并区分**外部变化**与
     **本方案自身执行效果**（已派工 assignment / 已建预占）；
  2. 点「按最新状态重新排程」→ 新方案绑定**新快照**，仍需独立审批人确认（重排不绕过审批）；
  3. 也可在方案卡片上先点「检查新鲜度」再决定，不必靠"点一下审批看会不会报错"探测。
  注意：**自动补偿已取消**——旧实现声称"过期后由 outbox 消费者自动重排"，但没有任何消费者
  做这件事，且 fire-and-forget 的求解跑在会被 409 回滚的请求事务里（白跑 + 写丢失）。重排入口
  现在只有一条显式路径：`POST /api/scheduler/plans/{planId}/replan`（页面按钮同源）。
- **重排接口 400 `requestConstraints 必须是约束数组`**：`lockedConstraints` 只能省略或传数组；
  传其它类型是调用方契约错误（省略 = 本次没有新增人工约束，方案既有约束照旧继承）。

## 执行边界：投递前授权复核与下行优先级（NO-62a/b）

**现场要看的三件事**：
1. **授权在投递窗口内失效会被拦下**：命令落成 `sent` 之后，平台每次投递前重新复核审批时效
   与**授权范围指纹**（请求/设备/命令/审批实例/参数）。不过 → 命令撤回
   （`status=revoked` + `revoked_reason` + `ewoh_control_result.result_type=delivery_rejected`）。
   原因码（页面/日志同源）：`authorization_expired`（审批过期）/ `authorization_revoked`（请求被撤销）/
   `approval_missing`（审批实例缺失或审批模块不可用）/ `approval_not_granted`（驳回/取消/绕过）/
   `fingerprint_mismatch`（授权范围被改写）/ `request_terminal`（请求已终态）/ `device_org_mismatch`（归属不符）。
   排障 SQL：
   `select command_id, command_key, status, revoked_reason, revoked_at from ewoh_control_command where status='revoked' order by revoked_at desc limit 20;`
2. **未授权执行会被单独记录**（不是"执行失败"）：设备在授权失效后仍然动作时，回执**照记**
   （事实不丢），并额外写一条 `authorization_violation` 结果行 + `control.command.unauthorized_execution`
   审计 + `NTF-CTRL-*` critical 提醒。这类提醒必须当**安全事件**处置，不能当普通失败重试。
3. **投递顺序是安全语义**：`pending` 按优先级返回（`stop`=0 安全停机插队 → `pause` → `return_to_dock`
   → `clear_fault` → `resume` → `dispatch_task`=5），并带积压可见性
   （`queued` / `oldestSentAt` / `revoked`（本轮被拦下几条）/ `truncated`）。现场若发现
   "急停排在搬运后面"，看边缘日志的 `platformOrderViolation`（边缘会自行重排并上报）。

**边缘网关传输选择**（`tools/edge_control_agent.py`）：
- 数字孪生（缺省）：`--transport simulated`；
- Modbus/TCP：`--transport modbus --modbus-host <PLC> --modbus-port 502 --source-type real`
  （真机必须显式 `real`；来源隔离是数据可信的前提）。寄存器契约见
  `src/edge_platform/edge/adapters/actuator/modbus.py` 的 `RegisterMap`；
  无硬件自测可先起 `FakeModbusSlave`（协议帧真实、设备是模拟）。
- 网关只持有 ingest key（机器身份），**不需要也不该持有**人类凭据。

**运维纪律（本轮实测教训）**：
- **拒绝路径上的写入必须独立提交**：请求被包在一个事务里（`OrgContextInterceptor`），
  "安全决策 + 抛 4xx"会回滚同事务写入。平台已用 `runDetachedTransaction` 承载撤回/留痕；
  新增类似逻辑时**不要**把关键写入和抛异常放在同一事务里。
- **SQL CHECK 注意三值逻辑**：`x IN (...)` 在 `x IS NULL` 时求值为 NULL，`false OR NULL = NULL`
  → CHECK 视为通过。写"成对字段"约束时必须显式 `x IS NOT NULL`（092/093 均已修 + verify 探针）。

## 能力停用状态的"漂移"与处置（NO-64 现场纪律）

**现象**：`e2e:capability-explain` 会**真的**停用再恢复一批设备的高风险能力（这是它要验证的语义），
但被中断/失败的运行只恢复了"它这一轮停用的那批"，历史上失败运行留下的 `status='disabled'` 行会
累积。实测：`exo-lift` 一度有 **116 台设备**处于停用状态，直接后果是 `e2e:exo-session` 报
"台账里没有具备 exo-lift 的外骨骼设备"（看起来像外骨骼链路坏了，其实是环境漂移）。

**审计（只读；工具化，NO-65c）**：

```bash
EWOH_DATABASE_URL=<owner 串> make capability-drift ORG_ID=<org uuid>
# 等价于：node scripts/capability-drift-check.js --org-id <org uuid>
# 输出按能力聚合的停用行数 + 最老/最新停用时间 + 缺留痕行数；高风险能力超过阈值即非零退出。
```

需要临时核对时也可直接查库：

```sql
select capability_key, status, count(*)
  from ewoh_device_capability group by 1,2 order by 1,2;
select device_id, capability_key, capability_value->'lifecycle'->>'reason' as reason, _updated_at
  from ewoh_device_capability
 where status <> 'active' order by _updated_at desc limit 50;
```

**处置（必须走产品路径，不要手改库）**：工具化批量恢复（dry-run 默认，`--yes` 才执行；
只恢复"设备仍声明该能力"的行，"恢复等于凭空授予"的行会跳过）：

```bash
EWOH_DATABASE_URL=<owner 串> node scripts/capability-restore.js \
  --capability exo-lift --org-id <org uuid> \
  --admin-pass "$EWOH_E2E_ADMIN_PASS" --approver-pass "$EWOH_E2E_APPROVER_PASS" [--yes]
```

逐台/按批也可直接调用
`POST /api/devices/{deviceId}/capabilities/{capabilityKey}/status`（带 `status=active` +
`approvalId`）——恢复高风险能力属"放宽"，需要**他人**审批（自批 403），一次审批可覆盖整批设备；
`e2e:capability-explain` 的 `restoreDevicesWithApproval` 就是这个流程的可复用实现。
**纪律**：任何停用高风险能力的场景/脚本，必须在 `finally` 里恢复**它所停用的全部设备**
（含失败路径），否则残留会被下一个场景当成产品缺陷。

## 投递配额与"排队"怎么读（NO-67b）

平台按**设备**限制投递吞吐（`EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE`，默认 60/分钟；`<=0` = 显式关闭），
计量口径是 `ewoh_control_command.delivered_at`（**平台把命令交给网关的时刻**，投递路径唯一写入点）。

- **为什么要有配额**：真实设备控制通道吞吐有限（现场总线 / WiFi / PLC 扫描周期），
  平台侧"有多少投多少"会把设备打爆（现场表现为丢帧/拒绝/超时，平台侧却看不出异常）。
- **两种排队都不是失败**（设备抽屉「执行边界」面板与 `pending.deferred` 都能看到）：
  - `reason=device_busy`：设备正在执行上一条运动命令（一车一活）；
  - `reason=quota`：本分钟配额用尽 → 下一分钟自动继续（命令保持 `sent`）。
- **安全动作永远插队**：`stop` 不受排队与配额约束，也不占配额（停机不能被吞吐限制卡住）。
- 排障 SQL：

```sql
-- 最近一分钟各设备实际交付了几条（配额计量口径）
select r.device_id, count(*) as delivered_last_minute
  from ewoh_control_command c join ewoh_control_request r on r.request_id = c.request_id
 where c.delivered_at >= now() - interval '1 minute'
 group by 1 order by 2 desc;
-- "下发但从未交付"的命令（下发 ≠ 交付；这类命令通常卡在排队或授权复核）
select command_id, command_key, status, sent_at, delivered_at
  from ewoh_control_command where delivered_at is null and sent_at is not null
 order by sent_at desc limit 20;
```

## 授权指纹密钥轮换（NO-66b）

签名指纹用 `EWOH_CONTROL_FINGERPRINT_SECRET` 签发（HMAC-SHA256）。轮换时的现实约束：
**平台上已用旧密钥签发的命令（在飞/排队中）必须仍能复核通过**，否则一次轮换会把现场正在执行的
命令判成"签名不符"并撤回。因此引入了**有期限的轮换窗口**：

```bash
# 1) 平台：把当前密钥挪到 _PREVIOUS，写入新密钥（复核接受两把，签发只用新密钥）
EWOH_CONTROL_FINGERPRINT_SECRET=<新密钥>
EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS=<旧密钥>
# 2) 边缘网关：先切新密钥（网关只验签，不签发；两把密钥期间用新密钥即可）
# 3) 观察在飞命令清零（窗口存在的唯一理由就是在飞命令）：
#    设备抽屉"执行边界"面板 → 在飞=0；或 SQL：
#    select status, count(*) from ewoh_control_command where status in ('sent','gateway_received') group by 1;
# 4) 清零后**立即移除** _PREVIOUS 并重启平台（窗口越短越好）
```

纪律：
- `_PREVIOUS` 只在轮换期间存在；**不要**把它当"长期兼容开关"（越久 = 被撤销的旧密钥一直可用）；
  平台启动时若检测到该变量会打一条醒目告警（NO-67c），提醒"清零后立即移除"；
- `_PREVIOUS` 与当前密钥相同视为配置错误——代码不会因此放宽（同值不构成额外接受面）；
- 窗口内仍拒绝被改写的命令范围（轮换只放宽**密钥**，不放宽**内容**）；
- 缺密钥时平台会显式拒绝带签名指纹的命令（`revoked_reason=fingerprint_key_missing`），
  不会静默退回无密钥校验——现场看到该原因码就说明"两侧密钥没配对"。

## Metrics

- Edge `/metrics`：uptime_seconds、db_counts、event_bus_handler_errors_total、inference 延迟。
- API `/metrics`：通用 HTTP 请求计数 + scheduler_run_total（solver_version/status label）、
  scheduler_fallback_total、scheduler_solver_timeout_total、scheduler_run_duration_ms。

## Backup / Restore

- **Edge（SQLite）**：`BackupManager`（db 文件 + JSON 副本 + integrity_check）：
  ```python
  from edge_platform.backup.manager import BackupManager
  bm = BackupManager()
  bkp = bm.backup('/data/ewoh/edge.db', '/backup/ewoh_edge')
  bm.restore(bkp, '/data/ewoh/edge.db')
  bm.verify('/data/ewoh/edge.db')  # PRAGMA integrity_check
  ```
- **PostgreSQL**：`pg_dump`/`pg_restore`（生产标准）。
- 已实测：Edge backup→destroy→restore→verify 数据完整。

## Restore 后一致性

- Edge 调度状态由 repository 持久化，重启后 `hydrate_from_repository()` 恢复
  （approved plan / reservation / assignment 不丢失）——已实测重启恢复。

## Incident 处理

| 症状 | 检查 | 动作 |
| ---- | ---- | ---- |
| API readiness 503 | DB 连接 | 检查 PostgreSQL 健康/连接池 |
| Edge 启动失败 | 日志 RealAssemblyError | 检查 DB 路径/权限；production 不降级 stub |
| Ingest 503/401 | INGEST_API_KEY | 确认环境变量已配置（production fail-closed） |
| Scheduler fallback 异常 | scheduler_fallback_total | 确认 heuristic 可用；CP-SAT UNAVAILABLE 属预期 |
| Feishu 验签失败 | FEISHU_VERIFICATION_TOKEN | 确认 token 一致；生产缺失=拒绝写操作 |
| SSE 断连 | 前端 useSchedulerStream | 自动 gap 检测→resync→poll fallback→恢复 |

## Scheduler Fallback

- Production Canonical = **HeuristicSchedulingSolver**；CP-SAT 不可用时 solverStatus=
  UNAVAILABLE/FALLBACK 显式标记，**绝不冒充 CP-SAT 成功**。
- 若未来启用 CP-SAT：需 OR-Tools pinned 依赖、worker 容器、readiness、资源限制、
  solver parity 测试、fallback 测试、production shadow 期。

## Edge Failure

- 真实组件装配失败 → fail-fast（进程退出非零），不静默 stub。
- development 模式需显式 EWOH_ALLOW_STUB=1 才允许 stub。

## Ingest Auth Failure

- production 缺 INGEST_API_KEY → 启动失败 + 请求 503（fail-closed）。
- 错误 key → 401。不泄露 key 到日志/响应。

## Feishu Failure

- webhook 验签失败 → 拒绝（fail-closed），不产生业务副作用。
- lark-cli 不可用（ENOENT）→ 同步降级（console.error，不阻断本地服务）；生产需安装 lark-cli。

## SSE Failure

- 前端自动：sequence 去重 → 缺口检测 → resync → 断线重连（Last-Event-ID）→ poll fallback → 恢复实时。
