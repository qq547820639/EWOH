# EWOH Canonical Contract 六方一致性审计报告（Contract Parity Report）

> 审计角色：契约审计员（只读）。审计日期：2026-08-17。
> 范围：JSON Schema（`contracts/`）↔ TypeScript（`ewoh-spark-app/shared/`）↔ Python（`src/edge_platform/contracts/`）↔ Database（`db/migrations/` + `db/contracts/schema-manifest.yaml`）↔ OpenAPI（`openapi/ewoh.yaml` / `openapi/work-orchestration.yaml` / `docs/api/openapi.yaml`）↔ Frontend types（`ewoh-spark-app/client/src/types/ewoh.ts`）。
> 输入：`docs/audit/current/findings-shared.jsonl`（11 条 TS/Python 漂移）+ `regression-shared.jsonl`（20 条回归状态）。

---

## 1. 执行摘要

**总体评价：核心契约面（Schema↔TS↔Python 三方注册表）已实现工程级锁定、全绿；DB 侧以 CHECK 约束对齐且质量高；OpenAPI 侧为系统性薄弱面（枚举不硬化、关键域 schema 缺失、内联重复定义）；Plan 域存在双生命周期并存的架构级漂移；前端 `types/ewoh.ts` 不是契约投影（仅角色注册表），前端契约消费实际由生成物承担。**

六项可运行门禁全部通过（均为本次实跑结果，非转述）：

| 门禁 | 结果 |
|---|---|
| `node scripts/audit-domain-contracts.js` | **581/581 PASS**（24 契约域 schema 形状 + 向量独立仲裁 + Python/TS 注册表逐项一致） |
| `node scripts/audit-identity-contracts.js` | **22/22 PASS**（identity 42 kinds 三方一致） |
| `node scripts/audit-event-envelope.js` | **24/24 PASS**（信封语义 TS/Python/仲裁三方一致） |
| `node scripts/audit-event-catalog.js` | **PASS**（65 messages / 65 channels） |
| `make contract-golden` | **329 passed**（golden 场景 + 域/identity/world/envelope/mq 契约 pytest） |
| `make contract-state-machine`（补跑佐证） | **5 passed**（Python 状态机 loader 与 7 个 yaml 一致） |

结论分档（24 个契约域行）：
- **✓ 一致 12 域**：三方注册表 + DB CHECK + OpenAPI 枚举全对齐（Maintenance/Quality 为全链样板）；
- **△ 漂移 7 域**：字段/枚举/状态集在两方以上不一致（Plan 最严重）；
- **✗ 单侧缺失 5 域**：某二方以上无实现或无 canonical 契约（Capability、Reservation、Dispatch、Execution、Approval-TS）。

另继承 findings-shared.jsonl 的 11 条 TS↔Python 字段级漂移（1 High / 3 Medium / 7 Low），全部为校验逻辑细节，不影响注册表级一致性结论。

---

## 2. 六方载体实际地图（审计事实源核定）

| 方 | 实际载体 | 核定结果 |
|---|---|---|
| JSON Schema | `contracts/{risk,location,resource,world,maintenance,quality,workorder,intelligence,reasoning,learning,observability,reliability,simulation,capability,decision,exo,entity,agent,agent_task,knowledge,identity,events}/` | 24+ 域 schema + test-vectors 齐备 |
| TypeScript | `ewoh-spark-app/shared/*.ts`（40 个源文件：域契约 + 状态机 + scheduler） | 与 Python 域文件 1:1 对应 |
| Python | `src/edge_platform/contracts/*.py`（28 文件）+ `src/edge_platform/scheduler/models.py`（调度状态机手写实现） | 契约层 + 调度运行时两层 |
| Database | `db/migrations/standalone_001..058`（成对 rollback）+ `db/contracts/schema-manifest.yaml`（74 受管表 + RLS 策略 + CHECK 注记） | 16+ 域有独立表；risk/location/capability/entity 无独立表 |
| OpenAPI | `openapi/ewoh.yaml`（18619 行，376 schemas，主契约）+ `openapi/work-orchestration.yaml`（1346 行）+ `docs/api/openapi.yaml`（472 行，仅 task 边缘 API） | 覆盖广但枚举硬化不均 |
| Frontend types | `client/src/types/ewoh.ts`（**仅 29 行：EWOH_ROLES 角色注册表**）；实际契约消费 = `client/src/types/openapi.d.ts`（19388 行，由 `scripts/gen-openapi.js` 从 ewoh.yaml 生成）+ `ewoh-spark-app/shared/api.interface.ts`（1365 行手写） | 任务指定载体不承载域契约，本报告以「生成型前端类型 + api.interface.ts」代为评审判定 |

