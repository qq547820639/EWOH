# EWOH Current State（现状事实）

> 维护规范：本文件是"向 Factory Embodied Intelligence OS 收敛"的**工作树现状视图**。
> 功能实现布尔事实以根目录 `feature-status.yaml` 为唯一事实源，本文件**引用而不复制**；
> 目标架构见 [`embodied_factory.md`](embodied_factory.md)（九层）与
> [`target-state.md`](target-state.md)（17 节北极星判据）。
>
> **本文件的每个数字都可由第 7 节的命令复算**。凡不能复算的断言一律不写在这里。
> 最后更新：2026-09-13 · 版本基线 `0.6.0-rc4` · HEAD `7611196` + 工作树未提交改动
> （350 修改 / 315 新增 —— 见第 6 节"未提交面的风险"）。

## 1. 一句话现状

EWOH 已是**多运行时单仓库**的"外骨骼人员作业协同与调度平台"，其工程治理（fail-closed 文化、
单一事实源、门禁矩阵、开放契约零漂移）达到产品级；**46 个 feature 全部 implemented/tested，
但 `productionEnabled` 为 0/46，`runtimeVerified` 为 35/46** —— 即"代码就绪、真机与生产未验收"。
距"Factory Embodied Intelligence OS"的差距不再主要是"缺代码"，而是三件事：

1. **若干条已宣布完成的链路在运行期实际不通**（例如埋点端点因缺角色声明恒 403；学习回路的
   shadow 采样/回填在生产路径无调用方）——即"文档强于实现"；
2. **多份'现状'文档彼此口径互斥**，按任一文档判断架构会得到不同结论；
3. **真实硬件与生产环境验收缺失**（CP-SAT worker、OPC-UA/厂商 AGV 传输、真机外骨骼入口）。

## 2. 运行时拓扑（实测）

| 运行时 | 目录 | 技术栈 | 实测规模 | 状态 |
|---|---|---|---|---|
| 边缘运行时 | `src/edge_platform/` | Python ≥3.9，**运行时零第三方依赖**（仅测试可选 ortools/pytest） | 204 个 `.py`（非测试）≈ 43.1K 行；72 个测试文件 | 三模式装配（`production` fail-fast 禁 stub，靠 `EWOH_RUNTIME_MODE`）；断网可离线续传；生产调度只读（advisory） |
| 云侧主产品（后端） | `ewoh-spark-app/server/` | NestJS 10 + Drizzle + postgres-js + PG17 RLS | 62 个 module 目录；531 个 `.ts` ≈ 136.4K 行；165 个 `.spec.ts` | `standalone-app.module.ts` 与 `app.module.ts` 双入口；生产入口 `dist/server/main.js` |
| 云侧主产品（前端） | `ewoh-spark-app/client/src/` | React 19 + Vite 7 + Tailwind 4 + Radix | 687 个 `.ts/.tsx` ≈ 141.4K 行；31 个 page 目录 | 30 条路由 + 侧栏导航（5 个任务域分组）+ `/command-map` 全屏页 + `/o/:type/:id` 深链 |
| 飞书侧车 | `ewoh-feishu-app/` | Express + better-sqlite3 | ≈5K 行 | 验签 fail-closed；webhook 幂等 |
| 契约层 | `contracts/` `openapi/` `db/` `catalog/` | YAML / JSON / SQL | 31 个契约子域（91 个文件）；OpenAPI 464 控制器操作 / 688 spec 操作；94 个 standalone 迁移（96 rollback、83 verify）；82 篇 ADR | 由 `scripts/audit-*.js` + `truth-check` 守护 |

部署形态：**四区**（设备区 / 边缘区 / 平台区 / 展示区），见 `embodied_factory.md` §11。

## 3. 已建立的真相层（Repository Truth 资产）

单一事实源不是口号，而是可执行的门禁。当前**全部通过**（见第 7 节复算）：

