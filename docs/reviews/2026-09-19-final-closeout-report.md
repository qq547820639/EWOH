# EWOH 具身智能工厂操作系统 · 阶段结项报告（2026-09-19）

> 本轮定位：不新增孤立功能，以「把已建成的产品闭环**全部验证到绿** + 销账已知缺口 + 修复质量门禁抓出的真实缺陷」为主题收口。
> 全部工作在未提交工作区完成（遵守纪律：未 commit / 未 push / 未动真实外部系统）。

---

## 一、愿景与目标复核结论

以 `docs/architecture/target-state.md` 北极星（Factory Embodied Intelligence OS）与
`docs/architecture/capability-alignment.md` 九层能力对齐表复核，当前仓库**已不是调度后台或功能演示**：

- **感知层**：传感器/相机/定位/环境/外骨骼/执行机构（AGV/PLC）六类上行通道 + 连接器 TCK + 边缘运行时（断网补传/死信/幂等/坏时钟闸门）。
- **世界模型**：ewoh_world_state 实体事实 + 设备/人员/工位台账 + 空间实体 + 能力声明 + 班次域；State/History/Replay/Projection 完整。
- **决策层**：Scheduler V2（优先级→资格→路由→求解器三族→方案→审批→预约→派工→SSE），启发式 canonical，CP-SAT/MILP 激活阶梯门控。
- **授权与执行边界**：审批独立身份、策略门禁（KPI 三态）、签名授权范围指纹（HMAC v2）、投递前再复核、一车一活、配额、安全停机插队——**大模型/自动化不得绕过授权直接驱动设备**的原则由代码与门禁双重落实。
- **反馈与学习**：执行回执→预计 vs 实际对账→运行记忆→学习信号→提案（自批回避）→改进行动项→复盘，全链 E2E 覆盖。
- **交互层**：FactoryOperations 班次工作台（NOW 面板/积压表/策略门禁看板）、Command Map、移动工单（多设备协同/执行状态）、Learning Console；真浏览器验收 121 项。

**结论**：愿景未降级，分层实现与"无真实硬件时以模拟器+数字孪生+对抗场景补位"的路线执行到位；本轮在该基础上把验证体系收敛到全绿并销账两项已知缺口（见下）。

## 二、本轮完成的工作

### 2.1 新能力：执行机构电量合理性闸门（NO-92a，销账 simfarm A6 已知缺口）

- **领域口径**（`ewoh-spark-app/shared/soc-plausibility.ts` 唯一事实源）：对称包络 1.5%/min × dt、量化噪声下限 4 点、锚点时效 30 分钟（过期=unjudgeable 如实接受）、越界/NaN 无条件拒绝、连续 3 帧同一新水平**再锚定**（`soc_reanchored` 标记）。四参数可经 `EWOH_SOC_*` 按机型配置。
- **接线**：`/api/ingest/actuator` 带电量的帧经 `gateActuatorSoc`——非物理跳变 `SOC_JUMP_IMPLAUSIBLE` 显式拒绝（不写台账/世界状态、释放幂等认领、错误文案带完整判据数值）；**同 record_id 重放不虚增连击**（拒绝集去重，1 帧毛刺重放 3 次不得误判持续变化）；锚点读取失败 fail-open（数据优先，留 warn）。
- **选型说明**（豁免外部调研的理由）：领域校验规则而非通用算法——主流开源时序异常检测（prophet/ADTK/pyod）面向统计离群、需训练窗口、不可解释到单帧；工业网关实践（Sparkplug B 死带等）即参数化包络判据。按仓库既有闸门模式（CLOCK_DRIFT_FUTURE_TS 同纪律）自实现，平台侧守在台账投影前（覆盖全部上行入口）。
- **验证**：纯函数 15 例 + 服务级 7 例单测；device-physics 对抗场景 A 腿重写（A4a 拒绝取证 / A4b 再锚定取证 / A7 全链汇总），仿真器新增 `--soc-window-min` 时间窗（物理时间匹配的合法曲线 vs 对抗腿）；**18 PASS / 0 FAIL** 实跑。

