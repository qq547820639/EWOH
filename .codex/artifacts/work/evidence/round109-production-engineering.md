---
workItemIds: T-114
kind: test
result: passed
commitSha: 20388380dff8c15ba0841db6d8af0bc2776127ea
branch: codex/ewoh-iteration-2026-08-04
buildVersion: 0.6.0-rc4
envFingerprint: fc13fa824502c48c54b7885cd4b8d6d7a749b47994c4d3ad4f84a56effa23e9b
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T05:05:00.000Z
verifier: 独立验证 Agent
expiresAt: 2026-11-01T12:00:00.000Z
---

# Round 109 - Production Engineering Deepening (Phase 5)

Branch: `codex/ewoh-iteration-2026-08-04` | HEAD: `20388380dff8c15ba0841db6d8af0bc2776127ea`
（本轮改动在未提交工作区，提交后以新 SHA 覆盖）

## 目标（Phase 5：生产工程深化）

闭合部署工件一致性、SBOM 与供应链安全、生产 SLO/错误预算、Runbook 关键章节、
密钥/审计/脱敏核对，并把依赖真实环境的验证项登记为 Blocked by External Validation。

## 1. 部署工件一致性验证（实际运行）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/verify-deploy-artifacts.js` | **PASS**（66/66） |
| 2 | `node scripts/verify-helm-chart.js` | **PASS**（128 checks，Helm ewoh 0.1.0 / app 0.6.0-rc4） |
| 3 | `node scripts/deployment-tck.js` | **PASS**（34/34 + REGO TCK 4 + DEPLOYMENT TCK 4 gates） |
| 4 | `make test`（Python） | **PASS**（667 tests OK） |

> 三个部署工件脚本全部通过，无失败项，无需修复工件。

## 2. SBOM 与供应链安全

- 新增 `scripts/generate-sbom.js`：Node 内置 `child_process` 调用 `npm sbom`（无第三方依赖），
  输出 CycloneDX 1.5；`npm sbom` 不可用时降级为 `package-lock.json` 派生摘要并标记
  `derived-from-lockfile`，绝不伪造。
- 本机实测：`node scripts/generate-sbom.js` → **mode=npm-sbom，top=ewoh-spark-app@2.2.5，
  components=235**，产物 `release/ewoh-spark-sbom.cyclonedx.json`（CycloneDX 1.5，含 hashes/licenses/purl）。
- 新增 `docs/delivery/supply-chain-security.md`：依赖扫描（`npm audit`）、镜像签名（cosign，待环境）、
  SBOM 校验流程。
- 依赖漏洞扫描/镜像签名真实执行为外部验证项。

## 3. 生产 SLO 与错误预算

- 新增 `docs/delivery/slo-error-budget.md`：核心 API 可用性 99.9%（月度预算 43.8 分钟）、
  延迟 P95≤800ms / P99≤2000ms（对齐 `perf-budget.mjs` api-p95 / slow-query 预算）、
  错误率≤0.5%、容量基线（200 并发 / 500 RPS / 池 20）、告警降噪规则与阈值速查。
- 真实压测校准容量基线归入外部验证。

## 4. Runbook 补齐

- 更新 `docs/delivery/deployment-runbook.md`（v1.1→v1.2），补充：
  - **Database Backup & Restore**：逻辑备份/恢复/校验/序列冒烟/编排脚本（`postgres-logical-backup.mjs`、
    `post-restore-smoke.mjs`、`standalone-ops-check.sh`）。
  - **Edge 断网/重连/重放/远程升级**：边缘缓冲、SEQ 重放、backfill/replay、远程升级三步。
  - **批量升级/灰度/暂停/回滚**：Release Ring（pilot/canary/stable）、canary、pause、rollback。
  - **可验证回滚点**：备份 manifest、表数、恢复行数、identity 序列、健康检查、错误率。

## 5. 密钥/审计/脱敏核对

- `.env.example`（`deploy/.env.example`、`deploy/cloud/.env.compose.example`、
  `ewoh-spark-app/.env.standalone.example`）与 `deploy/cloud/k8s/secret.example.yaml`：
  敏感值均为占位符（`CHANGE_ME`/`REPLACE_WITH`/空），**无真实密钥**。
- 审计与脱敏实现（复用）：
  - `ewoh-spark-app/server/modules/shared/audit.service.ts`：`redact()` 深度脱敏敏感键与凭据串。
  - `ewoh-spark-app/server/modules/system/system.service.ts`：`maskSensitiveConfig()` 掩码配置值。
  - `src/edge_platform/server.py`：`/api/security/policy` 对 `tls_cert/tls_key/jwt_secret/oidc_client_id` 脱敏。
- 结论：密钥未泄漏、审计脱敏已存在并复用，无新增缺口。

## 6. 外部验证项登记（Blocked by External Validation）

以下依赖真实环境（本机无 PostgreSQL/Docker/Kubectl/Helm/真机），**未伪造结果**：

| 验证项 | 所需输入 | 状态 |
|---|---|---|
| 真实 DB 迁移/回滚/备份恢复 | 真实 PostgreSQL 17（owner + ewoh_api 角色） | Blocked |
| Docker/K8s/Helm 部署 | Docker、kubectl、Helm、registry | Blocked |
| 边缘断网重连重放 | 真机/边缘设备 + 平台 | Blocked |
| 长稳大数据测试 | 真实 PG + 高负载 | Blocked |
| 批量升级灰度回滚 | 生产试点工厂 + 真机 | Blocked |
| `npm audit` 联网完整扫描 | 联网 registry | Blocked |
| 镜像签名/校验 | cosign/notation + registry + 密钥 | Blocked |
| 容量压测校准 | 压测环境（k6/ab） | Blocked |

## Check items

| Check | Result |
|---|---|
| 部署工件验证脚本通过 | PASS |
| make test 667 通过 | PASS |
| SBOM 生成（本机 npm-sbom） | PASS（235 组件） |
| supply-chain-security.md | PASS（新增） |
| slo-error-budget.md | PASS（新增） |
| deployment-runbook.md 关键章节补齐 | PASS（v1.2） |
| 密钥样例无真实密钥 | PASS |
| 审计/脱敏实现复用 | PASS |
| 外部验证项登记 Blocked | PASS |

## Interpretation

- 只做生产工程深化与文档补齐，未扩围业务、未改冻结契约；未引入新第三方依赖。
- 环境缺失项如实标记 Blocked by External Validation，未伪造任何测试结果。
- 部署工件验证、SBOM 生成、Python 测试为本地可执行项，已真实运行并记录。