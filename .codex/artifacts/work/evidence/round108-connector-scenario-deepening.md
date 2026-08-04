---
workItemIds: T-110
kind: test
result: passed
commitSha: 9850f6c5c362c0377d91323f8171ab69588940b8
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 273f809d98322fb9a9203df2f71f161dbf1ec7e282839a28f230b49d3f173a65
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T12:00:00.000Z
verifier: 独立验证 Agent
expiresAt: 2026-11-01T12:00:00.000Z
---

# Round 108 - Connector & Scenario Deepening (Phase 4)

Branch: `main` | HEAD: `9850f6c5c362c0377d91323f8171ab69588940b8`（本轮改动在未提交工作区，提交后以新 SHA 覆盖）

## 目标（Phase 4：场景包与连接器深化）

为 ERP/MRP/WMS 连接器建立统一连接器质量属性契约（Canonical Connector Contract），并扩展连接器 TCK 对契约的校验，闭合 LATEST_HEAD_AUDIT §10-P1「连接器与场景包 TCK」。

## 1. 统一连接器质量属性契约（Canonical Connector Contract）

新增共享 schema `catalog/connectors/connector-contract.schema.json`（JSON Schema draft-07，`$id: ewoh:///connector-contract/v1`），定义 10 项统一质量属性：

| 属性 | 必填字段 | 说明 |
|---|---|---|
| canonicalModel | schemaRef / entityType / version | 规范模型 |
| mappingTemplate | templateRef / direction | 字段映射模板 |
| cursor | field / type / mode | 游标（timestamp/incrementing-id/sequence/offset） |
| idempotency | keyField / ttlSeconds | 幂等键与 TTL |
| replay | supported / window / mode | 重放窗口与模式 |
| compensation | supported / strategy | 补偿策略 |
| deadLetter | enabled / topic / retryPolicy | 死信 DLQ 主题与重试策略 |
| rateLimit | enabled / requestsPerSecond / burst | 限流阈值 |
| dataQuality | validateRequired / schemaValidation / rejectOnInvalid / rules | 数据质量校验规则 |
| observability | metrics / healthEndpoint / trace | 可观测性指标与链路追踪 |

## 2. 连接器清单（grep 汇总）

- `catalog/connectors/erp/erp-inventory.yaml`：升级，新增 `spec.connectorContract`（cursor=updatedAt/timestamp，DLQ=`ewoh.erp.inventory.dlq`，rps=20/burst=40，DQ 规则 sku/quantity，metrics 3 项）。
- `catalog/connectors/erp/erp-order-delivery.yaml`：升级，新增 `spec.connectorContract`（cursor=updatedAt/timestamp，idempotencyKey=orderId，DLQ=`ewoh.erp.order.dlq`，rps=20/burst=40）。
- `catalog/connectors/mrp/mrp-material-planning.yaml`：**新增**，cursor=planSeq/incrementing-id，DLQ=`ewoh.mrp.plan.dlq`，rps=10/burst=20，replay 90d。
- `catalog/connectors/wms/wms-inventory.yaml`：**新增**，cursor=updatedAt/timestamp/`both`，DLQ=`ewoh.wms.inventory.dlq`，rps=15/burst=30，replay full-resync，compensation=reverse-api。

- `contracts/catalog/connector-package.schema.json`：`spec` 增加可选 `connectorContract`（object）以允许清单携带契约（结构由 connector-contract.schema.json 校验）。

## 3. 连接器 TCK 扩展（scripts/connector-tck.py）

新增 87 项校验（32→119 项）：
- schema 本体：`$id`、draft-07、8 项必填属性（canonicalModel/cursor/idempotency/replay/deadLetter/rateLimit/dataQuality/observability）齐备。
- 每个 ERP/MRP/WMS 清单（递归扫描 `catalog/connectors/*.yaml`）：`connectorContract.schemaRef` 指向共享 schema；8 项质量属性字段存在；结构抽查（canonicalModel.schemaRef、cursor.field、idempotency.keyField、replay.supported、deadLetter.topic、rateLimit.requestsPerSecond、dataQuality.schemaValidation、observability.metrics、mappingTemplate.templateRef、compensation.supported）。
- PyYAML 缺失时显式标记 `contract yaml parser available = False`（blocked），不静默跳过。

## Real command evidence

```text
# 1) 连接器 TCK（含新质量属性校验）
PYTHONPATH=src python3 scripts/connector-tck.py
# CONNECTOR TCK PASSED (119 checks)

# 2) 场景包 TCK（8 个 audit-*.js 门禁）
node scripts/scenario-tck.js
# SCENARIO TCK PASSED (8 gates)
#   Asset catalog contract audit: 4 scenarios | 4 connectors | 2 mappings | 38 checks passed

# 3) Python unittest
make test
# Ran 667 tests in 18.370s  OK
```

## Check items

| Check | Result |
|---|---|
| connector-contract.schema.json 为 draft-07 / `$id=ewoh:///connector-contract/v1` | PASS |
| 契约 10 项属性覆盖（含任务要求的 8 项） | PASS |
| ERP×2 清单含 connectorContract 且值明确 | PASS |
| MRP×1、WMS×1 清单对齐统一契约 | PASS |
| connector-package.schema.json 允许 connectorContract | PASS |
| connector-tck 新增质量属性校验（32→119 项） | PASS |
| scenario-tck 8 门禁通过 | PASS |
| make test 667 通过 | PASS |
| 核心中立性（连接器运行时/新增 catalog 无客户名/客户专属字段/长客户分支） | PASS（grep 0 命中） |

## Interpretation

- 只做连接器契约深化与缺口闭合，未扩围业务、未改冻结状态机/安全边界/共享事件契约。
- 未引入新第三方依赖（PyYAML 已在环境中，dev-only；运行时仍零依赖）。
- 真实 ERP/MRP/WMS 环境联调属外部验证，本环境不可用，未伪造结果（连接器契约以 schema+TCK 静态校验为准）。
- 核心服务代码未改动（仅新增 catalog 契约文件、扩展 TCK 脚本与 connector-package schema 的 `spec.connectorContract` 可选字段）。