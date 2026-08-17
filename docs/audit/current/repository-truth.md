# Repository Truth — EWOH 仓库运行时真相全图

审计日期：2026-08-17。方法：只读代码取证（不信 README/文档声明，文档只作对照）。所有结论附 file:line 或目录清单证据。
版本基线：`version.json` = 0.6.0-rc4；`ewoh-spark-app/package.json:3` = 0.6.0-rc4；helm `appVersion: "0.6.0-rc4"`。

---

## 1. Directory Map（一级/二级目录职责）

| 目录 | 职责 | 证据 |
|---|---|---|
| `src/edge_platform/` | Python 边缘平台（纯标准库 HTTP）：24 个子包 —— aas/audit/auth/backup/connectors/contracts/edge/inference/policy/rbac/routes/runtime/scenario/scheduler(+cpsat)/scripts/spatial/static/tests/twin/perception/world_model/monitoring/migrations/governance/assistant/collection | `src/edge_platform/*/__init__.py`（24 项 Glob） |
| `ewoh-spark-app/` | 云端全栈单体仓：`server/`(NestJS) + `client/`(React SPA) + `shared/`(跨端契约 TS) + `test/`(unit/e2e/browser/contract) + `scripts/` + `tools` 引用 | `ewoh-spark-app/package.json` |
| `ewoh-feishu-app/` | 飞书侧车（Express + better-sqlite3）：卡片/多维表格同步/轮询，独立 demo 栈 | `ewoh-feishu-app/package.json:2-12`；`ewoh-feishu-app/server/index.js:1-22` |
| `contracts/` | 跨运行时 canonical 契约（37 子目录：agent/agent_task/artifact-schemas/capability/catalog/decision/entity/events/exo/factory/identity/intelligence/knowledge/learning/location/maintenance/mapping/observability/policy/quality/reasoning/reliability/repository-facts/resource/risk/simulation/state-machines/work/workflow/workorder/world） | `contracts/` 目录清单 |
| `db/` | `contracts/schema-manifest.yaml` + `migrations/`（2 核心 + 58 standalone 迁移对）+ `runner/run_migrations.js` + `seed/` + `verify/` | `db/migrations/` 清单；`db/contracts/schema-manifest.yaml:1-45` |
| `openapi/` | `ewoh.yaml`（规范源）+ `route-manifest.json`（生成物）+ `work-orchestration.yaml` | `openapi/route-manifest.json:1-3` |
| `deploy/` | 边缘遗留 compose（DEPRECATED）+ `cloud/`（Dockerfile.api/cpsat/migrate、docker-compose.cpsat.yml、helm/ewoh、k8s/ 9 清单） | `deploy/docker-compose.yml:1-20`；`deploy/cloud/` 清单 |
| `scripts/` | 78 个可执行：truth-gate 族、audit-* 静态门禁、TCK（connector/aas/rego/scenario/deployment）、发布与运维脚本 | `scripts/` 目录清单 |
| `tools/` | work-orchestration 域 Node 服务：factory-replication/gate-engine/git-sync/handoff-service/resource-registry/semantic-rules/work-console/work-indexer + `run_demo.py` | `tools/` 目录清单 |
| `tests/` | Python 仓库级契约测试（35 文件，跨运行时 parity） | `tests/test_*.py` Glob |
| `ui/command_map/` | 静态演示前端（连边缘 8765，非 React 主前端） | `ui/command_map/assets/app.js:271-293`（arch-world §C 引证） |
| `release/` | rc1–rc4 四个冻结发布包 + SBOM | `release/ewoh-0.6.0-rc{1..4}/` |
| `delivery/` | V0.6 交付基线（PDF/规范/缺陷清单/06_Demo_Prototype/server.py）——历史交付物 | `delivery/00_交付总览/README.md` |
| `docs/`, `.github/`, `.codex/`, `catalog/`, `security/` | 文档 / CI / agent 工件 / 工厂选址目录 / 安全基线 | 目录清单 |

---

