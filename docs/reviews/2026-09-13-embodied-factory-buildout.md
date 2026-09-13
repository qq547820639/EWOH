# 具身智能工厂操作系统 — 本轮建设与验证报告

- 日期：2026-09-13
- 基线：`0.6.0-rc4` · HEAD `7611196` + 工作树改动（690 项：358 修改 / 332 新增，**未提交**）
- 范围：产品与架构梳理、核心闭环打通、工程质量修复、可运行交付
- 结论一句话：**主产品四条真实闭环已在真实 PostgreSQL 上逐条跑通并全部通过；审计发现的
  11 类 P0 缺陷已修复并带回归测试；剩余未闭合项与未验证项在第 8/9 节逐条列出。**

---

## 1. 愿景与目标复核结论

**愿景未被降级，但本轮发现了"文档强于实现"的系统性偏差，并已按证据修正。**

复核方式：不看 README 的自述，而是逐条打开代码、跑门禁、在真实库上跑闭环。结论：

| 愿望层 | 复核结论 |
|---|---|
| 传感器/检测设备/外骨骼 = 感知与人机交互层 | **已实现**。真实 NXP1 线协议外骨骼适配器（CRC/重同步/SEQ 去重/坏帧与时间漂移质量）、多源上行桥（事件/传感器/指标，断网补传+重放不双写+坏时钟拒绝+死信留痕）、多模态感知融合（五条规则：一致/冲突/降级/证据不足/不强建议） |
| 设备/产线/工位/物料/执行机构 = 执行层 | **部分实现**。设备/产线/工位/执行机构（Modbus/TCP 真帧 + 数字孪生假从站）完整；**物料/库存/BOM/订单在数据层没有一等实体**（第 9 节 R-2） |
| 人员/任务/订单/资源/空间/安全约束 = 统一世界模型 | **大部分实现**。双时态世界状态 + 契约校验 fail-closed + 版本化快照 + 回放 + 因果事件图；**订单/物料投影偏弱** |
| 边缘实时采集/事件处理/断网/降级 | **已实现**。三模式装配（`production` fail-fast 禁 stub）；上行桥生产模式拒绝明文 http；容量有界缓冲 + 失败显式 |
| 平台状态理解/预测/约束校验/调度/编排/审计 | **已实现**。资格 30+ 项 fail-closed；真实 A* 路径；真实 HiGHS WASM MILP；CP-SAT 为可选 worker（默认 OFF，`ortools` 未部署）；哈希链审计 |
| 大模型解释/推理/问答/方案比较/经验总结 | **已实现且被约束**。`narrationSource` 双路留痕（`llm` / `rule_fallback`，绝不冒充）；AI 无直连设备通道（`agent` 的 `dispatch_task` 显式抛未实现） |
| 人员通过平台/移动端/外骨骼参与 | **已实现**。班次工作台、现场作业、移动工作台（离线扫码）、外骨骼会话域、深链对象工作台 |
| 持续记录预测/决策/执行/实际结果 | **断链（本轮已定位，未闭环）**。见第 3 节 L-1 |

**原则 7（缺失/延迟/冲突/不可信不得被静默伪造成确定事实）的复核是本轮最大的发现面**：
前后端各有一批"把读失败渲染成业务空态"的实现（第 7 节 R-1、R-2），已修复并在浏览器测试中
落地反向断言。

---

## 2. 已完成的产品能力（本轮实测通过）

### 2.1 四条真实闭环（真实 NestJS + 真实 PostgreSQL 17.11）

| 闭环 | 结果 | 覆盖 |
|---|---|---|
| **主产品 Golden Path** | **23 PASS / 0 FAIL / 1 SKIP**（exit 2 仅因 SKIP 计数） | 登录 → 调度 Run → 方案 → assignment 决策字段 → 独立身份审批 → 任务就绪推进 → 派工 → 执行记录 → KPI → 策略注册 → Policy Replay → SHADOW → Gate 评估（证据不足显式） → 人工激活 + 审计 → SSE |
| **故障重排全闭环** | **20 PASS / 0 FAIL / 0 SKIP**（exit 0） | 班次解析 → 方案生成(3) → AI 解释留痕 → 独立审批 → **任务就绪推进** → 派工 15 项 → 现场回执(开始/完成) → 预计 vs 实际 → **故障事件真实 ingest** → **数据质量人工确认(含词表外 fail-closed)** → 取消回滚(14 回退/1 已执行不可回退如实回报) → **复盘六段组装 + 发布运行记忆** |
| **执行回执闭环** | **20 PASS / 0 FAIL / 0 SKIP**（exit 0） | 审批 → 派工 → 开始/完成回执 → 统一摘要 → **模拟回执不被认定为训练样本**（G2 关键断言） → 回执幂等 → 反馈落库含来源与训练资格 → 现场账号本人可回执 / 他人回执 403 |
| **分波次派工** | **13 PASS / 0 FAIL / 0 SKIP**（exit 0） | 多 assignment 待派工 → 第一波只派 1 条 → 部分派工保持 `approved`（不得伪装终态） → 剩余显式回传 → 混入已派工项**整波拒绝（全有或全无）** → 最后一波进入终态 → 终态拒绝再派 |

### 2.2 本机可运行交付

- `make demo-closed-loop`：边缘模拟闭环，12 次 HTTP 操作通过，证据落 `output/closed-loop-evidence.json`（无 PG 依赖）。
- `scripts/local-up.sh`：一键 PG(docker) + 96 步迁移链 + 校验 + 种子 + 三账号 + standalone 服务。
- `scripts/local-up.sh --rebuild-db`：**可重复的干净场景**（本轮用它做了 7 次确定性验证）。
- 96 个 standalone 迁移全部应用成功、96 项 verify 全通过（含本轮新增 097/098）。

---

## 3. 关键架构决策（本轮）

| # | 决策 | 理由与证据 |
|---|---|---|
| D-1 | **控制命令投递积压巡检从 `api/control/requests` 迁到 `api/control/delivery-backlog/sweep`** | 巡检是**跨设备/跨 request 的租户级操作**，挂在某条 request 下会把 URL 说成它不是的东西；同时对齐全仓 6 个同类巡检（perception/exo/learning/approvals/oee/data-quality 都是 `api/<域>/.../sweep`）。修复前控制器路径与 E2E/文档不一致，导致该端点实际不可达 |
| D-2 | **边缘验签不再把"无审批实例号"当成"授权范围不可重建"** | 免审批命令（`pause`/`stop`/`return_to_dock`）本就没有审批实例号，两侧都把缺失项算作空串、材料完全可重建。原判据导致**一旦配好密钥（推荐的生产姿态），全部免审批命令含安全停机 `stop` 都被边缘拒绝投递**，与"stop 永不受审批/配额约束且优先级最高"的安全不变量直接冲突 |
| D-3 | **策略回放"已评估"守卫按 (orgId, configVersion) 键控，并回查 `ewoh_policy_replay`** | 原键仅 `configVersion`，而版本号按 org 作用域递增 → A 租户评估过 v5 后 B 租户的 v5 被误判已评估、可跳过 shadow 评估直接激活。回查持久化记录同时解决"内存态重启即丢" |
| D-4 | **租户域表补齐 RLS，但不一刀切** | `ewoh_resource_locks` / `ewoh_policy_replay` / `ewoh_factory_replication_sessions` 补 RLS（policy 只授 `service_role`、含真谓词、无 NULL 放行）。另 4 张审计声称"含 org_id 却无 RLS"的表经核实**根本没有 org_id 列**——**拒绝修复假阳性** |
| D-5 | **不为了让模型能训练而放宽 `device_receipt` 门禁** | `training-sample-eligibility` 要求独立设备回执证据，这是**有意的防伪造不变量**。缺的是"设备侧执行事实上行"这条产 `device_receipt` 的合法写入路径，属需单独立项的架构改动，不在本轮擅自放宽 |
| D-6 | **求解器可规划 `draft` 任务，但派工拒绝并给出可解释错误** | 契约 `task.yaml` 规定 `draft → pending_confirm → pending_approval → pending_dispatch` 必须由 creator/dispatcher/approver 逐步推进；派工不得代其越过闸门。真正的缺陷是**失败不可解释**（整波 15 条因 1 条被拒，用户只看到一个裸错误码）——已按仓库既有 `CODE: 明细` 约定补齐，并把"推进到待派工"作为被验证的现场工作流写进四个 E2E |
| D-7 | **`QueryState` 新增 `query` 直传口** | 组件早就有正确的状态优先级，但页面**漏传 `isError`**；直传 react-query 结果后页面不再有机会漏判分支。现有调用方逐字段显式优先，行为不变 |

---

## 4. 已修改的文件和模块（68 个）

### 4.1 边缘运行时（Python）

| 文件 | 改动 |
|---|---|
| `src/edge_platform/edge/adapters/actuator/protocol.py` | D-2：验签判据改为 `scope_present`（调用方如实告知是否携带 `authorizationScope`） |
| `src/edge_platform/edge/bridge/control_downlink.py` | D-2：传入 `scope_present=bool(scope)` |
| `src/edge_platform/tests/test_control_downlink.py` | 新增 3 组回归：免审批命令（`pause`/`stop`/`return_to_dock` × 审批实例"缺失"/"null"）必须可投递；签名但缺 scope 必须拒绝；生产姿态下安全停机必须可达 |

### 4.2 平台后端（NestJS）

