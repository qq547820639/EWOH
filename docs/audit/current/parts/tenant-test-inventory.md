# 跨租户隔离测试证据清单（tenant-test-inventory）

> 二轮审计 · domain=app-tests · 基线 58b7819e
> 范围：ewoh-spark-app/test/ 全部 150 文件（unit 106 / e2e 11 / browser 18 / helpers 8 / contract 6 / scenarios 1）
> 用途：租户隔离报告的测试证据基础。每条注明验证方式与强度分级：
> - **[A] 行为级·真实栈**：真实 HTTP/PG 下双 org 用户互访断言（最强证据）
> - **[B] 行为级·应用层**：fake DB 有状态过滤下的双 org 行为断言（服务代码路径真实，存储为 fake）
> - **[C] SQL 谓词级**：断言生成的 WHERE 条件包含 org 谓词（containsNode/flattenSQL），不验证行数据
> - **[D] 写侧归属**：断言写入行 orgId=ctx.primaryOrgId（闭合写路径）
> - **[E] 机制级**：GUC/schema/键结构等支撑机制断言

---

## 1. [A] 行为级·真实栈（真实 PostgreSQL + HTTP）

| # | 文件 | 用例名 | 验证方式 |
|---|------|--------|----------|
| A1 | test/e2e/org-rls-guc.e2e.spec.ts | `并发请求：org A / org B 各自只读到自己 org 的约束行` | dispatcherA/dispatcherB **并发** GET /api/scheduler/plans/:id/constraints：idsA 含 constraintA+全局行、**不含** constraintB（idsB 反向同）；额外 `onlyOwnOrGlobal` 全集校验（不只测 200） |
| A2 | test/e2e/org-rls-guc.e2e.spec.ts | `原始 SQL：set_config(app.current_org_id) 下 RLS 策略真实过滤行` | 以 runtime 角色直连：orgA GUC→[A,全局]、orgB GUC→[B,全局]、**未知 org GUC→仅全局行**（证明 RLS 真在过滤、未被绕过；区分『隔离生效』与『过滤掉一切』） |
| A3 | test/e2e/ewoh-http.e2e.spec.ts | `isolates org A control data from org B over HTTP` | orgA dispatcher 建 control request 后：orgB dispatcher 读 → **404**、追加命令 → **404**；orgA 自读 → 200 且 id 匹配（读+写双面，404 反枚举语义） |
| A4 | test/e2e/ewoh-http.e2e.spec.ts | `persists org feature flags and enforces write roles` | orgA admin 建 flag 后 orgB **viewer 列表**（200 数据面）`some(flag===flagKey)===false` —— 列表级过滤，非仅状态码 |
| A5 | test/e2e/ewoh-http.e2e.spec.ts | `evaluates feature flags with OpenFeature-style targeting...` | orgB viewer 携 orgB 上下文 evaluate orgA flag → `flag_not_found`（评估面隔离；同上下文 orgA 用户为 default_on） |
| A6 | test/e2e/ewoh-http.e2e.spec.ts | 全套件 DB 侧断言（~15 处） | 每个业务持久化用例均 owner 直查断言 `org_id === fixture.orgA.id`（telemetry/event/notification/schedule_plan/task/step/resource_binding/factory_template/profile/asset_package/event_chain/audit_log 等）——写侧归属闭环 [D] 的 e2e 面 |
| A7 | test/e2e/f61-02-persistence.e2e.spec.ts | `coalesces two concurrent app instances onto a single resource lock` | 双实例**同 org** 并发锁 → 409/唯一 (orgId, resourceKey)；org 维度唯一键的行为证据（非跨租户负例） |

**注**：A1/A2 是全仓唯一对 RLS 策略本身的运行时验证，且仅覆盖 `ewoh_scheduling_constraint` 一张表。

## 2. [B] 行为级·应用层（fake DB 有 org 过滤语义）

| # | 文件 | 用例名 | 验证方式 |
|---|------|--------|----------|
| B1 | test/unit/files/file.service.spec.ts | `hides another organization files while allowing a global administrator` | orgB：list→[]、get→throw、remove→throw；`{...orgB, isGlobalAdmin:true}`→可读（跨 org 负例 + global admin 例外，内存 store 真过滤） |
| B2 | test/unit/files/s3-storage.driver.spec.ts | `finds a record by idempotency key across stored metadata` | 同 idempotencyKey：org-a 命中、**org-b → null**（org 前缀分桶语义） |
| B3 | test/unit/operations/workbench-view.service.spec.ts | `a shared view is visible to another member of the same org` | 同 org bob 可见 alice 共享视图；**org-2 carol 不可见**（正反双例） |
| B4 | test/unit/observability/frontend-metrics.spec.ts | `enforces org isolation on query` | org-a/org-b 各摄入 1 条，query 互不可见 |
| B5 | test/unit/agent/agent.service.spec.ts | `待批清单：org 作用域 + 过期显式标记` | `listPendingApprovals('ORG-OTHER')` → **0**（fake where 含 org 谓词匹配） |
| B6 | test/unit/control/control.service.spec.ts | `getRequest 跨租户 → NotFound（ADR-077 读面守卫，反枚举）` | orgId=ORG-1 行 + ACTOR_ORG2 → NotFoundException；同租户放行且读回 orgId；NULL legacy 行放行（standalone_025 过渡边界三态全覆盖） |
| B7 | test/unit/shared/audit-chain.service.spec.ts + test/scenarios/scenario-packages.spec.ts (SP-06) | `keeps per-org chains...` / `SP-06 multi-org isolation: audit chains stay per-org` | org-a/org-b 链各 1 条、互不掺混；篡改检测 |
| B8 | test/unit/shared/idempotency.payload.spec.ts + work-orchestration/domain-persistence.service.spec.ts | `(scope, key)` 唯一约束去重 | 幂等键作用域含 org 的机制面（StatefulDb 按 (scope,idempotencyKey) 去重、重放不二建） |