## 2. Runtime Entry Map（全部进程入口）

| # | 入口 | 启动方式 | 证据 |
|---|---|---|---|
| 1 | **Python 边缘平台** `src/edge_platform/run.py` → `server.build_server()` | `make run` = `PYTHONPATH=src python -m edge_platform.run`（默认 :8765；development 模式真实组件优先） | `Makefile:13-14`；`src/edge_platform/run.py:165-372`；`src/edge_platform/server.py:1-37` |
| 2 | 根级零配置入口 `run.py`（包一层 sys.path） | `python run.py [--host --port --stub]` | `run.py:1-20` |
| 3 | **NestJS 主入口** `ewoh-spark-app/server/main.ts` | `npm run start:standalone` = `node dist/server/main.js`（EWOH_DEPLOY_TARGET=standalone）；legacy 装配需显式 `EWOH_LEGACY_ENABLED=1`，默认抛错拒绝 | `ewoh-spark-app/server/main.ts:39-60`；`package.json:25-26` |
| 4 | **standalone 装配** `server/standalone-main.ts`（bootstrapStandalone，CSP/信任代理/CORS fail-closed） | 由 main.ts 按 deploy target 分派；`standalone-app.module.ts` | `server/main.ts:9,56-60`；`server/standalone-main.ts:8-46` |
| 5 | **飞书侧车** `ewoh-feishu-app/server/index.js`（Express，静态托管 + /api + webhook 卡片 + 30s 全量同步 + 60s 事件轮询） | `npm run dev` / `npm start` = `node server/index.js` | `ewoh-feishu-app/server/index.js:24-80`；`package.json:6-8` |
| 6 | **CP-SAT worker** `src/edge_platform/scheduler/cpsat/worker.py`（:8000，ortools 未装则 UNAVAILABLE） | `python -m edge_platform.scheduler.cpsat.worker --host 0.0.0.0 --port 8000`（Dockerfile.cpsat CMD） | `deploy/cloud/Dockerfile.cpsat:22`；`feature-status.yaml:84-96` |
| 7 | 演示入口 `tools/run_demo.py`（stub 平台 + 打开指挥地图） | `make demo` = `python tools/run_demo.py --port 8765` | `Makefile:19-20` |
| 8 | 迁移执行器 `db/runner/run_migrations.js` | 由 standalone 部署/CI 调用（migration-job.yaml） | `db/runner/run_migrations.js`；`deploy/cloud/k8s/migration-job.yaml` |
| 9 | scripts 可执行入口（78 个）：`connector-tck.py`、`aas-tck.py`、`rego-tck.py`、`cross-tenant-tck.sh`、`scenario-tck.js`、`deployment-tck.js`、truth-*（6 个）、audit-*（22 个）、verify-*（14 个）、soak/release/pilot 脚本 | `make connector-tck / aas-tck / rego-tck / cross-tenant-tck / pilot-readiness / truth-check` 等 | `Makefile:76-107`；`scripts/` 清单 |
| 10 | tools 域服务入口：`tools/{gate-engine,semantic-rules,work-console,work-indexer,handoff-service,git-sync,resource-registry,factory-replication}/index.js` | 由 server work-orchestration 模块/测试调用 | `tools/` 清单；F61-02 六域表（schema-manifest notes:18） |
| 11 | 冻结发布包入口 `release/ewoh-0.6.0-rc{1..4}/run.py` + 各含 Makefile | 历史版本归档运行 | `release/` 清单 |
| 12 | 交付 demo 原型 `delivery/06_Demo_Prototype/server.py` | 历史交付演示 | `delivery/06_Demo_Prototype/` |

Makefile 主要 target 实际命令：`run/run-stub/demo/test/test-contract/contract-*/scheduler-golden/production-smoke/connector-tck/aas-tck/rego-tck/cross-tenant-tck/pilot-readiness/lint/security/truth-check/format/clean`（`Makefile:13-116`）。

---

## 3. Dependency Map（四大运行时依赖关系）