### 2.2 TS E2E 规格漂移清账（长期挂账"39 过/19 挂"→ 9 套件全绿）

9 个套件 25 个失败用例逐一修复（**修 spec 对齐现行契约为先，确证产品错误才动产品**），实测揪出 **4 个真实产品缺陷**：

| # | 缺陷 | 修复 |
|---|------|------|
| 1 | 并发 replan 同根算出同 `newPlanId`，输家撞唯一键 23505 冒 500 | `plan.service.ts` 原生约束竞态→409 `PLAN_REPLAN_CONFLICT`（+3 单测） |
| 2 | `scale.service.generateSupportBundle` 漏传 actor → 非 global_admin 恒 400 / global_admin 全租户 trace 泄漏进单租户支持包 | `scale.service.ts` 补 actor（+2 单测钉死） |
| 3 | legacy `POST /api/scheduler/plans` actor 三跳断裂 → 已认证调用方恒 401（文档化路由坏死） | controller/service/orchestrator 透传（+单测） |
| 4 | **heuristic/rule-based 求解器只映射 person 预约，device/station 预约被静默丢弃** → 派工到已预占设备、dispatch 硬后盾 409 | 两个求解器三类全量映射（+3 回归单测；409 的 fail-closed 语义不动） |

规格漂移侧：ewoh-http 33/33（refresh cookie 语义、幂等快照、OEE 证据、审批图服务端映射等 9 处）；f61-02 注错手段 revoke→rename（owner 特权下 revoke 是空操作）；org-rls-guc/pg-temporary-failure 修正运行角色与 harness 形态前提（RLS 断言必须对 NOSUPERUSER NOBYPASSRLS 角色成立；故障注入改子进程生产形态使 R-4 守卫真实生效）；concurrency exclusion 双码；scheduler-upgrade policy 候选自建注册。

### 2.3 质量门禁抓出并修复的缺陷（先红后绿）

1. **迁移 ID 冲突**：工作区两个迁移同占 `standalone_101` → 迁移链 Duplicate ID 直接失败。积压快照重编号 **102**（文件/runner/verify 标记/文档引用同步；runner 中误指 `standalone_097_verified` 的标记一并修正）。
2. **OpenAPI 文档缺口**：`GET /api/control/delivery-backlog/history` 实现与 manifest 在册但 ewoh.yaml 缺路径 → 补契约 + 重生成两份 route-manifest（469 操作 / 0 未文档化 / 0 未实现）；`IngestResponse` 契约补 `soc_reanchored`（三投影同步）。
3. **RLS 缺口**（`audit-unrls-tenant-tables` 实测抓出）：迁移 102 的 `ewoh_control_backlog_snapshot` 含 org_id 未开 RLS → 补 org 隔离策略（KPI 快照表同款 GUC 判据）+ verify 断言 RLS/策略存在；四库重放 + 全新库全链验证通过。
4. **control-actuator 首跑 6 失败的根因（产品正确，harness 配错）**：场景进程未导出 `EWOH_CONTROL_FINGERPRINT_SECRET`，边缘代理用回退密钥本地验签平台签名失败、按 fail-closed 回传 → 平台**正确地**拒投并撤销（审计留痕 `fingerprint_signature_invalid`）。补齐环境后 **31/31**。链脚本 usage 已补凭据清单。

### 2.4 文档与事实源同步

- `CHANGELOG.md`：本轮全部批次条目（含教训三则）。
- `feature-status.yaml`：新增 `socPlausibilityGate`（implemented/tested/deployable/runtimeVerified）、积压快照条目迁移号修正；`scripts/truth-feature-status.js` 81/81 PASS。
- `README.md` 能力状态清单：新增 SOC 闸门行。
- `docs/reviews/2026-09-15-simfarm-adversarial.md`：已知缺口 ① 标记销账。
- `scripts/e2e-chain.sh`：usage 补齐凭据纪律（OPERATOR_PASS / FINGERPRINT_SECRET / 可选 PG_URL、PERSON_ID）。