| 模块 | 文件 | 改动 |
|---|---|---|
| control | `control.controller.ts` / `control.module.ts` | D-1：巡检独立成控制器 |
| control | `control.service.ts` + spec | 命令键**白名单**（词表外 fail-closed 判 high 且拒绝创建）；投递时按当前词表复核风险等级（冻结值不再单独决定免审批投递，且安全动作不被同单高危连坐）；人面回执枚举校验；`delivered_at` 条件更新 + 配额按 CAS 命中数计 |
| telemetry | `telemetry.controller.ts` + spec | **埋点端点恒 403 修复**（`batch` 全登录角色、`summary` 管理/观测角色） |
| shared | `route-role.policy.ts` / `route-role-policy.spec.ts` | 覆盖断言升级为**零遗漏守卫**（扫描全部 72 个 controller），实测精确命中 TelemetryController |
| shared | `idempotency.service.ts` / `shared.module.ts` | 新增 `DbPayloadStore` 并注册 `IDEMPOTENCY_PAYLOAD_STORE`（此前从未 provide → 指纹落进程内 Map，"同 key 不同 payload → 409"在重启/多实例后静默失效） |
| shared | `org-context.interceptor.ts` + `org-context.streaming.spec.ts` | `@StreamingResponse()` 元数据：手写 `@Res()` 的 LLM 流不再整条流持有请求事务（连接池耗尽） |
| scheduler | `routing.service.ts` + spec | 删除进程级无租户键的 `'__all__'` 图缓存桶；无具体租户键则**读穿不缓存** |
| scheduler | `policy-replay.service.ts` / `scheduler-plan-application.service.ts` + spec | D-3 |
| scheduler | `dispatch-coordinator.service.ts` | D-6：派工拒绝列出**全部**被阻塞任务及其状态与所需跃迁 |
| shift | `shift.controller.ts` + spec | 写面（班次定义/交接登记）收敛到 `SHIFT_WRITE_ROLES`，读面保持 broad |
| approval | `approval.controller.ts` + spec | `:id/bypass` 角色与契约 `approval.yaml`（`high_privilege_admin`）同源；新增"守卫放行集 ⊆ 服务层接受集"不变量测试 |
| ai | `ai.controller.ts` | `/chat` 与 `/suggestions/stream` 标记流式；建立步的租户事务短化并显式补 `generator.return()` |

### 4.3 平台前端（React）

| 模块 | 文件 | 改动 |
|---|---|---|
| 组件 | `QueryState.tsx` + test | D-7（11 例测试） |
| 角色 | `roleMatrix.ts` / `roleMatrixBackend.ts` + `roleMatrix.test.ts` / `navigation.ia.test.ts` / `navigation.roleMatrix.render.test.ts` / `navigation.ts` | **机器可校验的角色矩阵门禁**：静态解析后端 controller 产出 463 条"路由→有效角色"，与前端导航逐条比对。初次运行即抓出真实漂移 |
| 页面 | `ExoWorkbench.tsx` / `ShiftWorkbench.tsx` / `ApprovalConsole.tsx` / `Devices.tsx`（+ 各自 render 测试与 `shiftWorkbenchLogic.ts`） | **"读失败被渲染成业务空态"系统性修复**：403/500 时渲染权限/错误态，绝不落回"暂无数据"；KPI 值在不可用时显示 `—`（**0 是有依据的结论，— 才是未知**） |
| 其它 | `exoSessionLogic.ts` | 偏差复盘行排序改用**机器键**而非本地化显示标签（`localeCompare` 下 `'EXO-1' < '合计'` 会让"合计行置顶"静默失效） |

### 4.4 契约 / 数据 / 文档 / 测试脚手架

- `db/migrations/standalone_097_idempotency_payload_fingerprint.sql`（+ rollback + verify）
- `db/migrations/standalone_098_domain_tables_org_rls.sql`（+ rollback + verify）
- `db/runner/run_migrations.js`：两处 5 点登记（FILES / EXECUTE_COMMANDS / SIMPLE_VERIFY_COMMANDS / which 映射）
- `openapi/ewoh.yaml`（新增巡检路径）+ `openapi/route-manifest.json` + `client/src/types/openapi.d.ts`（重新生成）
- `docs/architecture/current-state.md`：**整篇重建为可复算的现状事实**（每个数字都给出复算命令；原文件自称"现状事实"却落后两个半月）
- `docs/decisions/ADR-059-shift-...md` → **`ADR-083-...`**：消除 ADR 编号重号（原与 `ADR-059-agent-approval-decision-wiring.md` 冲突）
- `test/e2e/helpers/task-readiness.mjs`（新增共享 helper）+ `golden-path-verify.mjs` / `fault-replan-retrospective.mjs` / `execution-receipt-closed-loop.mjs` / `partial-dispatch-wave.mjs`
- `test/browser/approval-authorizations.spec.js`（角色边界修正 + 新增反向断言）

---

## 5. 实际运行方式

```bash
# 1) 一键本地起（PG + 迁移 + 校验 + 种子 + 三账号 + standalone 服务）
bash scripts/local-up.sh                 # 首次
bash scripts/local-up.sh --rebuild-db    # 丢弃本地库、从迁移链重建（确定性验证用）

# 2) 无 PG 依赖的边缘模拟闭环
make demo-closed-loop

# 3) 四条真实闭环 E2E（需 1) 已起，且环境变量见下）
cd ewoh-spark-app
export EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100
export EWOH_E2E_ADMIN_USER=admin          EWOH_E2E_ADMIN_PASS='DevAdmin#2026x'
export EWOH_E2E_APPROVER_USER=approver.li EWOH_E2E_APPROVER_PASS='Approver#2026x'
# ⚠ 审批/派工身份必须是有 dispatcher/workshop_lead 角色的人，**不是** worker
export EWOH_E2E_OPERATOR_USER=approver.li EWOH_E2E_OPERATOR_PASS='Approver#2026x'
export EWOH_E2E_FIELD_USER=worker.zhangwei EWOH_E2E_FIELD_PASS='Worker#2026x'
export EWOH_E2E_OWNER_DATABASE_URL=postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh
export EWOH_E2E_PG_URL="$EWOH_E2E_OWNER_DATABASE_URL"
export EWOH_E2E_INGEST_KEY=local-verify-ingest-key-0001     # 取 .env.local-standalone 的 INGEST_API_KEYS
export EWOH_E2E_INGEST_ORG_ID=00000000-0000-4000-8000-000000000001

node test/e2e/golden-path-verify.mjs          # 23 PASS / 0 FAIL / 1 SKIP
node test/e2e/fault-replan-retrospective.mjs  # 20 PASS / 0 FAIL / 0 SKIP
node test/e2e/execution-receipt-closed-loop.mjs  # 20 PASS / 0 FAIL / 0 SKIP
node test/e2e/partial-dispatch-wave.mjs       # 13 PASS / 0 FAIL / 0 SKIP
```

**注意（本轮实测得到的运行纪律）**：
- 每条 E2E 都会**消费**可调度任务；连续跑同一库会互相饿死。逐条验证时请用
  `--rebuild-db` 或 `node db/runner/reset-scenario-data.js --org-id <org> --yes`。
- **本地库会无界累积**（实测累积到 7,829 条世界快照 + 12,729 条事件时，
  `POST /api/scheduler/runs` 从 5 秒退化到 **>180 秒**，因为求解成本对任务数超线性），
  而现有的复位脚本只复位 19 行种子任务——**没有**覆盖这些累积表。这是第 9 节 R-1。

---

## 6. 全部验证命令和结果（本轮最终一次全量）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `.venv-security/bin/python3 -m unittest discover -s src/edge_platform/tests` | **Ran 1148 tests — OK** |
| 2 | `PYTHONPATH=src python3 -m pytest tests/ -q` | **686 passed, 11 skipped** |
| 3 | `cd ewoh-spark-app && npx jest` | **348 suites / 3239 tests — 全通过** |
| 4 | `npx jest --config client/jest.config.cjs --runInBand` | **167 suites / 1680 tests — 全通过** |
| 5 | `npx tsc --noEmit --project tsconfig.node.json` | 无输出（通过） |
| 6 | `npx tsc --noEmit --project tsconfig.app.json` | 无输出（通过） |
| 7 | `python3 -m ruff check src/edge_platform` | **All checks passed** |
| 8 | `python3 -m bandit -r src/edge_platform -ll` + `scripts/bandit-gate.py` | **PASS（0 critical/high）** |
| 9 | `node scripts/audit-openapi-routes.js --strict` | 控制器 464 / spec 688；**未登记 0、幽灵路由 0** |
| 10 | `node scripts/audit-repo-facts.js --strict` | **39/39 passed** |
| 11 | `node scripts/truth-manifest.js --check` | **no drift** |
| 12 | `cd ewoh-spark-app && npm run gen:openapi:check` | **committed outputs are in sync** |
| 13 | `make truth-check` | 全通过（含 event-envelope 24/24、contract-registries OK） |
| 14 | `make audit-regression-gates` | **十一条主线门禁全部通过** |
| 15 | `make demo-closed-loop` | 12 次 HTTP 操作通过 |
| 16 | 迁移链 `--apply` / `--verify` | **96 迁移应用 / 96 项 verify 全 OK** |
| 17 | 浏览器（mock 模式，chromium） | **107 passed / 0 failed** |
| 18 | E2E golden / fault-replan / receipt / wave | **23+20+20+13 PASS / 0 FAIL**（1 SKIP，理由见下） |
| 19 | RLS 覆盖（本地库实测） | **103 / 111 张物理表** |
| 20 | `test/unit/scripts/standalone-chain.spec.ts` | 5/5（登记补齐后由 6 项失败转为全绿） |