---

## 3. 逐域六方矩阵

图例：✓ 一致 / △ 漂移 / ✗ 缺失 / — 不适用（该方按设计不承载此域）。「前端」列判定对象为 `types/ewoh.ts` + 生成型 `openapi.d.ts` + `api.interface.ts`。

| # | 域 | Schema | TS | Python | DB | OpenAPI | 前端 | 结论 |
|---|---|---|---|---|---|---|---|---|
| 1 | Identity | ✓ identity.schema.json（42 kinds） | ✓ identity.ts | ✓ identity.py | ✓ standalone_032（RLS） | ✓ IdentityMappingRecord | —（生成） | **✓ 一致**（残留 R2-SHR-007 bool 漂移） |
| 2 | Entity | ✓ entity-model.schema.json（45 kinds + 投影分工） | ✓ entity-model.ts | ✓ entity_model.py | —（逻辑模型，无实体表） | △ WorldEntity 仅为投影 | — | **✓ 一致**（DB 按设计缺席） |
| 3 | Observation/Event envelope | ✓ envelope.schema.json（requiredFields const 5 + rules 5 条） | ✓ event-envelope.ts（18 字段） | ✓ envelope.py | ✓ standalone_036 event_dedup | △ EnvelopeEventDto 13 字段 | — | **△ 漂移**（DTO 缺 tenantId/factoryId/actor；evidence 类型 object vs array） |
| 4 | Event catalog | ✓ event-catalog.yaml（65 类） | ✓ event-catalog.ts | ✓ event_catalog.py | —（目录不入库） | ✓ EventCatalog | — | **✓ 一致**（SH-015 已修） |
| 5 | World | ✓ world-state.schema.json（22 实体 + 双时态） | ✓ world-contract.ts | ✓ world.py | ✓ ewoh_world_state_snapshot / world_delta_log | ✓ WorldSnapshot/WorldDelta | — | **✓ 一致**（残留 R2-SHR-005 bool 漂移） |
| 6 | Resource | ✓ resource.schema.json（7 status） | ✓ resource.ts（scheduler.ts:11 import 收敛） | ✓ contracts/resource.py | —（无 canonical 资源表） | ✓ ResourceState | — | **✓ 一致**；但 scheduler/models.py 手写 6 值副本（见 §5-3） |
| 7 | Capability | ✓ capability.schema.json | ✓ capability.ts | ✓ capability.py | ✗ 无表 | ✗ 无 schema（仅 2 处提及） | ✗ | **✗ 单侧缺失**（DB/OpenAPI/前端三方无落点） |
| 8 | Location | ✓ location.schema.json | ✓ location.ts | ✓ location.py | —（spatial_hierarchy/relation 为拓扑非 canonical Location） | △ SpatialEntity 投影 | — | **✓ 一致**（三方核心；DB/OpenAPI 为投影面） |
| 9 | Risk | ✓ risk.schema.json（ladder 4 级 + legacy 映射） | ✓ risk.ts（decision.ts import 单源✓） | ✓ risk.py | △ 无 risk 表；severity CHECK 手写散布 3 表（034 mc/034 qf/035 wo，值对齐 ladder） | △ severity 无枚举（description-only，11718/11807 行） | △ api.interface.ts:1069 四值封闭（TS 严于 OpenAPI） | **△ 漂移**（OpenAPI 未硬化） |
| 10 | Task | ✓ state-machines/task.yaml（9 态 + role） | ✗ 无 task.yaml 状态机实现（agent-task.ts 属 #24） | ✓ scheduler/models.py TASK_*（tests 锁定） | ✓ ewoh_production_task | ✓ ProductionTask/CreateTaskDto | — | **△ 漂移**（TS 单侧缺状态机） |
| 11 | Plan | ✓ state-machines/plan.yaml（7 态） | △ scheduler.ts:34 SchedulePlanStatus=shadow/proposed/confirmed/rejected（**状态集不同**） | ✓ models.py PLAN_*（7 态手写对齐 yaml） | △ ewoh_schedule_plan：048 CHECK 的 production 态（approved/dispatched/executing/completed/confirmed/proposed）混两套 | △ SchedulePlan/V2 status 无枚举 | — | **△ 漂移（最严重）**：双生命周期并存 |
| 12 | Decision | ✓ decision.schema.json（8 kinds；riskLevels 与 risk 契约同源锁定） | ✓ decision.ts | ✓ decision.py | △ decision_records_json jsonb 落 4 表（050/052/053/054），无列级 CHECK，服务层强制 | ✗ 无 DecisionRecord 独立 schema（仅 6010 行 decisions 聚合 API 描述） | — | **△ 漂移**（OpenAPI 缺 schema） |
| 13 | Approval | ✓ state-machines/approval.yaml（5+7 态） | ✗ 无 approval 状态机实现（alert 有） | ✓ StateMachineLoader（5/5 绿） | ✓ standalone_049 agent_approval | ✓ ApprovalStep/Instance | — | **✗ 单侧缺失**（TS） |
| 14 | Reservation | ✗ 无 canonical schema | △ scheduler.ts 内嵌冲突语义 | ✓ tests/test_cpsat_reservation.py | ✓ standalone_009/022（capacity/conflict） | ✗ 无 schema | ✗ | **✗ 单侧缺失**（无契约 schema） |
| 15 | Dispatch | ✗ 无独立 schema | △ scheduler 内嵌 | △ scheduler/events.py | ✓ ewoh_assignment_event + standalone_024 | △ DispatchStatus 存在但 status 无枚举（14782） | — | **✗ 单侧缺失**（无契约 schema） |
| 16 | Execution | ✗ 无独立 schema（部分由 task.yaml executing 态承载） | △ scheduler.ts FROZEN 语义 | △ models.py TASK_EXECUTING | ✓ standalone_018 execution_feedback | ✓ SchedulingExecution/ExecutionUpdate | — | **✗ 单侧缺失**（无契约 schema） |
| 17 | Outcome | ✓ outcome-annotation.schema.json | ✓ outcome-annotation.ts | ✓ outcome_annotation.py | ✓ standalone_047 | ✗ 无 OutcomeAnnotation schema | — | **△ 漂移**（OpenAPI 单侧缺失） |
| 18 | Agent | ✓ agent-manifest.schema.json（15 角色 + L1-L4 + 命令注册表） | ✓ agent-manifest.ts | ✓ agent.py | ✓ standalone_037（status/risk/level CHECK，L4 排除） | △ AgentManifestInput/View：riskLevel 无枚举（15375） | — | **✓ 一致**（OpenAPI 枚举松，记轻微） |
| 19 | Learning | ✓ learning-evaluation/proposal/outcome 3 schema | ✓ 3 文件 | ✓ 3 文件 | ✓ standalone_041/045/047 | ✓ LearningEvaluation/LearningProposal（12551 proposal status 5 值枚举硬对齐✓） | — | **✓ 一致**（残留 R2-SHR-003 NaN） |
| 20 | Simulation | ✓ simulation-run.schema.json（kind/status 4+4） | ✓ simulation-run.ts | ✓ simulation_run.py（评估器跨语言仲裁绿） | ✓ standalone_044 | ✓ SimulationRun | — | **✓ 一致**（残留 R2-SHR-003 NaN） |
| 21 | Exoskeleton（ExoSession/ExoConfig） | ✓ exo 2 schema（3 kind/8 mode/状态按 kind） | ✓ exo-session.ts / exo-config.ts | ✓ exo_session.py / exo_config.py | ✓ standalone_046/051（kind/status-by-kind/device: 前缀 CHECK 齐） | ✓ /api/exo/configs|sessions（9780/9935，kind 枚举对齐；但 request/response 为内联 schema） | — | **✓ 一致**（OpenAPI 内联定义，见 §5-6） |
| 22 | Maintenance | ✓ maintenance.schema.json（6 type + 5 lifecycle） | ✓ maintenance.ts | ✓ maintenance.py | ✓ standalone_034（CHECK=注册表逐值一致） | ✓ MaintenanceCondition 枚举硬对齐（11715/11748） | — | **✓ 一致（全链样板）** |
| 23 | Quality | ✓ quality.schema.json（5 type + 4 lifecycle + 4 disposition） | ✓ quality.ts | ✓ quality.py | ✓ standalone_034（disposition_required CHECK） | ✓ QualityFinding 枚举硬对齐（11804） | — | **✓ 一致（全链样板）** |
| 24 | WorkOrder + AgentTask | ✓ work-order.schema.json + agent-task.schema.json | ✓ workorder.ts + agent-task.ts | ✓ workorder.py + agent_task.py | ✓ standalone_035 + 038（CHECK 齐） | ✓ MesWorkOrder 族；AgentTask ✗ 无独立 schema | — | WorkOrder **✓ 一致**（SH-020 已裁决差异）；AgentTask **△ 漂移**（R2-SHR-004 role 缺省旁路 + OpenAPI 缺 schema） |

