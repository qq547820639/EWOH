# EWOH 优化实施 · 断点交接文档

> 首次生成：2026-08-28 16:40　｜　**最后更新：2026-08-29（全部批次 + 全部决策项收口，交付完成）**
> 中断原因：agent 通道 429 限流（主会话改为主理人亲自执行）→ 2026-08-29 起恢复自主执行并收口
> 用途：本文档为**历史交接 + 最终执行记录**；最终交付清单见 `EWOH-最终交付清单.md`。

---

## ⚡ 接续速览（2026-08-29 终版）

**累计 19 个 commit**（c77895f → `1682151`，全部经测试验证）：
批次 A–C（11 项）：`b9d4c60`(T1) → `92ae73c`(T2) → `b9f406c`(T7) → `6376f69`(T8) → `4831848`(T5/T6) → `ae7433d`(T4最小加固) → `0a5ea14`(T11) → `32233a0`(T12-A) → `35687a9`(T12-B) → `ec023d4`(T8 lockfile 收尾)
批次 D + 决策项（本日 5 个）：`70aaa06`(T4 委托反转/决策项 1) → `05b861f`(T9 求解器复杂度) → `b7ad4ac`(T10 统一回退) → `2df572e`(决策项 2 零风险子项) → 交付文档

| 批次 | 任务 | 状态 | Commit |
|---|---|---|---|
| **A** | T1 前端测试接入 CI | ✅ 已完成并验证 | `b9d4c60` |
| **A** | T2 overview 缓存改 Map | ✅ 已完成并验证 | `92ae73c` |
| **A** | T3 生产模拟器开关 | ✅ **终验闭环**（2026-08-29 SSH 实测：`ENABLED=0` + `DISABLED=1` 双保险在位；零代码改动） | — |
| **A** | T7 预览接口切只读快照 | ✅ 已完成并验证 | `b9f406c` |
| **A** | T8 缓存抽象（方案①） | ✅ 已完成并验证；lockfile 收尾 `ec023d4`（裁决 4） | `6376f69`/`ec023d4` |
| **B** | T5 补 5 表 RLS | ✅ 迁移 standalone_067 | `4831848` |
| **B** | T6 复合索引 | ✅ 迁移 standalone_068（修正审计建议） | `4831848` |
| **C** | T4 派工收敛 | ✅ **完整收敛**：最小加固 `ae7433d` + 委托反转（决策项 1 裁决 B）`70aaa06` | `ae7433d`/`70aaa06` |
| **C** | T11 约束 fail-closed | ✅ error 显形 + 开关 | `0a5ea14` |
| **C** | T12 shadow 清理 + Execution 显形 | ✅ `32233a0`/`35687a9` | `32233a0`/`35687a9` |
| **D** | T9 求解器复杂度 | ✅ 槽位索引增量维护 + 二分判定 + engine 分组（对拍 oracle 100 用例全绿；500t -23% / 1000t -12%） | `05b861f` |
| **D** | T10 统一求解器回退语义 | ✅ milp/rule-based 显式回退 heuristic + 评估器单例 | `b7ad4ac` |
| **决策** | 决策项 1（T4 处置） | ✅ 裁决 B 并实施；C 观察期开放 | `70aaa06` |
| **决策** | 决策项 2（Python 调度栈） | ✅ 裁决 B 冻结；零风险子项已落（runbook 警告），完整冻结留季度评审 | `2df572e` |
| **决策** | 决策项 3（T3 终验） | ✅ **已闭环**（凭据恢复后 SSH 实测双保险在位 + 平台部署健康证据） | 见 §七 |
| **决策** | 决策项 4（T8 lockfile） | ✅ `npm install --package-lock-only`（2 行差异，npm ci 实测通过） | `ec023d4` |

**T13–T16**（shared 解环/边缘核心域下线/上帝文件拆分/覆盖率门禁）：维持路线图定位
——中长期架构治理，建议纳入下季度规划，不属于本交付范围。

---