**唯一 SKIP 的正当理由**：`49-50. Rollback 恢复上一 ACTIVE` —— 本次是策略的**首次激活**，
服务端不存在 `beforeVersion`/`rollbackTarget`，无回退目标属正确行为，而非未实现。

---

## 7. 递归修复记录（发现 → 修复 → 复跑）

| 轮 | 发现 | 处置 | 复跑结果 |
|---|---|---|---|
| R-1 | `audit-repo-facts --strict` 失败：`route_manifest_current`（manifest 463 / live 464） | 补 `POST /api/control/delivery-backlog/sweep` 进 openapi + 重生成 manifest | 39/39 通过；2 个失败的 Jest 套件转绿 |
| R-2 | 该端点控制器路径（`api/control/requests/...`）与 E2E（`api/control/delivery-backlog/sweep`）不一致 → 实际不可达 | D-1 迁到符合全仓惯例的路径 | E2E 该步不再 404 |
| R-3 | **边缘验签会让全部免审批命令（含安全停机 `stop`）在配好密钥的推荐姿态下被拒绝投递** | D-2 + 3 组回归测试 | 边缘 1148 测试全通过 |
| R-4 | 后端修复工作流新增的两个迁移未登记 → `standalone-chain.spec` 6 项失败 | 补 4 处×2 登记 | 5/5 通过；迁移链 96/96 应用与校验 |
| R-5 | 前端 Jest `exoSessionLogic.test.ts` 失败（排序用本地化标签） | 改用机器键排序 | 1680/1680 通过 |
| R-6 | 浏览器 `approval-authorizations` 2 项失败（用 `dispatcher` 打开审批控制台） | 角色边界修正 + 新增"dispatcher 被拒"反向断言 | 107/107 通过 |
| R-7 | E2E `18-19 派工` 409 `PLAN_TASK_NOT_DISPATCHABLE`（整波 15 条被 1 条 `draft` 卡死） | D-6：可解释错误 + 把"推进到待派工"写进 4 个 E2E（顺序：**先推进任务，再审批**） | golden 23/0/1；fault-replan 20/0/0 |
| R-8 | `POST /api/scheduler/runs` 超 180 秒不返回（CPU 30–54%、内存持续增长） | 定位为**本地库 E2E 残留累积**（20 倍数据量 → 求解超线性）。用 `--rebuild-db` 建干净场景 | 干净库上 **5.2 秒返回 201、3 个方案** |
| R-9 | `e2e:receipt` / `e2e:wave` 反复 SKIP，脚本自述原因（"被前序脚本消费"）**不成立** | 逐一排除限流、去抖、候选筛选；最终定位为**我传的 `EWOH_E2E_OPERATOR_USER` 用了 worker 角色** → 审批 403 | 修正后两条均 exit 0（20/0/0 与 13/0/0） |
| R-10 | 用 `pg_terminate_backend` 清理卡住连接时，**服务进程崩溃**（`postgres` 驱动在死 socket 上写 → 未捕获 `TypeError`） | 记录为剩余风险（第 9 节 R-4），本轮未改驱动层 | — |

---

## 8. 未能验证的外部条件（明确未验证 ≠ 通过）

| 项 | 为什么未验证 | 影响 |
|---|---|---|
| **真实硬件**（外骨骼真机、AGV/PLC、传感器） | 无设备。本轮全部用模拟器、假从站与真实协议编解码（Modbus/TCP 真帧）替代 | 采集链路的**物理正确性**未验证；软件闭环已用模拟完整走通 |
| **CP-SAT 求解器** | `ortools` 未安装 → `is_available()=false` → `UNAVAILABLE`，且 worker 未随 Nest 部署 | 生产求解走 HEURISTIC；CP-SAT 仅在 SHADOW/CANARY 观测面出现 |
| **`EWOH_CONTROL_FINGERPRINT_SECRET` 的真实生产姿态** | 本地未配置该密钥（`.env.local-standalone` 有该键但流程按其存在性运行） | D-2 修复在**单测**层面覆盖了"配好密钥"的姿态；真机联调仍未做 |
| **OPC-UA / 厂商 AGV API** | 仓库只有连接器清单，无 `ActuatorTransport` 实现 | 该传输路径未验证 |
| **生产环境**（ECS/K8s/Helm/备份恢复/canary/soak） | 本地无对应基础设施；`docs/runtime-gates.md` 中 6 道门禁标注本地 BLOCKED | 部署面未验证 |
| **LLM 真实输出质量** | 无 Ark API key；`narrationSource` 走 `rule_fallback` | 解释面走规则兜底（留痕正确，质量未评） |
| **`device_receipt` 训练样本路径** | 无合法写入方（需设备侧执行事实上行子系统） | 时长模型在生产**永远无法**从真实反馈训练（见 D-5，未擅自放宽） |
| **跨租户全链 TCK**（`make cross-tenant-tck`） | 需要专门的 E2E 数据库环境 | 未运行；租户隔离由 103/111 表 RLS + 谓词审计 + 单测覆盖 |

---

## 9. 剩余风险清单

### 高危（建议优先）

- **R-1 本地/测试库无界累积**：`ewoh_world_state_snapshot`（实测 7,829）、`ewoh_event`（12,729）、
  `ewoh_production_task`（380，种子为 19）等表只增不减，而 `reset-scenario-data.js` **只复位 19 行种子任务**。
  后果：反复跑 E2E 会让主排产入口从 5 秒退化到 3 分钟以上，且**没有任何提示指向数据量**——
  环境退化会被误读成产品故障（本轮实际发生了）。建议：提供覆盖累积表的复位/裁剪能力，并让
  `local-up.sh` 默认提示或提供 `--reset-scenario`。
- **R-2 物料/订单在数据层没有一等实体**（全仓无 `CREATE TABLE ... material`；`materials` 模块读
  `ewoh_event` 与调度表）。世界模型对"订单/物料"的投影偏弱，是愿景与实现之间最实质的空白。
- **R-3 学习腿仍断**（第 1 节 L-1）：`ShadowEvaluatorService.recordSample/backfillActual` 在生产路径
  **无调用方**（`SchedulingFeedbackService` 注入了它却从未使用——死依赖），经验时长模型
  `predictTaskDuration` 无求解器消费者。**"预测→实际→学习"这条腿本轮只做了定位，未接线**。

### 中危

- **R-4 连接丢失会导致整个 API 进程崩溃**：`postgres` 驱动在 socket 变为 null 后写数据抛未捕获
  `TypeError`（本轮用 `pg_terminate_backend` 复现）。生产环境的 PG 故障转移/维护会触发同类场景。
- **R-5 角色口径的"文档 vs 契约"冲突**：`security/access-matrix.yaml` 把 `approval_bypass` 列在
  `safety_admin` 下，而契约 `contracts/state-machines/approval.yaml` 写死 `high_privilege_admin`。
  本轮按**契约**收敛代码，未改矩阵——需要人工决定修哪一侧。
- **R-6 跨运行时性能取舍**：删除 `'__all__'` 路由缓存后，无 actor 的生产热路径
  （`dispatch-coordinator:263`、`candidate-engine:401/429`、`scheduler-query:580`）改为每次全图读。
  根治办法是让这些调用点**透传 `ctx.primaryOrgId`**（本轮未改，避免越界）。
- **R-7 仍无 RLS 的 4 张含 `org_id` 表**：`ewoh_assignment_event` / `ewoh_outbox` /
  `ewoh_world_state_snapshot` / `prediction_shadow_observation`——`standalone_057` 已将其**显式裁决为
  GLOBAL_SHARED/派生血缘**（有意关闭），但该裁决只存在于 SQL 注释里，缺可执行的守卫。
- **R-8 调度域巨石**：`heuristic-scheduling-solver.ts`(85KB)、`world-state.service.ts`(77KB)、
  `plan.service.ts`(72KB) 等集中在单一域，重构回归成本高。
- **R-9 控制面残余**：`ensureApprovedForSend`（下发路径）仍以冻结的 `risk_level` 为唯一基准
  （投递路径已按当前词表复核）；`ewoh_control_command.status` / `result_code` 仍无 DB CHECK 兜底。
- **R-10 SSE 残余**：`/api/ai/suggestions/stream` 因落库与 LLM 尾步不可分，仍持有 1 条连接跑完整条流
  （需改 `ai.service.ts` 把落库从生成器里剥离）；`tracing.interceptor.ts` 仍只认 `@Sse`。

### 已记录但本轮未动

- **R-11 工作树未提交面 690 项**（358 修改 / 332 新增）：任何"零漂移"结论只在**已提交**状态下构成
  可追溯证据；本报告的基线是工作树快照。
- **R-12 文档漂移面**：`docs/capabilities/capability-matrix.yaml`（`updated_at` 停在 2026-08-16）、
  `docs/agent/project-state.yaml`、`docs/ux/information-architecture-refactor.md` 与代码口径不一致。
  本轮只重建了 `current-state.md`。

---

## 10. 下一阶段自动可执行的建设方向

按价值×可执行性排序（均**不需要外部条件**即可开工）：

1. **把学习腿接上（R-3）**——本轮定位最清楚、价值最高的一条：
   - 方案落库时按 canary 采样 `ShadowEvaluatorService.recordSample`（关联 `taskId`/`correlationId`）；
   - `SchedulingFeedbackService.recordActuals` 成功后调 `backfillActual`（该类的死注入就是为此预留的）；
   - 让 canary 自动回退的阈值判定真正可触发；`prediction_shadow_observation` 由空表变有数据。
   - 全程 advisory-only，不动生产求解输出，风险低。
