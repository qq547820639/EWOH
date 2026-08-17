# Tenant Isolation Report — 租户隔离攻击矩阵与 RLS/谓词双层现状

> 生成时间：2026-08-18
> 数据来源：`parts/tenant-test-inventory.md`（测试证据清单，强度分级 [A]-[E]）、`findings.jsonl` 租户类 FIXED 项（SBZ/SAM/SNZ/SDB/SSV/SOP 系）、`parts/fixlog-tenant.jsonl`、`parts/fixlog-nz.jsonl`、`parts/fixlog-ops.jsonl`、`parts/fixlog-schsvc.jsonl`、`parts/fixlog-db-contracts.jsonl`、`parts/fixlog-p1-closeout.jsonl`（R2-APT-006）、`p2p3-dispositions.md`。
> 口径：findings.jsonl 中带租户边界标记的发现共 28 项，其中 **27 项 FIXED、1 项 DISPOSITIONED（P3 低风险）**（脚本统计）。

---

## 1. 防线架构：RLS + 应用谓词双层

| 层 | 机制 | 证据 |
|---|---|---|
| DB 层（RLS） | TENANT_SCOPED 表逐表 `*_org_isolation` RLS 策略（standalone_025/028/032/034-049/051/056/057 系列）；GUC 注入链 `app.user_id/current_org_id/current_org_ids/is_global_admin`；`CREATE ROLE ewoh_api NOBYPASSRLS`；GLOBAL_SHARED 豁免 6 张（repository-truth.md §5） | tenant-test-inventory [E] 机制级（org-context.interceptor.spec / request-database-context.spec / scenario-packages SP-08） |
| 应用层（谓词） | orgCondition 辅助模式：global_admin 放行、缺租户 400 fail-closed、他租户不可见（world/resource/organization/workflow 等域统一）；写侧 requireOrgId 显式注入 orgId | tenant-test-inventory [C] SQL 谓词级（plan-org-isolation.spec / scheduler-read-org-isolation.spec 等 ~25 用例） |

本轮关键收口：**ewoh_idempotency_keys 补齐租户维度**（standalone_060：org_id 列 + (org_id,scope,idempotency_key) 唯一键 + RLS idempotency_org_isolation——此前该表为 GLOBAL 表且服务层不透传租户上下文，R2-SDB-006）；**ewoh_spatial_entity / ewoh_device 复合唯一**（standalone_059 (org_id, entity_id)；057 (org_id, device_id) 对齐）——跨租户同 ID 互相覆盖面消除（R2-SOP-003/R2-SAM-003/R2-SDB-001）。

---

## 2. 租户攻击矩阵结论表

行=攻击者身份（对 Org A 数据发起访问），列=读写面。格内为**现有证据强度与结论**：✅=行为级证据（[A]/[B]，真实拒绝或过滤）；☑️=谓词/写侧归属级证据（[C]/[D]，代码路径锁定）；⚠️=无跨租户行为级用例（仅同租户正例/机制级）；✖️=本轮未覆盖。