---

## 4. 漂移明细（file:line）

### 4.1 本次审计新发现（跨方漂移）

| 编号 | 域 | 位置 | 漂移内容 |
|---|---|---|---|
| CP-001 | Plan | `ewoh-spark-app/shared/scheduler.ts:34-38` vs `contracts/state-machines/plan.yaml:3-10` vs `src/edge_platform/scheduler/models.py:25-31` vs `db/migrations/standalone_048_shadow_plan_isolation.sql:22-25` | **双生命周期并存**：plan.yaml/models.py 为 shadow/simulating/pending_review/approved/dispatched/expired/archived；TS 为 shadow/proposed/confirmed/rejected；DB 048 production 态为 approved/dispatched/executing/completed/confirmed/proposed。三套状态集互不覆盖，Plan 域「计划编排」与「调度确认」两语义未收敛 |
| CP-002 | Event envelope | `openapi/ewoh.yaml:15304-15326` vs `ewoh-spark-app/shared/event-envelope.ts:17-35` | EnvelopeEventDto 13 字段，缺 TS 18 字段中的 `tenantId/factoryId/actor`；`evidence` DTO 为 object、TS 为 array |
| CP-003 | Risk/前端 | `openapi/ewoh.yaml:10635-10637` vs `ewoh-spark-app/shared/api.interface.ts:1067-1069` | TimelineEvent.riskLevel：TS 已按 SH-016 封闭为 4 值（含 critical），OpenAPI 仍为 `type: string, nullable` 无枚举——SH-016 只修了 TS 半边 |
| CP-004 | Risk/OpenAPI 泛化 | `openapi/ewoh.yaml:11716-11718, 11805-11807, 15375` | maintenance/quality/agent 的 severity、AgentManifestView.riskLevel 均为 description-only 字符串，canonical ladder（critical/high/medium/low）未硬化为 enum |
| CP-005 | Decision | `openapi/ewoh.yaml`（全局无 `DecisionRecord` schema；仅 6010 行 decisions 聚合路由描述） vs `contracts/decision/decision.schema.json` | OpenAPI 缺 DecisionRecord 独立组件；decision_records_json（DB 050/052/053/054）的 API 投影未契约化 |
| CP-006 | Outcome | `openapi/ewoh.yaml`（无 `OutcomeAnnotation` schema） vs `contracts/learning/outcome-annotation.schema.json` | OpenAPI 单侧缺失 |
| CP-007 | AgentTask/OpenAPI | `openapi/ewoh.yaml`（无 `AgentTask` schema） vs `contracts/agent_task/agent-task.schema.json` | OpenAPI 单侧缺失（agent 命令执行 API 有，task 工件无） |
| CP-008 | Resource（Python 内部双定义） | `src/edge_platform/scheduler/models.py:117-135`（RESOURCE_STATUSES 6 值，无 UNKNOWN） vs `contracts/resource/resource.schema.json`（statusRegistry 7 值含 UNKNOWN） | Python 调度运行时手写副本与契约注册表漂移 1 值；对照 TS `scheduler.ts:11` 已 `import type { ResourceStatus } from './resource'` 收敛（好样板） |
| CP-009 | Plan/OpenAPI | `openapi/ewoh.yaml:14663-14664, 13750` | SchedulePlan/SchedulePlanV2 的 status 均无枚举 |
| CP-010 | Dispatch/OpenAPI | `openapi/ewoh.yaml:14782-14784` | DispatchStatus.status 为 `type: string, nullable` 无枚举 |
| CP-011 | 前端角色注册表 | `ewoh-spark-app/client/src/types/ewoh.ts:9-17`（注释自述与服务端 `server/modules/shared/roles.decorator.ts` 人工对齐） | 两处手写、无生成/门禁锁定（对照：其余前端契约均由 openapi.d.ts 生成） |
| CP-012 | exo API 内联 | `openapi/ewoh.yaml:9790-9824`（/api/exo/configs requestBody 为内联 schema，kind enum 值当前与契约一致） | 枚举值一致但为人工维护的第二份事实源，无 $ref/生成机制 |