```
React client (ewoh-spark-app/client)
  │ HTTP/SSE /api/*（client/src/api/*.ts 26 个 API 模块）
  ▼
NestJS server (ewoh-spark-app/server, standalone 装配)
  ├─ PostgreSQL（drizzle-orm/postgres-js；server/database/standalone.provider.ts、schema.ts）
  ├─ Redis（ioredis，限流降级；test/unit/shared/rate-limit-redis-fallback.spec.ts）
  ├─ S3（@aws-sdk/client-s3；modules/files/storage/s3-storage.driver.ts）
  ├─ Ark AI（modules/ai/ark.service.ts，ai/gamification 大脑建议）
  ├─ CP-SAT worker（可选 HTTP :8000 /api/scheduler/v2/solve；缺失回退 heuristic）
  └─ tools/* 域服务（F61-02 六域表：handoffs/git_sync_state/evidence/factory_replication/idempotency/resource_locks）

Python 边缘 (src/edge_platform, :8765)
  ├─ 采集：Modbus/OPC-UA 适配器（connectors/、edge/adapter_factory.py，EWOH_ADAPTERS 配置驱动）
  ├─→ 云端：EventUplink → POST {EWOH_EVENT_UPLINK_URL}/api/ingest/events（信封批量+断点续传）
  │       MetricsUplink → POST /api/observability/edge-metrics（周期快照）
  │       遥测帧 edge_to_spark.py → /api/ingest/exoskeleton
  │       （src/edge_platform/run.py:294-332；edge/bridge/event_uplink.py、metrics_uplink.py）
  └─ 调度 ownership：connected production 下 Edge 只 advisory（readonly 仓储），正式调度写权限唯一归 NestJS 控制面（run.py:50-96, 236-259；P0-SCHED-OWNERSHIP）

静态 ui/command_map ──HTTP──▶ 边缘 :8765 /api/resources/state（非云端）
ewoh-feishu-app：独立 SQLite demo 栈 + lark-cli ↔ 飞书多维表格/消息卡片（30s 全量同步 + 60s 状态轮询），不属世界主链（index.js:27-66；arch-world §C）
```

关键裁决：生产模式下边缘禁止写调度（`EWOH_EDGE_SCHEDULING_WRITE=1` + production → 启动即抛 `SchedulingWriteProhibitedError`，run.py:65-75）。

---

## 4. Domain Map（server/modules 全部 53 模块分组）

按主要职责归类（模块名 = `ewoh-spark-app/server/modules/<name>`，全部含 `*.module.ts`，Glob 取证）：

| 域 | 模块 |
|---|---|
| **World（世界状态/空间）** | world、world-cursor、spatial、timeline、view |
| **Decision（决策/审批/策略）** | approval、policy、workflow、reasoning、tracing、audit |
| **Scheduling（调度）** | scheduler（含 prediction/ 子域）、task、resource、oee |
| **Execution（执行/MES）** | workorder、control、mes、erp、operations、alert、maintenance、quality |
| **Intelligence（智能推理）** | ai、inference、model、rule-engine、simulation、knowledge |
| **Agent（多智能体）** | agent |
| **Learning（学习回路）** | learning |
| **Integration-Edge（边缘/设备接入）** | ingest、aas、exo、files、notification |
| **平台/横切（其他）** | auth、identity、organization、mobile、dashboard、parameters、system、health、shared、metrics、observability、reliability、events（event-catalog）、scale、onboarding、simulator、gamification、work-orchestration |

（53 模块 = 上表并集；分类按主职责，个别模块跨域，如 operations 兼 Decision/Execution。）

---

## 5. Database Map（受管表，db/contracts/schema-manifest.yaml）

**口径**（manifest:43 统一段）：`managed_tables` **74 项 = 68 张核心受管表 + 6 张 F61-02 域表**；`physical_create_count=77`；另 `additional_hardened_existing_tables` 26 条（硬化在位/映射既有/登记性）。

