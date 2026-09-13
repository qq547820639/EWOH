# 能力对齐表（愿景九层 ↔ 现状 ↔ 缺口 ↔ 处置）

> 维护规范：本文件回答"**大框架走到哪了**"——把 `docs/architecture/embodied_factory.md` 的
> 九层架构、`target-state.md` 的北极星与不变量，逐层映射到**仓库里的真实实现与证据**，
> 并对每项能力给出四类处置：**保留（keep）/ 增强（strengthen）/ 合并（merge）/ 淘汰（retire）**。
> 与 `feature-status.yaml`（机器可校验的功能事实清单）互补：那份是"字段级事实"，
> 本表是"层与层之间的对齐与缺口判断"。
>
> 最后更新：2026-09-12（长周期第 61 轮；按"先审计后立项、成批交付"完成 §3 第 61 轮批次：
> **执行机构状态投影到设备台账**（位置/电量/故障 → 可调度资源）+ **搬运任务→AGV 派工验证**
> （候选合格 → 方案派给 AGV，真实 PG 调度器）。
>
> 上一轮（第 60 轮）：按"先审计后立项、成批交付"完成当时批次：
> **平台授权 → 边缘执行 → 回执闭环**（命令 payload + 网关轮询下行 + 投递确认 + 机器身份回执）、
> **执行边界词表统一**（执行机构高危命令并入平台高危集合，同源于共享契约）。
>
> 上一轮（第 59 轮）：按"先审计后立项、成批交付"完成当时批次：
> **外骨骼关节角 → 动作交叉验证**（动作维度第二个独立源）、**置信度按源计权**（修掉多维度源多倍权重）、
> **删除冲突孪生实现**（`SchedulerQueryService.buildConflicts`，冲突读面单一实现且 GET 无写副作用）、
> **执行机构（AGV/PLC）适配与命令面**（协议面 + 回环模拟器 + 授权 fail-closed + 状态上行全链，
> 设备类别 `agv` 与能力 `transport.move`/`observe.actuator_state` 进世界模型）。
>
> 上一轮（第 58 轮）：按"先审计后立项、成批交付"完成当时批次三项：
> **行动项对象归属与复发度量**（复盘 incident `target_id` → 设备/人员/工位；完成前后窗口计数，
> 无归属即"不可度量"）、**感知门控接入推理/调度**（结论 `advisoryOnly` + 冲突面 `perception_inconsistent`
> 提示层，不阻断调度）、**视觉骨架 → 躯干角交叉验证**（两个独立角度源，差值 ≥ 30° 记姿态角度冲突）。

## 0. 一页结论

- **方向：正确**。九层职责、北极星闭环（Observation → World State → Reasoning → Planning →
  Approval → Coordination → Execution → Feedback → Learning）与安全不变量在仓库里都有实现与门禁。
- **风险：节奏偏科**。第 33–52 轮几乎全部投入**同一条垂直链**（外骨骼会话 → 提醒终态与处置 →
  安灯升级 → 设备责任人 → 班次维度 → 交接核对），其中约 4 轮是在修**自己引入的缺陷**
  （测试替身漏条件、类型不匹配、"假不阻塞"、e2e 断言自伤）。这是"深度换广度"，需要纠正。
- **框架层欠账（已清）**：能力清单曾漏收 NO-33a…NO-52a 的产出——第 52 轮补登记 4 项
  （含 README 行 + 关键词门禁），第 53 轮再登记 `dataQualityVerification`；
  `target-state/domain-map/data-flow` 的元数据已同步到 2026-09-12。
- **本轮（57）执行结果**：成批完成三项（订单链消费面 / 预计vs实际对账 / 经验回流知识），
  同轮自证又抓出两个真缺陷：**投影写死**（订单任务号与工序数一直没读）与**自写 ERP SQL 用了不存在的表**
  （ERP 出站是事件不是表 → 接口 500），并统一了"未完工订单"词表。
- **上轮（56）执行结果**：落地 §3 原 #1（多模态感知融合：§5 公式 + 五条规则 + 快照 + 页面），
  同轮 e2e 自证揪出摄入映射层两个"静默丢数据"缺陷（`pose.pitch_deg` 不认、帧内 `entity_id` 被覆盖），
  并把单帧/批量两条字段映射路径合并为一处。
- **上轮（55）执行结果**：补完 §3 原 #1 的后半段（复盘经验/缺口 → 改进行动项），
  同轮自证揪出"slug 撞号静默吞经验""UI 草案字段名与校验器不一致""场景与共享库条数上限冲突"三个问题。
- **上轮（54）执行结果**：落地 §3 原 #1（学习回路接线：运行记忆 → 信号 → 人点生成提案），
  同轮自证揪出"假处置率"（口径算反）、契约与规则自相矛盾、测试替身失真、页面空态掩盖读取失败四个问题。
- **上轮（53）执行结果**：落地 §3 原 #1（数据质量接入统一提醒契约），且**没有**再往旧垂直加深——
  同轮 e2e 自证还揪出 DR-4 的"confirmed 联动关告警"是死代码（状态机不允许跳步 + 调用处只 warn
  + e2e 只打印不断言），属"修补既有缺陷"而非新增垂直，符合 §5 的自我约束。
- **下一步（广度优先）**：§3 当前批次**成批做完再交付**（不再"每轮一项"）——第 58 轮一次做完
  NO-58a/b/c 三项并同轮验证；每轮结束同步能力清单/README/本文件并从 §3 销账。