## 二、已完成项的验证结论（已逐个 diff 复核，可放心保留）

### `b9d4c60` T1 — 前端 Jest 接入 CI
- 文件：`.github/workflows/test.yml:209` 之后新增 step
- 位置：紧跟后端 Jest 之后，**同一 job 共享已安装依赖**，`working-directory: ewoh-spark-app` 正确
- 效果：138 套件 / 1173 用例（约 13.9s）纳入发布门禁

### `92ae73c` T2 — overview 缓存单槽 → 有界 Map
- 文件：`server/modules/dashboard/dashboard.service.ts`
- 改动：`private overviewCache: {...} | null` → `new Map<string, {data, timestamp}>()`
- **有界化**：`OVERVIEW_CACHE_MAX_ORGS = 500`，超限淘汰最老一半（对齐 `scheduler-stream.service.ts:51` SEEN_CAP 做法）
- 命中逻辑 `:146` 改为按 orgKey 取；写入前调用 `evictOverviewCacheIfNeeded()`
- 单租户语义完全不变（命中/TTL/返回结构一致）

### `b9f406c` T7 — 预览接口切换只读快照
- 三个接口改为 `buildSnapshotReadOnly`：`conflict-preview.service.ts:72`、`override-preview.service.ts:56`、`replan-preview.service.ts`
- **同步补了测试 mock**（`override-preview.spec.ts`、`replan-preview.service.spec.ts` 均增加 `buildSnapshotReadOnly`）

---

## 三、未完成项的精确 spec（接续时直接执行）

### T3｜生产模拟器开关　【优先做，含调查】

1. Grep 定位模拟器开关（可能是 `EWOH_SIMULATOR_ENABLED` 或等价命名）的定义、默认值、读取点。
2. **判断生产环境变量配置是否在本仓库内**——查 `deploy/`、`.env.example`、`docker-compose`、ECS task definition。
3. 分两种处理：
   - **配置在库内** → 在生产部署配置中显式置 `0`。
   - **配置不在库内**（大概率）→ **绝对不要改代码默认值**（会误伤开发/演示环境），把结论回传给用户，由其在 ECS 侧设置。
4. 顺带确认代码里有无"simulated 事件占比"可观测点；没有则加最简形式（日志或指标）。**若需动超过 1 个文件则不加，只回传建议位置。**

> 背景：生产 105,269 条事件中 105,255 条为 simulated，真实告警仅个位数，是 `eventCritical` 计数异常增长至 100,309 的根因。

### T8｜缓存抽象（方案①，已决策，勿改方案）

1. 再次确认 `@nestjs/cache-manager` 与 `cache-manager` 零引用（含动态 `import(`、配置文件、NestJS module 装饰器引用）。
2. 确认后从 `ewoh-spark-app/package.json` 的 dependencies 移除这两个。
3. **不要动 `hbs` 和 `crypto-js`**——精确导入为 0 但在用（`main.ts:5` 视图引擎、`user-profile.tsx:9` 子路径导入）。
4. 补 `scheduling-policy.service.ts` 的缓存失效调用：`invalidateActiveRowCache`（`:563`，当前 private 且只被 2 处调用）需在这些写入方调用——`policy-activation.service.ts:285/299/418/430`、`shadow-policy.service.ts:91`。若跨类调用需调整可见性或暴露失效入口，自行判断最合理方式。
5. 改完跑 `scheduling-policy` 与 `policy-activation` 相关测试。
6. **不要跑 `npm install` 或动 lockfile**（大动作，留给用户决定）。

### 批次 B｜数据库与租户隔离

