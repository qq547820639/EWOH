# EWOH 待拍板决策单

> 生成：2026-08-28 18:58　｜　依据：《全量代码深度审计与优化路线图》T1–T16 实施后的遗留决策项
> 规范：每项含【背景与证据 / 备选方案对比 / 推荐意见与理由 / 默认路径 / 影响面】五要素
> 状态标记：⏸ 待拍板 ｜ ✅ 已决 ｜ ⊘ 已消解（调查后无需决策）
> **2026-08-29 全部裁决完毕**（完全自主授权模式，裁决依据随项记录；执行证据见《优化实施断点交接》§七）

---

## 决策项 1（✅ 已决：B）｜T4 完整收敛：派工旁路端点的处置

### 背景与证据

调度派工（`ewoh_schedule_plan.status → dispatched`）存在双实现：

| | 正统路径 | 旁路路径 |
|---|---|---|
| 端点 | `scheduler.controller.ts:383` | `gamification.controller.ts:41-48` |
| 实现 | `dispatchPlanV2`（approved→dispatched CAS） | `gamification.service.ts:537-620`（confirmed→dispatched） |
| 前置状态 | `approved` | `confirmed` |

**调用方排查结论（2026-08-28 18:50 全仓复核，含本轮修正）**：

- 前端 UI 组件**零调用**旁路——所有派工入口（`Scheduling.tsx:436`、`SchedulePanel.tsx:444`）均走 `dispatchPlanV2`
- 前端 API 层原存在旁路死封装（`api/gamification.ts` 的 `dispatchPlan`），**已随 commit `13e8af4` 删除**（零运行时引用）
- E2E / Playwright / scripts / deploy / 飞书端：**无调用**（全仓 TS/TSX/JS/PY/SH/YAML 排查，排除契约声明与审计文档）
- 旁路端点仍在 **OpenAPI 公开契约**中（`openapi/ewoh.yaml:6618`），理论上不排除仓库外调用方
- 既有加固已落地：CAS + NEST-330 闭合（`ae7433d`），历史裁决 R2-SBZ-014（DEFENSE_IN_DEPTH_ACCEPTED）已被事实上推翻为"修复"

### 备选方案对比

| 选项 | 动作 | 收益 | 成本/风险 |
|---|---|---|---|
| A 维持现状 | 保留旁路端点（已含 CAS 加固） | 零改动 | 双实现长期共存，修复调度逻辑需改两处 |
| **B 委托反转（推荐）** | 保留端点与契约，`gamification.dispatchPlan` 改为内部调用 `SchedulerService.dispatchPlanV2` 并做形状适配 | 消除行为分叉；零 breaking；`SchedulerService` 已在 gamification 的 import 中（依赖现成） | 需适配两轨状态前置差异（confirmed vs approved）；需回归旁路测试 |
| C 硬删 | 删端点 + 更新 OpenAPI 契约 | 最彻底，单一实现 | 公开契约变更；仓库外若有调用方即线上事故——**需先在网关/访问日志确认近 30 天零调用** |

### 推荐意见与理由

**推荐 B**。理由：外部调用方无法从仓库内完全排除（契约是公开的），B 在获得 C 的全部正确性收益的同时零 breaking；且 B 可作为 C 的前置观察期——委托上线运行一段时间、网关日志确认无流量后再执行 C（若仍需要）。

### 默认路径

**若 2026-09-11（两周）内未拍板，默认按 B 推进**（由工程师执行委托反转 + 回归测试）。C 不设默认路径——公开契约删除必须显式确认。

### 影响面

- B：`gamification.service.ts`（dispatchPlan 体替换）、旁路测试 mock、无契约变化
- C：`gamification.controller.ts`、`openapi/`（重生成）、`client/src/types/openapi.d.ts`（重生成）

### ✅ 裁决记录（2026-08-29，commit `70aaa06`）

**裁决 B（委托反转），已实施**。实施中发现的关键约束（决策单成文时未预见）：

