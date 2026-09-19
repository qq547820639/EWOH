# 仿真对抗验证：虚拟外骨骼机群 + AGV/PLC 设备物理（2026-09-15）

> 回应「你模拟仿真做对抗不就好了？」——对。行业对标（2026-09-14）里被标为
> 「❌ 需真机 / 未实现」的平台侧缺口，本轮用**设备物理仿真 + 对抗注入**验证掉，
> 并在此过程中**实测修掉两个静默失效缺陷**。真正不可数字化的部分如实留在线下。

---

## 1. 对抗设计：谁对抗谁

仿真器扮演"真设备"（物理真值），平台/边缘的推算与门槛被它对抗：

| 对抗面 | 仿真器（真值方） | 被对抗方（被验证方） | 断言 |
|---|---|---|---|
| 热积累 | 独立参数一阶热模型产生电机温度**真值**（真值不进帧——NXP1 线协议无温度字段，只进 stats-json） | 边缘 `thermal.py` 估计器只能从 torque 帧流推算（系数是它自己的默认值，与真值**不同**） | 平台 `DeviceThermalRisk` 事件里的估计值 vs 事件时刻真值插值，±8°C；condition 诚实标注"模型推算，非测量"+ 模型版本 |
| 电量 | SOC 模型持续放电穿越低电量阈值 | 边缘 `LOW_BATTERY` 规则 + 平台事件台账 + 云侧规则引擎 | 边缘与云**双路独立**触发 LOW_BATTERY 且都落账 |
| 线协议 | CRC 坏帧 / SEQ 重放 / 未来时间戳 / 突发粘包 | 真实适配器解码层（CRC/SEQ 去重/重同步）、平台时钟闸、上行桥账目 | bad_crc_frames ≥ 注入数（坏帧零遥测化）；坏时钟显式拒绝；账目闭合 |
| AGV 物理 | SOC 序列流（90→55→20→8→95，含坏传感回跳） | 派工资格门槛 | 95% → eligible；8% → 全候选 `battery_low`（可解释拒绝）；回跳如实接受（**已知缺口**，见 §5） |
| PLC 物理 | 故障门控孪生（真实 Modbus/TCP 帧；fault 态拒绝 dispatch_task）+ 脚本化故障窗口 | 命令闭环的回执终态语义 | 故障期 `execution_failed`（终态不伪装成功）；恢复后 `executed`；gateway_ack 与 command_receipt 两段事实 |
| 佩戴事实 | 设备配置 worker ≠ 会话声明佩戴人 | NO-41a 双源一致性判定 | `wearer_mismatch` + `needsHumanCheck` |

## 2. 交付物

| 类型 | 文件 |
|---|---|
| 边缘热估计器（新） | `src/edge_platform/inference/thermal.py`（+ `tests/test_thermal.py` 9 例） |
| 热积累规则 | `inference/rules.py` `THERMAL_ACCUMULATION`（L2、滞回、冷却、dt 上限/倒退不积分） |
| 事件目录 | `DeviceThermalRisk`（YAML + shared TS + edge Python 三投影同步，70 类） |
| 事件信封补齐 | `inference/events.py`：subject（规范身份校验）+ payload（deviceId/trigger/估计值） |
| 虚拟外骨骼机群（新） | `tools/exo_fleet_sim.py`（真实 RuntimeFactory + 真实 TCP 线协议 + 三腿对抗 + stats 账目） |
| 设备物理仿真器（新） | `tools/device_physics_sim.py`（AGV SOC 流 + PLC 故障门控孪生） |
| 场景链（新） | `test/e2e/exo-simfarm-adversarial.mjs`、`test/e2e/device-physics-adversarial.mjs`；`e2e-chain.sh` 18 → 20 场景 |
| 缺陷修复 | `ingest.service.ts`（exo 坏时钟闸）、`sensor_uplink.py`（批量逐帧账目） |

## 3. 实测结果

### 3.1 `e2e:exo-simfarm`（真实后端 + 真实 PG + 真实边缘运行时，45s 仿真）

**25 PASS / 0 FAIL / 0 SKIP**（2026-09-15 终局取证跑）：