**T5 补 RLS（5 张表）**
- 目标表：`ewoh_scheduling_execution`、`ewoh_scheduling_conflict`、`ewoh_scheduling_kpi`、`ewoh_route_cost_matrix`、`ewoh_policy_activation`
- 模式：按 `db/migrations/standalone_056` 既有写法
- **迁移必须注册 runner 7 处**（`db/runner/run_migrations.js`：FILES 3 键 + EXECUTE_COMMANDS + ROLLBACK_COMMANDS + usage + DDL allowlist + verify handler + which），参见 021/022
- 把 `org-rls-guc.e2e.spec.ts:64` 参数化为表清单驱动（当前仅覆盖 1/102 表 → 目标 86/102）
- 注意：`standalone_057:36-46` 是已登记的 ADR 偏差名单，这 5 张表不在其中，属遗漏

**T6 复合索引 + 谓词改写**
- 补索引：`(org_id, ts)`、`(org_id, status)`、`(org_id, online)`（现有 `:1409/:1421/:1451` 全是单列 `org_id`）
- `dashboard.service.ts:144,147`：把 `status='open'` 从 **`FILTER` 子句移到 `WHERE`**（当前无法 index-only scan）
- `:156-159` 遥测聚合 `where org_id=? and ts>=now()-1h` 补复合索引（遥测是写入量最高的表）

### 批次 C｜正确性修复

**T4 收敛 gamification 派工旁路**　⚠️ **需先调查，不可直接删**
- 现状：`gamification.service.ts:537-620` 独立重写派工（方案校验/租户校验/冲突检测/状态落库），与 `scheduler.controller.ts:383` 双实现
- **第一步必须查**：`POST /api/gamification/schedule/:planId/dispatch` 是否有活跃调用方（前端 `client/src/api/`、E2E、文档、飞书端）
- 有调用方 → 走废弃流程（先让旁路内部改为调用 `SchedulerService.dispatchPlanV2`，保留端点，观察后再删）
- 无调用方 → 直接删除 `gamification.dispatchPlan`
- **这是 breaking change 风险点，调查结论需回报用户确认后再动手**

**T11 约束加载静默降级改 fail-closed**
- `scheduler-run-orchestrator.service.ts:98-101`：`constraintLoader` 为 undefined 时静默返回 `[]`
- 改为 fail-closed，或至少 `logger.error` + 指标上报
- 风险：人工 LOCK/EXCLUDE 约束可能在静默降级中丢失而不被发现

**T12 shadow 清理 + Execution 完整性**
- shadow 清理：复用 `shadow-evaluator.service.ts:218` 的既有 retention 模式补到 `shadow-policy.service.ts:105`（当前清理逻辑全仓 grep = 0）
- Execution 完整性：`scheduler-plan-application.service.ts:337-391` 建档在事务外（已有 3 次重试），降级字段 `executionSync` **前端 0 处引用** → 前端需读 `executionSync.ok` 并提示 + 加对账告警

### 批次 D｜求解器治理

**T9 启发式求解器复杂度**
- `heuristic-scheduling-solver.ts:685-711`：三个槽位索引在任务循环**体内**每次迭代从全数组重建 → 改为增量维护、移出循环（**改动最小、收益最大，优先做这步**）
- `:1048/1063/1079`：三次 `.some()` 线性扫描单调增长的已预订槽位数组（`:1280/1286/1293` 每接受一个分配就 push）→ 改有序数组二分或区间树
- 复杂度 O(T²×S×D)，T=1000/S=20/D=50 ≈ 3×10⁹ 次操作（conflicts 曾实测 104s 的根因）
- **与上帝文件拆分是同一次重构**：抽 `solver-resource-index.ts` 时一并做
- **必须用 `scheduler-facade-characterization.spec.ts` 对拍确保结果不回归**

**T10 统一求解器选型与回退语义**
- 4 个求解器：heuristic(2000) / cp-sat(925) / milp-HiGHS(659) / rule-based(354)
- 只有 cp-sat 有完整回退（`solver.service.ts:494-508`）；**milp（`:258`）与 rule-based（`:253`）无回退**，注释自认"不隐式回退"（`:259-261`）
- 目标：统一为"策略声明 solver → 单一激活阶梯 → 统一回退 heuristic"
- `objectiveEvaluator` 强制单例注入（当前 `:123`、`:129` 各自 `new`，存在语义漂移）

