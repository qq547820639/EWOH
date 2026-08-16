# EWOH Contracts Index（契约索引）

> 维护规范：本目录（docs/contracts/）是契约层的**导航索引**，不是契约本身。
> 契约唯一权威源在根目录 `contracts/`、`openapi/`、`db/migrations/`、`catalog/`、
> `deploy/.env.example`。任何契约改动走契约优先工作流（README §9.1），本索引同步目录。
> 最后更新：2026-08-14。

## 1. 权威源地图

| 契约类别 | 权威源 | 生成/守护 |
|---|---|---|
| 维护/质量域契约 | `contracts/maintenance/`（conditionType 注册表+生命周期+overdue 判定）+ `contracts/quality/`（findingType 注册表+处置生命周期+disposition 必带决策）+ 各域 test-vectors（ADR-010） | `scripts/audit-domain-contracts.js`（两域独立仲裁 + 注册表一致，182/182） |
| 事件信封 | `contracts/events/envelope.schema.json`（16 字段：时间三态+漂移/迟到标记+规范引用+幂等去重键）+ envelope-test-vectors | `scripts/audit-event-envelope.js`（独立仲裁 + eventType 与 event-catalog 交叉校验，挂 make truth-check 与 CI） |
| 世界状态契约 | `contracts/world/world-state.schema.json`（StateRecord 双时态 + 22 类实体注册表 + Snapshot + 模拟隔离/版本单调规则）+ test-vectors | `scripts/audit-domain-contracts.js`（world 域独立仲裁 + 注册表一致） |
| 风险/空间/资源域契约 | `contracts/risk/`、`contracts/location/`、`contracts/resource/`（ADR-007：severity 阶梯+legacy 映射+生命周期 / 空间类型注册表+坐标记录 / 资源状态+可用性 fail-closed）+ 各域 test-vectors | `scripts/audit-domain-contracts.js`（JS 独立仲裁三域语义 + Python/TS 注册表一致，挂 make truth-check 与 CI） |
| 工业身份 | `contracts/identity/identity.schema.json`（kind 注册表+语法+规则）+ `identity-mapping.schema.json`（第三方 ID 映射记录）+ `test-vectors.json`（跨语言一致性向量） | `scripts/audit-identity-contracts.js`（独立仲裁 + Python/TS 注册表一致，挂 make truth-check 与 CI） |
| 身份持久化 | `db/migrations/standalone_032_identity_mapping.sql`（TENANT_SCOPED RLS）+ verify | `run_migrations.js --verify-standalone-identity-mapping` + standalone.yml CI（apply/verify/rollback/re-apply） |
| 身份 API | `openapi/ewoh.yaml` `/api/identity/mappings{,/resolve}` | `scripts/audit-openapi-routes.js --strict`（326 controllers 零漂移） |
| 状态机 | `contracts/state-machines/*.yaml`（alert/approval/control/fleet/plan/task） | Python `StateMachineLoader` + `tests/test_state_machine_contract.py` + Makefile `contract-state-machine` |
| 事件目录 | `contracts/events/event-catalog.yaml`（CloudEvents 1.0，30+ 类型） | `scripts/audit-event-catalog.js` |
| 工厂模板/复制 | `contracts/factory/`（factory-profile / site-readiness / replication-report / golden-factory） | `scripts/audit-factory-profile-contracts.js` / `audit-golden-factory.js` |
| 工件 Schema | `contracts/artifact-schemas/`（decision/evidence/gate/risk/state/release-manifest/task-board + index.js） | `scripts/audit-asset-catalog-contracts.js` |
| 映射 | `contracts/mapping/mapping-schema.json` + `catalog/mappings/*.yaml` | `scripts/audit-mapping-contracts.js` |
| 策略 | `contracts/policy/`（policy-schema.json + deploy-gate.rego） | `scripts/audit-policy-contracts.js` + `rego-tck.py` |
| 连接器包 | `catalog/connectors/connector-contract.schema.json` + `src/edge_platform/connectors/manifests/*` | `scripts/connector-tck.py` |
| 场景包 | `contracts/catalog/scenario-pack.schema.json` + `catalog/scenarios/*/manifest.yaml` | `scripts/scenario-tck.js` |
| 工作流/编排 | `contracts/workflow/workflow-schema.json` + `contracts/work/*` | `scripts/audit-workflow-contracts.js` / `audit-work-graph-contracts.js` |
| API（云侧） | `openapi/ewoh.yaml` + `openapi/work-orchestration.yaml` | `npm run gen:openapi` + `scripts/audit-openapi-routes.js`（323 控制器零漂移） |
| 数据库 Schema | `db/migrations/standalone_001..031`（成对 rollback） | `db/runner/run_migrations.js` + `gen:db-schema`（schema.ts 反向生成） |
| 部署参数 | `deploy/.env.example` | `scripts/audit-env-inventory.js --strict` |
| 仓库事实 | `contracts/repository-facts/repository-facts.schema.json` + `feature-status.yaml` | `scripts/truth-*` / `audit-repo-facts.js` |