- 三腿产帧 222/222/285；注入改**确定性调度**（CRC 每 25 帧、重放每 30 帧、坏时钟每 40 帧，相位错位互不碰撞）；CRC 注入 8 → 解码层拒绝 10（突发重投递副本计入）；干净腿零坏帧
- SEQ 重放 7、未来时间戳 6、突发 31；上行桥 rejected=8 ≥ 注入数 6（逐帧对账，漏拒一帧即红）
- 热真值 peak 72.1°C；平台事件 est=60.2°C vs 事件时刻真值插值 58.9°C（|Δ|=1.4 ≤ 8）；边缘估计器终点 vs 真值 |Δ|=1.50°C（时钟互洽修复后，残差来自真值/估计参数差本身）
- `EDGE_DeviceThermalRisk` 1 行、`EDGE_DeviceLowBattery` 2 行、云侧 `LOW_BATTERY` 1 行（双路印证）
- 事件信封 eventType/source/payload.deviceId 齐备；事件幂等为**行为级**验证（同一信封重发 → duplicate=true、行数仍 1）
- 三台设备遥测落账（source_type=simulated，220/220/207 行），EXO-03 worker=P-EXOSIM-03；EXO-03 发送 306 帧/落账 207 行——99 个重复副本（重放+突发）被平台幂等吸收，桥 duplicates=70
- 佩戴双源：`wearer_mismatch` + `needsHumanCheck=true`

### 3.2 `e2e:device-physics`（真实后端 + 真实 PG + 真实 Modbus/TCP 孪生）

**16 PASS / 0 FAIL / 0 SKIP**：

- AGV：SOC 帧全落账（rejected=0）；快照电量/位置/能力（transport.move）可见；95% → eligible=1；8% → battery_low=12/12
- PLC：故障窗口 [4s,26s) 内命令 → 经**真实 Modbus 异常路径**拒绝（adapterReason=`device_fault:MODBUS_FAULT_19975`）→ 代理 `execution_failed`（exit 2）→ 平台终态 `failed`（≠ executed）；恢复后 → `executed`；`ewoh_control_result` 两段事实（gateway_ack:delivered + command_receipt:executed success=true）；孪生侧 fault_states=22、modbus_requests=7

### 3.3 回归与门禁