- 两轨数据模型不可互换：legacy `confirmed` 方案不持有 `ewoh_scheduling_plan_assignment`
  明细与 `snapshotVersion`，直接委托 V2 派工机制将产生**空分配派工**（数据事故级）；
  而 `confirmed→approved` 状态提升等于伪造审批（治理违规）。故 B 的落地形态为
  **轨道分派适配器**：`approved` → 完整委托 `dispatchPlanV2`（获得安全熔断/快照
  新鲜度/资源预约/Execution 建档全套正统机制，消除"approved 经旁路只得 400"的分叉）；
  `confirmed` → 保留既有薄路径（该轨道唯一正确行为）并加 `[DEPRECATED]` 观察期告警日志。
- 契约兑现细节：委托分支回写一条 `ewoh_schedule_audit`（action='dispatch'）以兑现旁路
  契约的 `auditId` 承诺（正统审计在 audit_log hash 链，两审计面向不同契约承诺，不重复）。
- 回归：gamification.service.spec 19/19（新增 approved 委托适配回归）。
- **C（硬删）保持开放**：观察期告警日志已就位，待网关日志确认零调用后可执行 C。
  公开契约删除不设默认路径（与决策单原意一致）。

---

## 决策项 2（✅ 已决：B 冻结）｜Python 边缘调度栈定位：下线 or 保留

### 背景与证据

`src/edge_platform/scheduler/` 核心域（optimizer/planner/scoring/priority/reservation/replanner/world_state/scheduler_service/repository，约 6,812 行 + 19,047 行测试）与 NestJS `modules/scheduler/` 构成两套完整调度栈。**重复实现而非合理分层的反证**：云重连时边缘方案被逐条 delete（`scheduler_service.py:193-222`）——若为"离线求解→重连同步"分层，此处应是 upload/sync。边缘算出的 advisory 方案没有任何回流中心通道。

例外：`cpsat/` 是 NestJS 经 HTTP 调用的 CP-SAT worker（`cp-sat-scheduling-solver.ts:129` → `routes/scheduler.py:21-23`），是单一实现的客户端/服务端两侧，**真实价值，任何选项下都保留**。

潜在风险：运维误设 `EWOH_EDGE_SCHEDULING_WRITE=1`（`run.py:118-124`）会使 Edge 获完整写权限，与 NestJS 形成 split-brain。

### 备选方案对比

| 选项 | 动作 | 收益 | 成本/风险 |
|---|---|---|---|
| A 维持现状 | 保留双栈 | 零改动 | 6.8k 行 + 19k 行测试维护永不上线路径；split-brain 风险常驻 |
| **B 冻结（推荐）** | 核心域标记 frozen：README/Dockerfile 注明"仿真沙箱专用"、生产镜像/入口裁剪其 HTTP 路由（`routes/scheduler.py` 写路由）、保留代码 | 生产面收敛、split-brain 风险消除、维护成本大幅下降；代码保留供仿真 | 需确认仿真场景（simulation 模式）对核心域的依赖边界 |
| C 下线删除 | 删核心域 + 相关测试 | 极致瘦身 | 若产品路线图转向边缘离线求解，需要重建——**这是产品定位问题，技术方不可单方面判断** |

### 推荐意见与理由

**推荐 B（冻结），不推荐直接 C**。理由：C 不可逆且押注产品方向；B 获得约 80% 的收益（生产面收敛 + 维护下降）而保留全部选择权。若未来路线图明确不做边缘离线求解，再从 B 走到 C 成本很低。

### 默认路径

**本项不设自动推进的默认路径**（涉及生产镜像内容变化）。建议随下个季度规划评审；在此之前维持现状，仅建议先行落实一个零风险子项：在生产部署文档中显式警告 `EWOH_EDGE_SCHEDULING_WRITE` 不得设 1（纯文档变更，可随任意发布带上）。

### 影响面