### 4.2 继承 findings-shared.jsonl 的 TS↔Python 字段级漂移（未关闭，摘要）

| ID | 域 | 严重度 | 位置 |
|---|---|---|---|
| R2-SHR-001 | Reasoning（Decision 载荷） | **High** | `ewoh-spark-app/shared/reasoning-trace.ts:221` vs `src/edge_platform/contracts/reasoning_trace.py:29-36,177`（TS conclusionId 未清洗 traceId，引擎自产自拒） |
| R2-SHR-002 | Envelope | Medium | `src/edge_platform/contracts/envelope.py:59-60` vs `ewoh-spark-app/shared/event-envelope.ts:59-60`（Python 未锁 `const '1.0.0'`；SH-003 残留半） |
| R2-SHR-003 | Decision/ExoConfig/Learning/Simulation | Medium | `decision.py:98-99`、`exo_config.py:99-100`、`learning_evaluation.py:70-73`、`simulation_run.py:154-269`（Python 不检 isfinite，NaN 双端判定相反） |
| R2-SHR-004 | AgentTask | Medium | `agent-task.ts:105-109` / `agent_task.py:106-113` / `contracts/state-machines/agent-task.yaml:11-17`（role 缺省不 fail-closed） |
| R2-SHR-005~010 | World/Identity/Capability/Decision/Knowledge | Low | bool 放行、空串/空白串、null 语义等 6 处细节漂移（详见 findings-shared.jsonl） |
| R2-SHR-011 | Reasoning | Low（双侧共同缺陷） | conclusionId 不含 subjectId，多主体碰撞（TS+Python 同步修） |