| 门禁 | 结果 |
|---|---|
| 边缘 unittest（`make PYTHON=/usr/bin/python3 test`） | **1229 OK**（+热估计器 9 例 / 热规则 5 例 / 桥批量逐帧对账 5 例，含评审修复回归） |
| 服务端 Jest | **382 suites / 3436 tests 全过**（含 exo 坏时钟先红后绿 2 例） |
| 前端 Jest（`test:client`） | **1706 tests 全过** |
| `bash scripts/e2e-chain.sh`（20 场景全链，终局回归） | **0 失败 / 1 SKIP**（SKIP=e2e:receipt 步骤 20/21——绑定人员无在飞执行记录，链序环境态；单跑 receipt 亦同，与本轮改动无关。两条新链链内 25+16 全绿） |
| `audit-event-catalog.js` | 70 messages / 70 channels，三投影一致 |
| `audit-event-envelope.js` | 24/24 PASS |
| `audit-domain-contracts.js`（含死信注册表仲裁） | 586/586 PASS |
| dead-letter 契约测试 | 12/12 PASS（新增 2 条 reason 向量） |
| bandit 门禁（`-ll`） | PASS（0 critical/high） |
| ruff（src/edge_platform + tools） | 0 错误 |
| 迁移缺口门禁 + 新库全链 | apply PASS · verify **99/99**（含迁移 101；fresh install 从零建库全绿） |
| `e2e:fault-replan`（故障重排全闭环，独立 make 目标） | **18 PASS / 0 FAIL / 0 SKIP**（本轮补跑；此前不在 20 场景链内） |
| TS e2e specs（test/e2e/*.e2e.spec.ts，全新 runtime 库） | **39 过 / 19 挂 → 已定性：规格漂移**（非本轮回归）。铁证：f61-02 handoff 断言 `body.state==='open'`，而 API 实际返回 `status`（createHandoffDurable 字段已改名，env-gated 套件长期无人执行→漂移累积）；同簇 18 例同性质待修（机械但量大，挂账为独立工作包）。另修复两处测试基建缺口：e2e 应用未配摄入凭据（所有 /api/ingest/* 503/401）、runtime 库种子未应用 |
| OpenAPI | 无新增端点，零漂移 |

注：本机 shell 的 `python3` 指向 `.venv-cpsat`（装了 ortools），`test_cpsat_worker_hardening`
中 2 例假设"无 ortools → UNAVAILABLE"在该环境会翻红——属**环境敏感的既有测试前提**，与本轮
改动无关；用系统 python（无 ortools）全绿。

## 4. 实测发现并修复的缺陷（先红后绿；§5b 为对抗评审补抓的完整清单）

### 4.1 exo 通道坏时钟静默落库（平台侧）

`/api/ingest/exoskeleton`（单帧 + 批量）此前只在响应里**标记** `clock_drift`，帧仍照常
INSERT——未来时间戳被写成台账事实。同类闸门在环境/定位/执行机构/事件通道都是显式拒绝
（`CLOCK_DRIFT_FUTURE_TS`），唯独 exo 缺失——仿真器注入未来时间戳帧后，平台账上出现
45 分钟"未来"的遥测。修复：单帧在 entity 预检**之前**先决拒绝（不做任何 DB 读写）；
批量在循环内逐帧拒绝。单测两例（含"不再写 telemetry 行"）。

### 4.2 上行桥批量账目失真（边缘侧）

`SensorUplinkBridge._send_group` 批量路径按 HTTP 整组一口径计数：批量端点返回 201 +
逐帧 results，桥不解析 results——平台逐帧拒绝（如坏时钟）被桥记成 `sent`。实测注入
18 帧未来时间戳全被平台拒绝，桥 `rejected=0`——账目说"全发出去了"。修复：按 `results[]`
逐帧分类（sent/duplicate/rejected），rejected 单帧转死信；results 缺失/错位退回整组口径
（不误判）。修复后 rejected=8 ≥ 注入数 6（确定性调度 + 突发重投递副本），逐帧单计对得上。

同轮对抗评审另实测修掉：**死信注册表缺 reason**（`clock_drift_future`/`event_write_failed`
不在封闭注册表 → 死信落账抛 unknown_reason 被吞，"落死信人审"承诺静默失效，三投影补注册）
与 **edge_to_spark 通道批量 2xx 不看逐帧 results**（坏时钟帧在该通道会"彻底消失"，补逐帧对账转死信）；
以及**边缘热估计基线被倒退帧反向拖动**（下一帧按 dt_cap 凭空积分至多 5s，改高水位基线）。

### 4.3 死信"落死信人审"的第四层投影缺失（数据库 CHECK 约束）

评审修复了三处代码投影（schema reasonRegistry / shared TS / edge Python）后，**行为级
探针**（POST 一条坏时钟事件）仍然炸出第四层：`ewoh_dead_letter` 的 CHECK 约束
`chk_ewoh_dead_letter_reason` 是白名单的**数据库投影**——应用校验通过后 INSERT 违约，
整个请求 500，依然没有死信行。修复：迁移 **101** 对齐约束白名单（含 rollback/verify，
行为探针验证"新 reason 可插入 + 未注册值仍拒绝"），探针复跑取证：坏时钟事件 →
HTTP 201 逐帧拒绝（error=CLOCK_DRIFT_FUTURE_TS）+ **死信行落账**（reason=clock_drift_future，
status=pending）+ 事件表 0 行——"落死信人审"承诺首次真正闭环。

## 5. 已知缺口（如实记录，本轮不修）

1. ~~**AGV 电量回跳无合理性门槛**~~ **已销账（2026-09-18，NO-92a）**：执行机构电量
   合理性闸门落地（`shared/soc-plausibility.ts` 领域口径 + `gateActuatorSoc` 接线）——
   单帧非物理跳变 `SOC_JUMP_IMPLAUSIBLE` 显式拒绝（不写台账/世界状态），越界无条件
   拒绝，连续 3 帧同一新水平再锚定（`soc_reanchored` 标记）。device-physics 场景
   A 腿重写为对抗契约（A4a 拒绝取证 / A4b 再锚定取证 / A7 全链汇总）。
2. **热模型系数是假设值**：k_heat/tau_cool 未标定（无真机）。估计器的**逻辑**已对抗验证
   （跟踪容差、阈值、滞回、冷却、防风暴），标定后只需换系数，逻辑不变。
3. **location 帧不反哺路由投影**：人员路由坐标来自档案空间实体（`ewoh_personnel.
   spatial_entity_id` → `ewoh_spatial_entity`），实时 location 摄入只写世界状态——
   人员位置变化不会自动更新路由解析的起终点。E2E 前置按档案绑定配置建设（配置类
   前置，非绕过被测逻辑），但 location→路由投影这条集成路径本身不存在，留待立项。
4. **热规则 cooldown 从触发时刻起算**（与全部规则引擎一致，非热规则特有）：事件收口后
   到再触发之间的实际静默窗可短于 cooldown_sec；滞回（5°C）承担主要防抖职责。若现场
   需要"收口后静默 N 秒"语义，属规则引擎统一改造。

## 5b. 对抗评审（4 视角 × 25 findings，全部处置）

实现完成后按 ultracode 流程跑了四视角对抗评审（物理模型正确性 / E2E 可证伪性 /
集成与门禁 / 文档诚实性），每视角独立试图证伪。处置结果：

| 视角 | findings | 处置 |
|---|---|---|
| 物理正确性 | 2 major + 2 minor + 2 nit | **全改**：热基线高水位化（倒退帧不得拖动基线→凭空积分，回归测试钉死下一帧增量）；心跳不推进仿真时钟（三套时钟互洽）；NaN torque 按 0（不解除武装，+单测）；帮助文本/弱断言收紧 |
| E2E 可证伪性 | 1 major + 6 minor + 3 nit | **全改**：SEQ 重放断言改为实际契约（重复副本按确定性 record_id 被平台**幂等吸收**——实测发 306 帧/落账 207 行，桥 duplicates=70），链头措辞纠正；坏时钟拒绝逐帧对账（rejected ≥ 注入数）；事件幂等升级为行为重放；故障拒绝必须带 `adapterReason=device_faulted`（孪生账目留痕）；B 腿恢复等待锚定端口就绪时刻 + 孪生进程 kill 兜底；A6 观察项配真实取证；未认证/可达拆分；工位缺失显式 SKIP |
| 集成与门禁 | 1 major + 3 minor + 2 nit（+行为探针追加 1 个 major） | **全改**：死信注册表补 `clock_drift_future`/`event_write_failed`——行为探针发现**第四层投影**（DB CHECK 约束未同步，落死信从静默吞掉变违约 500），迁移 **101** 对齐 + 探针取证（死信行真实落账）；exo 批量 accepted 分支死代码移除；两通道批量逐帧对账补 5 个单测。**minor**：edge_to_spark 通道补逐帧对账（否则坏时钟帧在该通道"彻底消失"）；批量 results 逐帧分类的行为断言已入链（rejected ≥ 注入数）；独立单元测试由本轮 e2e 行为断言覆盖，细粒度单测留待补充；events payload 补热指标类型化字段（estimatedTempC/modelVersion）并注明 orgId 由云端归属。**workbench-now generatedAt 伪造问题非本轮引入，登记不修（属前一批次范围）** |
| 文档诚实性 | 1 major + 1 nit | **全改**：场景链计数 16→18 更正为 18→20（少报也是错）；"真实设备不会带病执行"改为假设式表述（该前提属真机边界） |

## 6. 诚实边界（未验证 ≠ 通过）

仿真覆盖的是**平台/边缘侧逻辑**：阈值判定、累积模型的一致性、事件必达、幂等去重、
资格门槛、回执终态语义、死信留痕。以下仍然**只有真机能回答**，本轮不声称覆盖：

- 热模型的物理保真度（真实电机的 k/τ 与温度-寿命曲线）；
- 设备控制器层的安全闭环（IEC 61508 / ISO 13849——平台本就不做安全控制，分层不变）;
- 真人工效学（真实作业姿势分布、人体测量）；
- 真实退化速率（设备物理寿命需要真机长期运行数据）；
- 真实无线电/网络物理层（仿真里的断网/重放是传输层语义，不是射频现实）；
- **TS e2e specs 的全新库绿基线**（19 红已定性为规格漂移；修复 18 例旧断言 = 独立工作包）；
- **MILP 适用边界 bug**：buildLpModel 在 40 任务规模爆栈（RangeError），小规模（8 任务）OPTIMAL 可用——挂账修复；CP-SAT 在合成负载上返回「OPTIMAL+空指派」（objective 对未指派无惩罚），真实负载 SHADOW=OPTIMAL 已有取证——objective 建模待立项；
- 本轮新增代码的**细粒度单测全覆盖**（桥批量对账已补 5 例；FaultGatedLoopback 守卫仅有直接调用冒烟验证 + Modbus 路径实测，未入库为正式单测）。

## 7. 结论

「需真机才能验证」的平台侧缺口，绝大部分可以在软件里对抗验证——本轮把行业对标里的
「热积累：未实现」转为「已实现（仿真对抗验证，系数待标定）」，把 #13/14/15 从
「❌ 无法验证」改为「平台侧链条已仿真对抗验证 + 如实标注真机边界」，并在过程中
实测修掉静默失效缺陷（§4 两个 + §4.3 数据库约束第四层 + §5b 评审清单），并补跑
此前不在链内的 fault-replan（18/18）与 TS e2e specs（暴露全新库基线缺口，挂账 §6）。
剩余边界见 §5/§6。「所有代码完完全全做过对抗」仍不成立——对抗是按风险切片推进的
持续过程，本轮切片见 §1/§3，未覆盖清单见 §5/§6，全部如实挂账。