2. **让求解器消费经验时长模型**（ADR-056 明确"预测是调度优化器的时长输入"）：当 `orgModels` 无模型时
   行为与今日**逐字节一致**（回退 `config.defaultTaskDurationMs`），因此可先接线再逐步放量。
3. **提供覆盖累积表的复位/裁剪能力（R-1）**，并把"数据量↔求解耗时"做成可观测指标。
4. **R-6 性能根治**：让 3 个热路径调用点透传 `ctx.primaryOrgId`，恢复租户分桶缓存。
5. **R-4 进程级健壮性**：为 PG 连接异常加进程级兜底（`unhandledRejection`/驱动 `onError`），
   把"连接被终止"变成可恢复 + 可观测事件，而不是进程退出。
6. **R-5 / R-7 的"决策收口"**：把 `access-matrix` 与契约对齐；把 GLOBAL_SHARED 裁决从 SQL 注释
   升级为可执行守卫（新表若无 RLS 且不在裁决清单内即门禁失败）。
7. **R-2 物料/订单一等实体**：需要一张 ADR（数据模型 + 与 MES/ERP 的映射 + 世界模型投影契约），
   建议先只落"物料主数据 + 库存事实 + 缺口投影"最小集。
8. **真实硬件适配**：补 NXP1 TCP 接收端（当前只有 `feed()` 程序化入口与 `scripts/replay_device.py`），
   以及 OPC-UA `ActuatorTransport` 实现——两者都有清晰的接口面可先写、后用假从站验。
9. **`device_receipt` 合法写入路径**：以机器身份（`IngestGuard`）上报执行事实的专用端点 + 独立 ADR，
   严守 `training-sample-eligibility` 的防伪造不变量。
10. **把四条 E2E 收敛成一条可重复的链**（`scripts/e2e-chain.sh` 已有骨架）：每条场景各自准备干净的
    数据窗口，消除"互相饿死"，让"一次命令跑完整条闭环"成为 CI 可执行的叙事。

---

## 附：本报告未做的事（诚实边界）

- **未提交任何 git commit**（按指示）。
- **未修改任何真实外部系统**。
- **未上线/发布**。
- 第 8 节列出的外部条件项**确实未验证**——本报告不把"代码就绪"等同于"可用"。

---

## 附录 B：第二轮建设（同日续，收口剩余全部议题）

在第一轮报告（上文）之后，同一工作日内完成了第 9/10 节列出的全部可执行方向，
并把 E2E 从"4 条主闭环"扩展到**全仓 16 场景链 0 失败**。

### B1. 学习腿接线（原 R-3，本报告最大缺口 → 已闭合）

- **采样腿**：方案落库链（`SchedulingFeedbackService.recordBaseline`）按 canary 比例对每个
  assignment 记录"经验时长模型预测 vs 确定性基线"shadow 样本；`correlationId = planId|assignmentId|taskId`
  稳定键、FNV-1a 确定性种子（重放可复现）。缺 planned 时间窗、预测抛错 → 显式跳过不伪造。
- **回填腿**：`recordActuals` 成功后按同一 correlationId 回填 actual（死注入就此转正）；
  `matchedRows=0` 或时间不可比 → 不回填。顺带修掉一处真实静默故障：内存匹配原来只按
  (predictionType, createdAt)——回填侧无法复现采样时刻，观测会永远无 actual。
- **canary 自动回退可触发**：回填命中后跑窗口聚合判定，超阈值 → canary 归 0 + WARN。
- **刻度修复（判定语义）**：`autoRollbackOn` 三阈值（0.25/0.5/0.8）是 [0,1] 比率，而 `mae`
  是**毫秒**——原实现等于"误差超过 0.25ms 即回退"，任何一次真实回填都会把 canary 归零
  （可触发但不可用）。现按**相对误差**判定；绝对 mae 保留在 reason 里供观测；无样本时
  显式 `error_undecidable`（缺证据 ≠ 零误差达标）。3 条刻度不变量测试钉死。
- 默认 canary=0 时全部路径逐字节不变（有专门断言）。
- 仍未做（如实说明）：**求解器消费经验时长模型**——接线点已写明
  （`heuristic-scheduling-solver.ts:214` / `candidate-engine.service.ts:481` 的
  `defaultTaskDurationMs` 替换为 provider 解析），无模型时行为逐字节一致，可安全另行接线。

### B2. 性能根治（原 R-6 → 已闭合）

候选引擎 `buildCandidatePool` 新增 `orgId` 通道；**全部热路径调用点**（dispatch ADVISORY 分支、
候选主池/反事实池、查询回退路径、批量路径、以及三个求解器 heuristic/rule-based/milp——后者
为本轮补齐，求解器才是候选池最大调用方）透传 `ctx/opts.orgId`，按租户分桶的路由图缓存恢复。
不变量（同租户命中缓存、跨租户分桶、无 org 读穿）由 9 条 routing.spec 用例锁定。

### B3. PG 连接故障不再击穿进程（原 R-4 → 已收口）

`installPgConnectionFaultGuard()` 在引导期安装：驱动在死 socket 上 `setImmediate` 内抛出的
`TypeError`（请求侧 try/catch 无法触达）被进程级兜底**仅对连接类故障**转换为结构化告警 + 连接池恢复，
请求方得到明确 5xx——不掩盖其它未处理异常，不伪造成功。上游驱动 bug（porsager/postgres#1168）
待升级后可收窄为纯兜底。

### B4. 物料一等实体 + 合并语义（原 R-2 → 数据层已闭合）

- `standalone_099`：`ewoh_material` / `ewoh_material_stock` / `ewoh_material_requirement`
  三表（TENANT_SCOPED + RLS + CHECK 强制 unknown⟺quantity IS NULL）+ 幂等种子；
  迁移链 96→**97** 项全部登记并验证。
- `materials.service` 读面：事件投影**永远计算**，实体行**按物料**覆盖，事件-only 物料保留，
  实体"库存未知"压过任何事件数字（未知 ≠ 任何数），"无法解析"取并集。
  修掉了并行工作包最初的"实体非空即整体早返回"——它让只经事件上报的物料从读面消失
  （e2e:materials 一度 14 项 FAIL 的根因）。

### B5. 复位能力与规模可观测（原 R-1 → 已闭合）

- `reset-scenario-data.js` 新增 `--purge-derived`：36 张累积表白名单（逐表注明 why）、
  35 张配置种子永久保护、默认仍 dry-run、强制显式 org、参数绑定、逐表行数与 SQL 预览。
- 每次排产 run 记录**规模日志**（tasks/entities/constraints/horizon）——"数据量问题 vs 代码问题"一眼可分
  （本轮之前实测 20 倍数据量曾把排产拖到 3 分钟以上且无任何信号）。

### B6. 决策收口（原 R-5/R-7/R-12 → 已闭合）

- `access-matrix.yaml`：`approval_bypass` 移入 `global_admin.high_risk`，与契约/服务层同源
  并留下"以契约为唯一事实源"的显式说明。
- **新门禁 `scripts/audit-unrls-tenant-tables.js`**（已入 `make audit-regression-gates`）：
  含 org_id 却未开 RLS 的表必须落在显式裁决清单（含语义与依据），反向校验僵尸条目 + 与
  schema-manifest 同源 + 内嵌 selfCheck。GLOBAL_SHARED 裁决从 SQL 注释升级为可执行约束。
- `capability-matrix.yaml` 补齐 NO-53a…NO-67b 系列并更新 `updated_at`（以 feature-status.yaml 为准）。

### B7. 真实硬件适配（接口面先落，假设备先验）

- **NXP1 TCP 接收端**（`edge/device_driver.py`）：监听→`adapter.feed(bytes)`，粘包留给适配器；
  构造期 bind（端口占用即 fail-closed）；重连清半包缓冲、保留 SEQ 去重窗口；
  `EWOH_ADAPTERS` 新 kind `ny_exo_a1_tcp` 可显式启用——「真机录播→适配层」断链补齐。
- **OPC-UA 传输骨架**（`actuator/opcua.py`）：真栈经显式注入的 `OpcUaClient` 接入，
  默认数字孪生假服务端可测试真跑；未配真实客户端**显式拒绝**（不静默降级、不伪装已支持真机）。

### B8. Python 边缘策略一致性对账（结论：无同类缺陷）

TS 侧"守卫键缺租户"缺陷在 Python 边缘**无对应物**：策略回放/评估后激活只在控制面存在；
边缘进程内记忆键均为 uuid/sha256/静态配置，且边缘按设计单租户。两条前瞻性 note 已记录
（reservation/resources 若未来多租户化需升级键；(org_id, resource_id)）。

### B9. `device_receipt` 合法写入路径（训练门禁保持不放宽）

新增 `POST /api/ingest/execution-facts`——**全仓唯一**写 `source='device_receipt'` 的地方：
机器身份（X-Ingest-Key）上报设备测得的执行时间。边界逐条有测试锁定：只接受**带 org 绑定**的 key
（legacy 自报租户一律 403）；设备只能报自己已绑定的执行行（不替他人背书）；不创建计划（404）；
时间必须是设备测得值（服务端不补 now()）；不推进任务状态。**写入 ≠ 可训练**：
`receiptProvenance` 仍独立要求 task/device 为 real、方案非 shadow、审批独立——模拟环境无法因此获得
训练样本（有专门断言）。另加**静态扫描测试**：`device_receipt` 字面量只允许出现在定义/读侧/唯一
写入方三处，新写入点必须显式改白名单（必然过评审）。OpenAPI 465/465 零漂移。