---

## 四、执行纪律（血泪教训，务必遵守）

1. **绝对不要用 Agent(Explore) 子代理**——子代理嵌套成倍放大请求量，是配额耗尽的主因之一。
2. **每完成一项立刻 commit**——这是本轮三次 429 失败后仍能保住 3 个成果的**唯一原因**。
3. Grep 必须带 `head_limit`（20~30）+ glob 过滤；大文件用 Read offset/limit 分段读，不要整文件读入。
4. 单轮任务限时 6~8 分钟，宁可小批量多轮。
5. 遇到不确定就停下来问，不要自行扩大范围。

---

## 五、待用户拍板的决策（执行前需确认）

| # | 决策点 | 影响 | 详细决策单 |
|---|---|---|---|
| 1 | **T4 派工旁路完整收敛**（前端死封装已删 `13e8af4`，全仓确认无其它调用方；剩后端端点与 OpenAPI 契约处置） | 推荐 B 委托反转（零 breaking）；C 硬删需网关日志确认 | `deliverables/EWOH-待拍板决策单.md` 决策项 1 |
| 2 | **Python 边缘调度栈定位**（未列入 4 个批次） | 推荐 B 冻结（生产面收敛，保留 C 选择权） | `deliverables/EWOH-待拍板决策单.md` 决策项 2 |
| 3 | T8 移除依赖后是否更新 lockfile | `npm install` 会动 pnpm-lock，属大动作，需用户决定时机 | — |
| 4 | T3 终验 | SSH 凭据已失效，需用户执行只读命令 `ssh ... "grep SIMULATOR /opt/ewoh/.env"` | `deliverables/EWOH-待拍板决策单.md` 决策项 3 |

---

## 六、关联文档

| 文档 | 路径 |
|---|---|
| 汇总路线图（含 T1–T16 完整清单） | `deliverables/EWOH-全量代码深度审计与优化路线图.md` |
| 架构层审计 | `deliverables/audit-architecture-deep-dive.md` |
| 代码层审计（性能 + 可维护性） | `deliverables/audit-code-deep-dive.md` |
| 测试与风险审计 | `deliverables/audit-risk-and-testing.md` |
| **最终交付清单（本日收口）** | `deliverables/EWOH-最终交付清单.md` |

---

## 七、2026-08-29 执行记录（批次 D + 决策项，含裁决依据与测试证据）

### `70aaa06` T4 完整收敛（决策项 1 裁决 B：委托反转）

- `gamification.service.ts` dispatchPlan 重构为**轨道分派适配器**：
  - `approved` → 完整委托 `SchedulerService.dispatchPlanV2`（安全熔断/快照新鲜度/
    资源预约/Execution 建档/audit_log 全套正统机制），回写 `ewoh_schedule_audit`
    兑现旁路契约 auditId（正统审计在 hash 链，两表面向不同契约承诺，不重复）；
  - `confirmed` → 保留既有薄路径（legacy 方案无 V2 assignment 明细与 snapshotVersion，
    进 V2 机制将产生空分配派工；状态提升=伪造审批）+ `[DEPRECATED]` 观察期告警日志。
- 测试：gamification.service.spec **19/19**（新增 approved 委托适配回归：dispatchPlanV2
  调用断言/形状适配/审计留痕）；tsc 干净。

### `05b861f` T9 求解器复杂度（含坏测试修复）

- 新增 `solver-resource-index.ts`（SlotIndex：按 start 排序 + 前缀 max(end) + 二分
  overlap 判定）；求解器三 Map 移出任务循环、增量维护（消除 O(T×S_total) 重建
  主导项）；预筛/复验 `.some()` 线性扫描 → O(log k)。
- `candidate-engine.service.ts`：候选 eligibility ctx 由全量槽位（每候选重分组
  O(C×S_total) 二次项）改为循环入口一次性分组、每候选携带本资源行（eligibility
  按 id 过滤 → 同果）；工位行解析与 eligibility 同式（`candidateStationId ??
  task.stationId`，修复潜在的 stationId 回退漏判）。