- B：`src/edge_platform/scheduler/routes/`（路由裁剪）、部署配置、文档；仿真模式路径需回归
- C：上述 + 删 6.8k 行源码 + 19k 行测试；`cpsat/` 不动

### ✅ 裁决记录（2026-08-29，零风险子项 commit `2df572e`）

**裁决 B（冻结），分两步执行**，与决策单"不设自动推进默认路径"的自我约束一致：

- 零风险子项（已落地）：`docs/operations/production-runbook.md` 增加
  `EWOH_EDGE_SCHEDULING_WRITE` 生产禁置 1 的显式警告（fail-closed 语义、
  部署清单排除、演练仅限 simulation 模式）；`deploy/.env.example:149-151`
  已有同口径警告，操作面文档补齐。
- 完整冻结（路由裁剪/生产镜像内容变化）：**留待季度评审**，不自动推进——
  涉及生产镜像内容变化，与决策单原文约束一致。复核时点：下季度规划。

---

## 决策项 3（⊘→待人工执行）｜T3 终验：生产模拟器开关确认

### 背景与证据

代码层 fail-closed 完备（`simulator.service.ts:129/152/166-170`：不显式授权不启动、双保险开关、手动启动也需授权，有测试把守）；部署模板默认安全（`deploy/.env.example:263-264`：`ENABLED=0` + `DISABLED=1`）；三份历史文档（`alert-backlog-cleanup.md:97`、`project-closure-final.md:142`、`EWOH-remaining-work-execution-report.md:120`）交叉印证生产已于 8/22 关停。

**⊘ 已消解**：该事项原为"是否关闭生产模拟器"的决策，调查后确认无需决策（已关停）。剩余仅为**事实终验**——但执行协作方 SSH 凭据已失效（2026-08-28 18:35 实测 Permission denied，密码与项目记忆中的记录不符），无法代为验证。

### 需要人工执行的动作

```bash
ssh root@121.43.230.202 "grep SIMULATOR /opt/ewoh/.env"
```

预期输出含 `EWOH_SIMULATOR_ENABLED=0` 与 `EWOH_SIMULATOR_DISABLED=1` 即闭环；若 `ENABLED=1`，按 `alert-backlog-cleanup.md:58-59` 的步骤置 0 并加双保险（该文档已含完整操作指引）。

### 默认路径

无需拍板，**仅需用户（或持有效凭据者）执行一次只读命令**。不影响任何开发进度。

### 影响面

只读验证，零改动（除非发现 ENABLED=1，则按既有文档操作）。

### ⊘→✅ 闭环记录（2026-08-29，凭据恢复后实测）

用户提供了 ECS 凭据，终验已执行（只读命令）：

```
$ ssh root@121.43.230.202 "grep SIMULATOR /opt/ewoh/.env"
EWOH_SIMULATOR_ENABLED=0
EWOH_SIMULATOR_ORG_ID=00000000-0000-4000-8000-000000000001
EWOH_SIMULATOR_DISABLED=1
```

`ENABLED=0` 且 `DISABLED=1`（双保险在位）——**与预期闭环条件完全一致，T3 终验闭环**。
ORG_ID 为模拟器归属租户配置，与开关无关，属正常配置项。

---

## 汇总

| # | 事项 | 状态 | 裁决 | 执行证据 |
|---|---|---|---|---|
| 1 | T4 旁路端点处置 | ✅ 已决 | **B 委托反转（轨道分派适配器）** | `70aaa06`；C 观察期开放 |
| 2 | Python 调度栈定位 | ✅ 已决 | **B 冻结**（零风险子项先落） | `2df572e`；完整冻结留季度评审 |
| 3 | T3 模拟器终验 | ✅ 已闭环 | SSH 实测双保险在位（凭据恢复后执行） | 见决策项 3 闭环记录 |
| 4 | T8 lockfile | ✅ 已决 | 同步 lockfile（覆盖移交限制） | `ec023d4`，npm ci 实测通过 |