## 1. 九层对齐（现状 × 证据 × 处置）

| 层（embodied_factory.md） | 现状 | 主要证据 | 缺口 | 处置 |
|---|---|---|---|---|
| 1 设备与现场层 | **部分**：台账（设备/类别/能力/位置/维护窗）+ 责任人（班次维度）+ 工位绑定 | `db/migrations/standalone_001/012/027`、`server/modules/dashboard`、`server/modules/responsibility`、`client/src/pages/Devices` | 产线/工位层级只有"绑定"没有"节拍/在制"；执行机构（PLC/AGV）只有能力声明没有动作闭环 | strengthen |
| 2 边缘适配层 | **较完整**：边缘运行时（采集/断网缓冲/死信/降级）+ 多源上行 + 模拟器；**执行机构（AGV/PLC）双向通道**（命令面授权 fail-closed + 状态上行）已就绪 | `src/edge_platform/`（`adapters/actuator/*`、`routes/actuators.py`）、`server/modules/ingest`（`ingestActuator`）、`test/e2e/edge-multisource-uplink.mjs`（54 项）、`pytest`（执行机构 28 例） | 真实硬件协议（Modbus/OPC-UA/厂商 API）仍是接口层（无真实设备） | keep + 适配器 |
| 3 流处理层 | **较完整**：事件目录/信封/去重/迟到与时钟漂移语义/死信 | `contracts/events/event-catalog.yaml`、`shared/event-envelope.ts`、`make truth-check`（24/24） | 长时窗口聚合（如"连续 3 帧异常"）靠各域自己实现 | keep |
| 4 空间数字底座 | **较完整**：空间实体/坐标/工位层级/地图 | `server/modules/spatial`、`client/src/pages/CommandMap` | 空间与"人/设备实时位置"的融合仍以模拟数据为主 | keep |
| 1 设备与现场层 | **部分**：台账（设备/类别/能力/位置/维护窗）+ 责任人（班次维度）+ 工位绑定 + **执行机构（AGV/PLC）**类别与能力、位置/电量由状态帧投影 | `db/migrations/standalone_001/012/027`、`server/modules/dashboard`、`server/modules/responsibility`、`server/modules/ingest`（`projectActuatorDeviceState`）、`e2e:agv-transport`（10 项） | 产线/工位层级只有"绑定"没有"节拍/在制"；**长求解后的方案审批窗口**（60s 新鲜度）尚无产品级方案 | strengthen |
| 5 感知融合层 | **较完整**：多源观测（UWB 定位 / 外骨骼 IMU（俯仰+**关节角→动作**）/ 视觉检测+骨架+动作 / 工位语义 / 任务上下文 / 环境传感）已按 §5 **公式 + 五条可解释规则**融合（置信度**按源计权**），落快照并给上游 `strongAdviceAllowed` 门控；门控已接入**推理**（`advisoryOnly`）与**调度冲突面**（`perception_inconsistent`，提示层不阻断）；数据质量提醒与责任人点名已闭环 | `server/modules/perception`（`perception-fusion.*`）、`shared/perception-fusion.ts`（`deriveVisionTrunkPitch`）、`standalone_089`、`npm run e2e:perception-fusion`（18 项） | 振动只到通道级（频谱/波形分析需真实振动数据）；视觉→主体绑定依赖相机工位绑定与 track_id 约定（真实相机适配器需按此实现） | keep + strengthen |
| 6 工厂世界模型层 | **较完整**：快照/版本/事件驱动链 + 会话/任务/资源/告警投影 | `server/modules/world`、`shared/world*.ts`、`worldModelExtension`（runtimeVerified） | 订单/物料在世界模型里的位置偏弱（物料走独立闭环） | keep + merge 候选 |
| 7 决策与调度层 | **较完整**：约束校验 → 候选 → 多目标评分 → 方案 → 审批 → 派工 → 回执 → 偏差；冲突面**单一实现**（`ConflictService`，含感知门控 `perception_inconsistent` 提示层，GET 无写副作用）；**控制命令闭环**（审批 → 授权号 → 边缘执行 → 投递确认/回执） | `server/modules/scheduler|approval|workflow`、`test/e2e/golden-path-verify.mjs`（22 项）、`__tests__/conflict-perception.spec.ts`（11 项）、`__tests__/conflicts.spec.ts`（19 项打真实实现） | 预测（duration model）与调度尚未形成"预测→计划→实际"的闭环对账（影子评估有，未回流）；`e2e:golden` 派工步偶发 `PLAN_STALE`（已加有界重试并登记） | strengthen |
| 8 场景仿真层 | **部分**：仿真运行/数字孪生/场景种子 | `server/modules/simulation`、`catalog/`、`db/seed` | 仿真未与"新策略预演"强绑定（policy shadow 有，偏评估） | keep |
| 9 指挥地图与助手 | **较完整**：指挥地图 + 智能体（审批闸门）+ 解释/叙述 + 学习控制台；**运行记忆已全段接进学习回路**（NO-54a 指标 → 信号 → 提案；NO-55a 经验条目/缺口 → 有责任/期限/判据/完成证据的行动项） | `server/modules/agent|ai|reasoning|learning`（`learning-signal.*`、`improvement-action.*`）、`client/src/pages/CommandMap|LearningConsole`、两个真实 PG 场景（各 19 项） | 学习提案种类仍只有阈值类（`rule_threshold`）——行动项已覆盖"改做法"，但"自动生成候选参数值"仍刻意不做（不拿数字装确定性） | keep + strengthen |