## 三、验证命令与结果（全部实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| Python 边缘平台 | `make test` | 1248 OK（2 skipped 环境敏感） |
| Python lint/安全 | `make lint` / `make security` | ruff 0 错误；bandit 0 critical/high |
| 类型检查 | `npm run type:check` | server+client 0 错误 |
| 服务端主套件 | `npx jest` | **387 套件 / 3483 用例全绿** |
| 前端主套件 | `npm run test:client` | **175 套件 / 1718 用例全绿** |
| 浏览器验收 | `test:browser:mock`（13 spec） | **121 passed** |
| OpenAPI | `gen:openapi:check` + `audit-openapi-routes --strict` | in sync；469 操作 0 缺口 |
| 事件契约 | `contract:events` / `audit-event-envelope` / `audit-domain-contracts` | 70 msg/70 ch；PASS；PASS |
| Golden 契约 | `make contract-golden` / `scheduler-golden` / `contract-envelope` | 330 / 6 / 4 全过 |
| 防回归十二主线 | `make audit-regression-gates` | 全部通过 |
| 迁移链（本地库） | `make local-up`（NO_SERVER=1） | 100 项 verify 全过 |
| 全新库全链 | `migration-fresh-chain-check.js` | apply PASS · verify **100/100** · 基线外 0 失败 |
| 事实源一致性 | `node scripts/truth-feature-status.js` | 81/81 PASS |
| 契约触达面 | `make audit-contract-touchpoints` / `contract-state-machine` / `contract-identity` | 全过 |
| 边缘闭环演示 | `make demo-closed-loop` | 12 次 HTTP 操作通过，证据已导出 |
| device-physics 对抗 | `node test/e2e/device-physics-adversarial.mjs` | **18 PASS / 0 FAIL** |
| control-actuator | 同名（完整凭据环境） | **31 PASS / 0 FAIL** |
| exo-session / edge | 同名（PERSON_ID=绑定账号人员） | **53 / 59 全 PASS** |
| receipt | 同名（含 PG_URL） | 17 PASS / 0 FAIL / 2 SKIP（链序环境态，已文档化） |
| TS E2E 9 套件 | `test/e2e/*.e2e.spec.ts`（专用库 + 正确运行角色） | 全绿（33/4/6/2/1/9/…） |
| **20 场景主链** | `bash scripts/e2e-chain.sh`（真实后端 + 真实 PG） | **0 失败 / 0 SKIP（exit=0）** |

## 四、递归修复记录（典型闭环）

1. 迁移 101 撞号 → 本地初始化失败 → 重编号 102 → runner 标记仍指 097 → 修正 → 100 项 verify 过。
2. 路由对齐测试红 → 补 ewoh.yaml 契约 → 生成器仅产 d.ts，route-manifest 需 `audit-openapi-routes --write-manifest` → 重生成 → 6/6 绿。
3. SOC 闸门服务级测试先写（红）→ 实现 → 22 例绿 → 自查发现重放虚增连击 → 补拒绝集去重 + 新单测 → 全绿。
4. device-physics 首跑 A5 人员新鲜度失败 → 探针隔离（位置帧 401→密钥提取修复→逐行理由）→ 补人员位置刷新 → 18/18。
5. control-actuator 6 失败 → 审计日志定位 `fingerprint_signature_invalid` → 确认产品 fail-closed 正确、环境缺密钥 → 补 env → 31/31。
6. `audit-regression-gates` 抓出 102 未开 RLS → 修迁移 + verify → 四库重放 → 十二主线全过。
7. ewoh_api 口令被子会话迁移重放改写 → 后端 503 → 安全引用恢复 + 预防性重设 → 登录恢复。