按域分组（managed_tables，括号=表数）：
- Device(5)：device、device_capability、device_person_binding→ewoh_device_binding(mapped)、environment、telemetry
- Workstation(5)：workstation、workstation_device/person/relation/skill
- Schedule(6)：schedule_plan/assignment/task/task_step、scheduler_config、schedule_audit
- System(5)：audit_log、system_config、notification、knowledge_base、knowledge_entry
- Event(5)：event、event_chain、event_rule、event_action、event_subscription
- Spatial(4)：spatial_entity、spatial_relation、topology
- World(3)：world_state、world_snapshot、world_delta_log
- Control(3)：control_command/request/result
- Scale(3)：asset_package、factory_profile、factory_template
- Model(3)：model_asset、model_binding、model_registry
- Task(3)：task_template、task_step、task_skill_req
- Organization(4)：role、skill、person_role、person_skill
- Domain(6)：resource_locks、handoffs、git_sync_state、evidence_metadata、factory_replication_sessions、idempotency_keys
- MultiAgent(2)：agent_manifest、agent_task；Agent(1)：agent_approval
- Intelligence(1)：inference_result；Learning(3)：learning_evaluation、learning_proposal、outcome_annotation
- Observability(1)：trace_span；Reliability(1)：dead_letter；Simulation(1)：simulation_run
- Exoskeleton(2)：exo_session、exo_config；Identity(1)：identity_mapping
- Maintenance(2)：maintenance_condition、work_order；Quality(1)：quality_finding
- EventBackbone(1)：ingest_event_dedup；Resource(2)：resource_binding、resource_preorder

**RLS 状态**：除 GLOBAL_SHARED 豁免外，TENANT_SCOPED 表逐表配 `*_org_isolation` RLS 策略（standalone_025/028/032/034-049/051/056/057 系列；manifest notes:19-44）。`ewoh_knowledge_entry` 为 knowledge_entry_service_all 五层 scope 硬化（manifest:144-147）。

**GLOBAL_SHARED 豁免（RLS 关闭/org_id 仅血缘）6 张**：
- `ewoh_trace_span`（managed_tables:530-536，trace_span_org_or_global 策略）
- `ewoh_world_state_snapshot`（ADR-004，manifest:707-714）
- `ewoh_assignment_event`（DERIVED_TENANT_OWNERSHIP，standalone_028 派生触发器，manifest:750-758）
- `ewoh_outbox`（全局 sequence，manifest:759-766）
- `prediction_shadow_observation`（standalone_029，manifest:786-794）
- `ewoh_snapshot_version_counter`（standalone_031，manifest:795-803）

additional 段 26 条含：ewoh_organization / ewoh_person→ewoh_personnel / ewoh_ai_suggestion / ewoh_device_config / ewoh_production_task（mapped-existing）+ Scheduling V2 家族 11 表 + 登记性 4 表（saved_views、workbench_export_tasks、prediction_shadow_observation、ewoh_snapshot_version_counter）。

---

## 6. API Map（openapi/route-manifest.json）

- **controllerKeys = 398 条路由**（specKeys 398 / controllerOperations 398 / documentedControllerOperations 398 / undocumented 0 / unimplemented 0；specOperations=590）。
- 按模块分布（TOP，脚本统计 `/api/<seg>` 前缀）：scheduler 56、scale 39、operations 27、work 25、mes 20、dashboard 14、agents 13、learning 13、ai 9、exo 9、observability 8、parameters 8、ingest 8、files 7、gamification 7、oee 7、system 7、world 7、approvals 6、erp 6、mobile 6、personnel 6，其余 ≤5（control/knowledge/workflows 5；aas/auth/models/organization/reliability/resource/spatial/tasks 4；alerts/devices/identity/inference/maintenance/notifications/quality/simulation/simulator/workorders 3；events/policies/reasoning 2；audit/me/timeline/root 1）。
- 零漂移门禁：`npm run gen:openapi:check`（package.json:17-18）+ `scripts/audit-openapi-routes.js --strict`（standalone.yml:76-77）。