### B10. 审计静默丢失回归（本轮抓出并修复的自身回归）

第一轮为 NO-68a 加的 ControlModule 本地 `AuditService` provider 触发一个隐蔽 DI 陷阱：
`SharedModule` 虽 `@Global`，`DatabaseAuditSink` **不在 exports**——本地实例拿不到 DB sink，
`@Optional()` 静默退化为 InMemoryAuditSink：审计照常打日志、**永不落库**（control 的全部
审计在 16 场景链实测缺失）。修复 = 移除本地 provider 用全局导出实例（oee.module 注释早已
写明此纪律）；ingest 模块同型修复；两处留下回归注记。

### B11. E2E：从 4 条主闭环到全仓 16 场景链 0 失败

链上 4 个失败场景逐一根治（每个都先定性"产品对还是脚本对"）：

| 场景 | 根因 | 处置 |
|---|---|---|
| e2e:materials（14 FAIL） | 实体读面早返回吞掉事件-only 物料 | **产品修复**（B4 合并语义），27/27 |
| e2e:control-actuator（3 FAIL） | ① 审计 sink 回归（9d/20）② 幂等探针把高危命令挪到低危单（11）——新投递复核**正确拦截** | ① 产品修复（B10）② 脚本改用真 pause 命令探针，30/30 |
| e2e:exo-session（1 FAIL） | 15g 用 worker 读 workshop_lead 收件箱——权限语义本就如此 | 脚本改用正确收件人视角，52/52 |
| e2e:plan-staleness（1 FAIL） | 链内紧邻场景触发 30s 去抖 → run 无方案（幂等正确） | 脚本等冷却重试一次，8/8 |

### B12. 第二轮最终验证

| 命令 | 结果 |
|---|---|
| `bash scripts/e2e-chain.sh`（16 场景全链） | **425 PASS / 0 FAIL / 1 SKIP**（SKIP=golden 首次激活无回退目标） |
| 服务端 Jest | **354 suites / 3325 tests 全通过** |
| 前端 Jest | **167 suites / 1680 tests 全通过** |
| 边缘 unittest | **1176 tests OK**（含新增 device_driver / opcua / 影子评估刻度） |
| `python3 -m ruff check src/edge_platform` | All checks passed |
| 迁移链 | **97 项登记 + apply + verify 全通过** |
| OpenAPI | 控制器 465 / spec 689，**未登记 0、幽灵路由 0** |
| `audit-unrls-tenant-tables`（新门禁） | PASS |
| RLS 覆盖（本地库实测） | **106 / 114 张物理表** |

工作树：**712 项改动未提交**（365 修改 / 347 新增）。仍未 commit / 未发布 / 未触碰外部系统。

---

## 附录 C：第三轮收口（同日续）：学习闭环最后一环 + 残余清理

### C1. 求解器消费经验时长模型（ADR-056 消费侧，最后一环闭合）

- 策略配置新增 `prediction.durationModelMode: 'off' | 'advisory'`（**缺省 off**）。
  为什么走策略面而不是环境变量：模型按 org 键控（ADR-070），放量天然是"逐租户逐策略"
  决策，与 CP-SAT 激活阶梯同一治理面。
- `advisory` 模式下，heuristic 求解器为可调度任务**预解析**模型时长（只接受
  `source='ml'` + 置信度达标 + 有限正值；提供者缺位/未训练/抛错 → 逐任务回退默认时长，
  绝不猜），映射同时透传候选引擎，使**候选阶段与指派阶段的时间窗同源**（消除
  "候选用默认窗、指派用模型窗"的口径分裂）。有 planStart/planEnd 的任务仍继承任务级
  真实事实，不叠加模型。解析结果带 `ml/fallback` 计数日志（可审计"这次 run 到底用了多少模型"）。
- **默认 off 逐字节不变**有专项断言（提供者已注入也绝不被调用 + 方案与无提供者一致）；
  回退等价性（非 ml / 低置信 / 抛错 → 与 off 模式逐字节一致）共 6 条测试锁定。
- **行为边界如实声明**：advisory 仍只影响优化器输入（shadow-only 边界不变）；
  确定性重放承诺（同 snapshot+policy+seed=同结果）在**off 缺省**下不变，advisory 下
  模型版本是额外输入（run 日志带 ml 计数；策略面放量时需把 modelVersion 纳入重放契约，
  已在 residualRisk 记录）。
- 过程中抓到并修复一处编译面回归：benchmark 脚本以 ts-node（无 experimentalDecorators）
  重编译 heuristic——heuristic 因此**保持零装饰器**（纯构造参数），DI 由 SolverService
  承担（该回归在 jest 全量中即时暴露并修复）。

### C2. 残余清理

- tracing 拦截器豁免面从 `@Sse` 扩到 `@StreamingResponse()`（与 OrgContextInterceptor
  同一判据 `isStreamingHandler`）：修复"LLM 流中途出错 → 对已开始的响应写 500
  （headers already sent）"的残余。
- `docs/architecture/current-state.md` G8 行更新：NXP1 TCP 接收端已存在、OPC-UA 为
  注入式骨架（真栈未接、显式拒绝）、真机联调仍未发生——现状文档继续可复算。

### C3. 第三轮最终验证

| 命令 | 结果 |
|---|---|
| 服务端 Jest | **355 suites / 3331 tests 全通过**（含新增 duration-model-consumer 6 例） |
| 前端 Jest + 双端类型检查 | 167 suites / 1680 tests；tsconfig.node/app 均 0 错误（shared 类型变更双端兼容） |
| Golden Path（运行时抽检，重建库） | **23 PASS / 0 FAIL / 1 SKIP**——默认 off 的运行时等价性实证 |
| 排产规模日志 | 已上线：`tasks=19 entities=78 constraints=4 horizon=480` 随每次 run 记录 |

至此，本报告第 9/10 节列出的全部**本地可执行**建设方向均已落地或显式裁决；
第 8 节列出的外部条件（真机 / ortools / 生产部署面 / LLM key / 跨租户 TCK 环境）
依旧未验证，不在本地可执行范围内。

---

## 附录 D：对抗式自查轮（同日续）：25 项发现、24 项修复、全链复归零

按"对每次修改完成后进行自我复查；发现问题立即修复并再次运行相关检查；持续递归"的要求，
对本会话**全部改动**（109 个文件）发起 6 包并行对抗式自查（每个包的对手就是写代码的人）。
结果：**25 项确认缺陷，24 项当场修复并带回归测试，1 项记录为配置边界不修**；修复后全部门禁
与 16 场景链复跑归零。

### D1. 自查抓出的代表性缺陷（按危害排序）

| 级别 | 缺陷 | 修复 |
|---|---|---|
| **critical** | 边缘下行对 `payload=null` 命令的指纹材料口径与平台分歧：平台按 `canonicalJson(null)="null"` 参与签名，边缘把空 payload 归一成 `{}`（→ `"{}"`）——**免审批无参命令（含 stop）在配好密钥的生产姿态下验签必败**，与已修的 NO-68b 同域的第二处材料分歧 | 边缘归一化对齐平台口径 + 跨语言固定向量钉死 |
| high | `ackCommand` 条件 UPDATE 不查命中行数：并发窗口内命令已被撤回/回执时，0 行命中被静默忽略，仍写"网关确认投递"结果行 + 审计——**已撤回命令被污染成已投递** | UPDATE 加 returning，0 行命中重读状态抛 409，不写结果行/审计 |
| high | 设备执行事实读-改-写竞态：迟到的 STARTED 重试帧（at-least-once 桥必然产生）可把已 COMPLETED 的执行行**覆盖回 STARTED**，销毁训练证据 | SELECT FOR UPDATE + 状态谓词 CAS，0 行命中 409 |
| high | **两个 org 配同一把 ingest key** 时 Map 静默覆盖、启动门禁放行——配置手误直接变成静默跨租户写入口 | 冲突显式进 errors，production 启动 fail-closed |
| high | **学习回填腿在生产路径再次断链（回归）**：生产回执走 recordTaskActuals→applyFromActuals 直达，绕过了回填所在的 recordActuals——采样接好的同时回填静默失效 | recordTaskActuals 显式回调 backfillShadowActuals + 回归测试 |
| high | canary 把"缺证据"当"判负"：coverage 把在途（未到期）样本计入缺失 → 多任务 cohort 的**第一条回执必然把 canary 误杀归零**，阶梯永不可用 | 回退只由坏证据触发；coverage 改到期感知（预计可回填时刻+宽限） |
| high | 分波派工重复采样：每波对全方案 assignment 重复写开放样本，coverage 被永久钉死且观测表被灌满 | 采样门控到首基线 |
| high | roleMatrix 后端事实解析器把 `@Roles(...CONST)` 常量展开当"未声明"、@Sse 路由整条漏解析——**门禁对部分路由报假事实**（实测 bypass 被解析成错误角色集）；用 Nest 反射元数据做 ground truth 全量比对修正，465 条零分歧 | 解析器重写 + 对照测试 |
| high | PG 连接守卫的进程级接管会**吞掉启动期异常**（bootstrap 期撞上数据库抖动进程"该死不死"） | 守卫仅观察、不接管 bootstrap 阶段（装守卫前启动失败照常退出）+ spec |
| high | 物料合并把"实体只有需求行"误当"实体声明库存读不到"，抹掉事件侧真实库存数字 | 区分 positive-unknown 与"无表态"（parseStockQuantity 单一判定源） |
| medium | 设备事实状态词表含不存在的 IN_PROGRESS、漏 PAUSED——**人工暂停后设备测得的完成事实永远被拒**；分波预检作用域跨波误伤（他波冲突挡本波合法派工）；巡检间隔 NaN→1ms 热循环；unrls 门禁把 FOREACH 内带 IF 守卫的表全判为已保护（fail silent）；多设备同端口帧交叉污染设备归属 | 各自最小修复 + 回归（词表/波作用域/正整数解析/解析器保守化/fail-closed 准入） |
| low | 通知小节标题错误态仍显示伪造的 0；eslint 规则名失配；测试等待条件间歇失败等 | 逐项修复 |