## 3. [C] SQL 谓词级（org 条件注入锁定）

| # | 文件 | 覆盖服务/读面 | 验证方式 |
|---|------|--------------|----------|
| C1 | test/unit/scheduler/plan-org-isolation.spec.ts | PlanService.getPlan/approvePlan/rejectPlan/dispatchPlan/replan（行为级：跨租户 **NotFound + 零状态变更 + 不触碰 DispatchCoordinator**）；SchedulerQueryService.getPlans/getActivePlans/getRun/getAudit/listPlanConstraints | 行为断言 + `containsNode(cond, ewohSchedulePlan.orgId)` + `flattenSQL(cond)` 含 org 值与 `is null`（org 匹配或 NULL 存量语义，与 standalone_025 RLS 逐字对齐）；无 actor → 无 org 条件（RLS 兜底路径显式锁定） |
| C2 | test/unit/scheduler/scheduler-read-org-isolation.spec.ts | ConflictService.listConflicts/getConflictDetail（行为级 NotFound）、SchedulingFeedbackService.list/deriveKpis、ExecutionService.list、SchedulingPolicyService.listVersions、PolicyActivationService.listActivations、RoutingService.loadGraph | 同上谓词断言；**org 来源=ctx 而非 query 参数**（controller 废弃 query 来源的语义锁定） |
| C3 | test/unit/mobile/mobile.service.spec.ts | MobileService.listWorkbench | `sqlText(predicate)` 含 `assigned_person_id` + `user-1` + **`org-1`**；personId 不匹配 → Forbidden（NEST-412 本人或特权） |
| C4 | test/unit/dashboard/device-contract.spec.ts / aas / parameters / operations（config fake） | config 类读面 | fake where 语义实现 `row.orgId === value || row.configKey === value`（org 谓词参与过滤；NEST-201/202/W4 注释锚点） |
| C5 | test/unit/world/world.service.spec.ts、tracing/tracing.service.spec.ts、ingest 系列 | getReplay/getEventContext/getTrace/sensor ingest | 显式 `{primaryOrgId}` ctx 透传（W4 注释锚点；fake 不验证行过滤，列为弱证据） |
| C6 | test/unit/world-cursor/world-cursor.service.spec.ts | getSnapshot/getDelta | **缺 org 上下文 → fail-closed throw**（`org context missing`）；读写显式 ORG 参数 |

## 4. [D] 写侧归属（orgId 注入闭环）

| 文件 | 断言 |
|------|------|
| unit/scheduler/plan-org-isolation.spec.ts | `persistPlan` 写 `orgId=primaryOrgId`；getPlan 读模型透出 orgId |
| unit/control/control.service.spec.ts | createRequest 注入 orgId=ORG-1；sendCommand/receiveReceipt org=请求行 org；**无 actor → 省略 orgId 列**（DB GUC default，不伪造 §33） |
| unit/gamification/gamification.service.spec.ts | allocateResources 的 plan 行 + audit 行 orgId=ORG-1（ADR-071）；设备按 (orgId,deviceId) 定位（NEST-311） |
| unit/resource/resource.service.spec.ts | preorder/binding 行 org_id=org-1；upsert 键 SEED_KEY_COLS 含 org_id |
| unit/scheduler/decision-projection.spec.ts | record.tenantId=ORG-1；无租户 → `decision_tenant_unknown` 显式缺口（8 种 kind 全测） |
| unit/organization/organization.service.spec.ts | org 行归属=自身 id（RLS ewoh_org_visible 对齐） |
| unit/ingest/sensor-ingest.service.spec.ts | 有 org → orgId 注入；无 org → NULL 显式 legacy；camera 缺 org fail-closed |
| unit/oee、ingest(Andon 通知)、agent(通知/决策) | 通知行 orgId=org-1（R-58/ADR-037 租户作用域） |
| e2e/ewoh-http（A6） | 全链 owner 直查 org_id 断言 |

## 5. [E] 机制级