---

## 5. 重复手写语义清单与收敛建议（10 项）

| # | 重复语义 | 现存独立定义位点 | 收敛建议 |
|---|---|---|---|
| 1 | **severity/risk ladder（critical/high/medium/low）** | ① risk.schema.json severityLadder（权威）② risk.ts/risk.py（门禁锁定✓）③ DB CHECK 手写 3 份：standalone_034（mc:47/qf:91）、standalone_035（wo:51）④ OpenAPI description 4 处（11718/11807 等）⑤ api.interface.ts:1069 手写 4 值 ⑥ decision 域已示范收敛（decision.ts import risk，audit 2006-2018 行强制 SINGLE_SOURCE✓） | DB CHECK 由 `scripts/generate-ddl-package.js` 从 schema 注册表生成；OpenAPI enum 由 gen-openapi 注入；api.interface.ts 改 import `RISK_SEVERITY_LADDER`（复制 decision.ts 模式） |
| 2 | **Plan 状态机** | ① plan.yaml（权威）② models.py:25-37 PLAN_* 手写 ③ scheduler.ts:34 SchedulePlanStatus 手写（值不同）④ standalone_048 CHECK 手写 ⑤ OpenAPI 无枚举 | 先裁决双生命周期（编排态 vs 调度确认态）归属：要么 plan.yaml 扩为分层状态机，要么拆两个契约；随后 TS 增 loader/生成、DB CHECK 与 OpenAPI enum 生成 |
| 3 | **Resource 状态枚举** | ① resource.schema.json（7 值权威）② resource.py/resource.ts（锁定✓）③ scheduler/models.py:117-135 手写 6 值（**漂移 1 值**）④ scheduler.ts 已 import 收敛✓ | models.py 改 `from edge_platform.contracts.resource import STATUSES`（对齐 TS 模式）；补一条门禁断言防再发 |
| 4 | **Task 状态机转移表** | ① task.yaml（权威）② models.py:62-110 TASK_* 手写（tests 锁定）③ TS 无实现 | TS 侧生成 task-state-machine.ts（复制 alert-state-machine + audit alert_state_machine_ts_vs_yaml 的 yaml↔TS 锁定模式） |
| 5 | **maintenance/quality/workorder/exo 枚举的 OpenAPI 内联副本** | ewoh.yaml 11715/11748/11804/9790+ 等内联 enum（当前值一致，人工维护） | gen-openapi 时从 contracts/*.schema.json 注册表注入 enum + 新增 audit-openapi-enums.js 门禁（当前仅路由零漂移被审计，枚举没有） |
| 6 | **exo configs/sessions API 内联 schema** | ewoh.yaml 9790-9935（requestBody/response 内联，未组件化） | 组件化为 ExoConfigRecord/ExoSessionRecord 并 $ref；或由契约 schema 生成 |
| 7 | **信封字段清单** | ① envelope.schema.json requiredFields const ② event-envelope.ts ③ envelope.py（三方绿✓）④ EnvelopeEventDto 内联 13 字段（**漂移**）⑤ DB 036 列 | EnvelopeEventDto 组件化并按 schema 字段清单生成/门禁对齐（补 tenantId/factoryId/actor，裁决 evidence 类型） |
| 8 | **agent 角色注册表** | ① agent-manifest.schema agentRoleRegistry ② agent-task schema（audit 强制同源✓）③ state-machines/agent-task.yaml role 字段 ④ alert.yaml/TS alert-state-machine.ts（audit 锁定✓） | 已基本收敛；剩余 yaml role 枚举可由 agentRoleRegistry 生成校验 |
| 9 | **前端角色注册表** | ① client/src/types/ewoh.ts:9-17 ② server/modules/shared/roles.decorator.ts（注释自述人工对齐） | 加一条 jest 门禁双向比对两表（零成本锁死） |
| 10 | **schema-manifest 计数/清单** | schema-manifest.yaml 手写 74 表 + notes 历史计数（2026-08-17 已整改单段口径） | `coreManagedTableCountFromManifest` 已从 manifest 派生✓；建议再补「migrations 目录 ↔ manifest 条目」双向对账门禁 |

---

## 6. 最严重漂移 Top 3（跨方排序）

1. **Plan 域双生命周期并存（CP-001）**——plan.yaml 7 态 / TS 4 态 / DB production 6 态三套状态集互不覆盖，同一「计划」在编排侧与调度侧语义分叉且无任何门禁覆盖交叉一致性；Reservation/Dispatch/Execution（#14-16）的契约缺位放大了该风险。
2. **TS reasoning conclusionId 未清洗（R2-SHR-001，High）**——云侧推理引擎对脏 traceId 自产自拒、与 Python 产出不可对账；这是当前唯一 High 级未关闭项。
3. **OpenAPI 系统性未硬化（CP-003/004/005/006/007/009/010）**——TimelineEvent.riskLevel 无枚举（SH-016 只修 TS 半边）、DecisionRecord/OutcomeAnnotation/AgentTask schema 缺失、severity/riskLevel/status 普遍 description-only；OpenAPI 作为前端生成源（openapi.d.ts 19388 行），其松弛直接传导为前端类型松弛。

---

## 7. 门禁运行记录（2026-08-17 实跑）

```
node scripts/audit-domain-contracts.js   → 581/581 passed, DOMAIN CONTRACT AUDIT PASS
node scripts/audit-identity-contracts.js → 22/22 passed, IDENTITY CONTRACT AUDIT PASS
node scripts/audit-event-envelope.js     → 24/24 passed, EVENT ENVELOPE AUDIT PASS
node scripts/audit-event-catalog.js      → 65 messages | 65 channels（PASS）
make contract-golden                     → 329 passed in 2.17s
make contract-state-machine（补跑）      → 5 passed in 0.25s
```

无 ENVIRONMENT_BLOCKED 项。

---

## 8. 统计口径（供上级汇总）

- 核对域数：**24**（23 个指定域 + AgentTask 单列）
- ✓ 一致：**12**（Identity、Entity、Event catalog、World、Resource、Location、Agent、Learning、Simulation、Exoskeleton、Maintenance、Quality、WorkOrder 中前 12 项按主判定；WorkOrder 亦一致，AgentTask 计漂移）
- △ 漂移：**7**（Observation/Event envelope、Risk、Task、Plan、Decision、Outcome、AgentTask）
- ✗ 单侧缺失：**5**（Capability、Approval-TS、Reservation、Dispatch、Execution）
- 最严重漂移 Top3：Plan 双生命周期、R2-SHR-001 conclusionId（High）、OpenAPI 系统性未硬化
- 重复语义收敛建议：**10 项**（§5）