## 2. 最近 20 轮的落点（避免"看不见的进展"）

| 轮次 | 主题 | 层 | 证据 |
|---|---|---|---|
| NO-33a/34a/36a/36b/37a/38a/39a/40a/41a/42a | 外骨骼会话域：闭环工作台、佩戴硬约束、偏差复盘、主动提醒、在飞任务边界、任务绑定/继承、遥测双源校验、冲突提醒 | 1/5/6 | `test/e2e/exo-session-loop.mjs`（52 项） |
| NO-43a | 按实际佩戴人更正（交接语义 + 审计链路 + 权限收紧） | 1/6 | 同上（15/15a–15h） |
| NO-44a | 提醒终态：处置即闭环（read ≠ resolved，同事务） | 3/9 | `test/e2e/approval-expiry-reminder.mjs` |
| NO-45a | 统一"提醒→处置→终态"契约并推广到审批到期（含 LIKE 转义安全修正） | 3 | `server/modules/notification/notification-resolution.link.ts` |
| NO-46a | 提醒治理与处置度量（处置率/时长/账龄/反复出现对象） | 9 | `shared/notification-metrics.ts` |
| NO-47a | 安灯/Agent 提醒确定性身份 + 通知号族契约门禁 | 3 | `test/unit/notification/notification-id-families.spec.ts` |
| NO-48a | 安灯"没人接手"主动升级（L1/L2）+ 重新开灯提醒 + 跨租户 worker | 1/3 | `server/modules/oee/andon-sla.*` |
| NO-49a | 设备责任人模型（一职责一 active、审计、缺口显式） | 1/6 | `db/migrations/standalone_083` |
| NO-50a | 责任人页面（缺失显式、空位保留、不猜名字） | 1（交互） | `client/src/pages/Devices/ResponsibilityDialog.tsx` |
| NO-51a | 责任人班次维度（本班优先、全天兜底、他班只报缺口） | 1/6 | `standalone_084` + 5i/5j |
| NO-52a | 交接班责任人核对（覆盖率快照 + 存证 + savepoint 真不阻塞） | 1/6（交互） | `standalone_085` + 5k/5l |
| NO-53a | 数据质量"待核实提醒"：叫到人 + 判定即闭环（同事务终态；并修掉 DR-4 的告警联动死代码） | 3/5 | `standalone_086`、`data-quality-notification.*`、`test/e2e/data-quality-notification-leg.mjs`（14 项）、`test/browser/data-quality-verification.spec.js`（6 项） |
| NO-54a | 学习回路接线：运行记忆 → 信号（证据/样本/可信度/方向）→ 人点生成提案 → 既有影子+人审阶梯（基线漂移 409） | 9 | `standalone_087`、`shared/learning-signal.ts`、`learning-signal.*`、`test/e2e/learning-signal-loop.mjs`（19 项） |
| NO-55a | 经验 → 行动：复盘经验条目/缺口 → 改进行动项（负责人/期限/验收判据/完成证据；与阈值提案并列） | 9 | `standalone_088`、`shared/improvement-action.ts`、`improvement-action.*`、`test/e2e/improvement-action-loop.mjs`（19 项） |
| NO-56a | 多模态感知融合：§5 公式 + 五条可解释规则（一致性/冲突/降级/证据不足/不强建议）→ 快照 + 班次工作台卡片；并修掉摄入映射层两个静默丢数据缺陷 | 5 | `standalone_089`、`shared/perception-fusion.ts`、`perception-fusion.*`、`test/e2e/perception-fusion-loop.mjs`（14 项） |
| NO-56b | 环境多源（区域级同类多源交叉验证）+ `quality_aging` 真实写入方 + 行动项逾期提醒（统一提醒契约 + worker + 迁移 090） | 5/9 | `shared/perception-fusion.ts`（env 源）、`improvement-action-overdue.worker.ts`、`standalone_090` |
| NO-57a | 订单链消费面：投影修复（真读任务/工序）+ 缺口词表 + 统一未完工词表 + 复用物料口径 + Operations 卡片 | 6 | `shared/order-chain.ts`、`order-chain.service.ts`、`OrderChainCard.tsx`、`e2e:materials`（3 项） |
| NO-57b | 预计 vs 实际对账：不可比分类、样本不足不给比率、系统性倾向提示 | 7 | `shared/planned-vs-actual.ts`、`planned-vs-actual.service.ts`、班次工作台卡片 |
| NO-57c | 经验回流知识：行动项完成 → 知识条目（规范证据）+ `outcomeRef`/`outcomeKind` | 9 | `standalone_091`、`improvement-action.service.ts`（knowledge backflow）、`e2e:improvement-action`（17c） |
| NO-58a–c | 行动项对象归属与复发度量 / 感知门控接入推理与调度 / 视觉骨架→躯干角 | 5/9 | `standalone_092`、`shared/perception-fusion.ts`、`e2e:improvement-action` |
| NO-59a/b | 外骨骼关节角→动作 + 置信度按源计权 / 执行机构适配与命令面（回环模拟 + 授权 fail-closed） | 1/2 | `shared/actuator.ts`、`src/edge_platform/edge/adapters/actuator/*`、`e2e:edge` |
| NO-60a | 平台授权 → 边缘执行 → 回执闭环 + 执行边界高危词表同源 | 2/4 | `control.service.ts`、`edge/bridge/control_downlink.py`、`e2e:control-actuator`（18 项） |
| NO-61a/b | 执行机构状态投影到设备台账（AGV 可调度）/ 学习信号"最老积压"可见性 | 2/9 | `projectActuatorDeviceState`、`e2e:agv-transport`、`e2e:learning-signal`（19/19） |
| NO-62a/b/c | 投递前授权复核 + 授权范围指纹 / 下行优先级（安全停机插队）/ 方案过期可解释 + 一键重排 | 2/3/6 | `standalone_093`、`verifyDeliveryAuthorization`、`PlanStalenessPanel.tsx`、`e2e:control-actuator`、`e2e:plan-staleness` |
| NO-62d | Modbus/TCP 真帧路径（主站 + 假从站 + 寄存器契约 + CLI） | 2 | `edge/adapters/actuator/modbus.py`、`test_actuator_modbus.py`（13 例） |
| NO-64a | 事实变化 vs 证据老化的分档闸门（心跳/沉默不再误判过期，依赖资源证据过期仍拒绝） | 2/7 | `world-state.service.ts`（stalenessVerdict）、`e2e:agv-transport`（11/11）、`PlanStalenessPanel.tsx` |
| NO-65a/b | 签名授权范围指纹（HMAC，边缘验签）/ 一车一活投递闸门 | 2/4 | `authorization-fingerprint.ts`、`standalone_094`、`actuator/protocol.py`、`e2e:control-actuator`（26/26） |
| NO-65c/d | 能力停用漂移巡检 + 审批路径恢复 / 场景清理自证 | 6 | `scripts/capability-drift-check.js`、`scripts/capability-restore.js`、`make capability-drift` |
| NO-66a/b | 执行边界人面读面与面板 / 授权指纹密钥轮换窗口 | 3/2 | `ExecutionBoundaryPanel.tsx`、`GET /api/control/requests?deviceId=`、`e2e:control-actuator`（28/28） |
| NO-67a/b | 执行边界浏览器验收 / 单设备投递配额与排队 | 3/2 | `test/browser/execution-boundary.spec.js`（30 项）、`standalone_095`、`e2e:control-actuator`（29/29） |