| 文件 | 机制 |
|------|------|
| unit/shared/org-context.interceptor.spec.ts | GUC 注入顺序契约 `app.user_id/current_org_id/current_org_ids/is_global_admin`；accessible 缺省回退 primary org；缺 RequestDatabaseContext → 500 不静默 |
| unit/shared/request-database-context.spec.ts | runInTransaction 执行 N 次 set_config 计数断言；`EWOH_DB_REQUIRE_TX=1` 回归根句柄 fail-closed；**systemTransaction 不加租户 GUC**（租户事务 vs 系统事务边界）；statement_timeout 注入 |
| unit/shared/org-scope.service.spec.ts | accessibleOrgIds 父子展开来源（ewoh_find_org*） |
| unit/scheduler/legacy-org-id-mapping.spec.ts | 17 张漂移表 + 控制面 3 表 org_id 列 schema 锁定（varchar 可空 / NOT NULL） |
| unit/simulator/simulator.service.spec.ts | 后台模拟器全部写经 org-sim GUC（隔离租户），无 org 配置跳过+计数 |
| scenarios/scenario-packages.spec.ts (SP-08) | `ENABLE ROW LEVEL SECURITY` DDL、`CREATE ROLE ewoh_api NOBYPASSRLS`、非破坏回滚断言 |
| contract/event-catalog.spec.ts | 每消息 required 含 orgId、source 含 {orgId} |

## 6. 伪隔离 / 弱隔离（不得作为租户隔离证据引用）

| 文件 | 用例名 | 问题 |
|------|--------|------|
| e2e/ewoh-http.e2e.spec.ts | `keeps system config rows org-scoped and unreadable by org B users` | 用 **viewerB 403** 冒充 org 隔离——viewer 对任何 org 的 config 都 403（角色拒绝）；未测 globalAdminB/dispatcherB 数据面。见 R2-APT-006 |
| e2e/ewoh-http.e2e.spec.ts | `runs maintenance, work-center, and efficiency lifecycle with org isolation` | 同上：仅 viewerB 对 /api/operations/summary 403；无任何 orgB 数据面断言。见 R2-APT-006 |
| browser/ 全部 18 文件 | — | ux009 fixtures 的 orgId 固定 `'default-factory'`，mock 层无租户维度；scheduler-command-map 全程单 admin org。浏览器层**零**租户覆盖（前端 RBAC 403 测试≠租户隔离） |
| helpers/fake-control-db.ts | （B6 依赖） | fake select/update 忽略 WHERE——control 的跨租户 NotFound 依赖服务层行内比对而非 fake 过滤，属脆证据。见 R2-APT-011 |

## 7. 缺口清单（隔离报告需如实声明）

1. **RLS 运行时验证仅 1 张表**：org-rls-guc 只播種/验证 `ewoh_scheduling_constraint`；`ewoh_org_visible` 覆盖 49 张受管表中的其余 48 张无 RLS 行为级 e2e。
2. **HTTP 跨租户负例仅 3 个业务面**（control 404、feature-flags 列表/评估、scheduler constraints）：MES 工单、ERP 订单/出站、OEE/安灯、scale 模板/资产、operations 维保、audit 查询、world replay、files（e2e 无 files 流程）、approvals 等模块**无跨租户 e2e**（files/workbench-view 等仅有 unit [B] 级）。
3. **global_admin 跨 org 语义未测**：globalAdminB 读 orgA 资源应得何结果（403/404/放行）在 e2e/unit 均无负例（仅 files unit 中 isGlobalAdmin 例外放行的单侧正例）。
4. **NULL org 存量行边界**：unit 侧三态（匹配/NULL/跨租户）覆盖良好（C1/B6），但 e2e 无 NULL org 行的行为验证。
5. **并发下的隔离竞态**：无双 org 并发写同一业务键（如同 orderId 跨 org 碰撞、idempotencyKey 跨 org 复用）的 e2e；ingest dedup 键含 org 仅有 unit 断言。
6. **browser 端零覆盖**（见 §6）。
7. **伪隔离用例的命名误导**（§6 前两条）若被报告引用会高估 e2e 隔离覆盖。

## 8. 汇总统计

| 强度 | e2e | unit/scenarios | 合计（用例/文件级） |
|------|-----|----------------|------|
| [A] 行为级·真实栈 | 5 个跨租户用例（A1-A5）+ 全套件 org_id DB 断言 | — | 5 用例 |
| [B] 行为级·应用层 | — | 8 个文件（B1-B8） | ~12 用例 |
| [C] SQL 谓词级 | — | 6 组（C1-C6，C1/C2 兼具行为级） | ~25 用例 |
| [D] 写侧归属 | 贯穿 ewoh-http | 8+ 文件 | 大量 |
| [E] 机制级 | — | 7 个文件 | — |
| 伪隔离 | 2 个用例 | — | 2（须排除） |
| browser | 0 | — | 0 |

**结论**：跨租户隔离测试金字塔为「机制/谓词/写侧覆盖扎实（C/D/E 广泛且有注释锚点 ADR-071~075、W4、NEST-2xx 系列），但行为级验证（A/B）集中在前端可见的少数面（control、feature flags、files、scheduler plan/constraint）」；RLS 本体的运行时证据仅一张表；两个 e2e 用例以角色 403 冒充租户隔离（R2-APT-006），引用时必须剔除。