### D2. 自查后的全量复验（递归闭环）

| 命令 | 结果 |
|---|---|
| 服务端 Jest | **357 suites / 3350 tests 全通过**（较自查前 +2 套件/+20 测试，全为回归锚点） |
| 前端 Jest | **168 suites / 1688 tests 全通过** |
| 双端类型检查 | tsconfig.node / tsconfig.app 均 0 错误 |
| 边缘 unittest + ruff | **1181 tests OK** / All checks passed |
| OpenAPI / repo-facts / truth / unrls 门禁 | 465/465 · 39/39 · no drift · PASS |
| demo-residue 门禁 | PASS（自查新增文案触发的 1 处残留已改写重生成） |
| **16 场景链复跑** | **exit 0 · 失败 0 · 1 SKIP**（唯一 SKIP 仍为 golden 首次激活无回退目标） |
| 真实后端浏览器测试（chromium，补验证项） | **3/3 通过**：绑定工人界面回执 / 学习控制台治理链（基线→提案→自批回避→他人审批→回滚）/ 分波派工收口 |

### D3. 自查明确"不修/上游"的事项（全部留痕）

- 投递配额 .limit(1000)：仅影响 >1000/min 的非现实配置，改动会牵连页面口径（wontfix，已注释）。
- CP-SAT/MILP 不消费 durationMsByTask：shadow-only、无被违背的不变量，建议上游接入同一通道。
- relativeError 无下界保护：保留"如实爆炸"（加下界属指标政策发明）。
- DbPayloadStore.get 无 org 谓词：当前由 RLS 兜底，读写同源化需连同 schema 注释契约一起设计（upstream）。
- 边缘 receipt 网络失败无重投队列：平台已有幂等端点，补队列属新特性（upstream）。
- schema-manifest 对 07x-09x 新表未登记（惯例如此，登记属数据治理项，upstream）。

---

## 附录 E：全仓对抗式审查轮（同日续）+ 事故与恢复 + 浏览器验证闭合

### E1. 审查范围扩展

在 SR 轮（审本会话 109 个改动文件）之后，按"对全仓每一行代码"的要求，把对抗式审查扩展到
**未审过的存量高险面**：8 包并行（MES/ERP 工单写路径、告警/通知/现场域、work-orchestration
等基础设施、世界模型/摄入/规则引擎、智能域（learning/ai/agent/retrospective 等）、前端核心页、
指挥地图等大页面、边缘核心管线）。完成 **2 包**（UR1: 8 findings、UR7: 2 findings，均 fixed），
**6 包因下述事故被中止**；其中被识别的半成品修复已由主线完成收口（见 E3）。

### E2. 事故记录：审查期间的工作树破坏与恢复（如实记录）

一个审查 agent 在会话期间执行了 `git stash` / `git reset --hard` 类操作，多个 agent 的
transcript 记录了"文件被周期性还原"的困惑。处置：

1. **立即停止工作流**，防止继续破坏；
2. **完整性审计**：`git status` 757 项、冲突标记零、关键内容抽查全在——确认 stash@{0}
   （11:18:51 快照，375 文件 +42K 行）即为"SR 轮全绿后的完整状态"备份，且已在工作树恢复；
3. **精确修复杂交态**：3 个文件处于"半个旧版 + 半个新版"的损坏态（ingest.controller 丢失
   actuator 与 execution-facts 两路由、ingest.service 丢失方言映射、mes spec 丢失 CAS 替身），
   均从 stash 精确恢复；
4. **完成被中断的半成品修复**（UR agent 已开工未收口的 3 处，主线代为收口）：
   - ERP 入站 advisory lock（并发双提交去重）+ 测试替身无 execute 时的既有跳过惯例；
   - MES 工单 23505 唯一约束冲突 → **幂等重放**（skipped:true）而非 502——否则边缘会把
     "已成功"当"未成功"反复重投；
   - 边缘安灯通知收件人语义（责任角色恒叫 + 点名到人追加）与摄入端点时间可解析性
     fail-closed 校验（env/camera/location 三端点，不触达服务层即 400）。

**教训已固化**：后续任何 agent 工作包的纪律清单中，`git stash/checkout/reset/clean`
一律列为禁用写命令（本轮事故根因是 COMMON 纪律只禁了 commit，未禁其它 git 写操作）。

### E3. 审查发现（已完成包 + 半成品收口）

- UR1（MES/ERP，8 findings fixed）：并发双提交去重的 advisory lock + 幂等重放（上节）；
  其余为同域边界校验与租户谓词补强。
- UR7（指挥地图等大页面，2 findings fixed）：SSE resync 状态机与图层空数据渲染边界。
- 半成品收口 3 项（E2 第 4 条）。

### E4. 最终全量验证（事故恢复后）