## 3. 剩余缺口（先审计后立项；成批交付）

> 已销账：第 56 轮审计发现"执行机构动作闭环 / 订单物料投影 / 预测侧 shadow"**其实已有**；
> 第 57 轮完成当时剩下的三项（订单链消费面、预计vs实际对账、经验回流）。
> 下一批在完成一次完整审计后重新推导，不预先抄写。

**第 67 轮批次（已完成并验证，逐项销账）**：
1. ✅ **执行边界浏览器验收（NO-67a）**：`test/browser/execution-boundary.spec.js` 5 用例 × 6 浏览器画像
   = **30 项全绿**（含 axe 无障碍）；覆盖在飞/排队/撤回/验签两维/空态/错误态。
2. ✅ **单设备投递配额（NO-67b）**：`delivered_at` 与"授权复核通过"拆成两个事实（迁移 095），
   配额用尽显式排队（`reason=quota`）、安全动作插队且不占配额；e2e 29/29。
3. ✅ **轮换窗口启动告警（NO-67c）**：`_PREVIOUS` 存在即提示"清零后立即移除"。
4. ✅ **清理自证推广（NO-67d）**：`e2e:plan-staleness` 收尾删除后计数，残留/异常都记 FAIL。
5. ⏳ **下一批候选**：① 配额按"命令类别"细分（运动类更严）与超限告警；② Modbus 批量写事务与重连退避、
   OPC-UA 适配器；③ 清理自证推广到其余场景（capability/agv 已具备）；④ 密钥轮换演练脚本（自动切换 + 观察在飞）。

**第 66 轮批次（已完成并验证，逐项销账）**：
1. ✅ **执行边界对现场可见（NO-66a）**：读面 + 设备抽屉面板（在飞/排队（设备忙）/撤回原因/
   指纹方案与验签结论/违规留痕）；排队口径与投递闸门同一实现。e2e 28/28（含 17b/17c）。
2. ✅ **密钥轮换窗口（NO-66b）**：`_PREVIOUS` 双密钥复核 + runbook 四步与纪律（5 例单测）。
3. ✅ **过期处置接入 golden/wave（NO-66c）**：共享 `approveWithReplan`；golden 22/22、wave 12/12。
4. ✅ **链前漂移预检（NO-66d）**：`e2e-chain` 第一屏打印只读巡检结果。
5. ⏳ **下一批候选**：① 投递配额/流控（单设备每分钟上限）；② Modbus 批量写事务与重连退避、
   OPC-UA 适配器；③ 浏览器 UX 场景覆盖「执行边界」面板（真实浏览器 + 可访问性）；
   ④ 密钥轮换的自动化演练脚本；⑤ 清理自证推广到其余 e2e 场景。

**第 65 轮批次（已完成并验证，逐项销账）**：
1. ✅ **签名授权范围指纹（NO-65a）**：v1 一致性指纹升级为 HMAC-SHA256（平台签发、边缘验签、
   缺密钥显式拒绝且不退回 v1）；`pending` 下发可重建的 `authorizationScope`。
   证据：`e2e:control-actuator` 26/26（v2 + scope + 参数改写被撤回）、跨语言固定向量、边缘 6 例。