## 2. Canonical Model 收敛状态（总提示词 §3 十二模型）

| Canonical Model | 状态 | 权威源（现） | 差距 |
|---|---|---|---|
| Identity | Partial | `contracts/identity/*` + standalone_032 + Identity 模块 + ingest entity_id 落点（NO-02b 已接线） | Golden Scenario 覆盖 + legacy 存量 reconcile（NO-02d） |
| Risk | Partial | `contracts/risk/*`（ADR-007 契约+双实现+门禁） | 云侧 alert severity 枚举接线（NO-02c-b） |
| Location | Partial | `contracts/location/*`（ADR-007 契约+双实现+门禁） | SpatialEntityType 收敛 + spatial 入口归一（NO-02c-b） |
| Resource | Partial | `contracts/resource/*`（ADR-007 契约+双实现+门禁） | ResourceState.status 枚举锁定（NO-02c-b） |
| Entity | Partial | 分散（schema.ts / edge storage / artifact-schemas） | 无 Entity Contract 生成器 |
| Event | Implemented | `contracts/events/event-catalog.yaml` | Envelope 未全链路强约束（Phase 4） |
| Task | Implemented | `contracts/state-machines/task.yaml` | — |
| Resource | Partial | ResourceProjection SSOT（云侧） | 无跨运行时 Resource Contract |
| State | Implemented | `contracts/state-machines/*.yaml` | — |
| Location | Partial | 分散（spatial 双侧） | 无 Location Contract |
| Capability | Partial | connector manifests + 任务技能字段 | 无统一 Capability Contract |
| Risk | Missing | 分散（边缘 L1-L3 / 云 alert） | 需统一 Risk Contract |
| Decision | Partial | DecisionTrace + decision.schema.json | 无 Decision Catalog |
| Execution | Partial | assignment 生命周期 | 边缘 execute 状态分叉（R-3） |
| Evidence | Implemented | evidence.schema.json + 证据窗口 | — |

## 3. 契约优先工作流（不可绕过）

1. 改 API → `cd ewoh-spark-app && npm run gen:openapi` → `openapi:no-drift` 全绿。
2. 改状态机 → 更新 `contracts/state-machines/*.yaml` + Python 模型 + `make contract-state-machine`。
3. 新事件类型 → 更新 `contracts/events/event-catalog.yaml`（禁止连接器私造类型）。
4. 改表 → 新增 `standalone_0xx.sql` + `.rollback.sql` 成对 + verify + `gen:db-schema` 再生成。
5. 新连接器/场景 → manifest + schema + 对应 TCK 全绿。
6. 新配置项 → `deploy/.env.example` + `audit-env-inventory --strict` 全绿。
7. 改身份契约（kind 注册表/语法） → 更新 `contracts/identity/identity.schema.json` +
   Python `identity.py` KINDS + TS `identity.ts` IDENTITY_KINDS +
   `make contract-identity` 全绿。

## 4. 待建契约（按优先级）

1. Event Envelope 强约束 schema（Phase 4，World State 契约族之上）。
3. Agent Manifest / Tools / Policy 契约（Phase 9 立项）。
