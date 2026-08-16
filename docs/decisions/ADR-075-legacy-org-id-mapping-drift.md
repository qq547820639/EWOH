# ADR-075：Legacy 受管表 org_id 映射漂移闭合（NO-13z）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-071~074（读面组织隔离四波）、001 ewoh_org_visible RLS、
  §3（单一事实源）/§15（多租户）/§30（领域模型优先）

## 背景

NO-13z 仓库事实扫描（R-96）对照 001 的 `ewoh_rls_normal` 通用循环
（49 张表全部 `ENABLE ROW LEVEL SECURITY` + `ewoh_org_select /
ewoh_service_all` policy = `ewoh_org_visible(org_id)`）与 drizzle
schema.ts 映射，发现 **17 张受管表在 schema.ts 中缺失 org_id 映射**：

- 物理层（既有 workspace 库）：这些表带 org_id 列并受
  ewoh_org_visible 约束；`ewoh_org_visible(p_org_id uuid)` 严格
  语义 = 全局管理员或 org ∈ app.current_org_ids（GUC 未设置时
  coalesce 缺省 'true'——仅影响无 GUC 的裸连接）；
- 应用层（drizzle）：映射缺失 → 所有 insert 不携带 org_id →
  写入 NULL org 行 → 非 admin 请求（GUC 已设置 is_global_admin=
  false）下 **RLS WITH CHECK 拒绝 INSERT、USING 读回为空**——
  潜伏的生产级故障（CI 从未在真实 PG 上跑过这些路径，
  CR-STANDALONE-* 同源）；
- standalone 引导路径：generate-standalone-ddl 由 drizzle schema
  生成 → 物理表也无 org_id → RLS 循环的 CREATE POLICY 引用不存在
  列——与"standalone 链从未实证运行"一致。

17 表：ewoh_ai_suggestion、ewoh_production_task、ewoh_task_template、
ewoh_task_step、ewoh_device_config、ewoh_device_binding、
ewoh_organization、ewoh_environment、ewoh_model_registry、
ewoh_schedule_audit、ewoh_event_chain、ewoh_topology、
ewoh_telemetry、ewoh_factory_template、ewoh_factory_profile、
ewoh_asset_package、ewoh_device。

## 仓库事实

- 001 手写基线 CREATE TABLE（fresh-workspace bootstrap）同样缺
  org_id 列（既有 workspace 库的表是更早系统建的，带 org_id）；
- 活跃写路径：schedule_audit（plan.service/plan-application/
  gamification）、telemetry+device（ingest 批量/单帧）、
  model_registry（R-91 persistModel）、environment
  （sensor-ingest）、organization（create）、device（dashboard
  createDevice）、telemetry+device（simulator，EWOH_SIMULATOR_
  ORG_ID GUC 包装）；production_task/device_binding/topology/
  event_chain/ai_suggestion/task_*/factory_*/asset_package 无应用
  写路径（种子/迁移注入）。

## §29 十八问（实现前作答）

1. **Domain**：多租户数据面（§15）+ 领域模型漂移（§30）。
2. **Canonical Contract**：无契约变更（schema 映射修复）。
3. **Authoritative Source**：物理 org_id 列（001 RLS 判定事实）；
   schema.ts 必须与之对齐（§3 禁止两个事实源漂移）。
4. **如何改变 Factory World**：写路径开始携带 org 归属（读取/写入
   均本租户）；零语义变化。
5. **Event**：无。
6. **谁消费**：全部既有读写路径。
7. **失败会怎样**：修复前 = 生产写拒绝/读空（潜伏）；修复后 =
   正常。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：写侧确定性；upsert 幂等不变。
10. **权限边界**：org 归属注入不改角色语义（RLS 判定层不变）。
11. **租户边界**：新行 org 归属（ctx/事件租户/模拟器 GUC 注入）；
    存量 NULL 行 = ewoh_org_visible 语义下的全局管理员可见
    （过渡边界，与前几波语义一致——函数语义本身不变）。
12. **安全风险**：消除"生产写被 RLS 拒绝/读回空"的潜伏故障与
    漂移事实源。
13. **Human Approval**：不涉及（数据面修复）。
14. **如何解释 Decision**：非调度决策（访问/归属）。
15. **如何测试**：写路径 orgId 注入断言（audit/telemetry/device/
    model registry）+ schema 映射存在断言 + 双 tsc。
16. **如何审计**：audit 行自身开始携带 org_id（审计链可租户
    过滤）。
17. **如何迁移**：无新迁移（列已存在；映射+注入为应用层收敛）；
    001 手写基线补 org_id varchar(255)（fresh bootstrap 对齐）。
18. **如何回滚**：还原 schema 映射与注入即回滚（无 DDL）。

## 决策

### 决策 1：schema.ts 全 17 表补 org_id 映射

`orgId: varchar("org_id", { length: 255 })`（可空；物理既有列对齐；
uuid 值以字符串承载——ewoh_org_visible 内部 `::uuid` 转换兼容）。
001 手写基线 CREATE TABLE 同补 `org_id varchar(255)`（fresh
workspace bootstrap 路径与物理真相一致）。

### 决策 2：活跃写路径 org 注入（ctx/事实来源）

- schedule_audit：plan.service insertAudit(+orgId) 三调用点 +
  constraint.deactivate 内联（actor）；plan-application confirm/
  reject（gucContext）/override.apply（ctx）；gamification 四站点
  （actor）——audit 行归属 = 操作者 org；
- telemetry/device（ingest）：批量/单帧路径 orgId = ctx.primaryOrgId
  （行级注入；无租户上下文 → NULL 显式 legacy，不伪造）；
- model_registry（persistModel）：orgId = orgIdFromModelId(modelId)
  （R-91 org 命名空间唯一事实源，§3 不新建第二来源）；
- simulator telemetry/device：orgId = EWOH_SIMULATOR_ORG_ID（与
  withSimulatorOrgContext GUC 同源，模拟数据显式标记 §13）。

### 决策 3：显式边界（NO-13aa 候选）

无 ctx 写路径保持 NULL 并显式登记：sensor-ingest ingestEnvironment
（frame 无租户字段）、organization.createOrganization（org 行自身
归属=自身 id，需 CTE/回读改造）、dashboard.createDevice（无 actor
签名）。这些路径在真实库中本就受 RLS 约束（写入会失败/读空），
登记为下一波改造候选，不在本轮伪造 org。

## 后果

- 17 张受管表的 schema↔物理漂移闭合（§3）；audit/telemetry/device/
  model 写路径恢复生产可用（RLS 判定可满足）；
- 无 DB 迁移（列已存在）、无契约/OpenAPI 变更。