2. ✅ **一车一活投递闸门（NO-65b）**：设备在飞（`gateway_received`）时第二条运动命令暂缓；
   安全动作永不暂缓。首版口径缺陷（把 `sent` 算在飞）由单测抓出并修正。
3. ✅ **能力停用漂移巡检与恢复（NO-65c）**：只读巡检 + 审批路径恢复两个工具；
   实测清零 116 台 `exo-lift` 漂移（此前它让 `e2e:exo-session` 误报）。
4. ✅ **场景清理自证（NO-65d）**：清理后计数，有残留即 FAIL。
5. ⏳ **下一批候选**：① `approveWithReplan` 接入 golden/wave（receipt 已接入）；
   ② 投递配额/流控（单设备每分钟上限）；③ Modbus 批量写事务与重连退避、OPC-UA 适配器；
   ④ 指纹密钥轮换流程（双密钥窗口）；⑤ 前端展示 `deferred`（"设备忙，已排队"）与验签结论。

**第 64 轮批次（已完成并验证，逐项销账）**：
1. ✅ **审批窗口的根因修复（NO-64a）**：第 61–63 轮把"方案到达即过期"记成环境事实并以 SKIP/重排绕行；
   本轮审计确认是**判定口径缺陷**——`entityVersions` 混入了随时间自然变化的派生字段
   （设备 `status/online`、证据时钟 `telemetryUpdatedAt`），于是**心跳与沉默都让方案过期**。
   新增 `entityContentVersions`（内容版本）+ `entityEvidence`，审批/派工共用分档判定：
   事实变化 → 拒绝；仅证据老化且**方案依赖**该资源且其证据已不可信 → 拒绝（`EVIDENCE_STALE`）；
   与方案无关 → 不阻断并如实报告；老快照 → 严格判定（fail-closed）。
   证据：`e2e:agv-transport` **11 PASS / 0 FAIL / 0 SKIP**（审批 200、派工 200、assignment=dispatched、
   本设备执行行已生成）；分档闸门 7 例单测 + 客户端分档展示 2 例。
   **同轮 e2e 链首次全绿：18/18 场景、420 PASS / 0 FAIL / 0 SKIP**。
2. ✅ **同轮抓到的两个真实缺陷（都在本批修掉）**：① **审批确认人的身份边界**——
   `confirmed_by` 原写客户端自报的 `body.operator`，而它是"独立审批"闸门与回执授权闸门的输入
   → 可用别人的名字落库 / 把自批伪装成独立审批；现在一律写认证主体（自报只作声明进审计）。
   ② **场景残留**——`e2e:agv-transport` 收尾清理引用了不存在的表名/列（异常被 warn 吞掉），
   残留被 `e2e:receipt` 捡到（7 FAIL + 3 SKIP）。修复后 `e2e:receipt` **19/19**。
3. ⏳ **下一批候选**：① 把 `approveWithReplan` 接入 golden/wave 的审批段（receipt 已接入）；
   ② 授权指纹升级为设备级 HMAC；③ 投递配额/流控；④ Modbus 批量写事务与重连退避、OPC-UA 适配器；
   ⑤ `desc(createdAt)+limit` 类读面复审、SQL CHECK 三值逻辑全库扫；
   ⑥ **场景收尾自检**：所有 e2e 的 cleanup 语句必须"真的删掉了"（计数断言/失败即 FAIL），
   避免残留再次伪装成下一个场景的产品缺陷。

**第 62 轮批次（已完成并验证，逐项销账）**：
1. ✅ **审批窗口设计（第 61 轮遗留 #4）→ 过期可解释 + 一键重排（NO-62c）**：
   审计确认"长时间求解 vs 60s 设备新鲜度"这条限制的真实表现是**用户只看到一句"请重新计算"**——
   既不知道变了什么，也不知道是不是自己造成的（例如刚派了本方案第一波）。
   现在：409 `PLAN_STALE` 体带差异事实（`entityVersions` + `reservations` 增删改，区分外部变化与本方案
   自身执行效果）、新增只读 `GET /api/scheduler/plans/{planId}/staleness`（与审批**同一实现**）、
   页面差异面板 + 一键重排（重排仍走完整审批链）。**注意：这不放宽审批语义**——
   过期仍然拒绝，只是把"拒绝"变成可处置的诊断；"冻结窗口审批"未采纳（会削弱新鲜度闸门）。
2. ✅ **投递时授权复核（第 60 轮遗留 #4）→ NO-62a**：审计证实这不是"可选加强"而是**真实 fail-open**：
   命令落 `sent` 后投递只看请求行是否终态，审批在"下发→投递"窗口内被撤销/过期，命令照样落到 AGV 上。
   现在投递/确认/回执三路径都复核审批时效 + 授权范围指纹（跨语言同源），
   不过即撤回（封闭原因码 + 结果行 + 审计 + 提醒），设备仍执行则回执照记并额外落"未授权执行"违规。
   证据：`e2e:control-actuator`（新增 6 项）。
3. ✅ **下行优先级/配额（第 61 轮候选）→ NO-62b**：`sentAt ASC + limit` 会让排队中的 `stop`
   被搬运命令挤出窗口 → 改为共享词表优先级排序（安全停机插队）+ 边缘侧重排核对 +
   积压可见性（`queued`/`oldestSentAt`/`revoked`/`truncated`）。