- **`feature-status.yaml`** —— 46 个 feature × 6 维布尔矩阵（implemented / tested / deployable /
  productionEnabled / runtimeVerified / docsUpdated），由 `scripts/truth-feature-status.js` 行级强制，
  并与 README 能力表逐行对齐。
- **`openapi/ewoh.yaml`** —— 对外 API 唯一事实源；`scripts/audit-openapi-routes.js` 双向守护
  （控制器→spec 无遗漏、spec→控制器无幽灵路由），并生成 `openapi/route-manifest.json` 作基线。
  `client/src/types/openapi.d.ts` 由其生成，`npm run gen:openapi:check` 守护零漂移。
- **`contracts/`** —— 31 个子域的"文档即契约"：schema（注册表 + 文字约束）+ `test-vectors.json`
  + TS 镜像（`ewoh-spark-app/shared/*.ts`）+ Python 镜像（`src/edge_platform/contracts/*.py`），
  三方由 `scripts/audit-*.js` 与 `tests/test_*_contract.py` 仲裁。
- **`db/migrations/standalone_*.sql`** —— 94 步迁移链为唯一建库事实源；每步配 `.rollback.sql`；
  `db/verify/*.verify.sql` 与迁移近乎 1:1 并由 runner 精确断言（`SELECT 1 AS standalone_0NN_verified`）。
  `server/database/schema.ts` 是 Drizzle 映射，**不是**建库事实源。
- **`deploy/.env.example`** —— 部署参数单一事实源（`scripts/audit-env-inventory.js`）。
- **`docs/decisions/`** —— 82 篇 ADR 构成决策链。

## 4. 关键闭环现状

判据是"**代码路径真的会跑**"，不是"文件存在"。下表按第一手核查（2026-09-13）填写。

| 闭环 | 现状 | 说明 |
|---|---|---|
| 边缘故障重排闭环 | **可运行（模拟）** | `make demo-closed-loop` 实测 12 次 HTTP 操作全部成功；真实 HTTP + SQLite，证据落 `output/closed-loop-evidence.json` |
| 感知 → 质量 → 决策 → 授权 → 执行 → 回执 | **代码就绪，真机未验收** | 平台侧 `control` 模块 + 边缘 `control_downlink` + 执行机构适配器（Modbus/TCP 真帧 + 假从站）；授权指纹 HMAC v2、投递前复核、投递配额、安全停机插队均已实现 |
| 调度主链（快照→优先级→资格→路径→求解→审批→预约→派工→SSE） | **代码就绪** | 资格为 30+ 项 fail-closed 硬校验；路径为真实 A*；MILP 走真实 HiGHS WASM；CP-SAT 为可选 worker（默认 OFF，`ortools` 未部署） |
| 预计 vs 实际 → 学习 | **断链（本轮修复中）** | `ShadowEvaluatorService.recordSample/backfillActual` 在生产路径**无调用方**；`SchedulingFeedbackService` 注入了它却从未使用（死依赖）；经验时长模型 `predictTaskDuration` 无生产消费者，求解器一律读 `config.defaultTaskDurationMs` |
| 训练样本资格 | **门恒关闭（设计使然）** | `training-sample-eligibility.ts` 要求 `provenance.independentReceipt.source='device_receipt'`，而**没有任何写入方**产出该来源 → 人工上报/模拟回执永不入训。这是**有意的防伪造不变量**，不是 bug；其真实缺口是"缺少产 `device_receipt` 的机器身份写入路径" |
| 复盘 / 运行记忆 | **代码就绪** | `retrospective` / `learning` 模块 + 经验回流知识 + 改进行动项均已实现 |
| 世界模型 | **代码就绪，投影默认关闭** | 边缘 `ContractWorldStore` 双时态 + 契约校验 fail-closed；`TelemetryWorldProjector` 需 tenant+factory+kind_map 三者齐备才 `enabled=true`，默认部署下不投影 |