| 命令 | 结果 |
|---|---|
| 服务端 Jest | **370 suites / 3395 tests 全通过** |
| 前端 Jest | **169 suites / 1697 tests 全通过** |
| 双端类型检查 | 0 错误 |
| 边缘 unittest + ruff | **1201 tests OK** / All checks passed |
| OpenAPI 零漂移 | 465/465（事故丢失的 2 操作已恢复） |
| 十二条主线门禁 + truth + repo-facts | 全通过 |
| **16 场景链** | **exit 0 · 425 PASS · 0 FAIL · 1 SKIP** |
| 浏览器 mock（chromium） | **107 passed** |
| **浏览器真实后端（chromium）** | **22 passed**：真实登录/导航/响应式/**真实登出**（19）+ 分波派工/现场回执/学习治理（3） |

### E5. 浏览器真实后端验证的补全与一处用例纠偏

- 补跑了 `auth-real-login.spec.ts` 全套（此前只跑过 3 个 real 场景）：真实登录 → 仪表盘 →
  8 个核心页导航 → 4 视口响应式 → 登出流，**19/19 通过**。
- 其登出用例原断言"清空 Web Storage 应跳登录页"——与现行架构（CLI-501/701：
  **refresh token 在 httpOnly cookie**，JS 不可见；清 Web Storage 本就不构成登出）矛盾。
  用例改写为走**真实登出路径**（侧栏「退出登录」→ 服务端吊销 refresh 会话 → 重定向登录 →
  受保护页不可再入），断言强度更高（覆盖 cookie 撤销 + 服务端会话失效）。

### E6. 收尾状态

- 工作树：**约 760 项未提交改动**（含 stash 备份 stash@{0}——建议保留至本轮改动正式提交后再清理）。
- 未 commit / 未发布 / 未触碰外部系统。
- 未验证外部条件与第 8 节一致；新增：SR2 残余（CP-SAT/MILP 未接模型时长通道、SSE
  prediction.rollback 事件未接线）已在附录 B/C 记录。

---

## 附录 F：全仓审查收尾轮（同日续）：6 包补齐 · 纪律强化 · 递归归零

### F1. 覆盖闭合

UR 轮被事故中止的 6 个审查包以**强化纪律**重新下发（明令禁止 git stash/checkout/reset/clean/
apply/restore 等一切写命令；git 仅限只读 diff/status/show；"观察到内容异常就按当前磁盘内容审，
不做任何恢复动作"）。**6/6 完成、零事故**，全程工作树完整性监控（tree/stash 基线对比）无异常。

至此对抗式审查覆盖：SR 轮（本会话 109 改动文件）+ UR1/UR7 + FR 全 6 包 —— 服务端全部 62 模块、
前端核心域（排产/现场/移动/指挥地图/控制台/物料/深链）、边缘核心管线（推理/世界模型/上行桥/
编解码）均已过 adversarial 审查。

### F2. 本轮确认并修复的真 bug（22 项 fixed，全部先红后绿）

| 包 | 级别 | 缺陷（触发 → 后果） |
|---|---|---|
| FR3 | **high** | scale 映射 dry-run 原型链污染（CWE-1321）：`to='__proto__.x'` 全局污染进程（dispatcher 可达）→ sink 拒绝保留段 + 结构化 ILLEGAL_TARGET_PATH |
| FR3 | medium | work-orchestration 门禁决定/历史文件损坏被静默当 [] → 下一次写入**不可逆销毁审计史**（revoke 恢复的唯一事实源）→ 损坏即 500 并保留原字节供恢复 |
| FR2 | **high** | global_admin 绕过告警状态机拓扑（open→closed 被接受，跳过两步审计）→ 豁免收窄为"仅角色条件"，边有效性仍强制（拓扑判断 584/584 门禁不回归） |
| FR2 | **high** | 同一安灯第二次重开的提醒被确定性 id 静默吞掉（NO-48a 要消灭的"关过一次就静默"）→ 重开桶带发生序号（reopened-N），幂等保持 |
| FR4 | high | 事件上行入口锚错时钟源（唯一未锚服务端时钟的帧入口）→ 修 + actuator 坏时间不再误标 retryable |
| FR4 | high | world replay 实体类型查询缺 org 谓词 + 回放标注租户归属错误 → 修 |
| FR4 | medium | actuator 明文 http 守卫被 URL 前后空白绕过（`" http://host"` 不命中守卫）→ 三路 sender 统一 strip 归一（+4 类空白测试） |
| FR5 | **high** | retrospective scope 用**状态词表**校验（误用），incident 行被静默改写成 'plan' → 换 scope 词表 |
| FR5 | **high** | 人工修订经验条目"写入成功但所有读接口永远返回 AI 旧条目"（lessons_json 与 assembled_json 不同步）→ 同 UPDATE 双列一致写 |
| FR5 | medium | agent completeTask 用 3 字段对象**整体覆盖**完整任务契约 taskJson → 改合并保留原契约字段 |
| FR5 | medium | dashboard getWorkers 把时间窗谓词放 WHERE 而非 LEFT JOIN ON → 离线设备整行消失 → 谓词移入 ON |
| FR5 | medium | learning propose 幂等的 select→insert TOCTOU：并发同 id 23505 裸抛 500 → 捕获回读 created=false |
| FR6 | **high** | MobileWorkbench 离线入队失败仍 toast「已加入队列」→ 操作静默丢失且 unhandled rejection → 失败如实报错"本次操作尚未被记录" |
| FR6 | medium | 离线队列重放按 IndexedDB 主键序 → 刷新恢复后同工单 start→report 乱序重放撞 409 → 按 queuedAt 升序投递 |
| FR6 | medium | 现场提醒 detail 直出 UTC ISO（UTC+8 现场读错 8 小时）→ 统一北京时间渲染 |
| FR6 | medium | 冲突"采用本地"丢弃照片附件（body 不含运行时合并的附件引用）→ 重上传并合并引用 |
| FR8 | **high** | **世界投影重启后永久 declaration_rejected**（内存声明集清空 vs 持久层 version≥1）→ 恢复声明与配置一致则直接采纳，配置变更仍 fail-closed |
| FR8 | **high** | production 明文 http 守卫被空白绕过（同上，桥侧三处）→ 归一后判定 |
| FR8 | medium | sensor_uplink 入队与压实线程竞态：replace 落盘瞬间并发帧丢失（违背"入队即落盘"）→ 同锁串行（受控交错复现红） |
| FR8/FR5/FR6 | low | EventUplink 空 URL enabled 误报、metrics 测试缺 sys.path 引导、时间校验 spec 构造参数等 | 
| 主线 | high | ingest.controller 事故杂交修复（actuator + execution-facts 路由恢复）、ERP advisory lock、MES 23505 幂等重放、安灯收件人语义、时间校验——见 E2/E3 |

另有 **~10 项 upstream** 留档（通知号缺 org 段的结构性风险、安灯提醒在主事务外写、agent
审批角色强制缺失（需产品裁决）、外骨骼幂等分支建议显式 replay 标记、同步 IO 读模型需设计级
重构、DbPayloadStore 读写同源、边缘 receipt 重投队列、schema-manifest 新表登记等）。

### F3. 递归修复记录（本轮三段）

1. FR 审查中各包**先红后绿**自证（每项修复都有红→绿回归，包内定向测试全绿后才收工）。
2. FR 合入后全量复验发现 **1 个失败**：`order-chain` 时间炸弹（fixture 硬编码
   `dueDate='2026-09-13T08:00Z'`，真实时钟越过即翻车——典型的"写死日历日期"）。
   修复为相对时间（+7 天）并**补一条 overdue=true 语义锁**配对；另发现 dueAt 实际来自
   materialsStub（第一处修复没改到真实数据源，二次自查抓出）。
3. 复跑至零：见 F4。

### F4. 最终验证（本轮递归终态）

| 命令 | 结果 |
|---|---|
| 服务端 Jest | **380 suites / 3423 tests 全通过** |
| 前端 Jest | **173 suites / 1706 tests 全通过** |
| 双端类型检查 | 0 错误 |
| 边缘 unittest + ruff | **1210 tests OK** / All checks passed |
| bandit + 十二条主线门禁 + truth + repo-facts + demo-residue + unrls | 全通过 |
| OpenAPI | 465/465 零漂移 |
| **16 场景链** | **exit 0 · 425 PASS · 0 FAIL · 1 SKIP** |
| 浏览器 mock | **107 passed** |
| 浏览器真实后端 | **22 passed**（真实登录/导航/响应式/真实登出 19 + 分波派工/现场回执/学习治理 3） |

---

## 附录 G：最终周期 —— upstream 清单本地可完成项落地 + 全域递归归零

### G1. 本周期落地（8 项，全部先红后绿或带定向回归）

| # | 事项 | 内容 |
|---|---|---|
| G1-1 | **agent 审批角色强制**（FR5 upstream → 已裁决落地） | resolveApproval 强制：台账 rolesJson 非空时 actor.roles 必须与之有交集（无交集/未带角色 → 403 fail-closed）；rolesJson 为空 = 部署未声明约束（不发明约束）；TTL 超期按 policy 权威执行不受闸门约束。controller 透传 roles；既有用例调用方签名同步；新增 3 条回归（无资格 403 且零副作用 / 带角色放行 / 空 rolesJson 放行） |
| G1-2 | **通知号唯一性收敛 org 作用域**（standalone_100） | DROP 全局 UNIQUE 约束（CONSTRAINT，非 INDEX）；建 (org_id, notification_id) 复合唯一索引。同 org 幂等保持、跨租户通知压制消除。verify 含行为探针（同 org 压制 + 跨 org 并存 = 2 行）。drizzle 全部 4 处 conflict target 同步为两列（deterministic-notifications / exo-reminder / agent / approval-expiry） |
| G1-3 | **学习信号 E2E 种子冲突目标** | 场景自种 SQL 的 2 处 `on conflict (notification_id)` 同步为两列目标（真实缺口，非猜测） |
| G1-4 | **策略守卫 2 org 透传** | activatePolicyVersion 的 getPolicyVersionStatus 补传 ctx.primaryOrgId（与守卫 3 同纪律，消同族跨租户版本读取） |
| G1-5 | **安灯事件号熵** | `ANDON-<8hex>`（32-bit 熵）→ 加毫秒时间前缀，跨租户 event_id 相撞致 openAndon 500 的概率趋零 |
| G1-6 | **exo start 幂等 replay 标记** | 终态旧会话重放显式 `replay: true`（不改变既有字段，"重放"与"新建"可区分） |
| G1-7 | **DbPayloadStore 读写同源** | get 补 org 谓词（与 DDL 的 org_id DEFAULT 表达式逐字对齐）——无 GUC 后台路径不再把他租户指纹当作 409 判据 |
| G1-8 | **边缘 receipt 重投队列** | ControlAgent 记账上行失败的执行结果（有界 100、溢出丢最旧并计数留痕），每轮 run_once 先重投（平台按 commandId 幂等接收）；run 统计带 receiptRetryFlushed 可观测 |
| G1-9 | **MILP 接入模型时长通道** | 共享解析器 `prediction/duration-resolution.ts`（heuristic 内联实现收编为委托，消除两份实现漂移）；MILP 注入 provider 并在 advisory 模式下与 heuristic 同源同判。CP-SAT 因 worker 协议需改（时长随任务下发）划 upstream |

### G2. 递归修复记录（本周期三处）

1. **迁移 100 首版两连错**（自证复查有效）：
   - `DROP INDEX` 打在 CONSTRAINT 上（底层索引由约束持有）→ 改 DROP CONSTRAINT；
   - verify 行为探针缺 NOT NULL 列（recipient_type/recipient_id/channel）→ 补齐；
   - 首次 apply 已建出 **COALESCE 表达式索引**（初版误以为 org_id 可空），修正版 `IF NOT EXISTS` 跳过重建 → verify 正确地拒绝旧索引 → 手动清理后重放为复合索引。
2. **迁移合入后全链跑出 7 个失败场景**：全部重通知域 500——根因是 drizzle 生成**带列目标的** `on conflict ("notification_id")`，与旧唯一索引失配（"无目标 DO NOTHING 兼容表达式仲裁器"的假设错误）。修正迁移为复合唯一 + 全部调用点 target 两列。
3. **第二次全链仅剩 learning-signal**：其**自种 SQL**（E2E 脚本直写 PG）还有 2 处旧目标 → 同步修正后 19/19；随后全链最终跑 **exit 0 / 425 PASS / 0 FAIL / 1 SKIP**。
4. 另有一次 `e2e:edge 2g` 偶发失败（异步投影窗口时序），单场景复跑 59/59、最终全链全绿——判定为环境时序非产品缺陷，如实记录。

### G3. 复查终态（全绿）

| 门禁 | 结果 |
|---|---|
| 服务端 Jest | **380 suites / 3425 tests 全通过** |
| 前端 Jest | **173 suites / 1706 tests 全通过** |
| 双端类型检查 | 0 错误 |
| 边缘 unittest + ruff | **1210 tests OK** / All checks passed |
| bandit / 十二条主线门禁 / truth / repo-facts / demo-residue / unrls | 全通过 |
| OpenAPI | 465/465 零漂移 |
| 迁移链 | **98 项 apply + verify 全通过**（100 项幂等重入实测） |
| **16 场景链（最终取证跑）** | **exit 0 · 425 PASS · 0 FAIL · 1 SKIP** |
| 浏览器 mock | **107 passed** |
| 浏览器真实后端 | **22 passed**（真实登录/导航/响应式/真实登出 19 + 分波派工/现场回执/学习治理 3） |

### G4. 对抗式审查总账（全天三轮）

| 轮 | 范围 | 发现 | 修复 | upstream/不修 |
|---|---|---|---|---|
| SR | 本会话 109 改动文件 | 25 | 24 | 1 wontfix |
| UR（完成 2 包） | MES/ERP + 指挥地图 | 10 | 10 | 0 |
| FR（补齐 6 包） | 告警/通知/现场、基础设施、世界/摄入/规则、智能域、前端核心页、边缘核心 | 40 | 22（其余 upstream 留档） | — |
| **合计** | 全域 | **75** | **56** | **~12 upstream + 7 记录不修** |

---

## 附录 H：终局周期 —— upstream 清零裁决 + 全域递归归零

### H1. 本周期裁决与落地（6 项）

| # | 事项 | 裁决与处置 |
|---|---|---|
| H1-1 | **agent 审批角色强制**（FR5 upstream → 落地） | rolesJson 非空 → actor.roles 必须有交集（403 fail-closed，零副作用）；空 = 未声明约束放行；TTL 超期 policy 权威不受闸门约束。controller 透传 roles；10 处既有调用方同步；3 条回归（含零副作用断言） |
| H1-2 | **通知号唯一性收敛 org 作用域**（standalone_100） | 迁移三件套 + runner 登记（98 项）；verify 行为探针（同 org 压制/跨 org 并存=2 行）；drizzle 4 处 conflict target 同步两列；schema.ts 漂移同步。**递归实证**：首版 DROP INDEX 误用 → verify 抓旧表达式索引残留 → 修正后全绿 |
| H1-3 | **学习信号 E2E 种子冲突目标** | 场景自种 SQL 2 处同步两列目标（19/19 归零） |
| H1-4 | **策略守卫 2 org 透传** | activatePolicyVersion 的版本存在性检查补传 ctx.primaryOrgId（与守卫 3 同纪律） |
| H1-5 | **安灯事件号熵 + exo replay 标记** | ANDON 事件号加毫秒前缀；exo start 幂等重放显式 replay:true |
| H1-6 | **DbPayloadStore 读写同源** | get 补 org 谓词（与 DDL DEFAULT 表达式逐字对齐） |

### H2. FR 残余裁决（两项设计级收口）

| 项 | 裁决 |
|---|---|
| **global_admin 超管语义不一致**（alert 放行 / oee 拒绝） | **统一为"豁免仅限角色条件，转移拓扑仍强制"**——oee.transitionAndon 增设与 alert.service 同款的 alertTransitionEdgeExists 判定；open→closed/reopened 等非法边 global_admin 也不可发明；timeline 审计照记。拓扑回归 3 例（含 open→closed 非边反例，纠正初版测试的边存在性误判） |
| **CP-SAT 时长通道**（原判"worker 协议需改"→ **复核推翻**） | worker 契约**本就携带逐任务 durationMs**（cpsat/contract.py:18）——无需协议变更。CP-SAT 经 heuristic 公共解析器同源解析（advisory 时），时长写入既有 durationMs 字段。heuristic 内联实现收编为共享解析器 `prediction/duration-resolution.ts`（三族求解器同源同判）。默认 off 逐字节不变 |

### H3. 递归修复记录（本周期两处，均被门禁当场抓获）

1. agent.service import 逗号拼接错误（`,,`）→ tsc 即时暴露 → 修正。
2. CP-SAT 接入三步返工（引用不存在的 override 字段 / 非 async 函数内 await / 返回类型 Promise / 参数顺序）——每步 tsc 即时暴露即时修正；最终端到端由 16 场景链回归锁定。

另：order-chain 时间炸弹（上轮遗留修复）在本轮全量中保持绿色。

### H4. 最终递归验证（全绿终态）

| 门禁 | 结果 |
|---|---|
| 服务端 Jest | **380 suites / 3427 tests 全通过**（+2 为 CP-SAT 复用回归） |
| 前端 Jest | **173 suites / 1706 tests 全通过** |
| 双端类型检查 | 0 错误 |
| 边缘 unittest + ruff | **1210 tests OK** / All checks passed |
| truth / repo-facts / OpenAPI / demo-residue / unrls | 全通过（465/465 · 39/39 · no drift） |
| 迁移链 | **98 项 apply+verify 全通过** |
| **16 场景链** | **exit 0 · 425 PASS · 0 FAIL · 1 SKIP** |
| 浏览器 mock + 真实后端 | **107 + 22 全过** |

### H5. 剩余风险清单（终态）

**已全部本地可完成项清零。** 剩余仅两类：

1. **未验证外部条件**（不可本地完成）：真机外骨骼/AGV；CP-SAT 生产部署（ortools 安装 + worker 上线——接入通道本周期已就绪，激活阶梯 OFF→…不变）；生产部署面（K8s/备份恢复/canary/soak）；LLM 真实 key（当前 narrationSource=rule_fallback）；跨租户全链 TCK 环境。
2. **记录在案的设计级事项**（有真实成本，需排期而非随手修）：work-orchestration 读路径同步 IO；安灯提醒主事务外写的崩溃窗口（补偿扫描可行）；schema-manifest 规划期工件的 drift-boundary（本轮已加显式说明，机制由迁移链+feature-status 接管）。
3. **工程事实**：工作树约 795 项未提交（含 stash@{0} 备份）；未 commit / 未发布 / 未触碰外部系统。

---

## 附录 I：终局收官 —— CP-SAT 真实 ortools 运行时验证（"从未验证"清零）+ 全域递归

### I1. 历史遗留的 runtimeVerified=false 项闭合

**CP-SAT（self-declared "从未在含 ortools 的环境验证过求解运行"）本周期完成真实闭环：**
1. `.venv-cpsat` 安装 `ortools==9.11.4210`（worker requirements 固定版本）；
2. 真实 worker 启动（`PYTHONPATH=src python -m edge_platform.scheduler.cpsat.worker`）；
3. 服务端 `EWOH_SOLVER_ACTIVATION=SHADOW` 重启 + 日志代理捕获请求；
4. **端到端实证：`SHADOW double-run: production=HEURISTIC shadow=OPTIMAL`** ——
   真实 ortools CP-SAT 对生产场景求解成功。

### I2. 过程揪出并修复的真实 TCK 级缺陷（"从未验证"掩盖的契约漂移）

- **症状**：worker 全部 400 `__init__() got an unexpected keyword argument 'status'` → 熔断器
  5 连开 → CP-SAT 永远 UNAVAILABLE。
- **根因**：TS 任务节点故意透传 `status` 供 worker 审计（cp-sat 注释明示），但 Python 契约
  `SolverTask` dataclass 无此字段，`**task` 直接 TypeError。此前 worker 不在线，
  fetch 直接失败——同一熔断结果掩盖了"失败原因从连接错误变成了契约错误"。
- **修复**：`SolverTask` 增加可选 `status` 字段（向后兼容，旧 worker 忽略）；测试代理 dump
  完整请求体逐字段比对锁定。
- **递归涟漪修复**：共享解析器抽取后，`travel-cost` 缓存语义用例走 org-less 路径失败——
  顺势发现并修复**第三个真实缺陷**：`persistMatrix` 在缺 org 时写 `'system'` 哨兵行 →
  必然违反 FK（23503）→ catch 吃掉报错但**事务已中止（25P02）** → 同请求内后续
  set_config/写入全部失败 → createRun 500。修为缺 org **跳过**缓存写（缓存可省，
  事务不可污染）+ 缓存语义用例补 orgId（走真实请求路径）+ 新增跳过回归。
  另：golden 首轮一次 `set_config` 500（连接级瞬时）由 H 周期的 PgFaultGuard 语义边界覆盖。

### I3. 全量验证终态（零失败递归归零）

| 门禁 | 结果 |
|---|---|
| 服务端 Jest | **380 suites / 3427 tests 全通过** |
| 前端 Jest | **173 suites / 1706 tests 全通过** |
| 双端类型检查 | 0 错误 |
| 边缘 unittest + ruff | **1210 tests OK** / All checks passed |
| bandit / 十二条主线门禁 / truth / repo-facts / demo-residue / unrls | 全通过 |
| OpenAPI | 465/465 零漂移 |
| 迁移链 | **98 项 apply+verify 全通过** |
| **16 场景链（SHADOW + 真 ortools worker 下取证）** | **exit 0 · 425 PASS · 0 FAIL · 1 SKIP** |
| 浏览器 mock + 真实后端 | **107 + 22 全过** |

### I4. 未验证外部条件（终态收敛）

- 真机外骨骼/AGV（NXP1 TCP 接收端 + Modbus 假从站已可承接，等待真机）；
- 生产部署面（K8s/Helm/备份恢复/canary/soak——本地无对应基础设施）；
- LLM 真实 key（narrationSource=rule_fallback 兜底已验证，llm 路需 Ark key）。
- **CP-SAT 已从"未验证"清单移除**：ortools 真实求解 SHADOW=OPTIMAL 实证；
  生产 PRODUCTION 阶梯仍需 `EWOH_SOLVER_PRODUCTION_ENABLED=1` 显式开闸（gated 设计）。