- `constraint-run-loading.spec.ts`：补 `buildSnapshotReadOnly` mock（`b9f406c`
  改名遗留的坏测试，main 上已红）。
- **量化**（benchmark-scheduler，seed=20260807，新旧对比结果零差异
  feasibleRate=1/violations=0）：500t/12p/8d 155→120ms（-23%）；1000t/250p/125d
  12.85→11.29s（-12%）。端到端占比低于审计预估的原因：本轮修复的两个站点是
  渐近复杂度站点（O(T×S_total)/O(C×S_total) 消除），剩余耗时由每候选 eligibility
  深度校验等主导（不在 T9 规格内）。
- **对拍 oracle 全绿**：solver-fixtures（逐 fixture 确定性重放 + 精确 assignment
  断言）+ solver-invariants + solver-perf-parity（500 任务硬不变量）+
  solver-contract-parity + candidate-engine-parity/reject + candidates +
  scheduler-facade-characterization（56/56）= **100 用例**；scheduler 全目录
  119 套件 **979/979**。

### `b7ad4ac` T10 统一求解器回退语义 + 评估器单例

- milp/rule-based 求解异常 → 显式 warn + 回退 heuristic（原为异常直抛，与 cp-sat
  采样路径回退语义不一致）；"不隐式回退"更新为"不静默回退"（可观测性意图保留）。
  语义边界：MILP 两种失败（HiGHS WASM 加载失败/非 Optimal 实现缺陷）均为基础设施/
  实现缺陷类，非"问题不可行"判定，回退不掩盖问题语义。
- 缺省 `SchedulingObjectiveEvaluator` 收敛单例（原 `:123`/`:129` 两处 `?? new`）。
- 测试：solver-activation **13/13**（新增 milp/rule-based 回退回归 2 例）。

### `2df572e` 决策项 2 零风险子项

- `docs/operations/production-runbook.md`：Edge Runtime 小节增加
  `EWOH_EDGE_SCHEDULING_WRITE` 生产禁置 1 警告（fail-closed 语义 + 部署清单排除 +
  演练仅限 simulation）；`deploy/.env.example:149-151` 已有同口径警告，操作面补齐。
- 完整冻结（路由裁剪/生产镜像变化）留季度评审，不自动推进（与决策单约束一致）。

### 决策项 3（T3 终验）— ✅ 已闭环（2026-08-29 凭据恢复后）

- 用户提供 ECS 凭据后执行只读命令
  `ssh root@121.43.230.202 "grep SIMULATOR /opt/ewoh/.env"`，实测输出：
  `EWOH_SIMULATOR_ENABLED=0`、`EWOH_SIMULATOR_ORG_ID=…0001`、
  `EWOH_SIMULATOR_DISABLED=1` —— 双保险在位，与预期闭环条件完全一致。
- **测试平台部署健康证据（同日只读实测）**：`:3000` 首页/live/ready 全 200；
  `/health/ready` 返回 `{"status":"ok","service":"ewoh-api"}`（DB 门禁通过）；
  容器 `ewoh-api:0.6.0-rc42` Up 5 days (healthy)、`ewoh-postgres`（postgres:17）
  Up 6 days (healthy)、`ewoh-redis` Up 6 days (healthy)。
- 遗留说明：本地 main 整改链与在跑镜像 rc42 的代码对应关系未核实（容器无
  commit 标记）；本地整改随下次发布流水线上线。

### 类型检查口径说明

- 全仓类型检查应使用 `npx tsc --noEmit -p tsconfig.spec.json`（覆盖 server/shared/
  test；根 `tsconfig.json` 为 solution-style 引用工程，`-p .` 恒空转）。
- 当前唯一报错：`test/e2e/concurrency-real-pg.e2e.spec.ts` 3 处 `TS2554`（预存在，
  不在任何 jest 执行集内，与本轮变更无关，已验证对未改动代码同样报错）。