## 5. 权限与租户边界（三层，实测）

1. **认证层**：`AccessTokenGuard` 从 JWT 取 `userId/orgId/roles`，经 `OrgScopeService` 解析组织树 scope。
2. **数据库层**：`OrgContextInterceptor` 把每个 HTTP 请求包进一个 GUC 事务
   （`app.current_org_id` / `app.current_org_ids` / `app.is_global_admin` / `app.user_id`，**transaction-local**）。
   实测 **110 张物理表中 99 张已启用 RLS**（`relrowsecurity`）。
3. **应用层**：`assertTenantVisible` 做纵深防御（反枚举 404）。

RBAC 为全局 `RolesGuard` 的 **default-deny**：控制器必须显式 `@Roles`、`@FallbackRoles`，
或命中 `modules/shared/route-role.policy.ts` 的 `FALLBACK_CONTROLLER_ROLES`，否则 403。

**执行边界**（大模型不得绕过的部分）：事件摄入 / 重排触发 / 提醒派生 / 感知融合 / 数据质量扫描 /
学习信号是**可自动执行的只读派生**；策略激活、方案 approve+dispatch、高危物理指令
（`ACTUATOR_HIGH_RISK_COMMANDS`：`dispatch_task`/`resume`/`clear_fault`）、能力放宽、阈值覆盖
**一律人审**（且普遍带生成人回避与审批时效校验）。`stop` 为安全动作，**永不受审批/排队/配额约束**。
AI/大模型侧确无直连设备通道：`agent` 的 `dispatch_task` 显式抛 `tool_execution_not_implemented`。

## 6. 未提交面的风险（必须知道）

工作树有 **350 个修改 + 315 个新增**未提交文件，横跨契约、迁移、verify、控制面与前端。
后果：`truth-check` 的"零漂移"基线**不可复现**（基线本身是工作树快照），
且改动跨越 94 条迁移链——评审者无法用 `git diff HEAD` 判断"这一版到底改了什么"。

> 纪律：本仓库的零漂移门禁只在**已提交**状态下才构成可追溯证据。落地任何结论前应先提交。

## 7. 复算命令（本文件所有数字的来源）

```bash
# 2 节 规模
find src/edge_platform -name '*.py' -not -path '*__pycache__*' -not -path '*tests*' | wc -l
find src/edge_platform -name '*.py' -not -path '*__pycache__*' -not -path '*tests*' -exec cat {} + | wc -l
ls -d ewoh-spark-app/server/modules/*/ | wc -l
find ewoh-spark-app/server -name '*.ts' -not -path '*node_modules*' -exec cat {} + | wc -l
find ewoh-spark-app/client/src \( -name '*.ts' -o -name '*.tsx' \) -exec cat {} + | wc -l
node scripts/audit-openapi-routes.js --strict          # 控制器/spec 操作数
ls db/migrations/standalone_*.sql | grep -v rollback | wc -l
ls docs/decisions/ADR-*.md | wc -l

# 3 节 真相层门禁
make truth-check
node scripts/audit-repo-facts.js --strict
cd ewoh-spark-app && npm run gen:openapi:check

# 5 节 RLS 覆盖（需本地 PG）
docker exec ewoh-pg-dev psql -U ewoh_owner -d ewoh -tAc \
  "select count(*) filter (where c.relrowsecurity) || '/' || count(*) from pg_class c
   join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r'"

# 6 节 未提交面
git status --porcelain | awk '{print $1}' | sort | uniq -c

# 4 节 闭环
make demo-closed-loop
```

## 8. 与目标状态的差距（按证据排序）