4. ✅ **真实硬件协议适配（第 2 层）→ Modbus/TCP 真帧路径（NO-62d）**：
   主站 Transport（MBAP + FC03/FC06/FC10 + 异常响应码 + 越界拒绝）+ 假从站（协议帧真实解析，
   寄存器背后是数字孪生）+ 寄存器映射契约 + CLI `--transport modbus`；pytest 13 例（含 CLI 走真帧
   端到端：平台命令 → Modbus 帧 → 从站 → 设备 moving → ack/回执）。
   **诚实边界：线上协议是真的，设备是模拟的**；真机只需换从站/指向现场 PLC。
   OPC-UA/厂商 API 仍是外部条件（同一 `ActuatorTransport` 接口，未实现）。
5. ✅ **同轮抓到的三个真实缺陷（都在本批修掉，不是"下一批"）**：
   ① `POST /plans/:id/replan` 省略可选字段 `lockedConstraints` → `ConstraintLoader` 直接
   `[...undefined]` → 重排接口 **500**（新 e2e 场景当场抓到）；
   ② **错误路径上的写入被回滚**：`OrgContextInterceptor` 把请求包在事务里，"撤回/事件化 + 抛 4xx"
   会让刚写的撤回、审计、结果行、outbox 事件**全部回滚**（实测：授权复核拒绝后命令留在 `sent`，
   下一轮还会投给设备；`stale_plan` 事件从未真正落库）。新增
   `RequestDatabaseContext.runDetachedTransaction`（独立连接 + 独立事务 + 新 ALS 上下文，
   GUC/RLS 仍生效）承载"拒绝路径上必须存活"的写入；
   ③ `stale_plan` 注释声称"由 outbox 消费者异步重排"——**没有任何消费者做这件事**，
   fire-and-forget 的 `handleTrigger` 还跑在被中止的事务里（求解白跑 + 写丢失 + 长时间占用连接）。
   已改为不假装自动补偿：留痕独立提交，重排入口是显式的 `POST /plans/:id/replan`（页面一键重排）。
6. ✅ **"过期 → 诊断 → 重排 → 审批"接入场景（NO-62c 配套）**：共享助手
   `test/e2e/helpers/plan-freshness.mjs`；`e2e:agv-transport` 12 PASS / 0 FAIL / 1 SKIP
   （审批腿由"诊断→重排→再审批"走通；仅派工被新鲜度闸门拒绝并如实记 SKIP）。
   **同轮修掉 4 处"环境事实被报成产品缺陷"的场景缺陷**：
   ① 人员**档案**新鲜度（`person:master` 24h）：种子超 24h 未同步 → 全员 UNKNOWN →
   候选恒 `person_unavailable` → 搬运任务不可调度（场景改为"档案同步 + 断言 AVAILABLE"）；
   ② 人员位置补帧（`person:location` 60s，与设备心跳同纪律）；
   ③ 候选合格性检查必须放在审批**之前**（审批会给工位建预占 → 之后查候选恒 `station_reserved`）；
   ④ **派工前不得补心跳**（设备实体版本含 `lastTelemetryAt`，补帧会让刚生成的快照立刻过期）；
   ⑤ `e2e:capability-explain` 的任务选择必须排除"当前要求高风险能力"的任务（否则 PATCH 409
   连锁 3 项失败；实测是被中断的 AGV 场景残留任务触发的）。
7. ⏳ **复审项（进入下一批候选）**：把 `approveWithReplan` 接入 `e2e:golden` / `e2e:receipt` /
   `e2e:wave` 的审批段（它们目前仍以 SKIP 记录"快照失效"，处置手段已就绪）；
   `desc(createdAt) + limit` 类"取数上限掩盖最老事实"是否还有其它读面；
   SQL CHECK 三值逻辑是否还有其它迁移（本轮 092/093 各修一处）；
   测试替身列/条件映射缺口。

**第 61 轮批次（已完成并验证，逐项销账）**：
1. ✅ **执行机构状态投影到设备台账（NO-61a）**：`projectActuatorDeviceState` 把位置/电量/故障码/
   在线写进 `ewoh_device`（`COALESCE` 保留已知值）；修掉"AGV 恒 `battery_unknown` → 永不 eligible"。
2. ✅ **搬运任务 → AGV 派工（真实调度器）**：`e2e:agv-transport` 证明候选合格 + 方案把任务派给 AGV；
   审批腿受"60s 设备新鲜度 vs 数分钟求解"限制，按诚实口径记 SKIP 并写明原因（见 §3 下一批候选）。
3. ✅ **提醒记忆的"最老积压"可见性（NO-61b）**：学习信号原来只读最近 2000 条提醒 →
   陈旧待处置积压被近期噪声挤出窗口（信号漏报，原则 7 缺口）；改为"最近窗口 + 待处置按最老优先"
   两条读合并，回归测试在旧行为下必红。证据：`e2e:learning-signal` **19/19**。
4. ⏳ **审批窗口设计（新发现，下一批候选）**：长时间求解后的方案到达即过期——需要
   "run 完成即显式标 stale + 一键 replan"或"冻结窗口审批"这类产品级方案；
5. ⏳ **真实硬件协议适配**：接口 + 回环模拟已就绪，真机需现场设备。