## 五、已修改的文件与模块（本轮全部改动）

**修复（质量门禁抓出）**
- `db/migrations/standalone_102_control_backlog_snapshot.{sql,rollback.sql}`、`db/verify/standalone_102_….verify.sql`（重编号 + RLS/策略 + verify 断言）
- `db/runner/run_migrations.js`（102 路径与 verify 标记）
- `openapi/ewoh.yaml`（delivery-backlog/history 契约 + IngestResponse.soc_reanchored）
- `openapi/route-manifest.json`、`ewoh-spark-app/openapi/route-manifest.json`（重生成）
- `ewoh-spark-app/client/src/types/openapi.d.ts`（重生成）

**产品缺陷修复（E2E 对抗实测抓出）**
- `server/modules/scheduler/plan.service.ts`（replan 竞态 409）
- `server/modules/scheduler/heuristic-scheduling-solver.ts`、`rule-based-scheduling-solver.ts`（device/station 预约槽位映射）
- `server/modules/scale/scale.service.ts`（support-bundle actor 泄漏）
- `server/modules/scheduler/scheduler.controller.ts`、`scheduler.service.ts`、`scheduler-run-orchestrator.service.ts`（legacy plans actor 透传）

**新能力（SOC 合理性闸门）**
- `shared/soc-plausibility.ts`（新，领域口径唯一事实源）
- `server/modules/ingest/sensor-ingest.service.ts`（gateActuatorSoc 接线 + 重放连击去重）
- `tools/device_physics_sim.py`（--soc-window-min 时间窗 + 逐帧响应留痕）
- `test/e2e/device-physics-adversarial.mjs`（A 腿重写为对抗契约 + 人员选取加固）

**测试**
- `server/modules/ingest/__tests__/soc-plausibility.spec.ts`、`sensor-ingest-actuator-soc-gate.spec.ts`（新）
- `server/modules/scale/__tests__/support-bundle-trace-scope.spec.ts`（新）
- `server/modules/scheduler/__tests__/{plan-persistence,r2-sch-p1-regression,scheduler-facade-characterization}.spec.ts`（扩充）
- `test/e2e/{ewoh-http,concurrency-real-pg,f61-02-persistence,org-rls-guc,pg-temporary-failure,scheduler-upgrade}.e2e.spec.ts`（漂移对齐）
- `test/helpers/e2e-http.ts`、`test/helpers/e2e-app.ts`（cookie 语义 + R-4 守卫装配）

**文档与脚本**
- `CHANGELOG.md`、`README.md`、`feature-status.yaml`、`docs/architecture/capability-alignment.md`、`docs/reviews/2026-09-15-simfarm-adversarial.md`、`scripts/e2e-chain.sh`、本报告

## 六、关键架构决策（本轮新增/确认）

1. **SOC 闸门守在平台侧台账投影前**（而非边缘单通道）：平台闸门覆盖所有上行入口；拒绝=不写世界状态与台账（不可信读数不得进入事实源，原则 7），原始观测经边缘死信与响应回显可取证。
2. **拒绝是可重复观察的事实**：拒绝帧释放幂等认领、同 record_id 重放重现拒绝且不虚增再锚定连击——把"at-least-once 重投"与"设备新观测"严格区分。
3. **再锚定语义**：单帧毛刺 vs 持续真实变化用"连续 N 帧同水平"判据区分，接受时显式 `soc_reanchored` 标记——宁可多一次显式标记，绝不静默改写或静默拒绝。
4. **RLS 裁决纪律**：凡含 org_id 的表必须开 RLS（不允许登记豁免绕过）——audit-unrls 门禁抓出迁移 102 缺口并当轮修复。
5. **E2E 对抗优先修产品而非断言**：9 套件 25 失败中 4 个被确证为产品缺陷并修复，其余按现行契约对齐 spec——杜绝"改断言凑绿"。