---

## 7. Event Map（contracts/events/event-catalog.yaml）

- **canonical 事件类型 65 个**（`x-event-types` 列表，:12-77）。注意：`simulation.service.ts:35` 注释仍写"59 类"，与目录 65 存在注释漂移。
- 信封：CloudEvents 1.0 + ADR-009 envelope（`contracts/events/envelope.schema.json`；TS `shared/event-envelope.ts`；Py `src/edge_platform/contracts/envelope.py`）。
- 主要生产位：
  - 云端域服务逐事件落库：workorder/maintenance/quality/identity/learning/inference/knowledge/dead-letter/simulation 等（如 `identity.service.ts:265` EntityIdentityMapped；`workorder.service.ts:44`）
  - 模拟器：`simulator.service.ts`（写 ewoh_event/event_chain + telemetry + world_state，source_type='simulated'）
  - 调度域：outbox 全局 sequence（ewoh_outbox + assignment_event，ADR-004）
  - 边缘：EventUplink 批量上行 EntityDeclared/EntityStateObserved 等（run.py:294-309；edge/bridge/event_uplink.py）
- 主要消费位：`modules/ingest`（/api/ingest/events，去重台账 ewoh_ingest_event_dedup）、`modules/events/event-catalog.service.ts:29-34`（运行时加载 catalog）、rule-engine（event-envelope.spec.ts）、SSE scheduler-stream。

---

## 8. Contract Map（三方实现对照）

`contracts/<dir> ↔ ewoh-spark-app/shared/*.ts ↔ src/edge_platform/contracts/*.py`（27 个 Python 契约文件、30 个 TS 契约文件，Glob 取证）：