**第 60 轮批次（已完成并验证，逐项销账）**：
1. ✅ **平台授权 → 边缘执行 → 回执闭环（NO-60a）**：命令 payload 落库（`dispatch_task` 必须给目标工位）+
   `GET /api/control/commands/pending`（平台签发授权号 `control:<requestId>`）+
   `POST .../ack`（gateway_received / failed，幂等、终态 409）+ `POST .../receipt`
   （机器身份回执，按 commandId 复用同一套校验）+ 边缘命令代理（`tools/edge_control_agent.py`）。
   证据：`e2e:control-actuator` **18/18**（真实 PG）。
2. ✅ **执行边界词表统一（原则 3/4）**：平台 `HIGH_RISK_COMMAND_KEYS` 并入共享契约
   `ACTUATOR_HIGH_RISK_COMMANDS`——此前 `dispatch_task` 能绕过审批直达设备。
3. ⏳ **真实硬件协议适配（第 2 层，外部条件）**：接口 + 回环模拟已就绪；Modbus/OPC-UA 真机需现场设备。
4. ⏳ **授权号存在性核对**：当前授权号由平台签发并绑定 requestId（构造不出不匹配）；
   进一步可让平台在投递时核验"审批仍有效"（时效闸门已在 `sendCommand` 侧），作为下一批候选。

**第 59 轮批次（已完成并验证，逐项销账）**：
1. ✅ **删除冲突孪生实现（原则 9）**：`SchedulerQueryService.buildConflicts`（≈470 行）与
   `ConflictService` 并行推导冲突，已漂移（缺 `reservation_expiring`/`perception_inconsistent`，
   生命周期/SSE 各写一套），并让 **GET /conflicts 产生 SSE 写副作用**。删除后冲突读面单一委托
   `ConflictService`，未装配即**显式失败**；19 个冲突场景测试改打真实实现（覆盖变强）。
2. ✅ **外骨骼关节角 → 动作（NO-59a）**：`joint_angles` 被摄入却从未参与融合 → `deriveExoAction`
   确定性映射为封闭词表动作（squatting/kneeling/bending/standing），动作维度获得**两个独立源**
   （关节角 vs 视觉动作词），直立性相反即记 `action` 冲突；中间态/缺角 → null + 原因（不猜）。
3. ✅ **置信度按源计权**：修掉"同一源报 N 个维度就拿 N 倍权重"的结构性高估；
   并修掉 `Number(pitchDeg)` 把"俯仰未知"变成"0°"的静默伪造（测试抓到）。
4. ✅ **执行机构适配与命令面（NO-59b）**：边缘 `ActuatorTransport` 协议面 + 确定性回环模拟器 +
   `POST /api/actuators/{id}/commands`（高危命令必须带平台授权号，`stop` 免授权）+
   状态上行 `/api/ingest/actuator` → 世界状态实体行（位置/电量/故障/最后授权号）+
   设备类别 `agv` 与能力 `transport.move`/`observe.actuator_state`；两套词表跨语言逐项对账。
   **真机协议（Modbus/OPC-UA/厂商 API）仍需现场设备**——接口与模拟器已就绪，替换 Transport 即可。
5. ⏳ **verify 基线**：**已清零（12 → 0）**，第 59 轮起改为"新增失败必须修验证资产本身"的常态纪律。

**第 58 轮批次（已完成并验证，逐项销账）**：
1. ✅ **行动项对象归属与复发度量（NO-58a）**：`subject_type/subject_id` 由复盘 incident `target_id`
   派生（迁移 092，成对 CHECK + 封闭词表）；`GET /api/learning/actions/:actionId/effect` 给
   完成前后各一窗口的偏差计数；**无归属 = 不可度量**、**样本 < 3 不给趋势结论**、
   下降只是事实（页面原样显示"不等于这条改进有效"）。
2. ✅ **感知门控接入推理/调度（NO-58b）**：推理事实注入 `perceptionGate`（结论标 `advisoryOnly` +
   原因，门控一致性有契约校验）；调度冲突面新增 `perception_inconsistent`（提示层：**不阻断**调度、
   与在飞任务无关的主体不进冲突面、读取失败如实降级）；冲突号按"主体 + 不一致类型"稳定。
3. ✅ **视觉骨架 → 躯干角（NO-58c）**：`deriveVisionTrunkPitch`（双肩/双髋中点 → 躯干相对竖直夹角，
   支持命名与 COCO 序号；缺要点/低置信/退化 → null + 原因）；姿态维度因此有**两个独立角度源**，
   差值 ≥ 30° 记姿态角度冲突。**振动**已由环境源（`env_sensor`）的同通道交叉验证覆盖，
   本轮不重复造第二套（频谱级分析需要真实振动波形，属外部条件）。
4. ⏳ **真实硬件协议适配（第 2 层，外部条件）**：适配器接口与模拟器已在，真机/网关协议需现场设备。
5. ✅ **verify 基线烧账（工程债）**：**12 项历史失败全部清零（基线文件已空）**，全部是"验证资产自身"
   的缺陷，不是迁移装不上：缺自证标记（058/059/060/067/068 五处）／标记写错迁移号（065 写成 057）／
   verify 从未登记进 `SIMPLE_VERIFY_COMMANDS`（063 → runner 读不到文件）／`FROM (VALUES 'a','b')`
   语法错误（057，基线曾误记为"psql 专属 \gexec"）／psql 专属 `\gset`（064/069）／探针未满足后续
   收紧的 CHECK（053，且 `EXCEPTION WHEN OTHERS` 静默吞错 → 已把 `SQLERRM` 写进断言）／
   可见性探针以 owner（superuser）连接被 RLS 绕过（056 → 改 `SET LOCAL ROLE ewoh_api` 下探针）。
   证据：`make migration-fresh-chain` → apply PASS + verify **90/90 PASS（已知基线失败 0）**。