| # | 差距 | 证据/位置 |
|---|---|---|
| G1 | **学习腿断链**：shadow 采样/回填无生产调用方；经验时长模型无求解器消费者 | `prediction/shadow-evaluator.service.ts`、`scheduling-feedback.service.ts`（死注入）、`heuristic-scheduling-solver.ts` |
| G2 | **已宣布完成的链路运行期不通**：埋点端点缺角色声明恒 403 | `modules/telemetry/telemetry.controller.ts` 无 `@Roles`/`FALLBACK_CONTROLLER_ROLES` 条目 |
| G3 | **契约漂移**：控制命令的 attempt/投递/撤回词表不在 `contracts/`（只在 openapi 与代码），安全语义无契约门禁 | `contracts/state-machines/control.yaml` vs `openapi/ewoh.yaml` vs `control.service.ts` |
| G4 | **世界模型缺物料/订单一等实体**：物料/库存/BOM/订单在数据层无一等表，`materials` 模块读 `ewoh_event` 与调度表 | 全仓无 `CREATE TABLE ... material`；`modules/materials/materials.service.ts` |
| G5 | **角色矩阵双源**：前端 `navigation.ts` 的 roles 与后端 `@Roles`/`FALLBACK_CONTROLLER_ROLES` 无一致性门禁 | 已产生"链到 403"与"服务端放行但前端无入口"两类断点 |
| G6 | **无 RLS 的租户域表**：`ewoh_resource_locks` 等含 `org_id` 却未启用 RLS | 见 `db/migrations/standalone_004` |
| G7 | **真实硬件缺失**：CP-SAT worker 未部署（`ortools` 未安装→UNAVAILABLE）；OPC-UA/厂商 AGV 只有连接器清单，无 `ActuatorTransport` 实现 | `scheduler/cpsat/`、`connectors/opcua.py` |
| G8 | **真实硬件接口面（2026-09-13 部分收口）**：NXP1 TCP 接收端已补（`edge/device_driver.py`，`EWOH_ADAPTERS` kind=`ny_exo_a1_tcp`，可经 `scripts/replay_device.py` 录播验证）；OPC-UA 传输为**注入式骨架**（`actuator/opcua.py`，真栈未接，未配真实客户端显式拒绝）；CP-SAT worker 仍默认 OFF（`ortools` 未安装→UNAVAILABLE）。**真机联调仍未发生** | `edge/device_driver.py`、`edge/adapters/actuator/opcua.py`、`scheduler/cpsat/` |
| G9 | **文档漂移**：`capability-alignment.md` 能力矩阵 `updated_at` 停在 2026-08-16，缺 NO-53a…NO-67 系列 | `docs/capabilities/capability-matrix.yaml` |
| G10 | **ADR 编号冲突**：两篇 ADR-059 | `docs/decisions/ADR-059-*.md`（两个文件） |

## 9. 最近一次全仓门禁矩阵（2026-09-13 实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 边缘 unittest | `python3 -m unittest discover -s src/edge_platform/tests` | **1145 passed** |
| 仓库级契约测试 | `PYTHONPATH=src python3 -m pytest tests/ -q` | **686 passed, 11 skipped** |
| 平台 Jest | `cd ewoh-spark-app && npx jest` | **3183 passed / 3185**（2 项失败同源于 route-manifest 漂移，已修） |
| 静态检查 | `ruff check src/edge_platform` | **All checks passed** |
| 安全扫描 | `bandit -r src/edge_platform -ll` + `scripts/bandit-gate.py` | **PASS（0 critical/high）** |
| OpenAPI 零漂移 | `node scripts/audit-openapi-routes.js --strict` | **464/464 已登记，0 幽灵路由** |
| 仓库事实 | `node scripts/audit-repo-facts.js --strict` | **39/39 passed** |
| 单一事实源 | `node scripts/truth-manifest.js --check` | **no drift** |
| 边缘模拟闭环 | `make demo-closed-loop` | **通过（12 次 HTTP 操作）** |
| 本地真实 PG 栈 | `scripts/local-up.sh` | 容器 `ewoh-pg-dev`(PG 17.11) 就绪；110 表 / 99 开 RLS / 3 账号 |