| 攻击面 | Org B（同角色 dispatcher 等） | Org B Viewer（低权角色） | Global Admin（跨 org） | 匿名/无凭证 |
|---|---|---|---|---|
| **读·调度域**（plan/constraint/conflict/policy/feedback/KPI） | ☑️+部分✅：constraints 有 [A] 并发行为级（A1：orgA 读到 A+全局、不含 B）；plan 冲突 KPI 谓词锁定（C1/C2）；policy 版本读写面 R2-SSV-01 修复（激活不再改写他租户行归属） | ☑️（同谓词，角色面另有 RBAC） | ✅ 显式例外语义：global_admin 放行为既定设计（NEST-614/plan-tenant-guard R2-SMI-011 单条读放行一致化） | ✅ RolesGuard default-deny + AccessTokenGuard（401） |
| **读·控制/工单/MES**（control/workorder/step） | ✅ control 404 反枚举（A3：orgB 读/追加均 404）；workorder/step 经 R2-SAM-002/R2-SNZ-012 修复（mobile scan/getOrder 透传 userContext + mes orgCondition 收敛 fail-closed） | ⚠️ 未单独测 viewer 跨租户（角色 403 与租户隔离在此面不可区分——R2-APT-006 已把 e2e 断言改同角色跨 org，避免以 403 冒充） | ☑️ global_admin 放行 | ✅ 同上 |
| **读·特征旗标/系统配置/operations 汇总** | ✅ R2-APT-006 修复后：dispatcherB 读 orgA feature flag → 404、config 面 403、operations 列表不含 orgA 行/汇总 0（e2e 真实断言） | ⚠️ viewer 403 保留为 RBAC 补充断言（不再冒充租户隔离） | ✅ globalAdminB 跨 org 读为 NEST-614 既定例外显式断言（R2-APT-006） | ✅ |
| **读·文件/工作台视图/前端指标** | ✅ [B] 应用级行为证据（B1 files list→[]/get/remove→throw + isGlobalAdmin 例外；B3 workbench-view org-2 不可见；B4 frontend-metrics 互不可见）；e2e 无 files 流程（缺口） | ☑️ | ✅ B1 单侧正例（isGlobalAdmin 放行） | ✅ |
| **读·世界/回放/事件链** | ☑️ R2-SNZ-001 修复（getEventChain 谓词 + 5 用例：他租户空/缺租户 400）；R2-SNZ-014 replay limit；⚠️ e2e 无 world replay 跨租户负例 | ☑️ | ☑️ | ✅ |
| **读·人员/组织**（personnel） | ☑️ R2-SNZ-011 全端点收口（原零谓词跨租户枚举/篡改；list/get/getSensitive/update/bindings + create 归属强制） | ☑️ | ✅ global_admin 放行 + orgId 参数 ∈ accessibleOrgIds 校验 | ✅ |
| **写·策略激活/回滚** | ✅ R2-SSV-01：activatePolicyVersion 叠加 org 可见性条件且 set 不再含 orgId（跨租户策略抢注/改写归属关闭，4 用例）；R2-SSV-09 policy-replay org 条件 | ☑️ | ☑️ | ✅ |
| **写·执行回填/反馈** | ✅ R2-SSV-13：对 dispatched/executing 的回填限受派人本人或可信调用方，否则 403；R2-SSV-15 recordBaseline org 条件（跨租户 planId 返回 0） | ☑️ | ☑️ | ✅ |
| **写·资源库存/预占**（resource） | ✅ R2-SNZ-009：getPreorder/issue/release 全链读写谓词（他租户 404、缺租户 400、insert 显式 orgId）+ R2-SNZ-010 issue 增量 CAS（并发覆盖关闭） | ☑️ | ✅ global_admin 放行 | ✅ |
| **写·Ingest 上行**（遥测/事件/环境帧） | ✅ R2-SOP-004：per-key org 绑定（INGEST_API_KEY_<ORG_ID>），自报 X-Org-Id 越出绑定域 403 INGEST_ORG_MISMATCH；R2-SOP-022 环境帧缺 org fail-closed；R2-SNZ-004 模拟器行显式 org | —（key 面） | —（key 面） | ✅ IngestGuard 401（X-Ingest-Key constant-time） |
| **写·幂等键** | ✅ R2-SDB-006：幂等表 org 维度 + RLS（跨 org 幂等键不复用） | ☑️ | ☑️ RLS 全局管理员分支 | ✅ |
| **写·审批/Agent/Learning** | ☑️ R2-SBZ-002（agent getCurrentWorldState ctx 透传，建议 facts 不再聚合全租户世界）；R2-SBZ-003（learning approve @Roles）；R2-SBZ-004（影子评估 facts 服务端 org 作用域重建） | ☑️ | ☑️ | ✅ |
| **写·gamification/scale/onboarding** | ✅ R2-SBZ-005/006、R2-SAM-004（跨租户遥测/实体名不再进入节拍推算；plan 归属分裂 400 plan_tenant_mismatch）；R2-SOP-008/009/010（scale 读/写谓词 + 23505→409 跨租户抢注显式化） | ☑️ | ☑️ | ✅ |

矩阵结论：**读面行为级证据集中在 control、feature-flags/config、scheduler constraints、files/workbench（unit）、world（unit）**；写面经本轮修复后应用层谓词全覆盖（调度域 SSV 系列、资源 SNZ-009/010、ingest SOP 系列、幂等 SDB-006），且跨租户写路径均有负例用例登记（fixlog tests 字段）。**未覆盖面如实声明**：MES 工单/ERP 订单/OEE 安灯/scale 模板资产等模块无跨租户 e2e（tenant-test-inventory §7.2）；browser 层零租户覆盖（§6）；双 org 并发写同业务键无 e2e（§7.5）。

---

## 3. RLS 本体的运行时证据现状