**下一批（第 60 轮起，先审计再立项）**：完成一次全仓审计后重新推导，不预先抄写。审计的固定检查项：
①清单/README/关键词与实际能力是否一一对应；②新写的读面是否有"静默 0 行/静默空"路径；
③e2e 断言是否只打印不断言；④测试替身是否漏条件；
⑤**同义多实现**（本轮删除的冲突孪生即此类：并行推导 + 各写一套生命周期/SSE）；
⑥**`Number(x)` 类隐式转换把"缺失"变成 0**（本轮实测：`Number(null) === 0`）；
⑦**同一源多维度是否被重复计权**（本轮修掉置信度按观测累加的结构性高估）。

## 4. 四类处置（能力去留）

- **保留（keep）**：调度闭环、约束/审批/派工、事件信封与去重、空间底座、边缘运行时、指挥地图与助手。
- **增强（strengthen）**：学习回路剩余部分（复盘结论/经验条目进提案）、多模态融合（缺口 2）、
  世界模型覆盖面（缺口 3）、预测对账（缺口 4）、执行机构动作闭环（缺口 5），
  以及前几轮垂直链留下的"可运维性"（责任人/班次/交接/数据质量提醒/运行记忆信号均已在 UI 可用）。
- **合并（merge）**：物料/订单的重复投影路径（第 4 项落地时统一到世界模型投影，避免两套读数）。
- **淘汰（retire）**：已无写入方的历史形态——如**随机 id 通知**（NO-47a 已改确定性 id；存量行按 `other` 归类，不再新增）、
  以及 `getDevices` 双路由（`/api/devices` 与 `/api/dashboard/devices`）中的重复实现风险（契约冻结，暂留并标注）。

## 5. 判断"是否只在修补"的量化口径（自我约束）

为避免再次偏科，用三条可核对的口径约束后续轮次：

1. **每轮必须落在 §3 的缺口清单内**（或明确说明为何插队），且一周期的 5 轮里至少 3 轮属于不同层；
2. **修补类工作单独计数**：因自己引入的缺陷而返工的轮次，不得连续出现 2 轮；
3. **框架层同步**：每轮结束必须同步 `feature-status.yaml` / README 能力表 / 本文件的对应行
   （第 52 轮补登记 4 项，第 53 轮新增 `dataQualityVerification`，第 54 轮新增 `learningSignalLoop`，
   第 55 轮新增 `improvementActions`，第 56 轮新增 `perceptionFusion`，
   第 57 轮新增 `orderChainView`/`plannedVsActual`/`improvementKnowledgeBackflow`，
   第 58–61 轮新增 `improvementActionRecurrence`/`perceptionUpstreamGate`/`visionSkeletonPosture`/
   `actuatorAdapter`/`controlActuatorLoop`/`actuatorSchedulingLoop`，
   第 62 轮新增 `controlDeliveryAuthorization`/`actuatorCommandPriority`/`planStalenessDiagnosis`，
   第 64 轮新增 `modbusActuatorTransport`/`freshnessContentVersionGate`，
   第 65 轮新增 `signedAuthorizationFingerprint`/`deviceBusyDeliveryGuard`/`capabilityDriftPatrol`，
   第 66 轮新增 `deviceExecutionBoundaryView`/`fingerprintKeyRotation`，
   第 67 轮新增 `deviceDeliveryQuota`）。
4. **完成即销账**：§3 的条目落地后必须从清单移出并写进 §2（避免"清单永远挂着同一批下一步"，
   第 53 轮已按此销掉原 #1）。
5. **门禁必须"真的会跑"**：第 53 轮把"全新库全链 apply + 全量 verify"跑通后发现，
   主线 5 的真实空库模式长期没人跑（依赖主机 `psql`），根因是一批**验证资产缺陷**
   （类型不匹配、`pg_policies` 列名、uuid 字面量、`RAISE` 占位符数量）。
   新增 `make migration-fresh-chain` + `db/migration-verify-baseline.txt`（**只许缩小**的
   已知失败基线）把这条跑法固化：apply 84/84、verify 72/84 + 12 项基线内、0 项回归。
   结论：**"有门禁"不等于"门禁跑得动"**——每类门禁都要有一条能在本地复现的命令。
6. **验证脚手架不得吞掉退出码**：第 53 轮的 e2e 链脚本用 `npm run e2e:x | tail -3` 收集输出，
   管道让**失败场景的退出码被 tail 吃掉**（实测 Golden Path 21 PASS/1 FAIL 仍报 exit=0）。
   已改为 `set -o pipefail` + 每场景完整日志 + 打印 FAIL/SKIP 明细；改后复跑 12 个场景
   **302 PASS / 0 FAIL / 0 SKIP**（此前那次 FAIL 是偶发，同一脚本单独复跑 22/22 通过）。
   纪律：**任何"汇总行"都必须能被追到明细**，否则汇总就是叙事。