| contracts/ | shared/*.ts | edge_platform/contracts/*.py |
|---|---|---|
| identity | identity.ts | identity.py |
| risk | risk.ts | risk.py |
| quality | quality.ts | quality.py |
| world | world-contract.ts | world.py |
| agent | agent-manifest.ts | agent.py |
| agent_task | agent-task.ts | agent_task.py |
| capability | capability.ts | capability.py |
| reliability(dead letter) | dead-letter.ts | dead_letter.py |
| decision | decision.ts | decision.py |
| entity | entity-model.ts | entity_model.py |
| events/envelope | event-envelope.ts | envelope.py |
| events/catalog | event-catalog.ts | event_catalog.py |
| exo | exo-config.ts / exo-session.ts | exo_config.py / exo_session.py |
| intelligence | inference-result.ts | inference_result.py |
| knowledge | knowledge-entry.ts | knowledge.py |
| learning | learning-evaluation.ts / learning-proposal.ts / outcome-annotation.ts | learning_evaluation.py / learning_proposal.py / outcome_annotation.py |
| location | location.ts | location.py |
| maintenance | maintenance.ts | maintenance.py |
| observability | metrics-registry.ts | metrics_registry.py |
| reasoning | reasoning-result.ts / reasoning-trace.ts | reasoning_result.py / reasoning_trace.py |
| resource | resource.ts | resource.py |
| simulation | simulation-run.ts | simulation_run.py |
| workorder | workorder.ts | workorder.py |
| scheduler（TS 侧） | scheduler.ts | （Py 侧在 scheduler/cpsat/contract.py + scheduler/models.py） |
| state-machines/alert | alert-state-machine.ts | state_machine_loader.py（加载 yaml） |

仅单/双侧存在的契约：mapping、policy（policy-schema.json + deploy-gate.rego）、factory（golden-factory.yaml）、work（work-graph.schema.json + artifact-paths.json）、artifact-schemas、catalog、repository-facts（无 Python 对应）；TS 侧另有 api.interface.ts/index.ts 总伞。
Parity 门禁：`make contract-domain`（audit-domain-contracts.js + pytest tests/test_domain_contracts.py，Makefile:35-38）、`tests/test_ts_python_contract_parity.py`（Makefile:65-66）、`make contract-identity`（ADR-006）、`make contract-envelope`（ADR-009）。

---

## 9. Deployment Map（deploy/）

| 构件 | 内容 | 状态 |
|---|---|---|
| `deploy/docker-compose.yml` | 边缘试点编排：nginx 网关 + ewoh-api(0.6.0-rc4) + adapter/inference **sleep 占位** + postgres16 + redis7 + busybox 日志 | **DEPRECATED**（文件头 :1-19 显式声明：根级 Dockerfile 从未落地，占位服务无真实入口） |
| `deploy/cloud/Dockerfile.api` | 多阶段：node:22-alpine 构建 standalone（复制 contracts/catalog/tools/.codex artifacts）→ 运行 `node dist/server/main.js`（EWOH_DEPLOY_TARGET=standalone, USER node, :3000） | 生产镜像（runtime-gates.yml 真实构建门禁） |
| `deploy/cloud/Dockerfile.cpsat` | python:3.12-slim + ortools==9.11.4210（失败则 UNAVAILABLE 模式），`python -m edge_platform.scheduler.cpsat.worker :8000` | 可选求解 worker（OPTIONAL/EXPERIMENTAL） |
| `deploy/cloud/Dockerfile.migrate` | 迁移 Job 镜像（db/runner/run_migrations.js） | 生产迁移链 |
| `deploy/cloud/docker-compose.cpsat.yml` | 单独拉起 cpsat worker（healthcheck /health/live） | 可选 |
| `deploy/cloud/helm/ewoh/` | Chart ewoh-0.1.0 / appVersion 0.6.0-rc4；ghcr.io/example/ewoh，3 副本，HPA 3-12，ingress+tls，pdb minAvailable=2，resources 500m-2cpu/512Mi-2Gi | 生产 Helm（verify-helm-chart.js + kind 真实安装门禁） |
| `deploy/cloud/k8s/` | namespace/api-deployment/api-service/configmap/hpa/ingress/migration-job/pdb/secret.example 9 清单 | 声明式参考 |
| `release/ewoh-0.6.0-rc{1..4}/` | 打包发布源码 tarball（package.yml tag 触发）+ SBOM（cyclonedx） | Frozen 归档 |

---

## 10. Test Map（五大测试体系 + feishu）

| 体系 | 数量（文件） | 入口命令 | 证据 |
|---|---|---|---|
| pytest/unittest 边缘单测 | 57 | `make test` = `python -m unittest discover -s src/edge_platform/tests` | Makefile:22-23 |
| pytest 仓库契约测试 | 35（34 + edge/1） | `make test-contract` = `pytest tests/ -q` | Makefile:25-26 |
| jest server（含 shared/test） | 271 spec 文件（server 134 + shared 24 + test/unit 106 + test/contract 6 + helpers 1） | `cd ewoh-spark-app && npm test` | package.json:27,270-299 |
| jest client | 126 spec 文件 | `npm run test:client`（jest.config.cjs，--runInBand） | package.json:28 |
| jest e2e（真实 PG） | 8 spec | `npm run test:e2e` | package.json:34；test/e2e/jest.config.js |
| Playwright 浏览器 | 4 spec（a11y/lowbandwidth/scheduler-command-map/sw-update；另有 visual config） | `npm run test:browser` / `:browser:visual` | package.json:29-31；test/browser/ |
| feishu sidecar（node --test） | 11 test 文件 | `cd ewoh-feishu-app && npm test` | feishu package.json:9；feishu.yml:34-39 |

专项门禁：`make production-smoke`（P0-EDGE-006 真实装配 no-stub）、`make scheduler-golden`、`make contract-golden`、`make audit-regression-gates`（十条主线，Makefile:50-71）、`make cross-tenant-tck`、`make truth-check`。

---

## 11. CI Map（.github/workflows，7 个）

| workflow | 触发 | 关键 job/steps |
|---|---|---|
| `test.yml` | push + PR | Python 3.11：make test / test-contract / contract-state-machine / production-smoke；P0-EDGE-002 production 冒烟（run.py :8876 校验 rule_version=risk-rule-v0.2，:47-62）；edge 断连/乱序/重放门禁；ruff；Node24：npm ci/audit/license/SBOM |
| `standalone.yml` | push + PR | postgres:17 service；type:check、lint、jest --runInBand、OpenAPI route audit --strict、契约漂移门禁、Scheduler 多租户 E2E（verify-scheduler-multitenant.mjs） |
| `runtime-gates.yml` | push + PR | 真实 PG：生产迁移门禁 / RC 升级门禁 / 备份恢复门禁；Helm 静态审计；容器镜像门禁（真实构建+SBOM+Trivy）；helm-kind-gate（kind 集群 install→迁移→探活→回滚→canary）；soak-load-gate（2000 请求/25 并发 + 500 调度事件风暴）（:1-19 注释） |
| `security.yml` | push + PR | bandit 1.8.6 JSON 报告 + HIGH 门禁（bandit-gate.py + suppressions）；gitleaks 固定版本；npm audit；Trivy |
| `perf.yml` | push + PR | workbench-perf-gate：真实 PG 种子 + 基准 + 硬预算门禁（N+1/全表扫/org 隔离守卫，:1-7） |
| `feishu.yml` | push + PR | ewoh-feishu-app node --test + JUnit artifact |
| `package.yml` | tag v* | Python 源码 tarball 打包上传（纯标准库，无 wheel） |

---

## 12. 构件状态标注

判定依据：代码活跃度 / 生产路径引用 / 注释声明（feature-status.yaml 为单一事实源）/ 测试覆盖。全局事实：`feature-status.yaml:21-22` —— **无任何功能生产启用（productionEnabled 全 false）**。

| 构件 | 状态 | 依据 |
|---|---|---|
| NestJS server（standalone 装配）+ 53 模块 | **Development（代码就绪、生产门控）** | feature-status.yaml 全量 productionEnabled=false；standalone 装配为默认（main.ts:41-54） |
| heuristic solver（canonical） | **Development（生产指定回退路径）** | feature-status.yaml:42-55 |
| MILP solver（HiGHS WASM） | **Development（策略显式选择）** | feature-status.yaml:57-70 |
| CP-SAT | **Prototype/EXPERIMENTAL（未部署 OR-Tools，默认 OFF）** | feature-status.yaml:72-97 |
| predictionShadow | **Prototype（内存态 advisory，仅观测）** | feature-status.yaml:99-113 |
| React client / CommandMap / DecisionCockpit | **Development** | feature-status.yaml:134-164 |
| Python edge_server | **Development（CI 生产模式真实启动验证 runtimeVerified=true）** | feature-status.yaml:166-180 |
| **simulator（server/modules/simulator）** | **Simulation（演示数据引擎）**——活代码：写生产表 ewoh_world_state/spatial_entity/telemetry/event，但全部 source_type='simulated' 标记；OnModuleInit 起 tick 循环 | simulator.service.ts:1-25（arch-world A1/A2 写入者 :519-553）；3 条路由 + spec |
| **simulation（server/modules/simulation）** | **Development（契约 fail-closed，只写 ewoh_simulation_run，绝不写生产世界表）** | simulation.service.ts:26-38；feature-status 未单列但 ADR-025/standalone_044 |
| **scenario（src/edge_platform/scenario）** | **Prototype/未接线**——包内 simulator.py/comparison.py/metrics.py 仅被自身测试 import；运行时 `/api/scenario/evaluate` 实际由 `services.evaluate_scenario` 实现，不走该包 | Grep `edge_platform.scenario` 仅命中 tests/test_scenario.py:21；routes/inference.py:192-193,248；services.py:596-607 |
| **twin（src/edge_platform/twin）** | **Prototype/契约件**——仅 package.py + manifests，唯一调用方为 tests/test_twin_package.py；云侧无 twin 模块（数字孪生走 server/modules/simulation） | Grep 仅 twin/__init__.py:3 + tests/test_twin_package.py:12 |
| **aas（双侧）** | 云侧 **Development**（4 路由 + client api/aas.ts + spec）；边缘 Python codec **Contract/TCK 构件**（仅 tests/test_aas_codec.py + scripts/aas-tck.py 引用，无运行时路由） | route-manifest（aas 4）；Grep aas 引用；Makefile:79-80 |
| **assistant / local_llm（src/edge_platform/assistant）** | **Development（边缘本地白名单助手）**——经 /api/query、/api/vision/understand 暴露（rbac query_assistant），health 声明"本地白名单助手，无外部依赖"，非大模型路径 | routes/inference.py:33；routes/health.py:89；rbac/permissions.py:47,258；tests/test_local_llm.py |
| **world-cursor 协议** | **Dead/空转协议面（预留未接线）**——ewoh_world_snapshot/ewoh_world_delta_log 生产零写入者（applyUpsert/applyRemoval 全仓仅测试命中）、前端不消费（client api/world.ts 无此二端点）；NEST-648 注释自称"有意并存"；有权限控制、无数据（最差组合，arch-world 收敛建议 1：接线或显式降级标注） | arch-world.md §二"空转协议面"、§四.1；world-cursor.service.ts:13-23；world-cursor.controller.ts:16-44 |
| **gamification** | **Prototype/演示玩法**——G3.1-G3.7 玩家角色/资源分配/任务编排/takt 仿真/大脑建议，依赖 ArkService 与调度服务，7 条路由 + spec 存在，无生产启用 | gamification.service.ts:36-40；route-manifest（gamification 7） |
| ewoh-feishu-app | **Development（独立 demo 栈，v1.1.0 加固，不属世界主链）** | feature-status.yaml:182-196；arch-world §C |
| deploy/docker-compose.yml（边缘编排） | **Legacy/DEPRECATED** | 文件头 :1-19 |
| release/rc1-rc4、delivery/ | **Frozen（归档）** | 目录性质 |
| ui/command_map | **Development/Demo（连边缘 :8765，与 React client 双轨）** | arch-world §C、§三.4 |
| tools/* 域服务 + F61-02 六域表 | **Development（work-orchestration 支撑，standalone_004 迁移+单测）** | schema-manifest:18；test/unit/work-orchestration/* |
| truth-gate 族 / runtime gates | **Production-track 基建（CI 对真实 PG 验证 runtimeVerified=true）** | feature-status.yaml:198-212 |
| benchmarkScheduler | **Development 工具（docsUpdated=false）** | feature-status.yaml:214-226 |
| stubs.py（edge_platform/stubs.py） | **Simulation-only（--stub 显式，production 禁止静默 stub）** | run.py:36-47；test.yml P0-EDGE-002 |

**Dead/Prototype 清单（汇总）**：world-cursor 协议（空转）、edge scenario 包（未接线）、edge twin 包（契约件）、CP-SAT（实验性未部署）、predictionShadow（advisory）、gamification（演示玩法）、deploy/docker-compose.yml（DEPRECATED）、delivery/06_Demo_Prototype（历史）。

---

## 附：核心数字速查

| 维度 | 数值 |
|---|---|
| 进程入口（现行，非归档） | 8 类（edge run.py×2、NestJS main/standalone、feishu index.js、cpsat worker、run_demo、run_migrations）+ scripts 78 + tools 8 |
| NestJS 模块 | 53（server/modules/*） |
| 受管表 | 74（68 核心 + 6 域表）+ 26 硬化/登记 ≈ 100 追踪；GLOBAL_SHARED 豁免 6 |
| API 路由 | 398（controller 实现且 OpenAPI 全文档化；spec operations 590） |
| 事件类型 | 65（catalog）；注释漂移：simulation.service.ts 写 59 |
| 测试 | 57+35 pytest 文件；271+126+8 jest spec；4 playwright；11 feishu |
| CI workflows | 7 |
| 版本 | 0.6.0-rc4（全仓一致） |