- **唯一运行时 RLS 验证**：test/e2e/org-rls-guc.e2e.spec.ts（A1/A2）——真实 PG 下 `set_config(app.current_org_id)` 对 `ewoh_scheduling_constraint` 的策略过滤：orgA→[A,全局]、orgB→[B,全局]、未知 org→仅全局行（证明 RLS 真在过滤、未被绕过）。
- **覆盖缺口**：RLS 行为级 e2e 仅此 1 张表；`ewoh_org_visible` 覆盖的其余 48 张受管表无 RLS 行为级 e2e（tenant-test-inventory §7.1）——由 [E] 机制级（GUC 注入契约、NOBYPASSRLS、DDL 断言）+ [C] 谓词级 + CI verify 脚本（db/verify/*.verify.sql 结构断言）三层补偿。
- 空库链路 verify（standalone_060 等）需真实 PG：ENVIRONMENT_BLOCKED（见 `test-report.md`）。

## 4. 本轮租户类修复清单（27 项 FIXED 摘要，按域）

| 域 | ID（修复要点） |
|---|---|
| scheduler-svc（7） | R2-SSV-01 策略版本 org 读写面+不改写归属；R2-SSV-02 KPI 聚合 orgId；R2-SSV-04 维护/质量附着 org 过滤；R2-SSV-09 replay/candidate org；R2-SSV-13 回填授权；R2-SSV-15 基线 org；R2-SSV-17/18/22/25/26（影子评估/euclidean/adapter/聚合守卫/global_admin 全局 KPI 放行） |
| server-ops（7） | R2-SOP-001 requireActorOrgId（不再写 'default' 共享 org）；R2-SOP-003/059 复合唯一；R2-SOP-004 key-org 绑定；R2-SOP-009/010 scale 读写谓词+409；R2-SOP-011 故障转移 org 谓词；R2-SOP-022 环境帧 fail-closed |
| server-m（3+） | R2-SAM-001 ERP ack 双面谓词；R2-SAM-002 mobile 透传+mes fail-closed；R2-SAM-004 gamification 谓词 |
| server-biz（3） | R2-SBZ-002 agent ctx；R2-SBZ-004 影子评估服务端 facts；R2-SBZ-005/006 gamification 谓词+plan 归属分裂 400 |
| server-nz（SNZ 系列） | R2-SNZ-001 事件链；R2-SNZ-003 workflow fail-open→fail-closed；R2-SNZ-009/010 resource 谓词+CAS；R2-SNZ-011 personnel 全端点；R2-SNZ-012 mobile/mes（交叉登记 R2-SAM-002）；R2-SNZ-015 task/model 写谓词；R2-SNZ-016 配置写 requireOrgId |
| server-db | R2-SDB-001/002/003 schema↔057 对齐；R2-SDB-005 幂等占位式；R2-SDB-006 幂等 org 维度 |
| server-misc | R2-SMI-002 deviceId 归属；R2-SMI-005 audit org 守卫；R2-SMI-006 AI 读面租户收敛；R2-SMI-011 global_admin 单条读放行一致化 |
| app-tests | R2-APT-006 e2e 跨租户断言修正（同角色跨 org；见 §5） |

## 5. e2e 跨租户断言修正（R2-APT-006，P1）

- **before**：两个 e2e 用例以 viewerB 403（角色拒绝）冒充 org 隔离——system config 与 operations 的真实跨租户读隔离在 e2e 层零覆盖（tenant-test-inventory §6 伪隔离清单）。
- **after**（parts/fixlog-p1-closeout.jsonl R2-APT-006）：跨租户断言改**同角色跨 org**——dispatcherB 读 orgA feature flag → 404、config 面 403、globalAdminB 跨 org 读为 NEST-614 既定例外**显式断言**；operations 用例加 dispatcherB 列表不含 orgA 行/汇总 0；viewer 403 保留为 RBAC 补充。
- 关联：R2-APT-011（fake-control-db 忽略 WHERE 的脆证据）按 TEST_HYGIENE_ACCEPTED 裁决保留现状（control 的跨租户 NotFound 依赖服务层行内比对）。

## 6. DISPOSITIONED 中的租户相关低风险残留

| ID | 裁决码 | 内容（低风险理由） |
|---|---|---|
| R2-SBZ-011 | DEFENSE_IN_DEPTH_ACCEPTED | storage 驱动未校验 orgId 格式即拼路径/S3 键（防御性缺失，核心谓词已闭合） |
| R2-SDB-008 | DEFENSE_IN_DEPTH_ACCEPTED | 057 NULL-org 回填启发式（全部存量 NULL 并入 min(org_id)，多租户存量场景需人工核对——已知限制） |
| R2-SDB-010 | DEFENSE_IN_DEPTH_ACCEPTED | 生产 DatabaseOrgHierarchyProvider 未实现 loadAll（resolveOrgScope 降级） |
| R2-SAM-009/011/013 | DEFENSE_IN_DEPTH_ACCEPTED | ERP 审计 orgId 回退空串 / model transition 无 org 谓词（前置守卫存在 TOCTOU 窗口）/ 环境帧 legacy 豁免 |
| R2-SBZ-010 | DEFENSE_IN_DEPTH_ACCEPTED | files list 无分页/索引化（org 文件量增长后性能面） |

（findings 租户标记 DISPOSITIONED 仅 1 项在统计口径内；上表按 p2p3-dispositions 裁决语义归入租户残留观察。）

## 7. 结论

1. **双层防线成立且本轮显著增厚**：应用层谓词从"点状覆盖"收敛为跨域统一模式（orgCondition/requireOrgId + 负例用例登记）；DB 层新增 060 幂等 RLS 与 059/057 复合唯一三处结构性补强。
2. **跨租户行为级（[A]）证据仍集中少数面**（control、feature flags、scheduler constraints、RLS 1 表），其余靠 [B]/[C]/[D]/[E] 金字塔支撑——这是当前最大的证据缺口，如实保留为 tenant-test-inventory §7 所列 7 项。
3. 伪隔离用例（2 个 viewer-403 冒充）已由 R2-APT-006 修正为同角色跨 org 断言；引用隔离覆盖时必须剔除的用例清单见 tenant-test-inventory §6。