## 七、实际运行方式

```bash
# 一键本地产品（PG docker:55432 + 迁移 + 种子 + 三账号 + standalone 服务）
make local-up            # → http://127.0.0.1:3100（admin / DevAdmin#2026x）

# 边缘闭环演示（无需 PG）
make demo-closed-loop

# 20 场景主产品闭环链（真实后端 + 真实 PG；凭据纪律见脚本头）
EWOH_E2E_OWNER_DATABASE_URL=… EWOH_E2E_ADMIN_PASS=… EWOH_E2E_APPROVER_PASS=… \
EWOH_E2E_OPERATOR_PASS=… EWOH_E2E_FIELD_PASS=… EWOH_E2E_INGEST_KEY=… \
EWOH_CONTROL_FINGERPRINT_SECRET=… bash scripts/e2e-chain.sh

# 设备物理对抗（AGV SOC 闸门 + PLC 故障门控孪生）
node test/e2e/device-physics-adversarial.mjs   # 需后端 + INGEST_KEY + OWNER_DB

# 模拟器
python3 tools/exo_fleet_sim.py …      # 虚拟外骨骼机群（真线协议 + 对抗注入）
python3 tools/device_physics_sim.py … # AGV SOC / PLC 故障窗数字孪生
```

## 九、未能验证的外部条件（诚实边界）

- **真机**：外骨骼/AGV/PLC 均为数字孪生与仿真器对抗（Modbus/TCP 为真协议帧，设备物理为建模真值）；热模型系数、SOC 包络参数为行业假设值，现场标定后仅换系数。
- **OPC-UA 真栈**、厂商 SDK、MES/ERP 对接：接口与 TCK 就绪，未经真实对端验证。
- **生产部署面**：K8s/Helm/云部署编排未在本机演练；RLS 在 superuser 连接下语义失效的前提已写进测试纪律。
- **CP-SAT**：未部署 OR-Tools 的环境按 fail-closed 回退（如实 `UNAVAILABLE`），求解质量横向对比见 `e2e:solver-comparison`。
- receipt 步骤 14-16 / edge 步骤 5f 需可选 env（本轮终验已带，见终值）。

## 十、剩余风险与下一阶段自动可执行方向

**20 场景主链终值（本轮最终一次全链实跑）**：`失败场景数：0 / 含 SKIP 场景数：0`（exit=0）——
golden 22、receipt、wave 12、learning 27、capability-explain 28、approval-expiry 22、
observation-reasoning 12、master-data 15、materials 27、exo-session 53、data-quality 16、
learning-signal 19、improvement-action 28、agv-transport 11、**control-actuator 31**、
exo-simfarm 25、**device-physics 18**、plan-staleness 8、perception-fusion 21、**edge 59**
全部 PASS。 receipt 步骤 20/21（本人回执）在本轮链中真实执行并通过（依赖链序产生的
在飞执行记录——该前置已在脚本头文档化）。

1. **postgres@3.4.9 write/close 竞态**：产品以 R-4 进程守卫兜底（本轮已在子进程形态真实演练）；根治需上游式驱动补丁（独立立项）。
2. **工位容量计数**：`bookedStationCounts` 未用快照预约播种（容量>1 工位的历史预约不进计数）——保守方向安全，容量感知对齐可作后续项。
3. **location 帧不反哺路由投影**、**热规则 cooldown 语义**（规则引擎统一改造）：维持挂账。
4. 学习提案仍只有阈值类（刻意不自动生成参数值）；多模态融合缺口 2、世界模型覆盖面缺口 3 维持挂账（capability-alignment §3）。
5. **e2e spec 与契约演进联动**：本轮教训已写入 CHANGELOG——契约演进轮必须同目录 e2e 纳入回归；建议 CI 增加带真实 PG 的 TS E2E job（`.github/workflows/tests.yml` 已有雏形）。
