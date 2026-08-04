---
workItemIds: T-103
kind: test
result: passed
commitSha: 4e06e0a5a8d35e19f86213e1b00b09e49d967d0c
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: ed991c0a0b9c0561d3add5558435d908cdb800019e637390ceefd3a3ecfbba65
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T04:00:00.000Z
verifier: 独立验证 Agent
expiresAt: 2026-11-01T04:00:00.000Z
---

# Round 106 - Causal Console Gate Revoke/History/BlockedReason (Phase 2)

Branch: `main` | HEAD: `4e06e0a5a8d35e19f86213e1b00b09e49d967d0c`

## 目标（闭合 LATEST_HEAD_AUDIT.md G3）

G3：Gate 无撤销/回滚 API。本 Phase 2 新增：

- `POST /api/work/gates/{id}/revoke`：撤销门禁当前决定，若历史存在前一条决定则回滚恢复。
- `GET /api/work/gates/{id}/history`：返回该门禁完整历史（决定/撤销，含时间、actor、reason）。
- `GET /api/work/items/{id}/blocked-reason`：返回「为什么被阻塞」自然语言解释。
- 前端 `GatesPanel.tsx` 撤销/历史按钮接线；`WorkGraphPanel.tsx` 节点详情展示阻塞原因。

## Real command evidence

```text
# 1) 服务单元测试（新增 revoke/history/blockedReason 用例）
npx jest test/unit/work-orchestration/work-orchestration.service.spec.ts --runInBand
# PASS 25/25（含 7 个新增用例）

# 2) 全量类型检查（server + client）
npm run type:check
# PASS（tsc 0 错误）

# 3) lint（eslint + stylelint + type:check）
npm run lint
# PASS

# 4) 全量后端测试
npm test -- --runInBand
# PASS 82 suites / 405 tests

# 5) OpenAPI 路由审计（严格模式）
node scripts/audit-openapi-routes.js --strict
# Controller operations: 251 | Spec operations: 251 | undocumented: 0 | unimplemented: 0

# 6) 重新生成 route-manifest（生成器产物）
node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json
# Route manifest written: openapi/route-manifest.json
```

## Check items

| Check | Result |
|---|---|
| Revoke 撤销无前决定 → 回到无决定状态 | PASS（history 追加 action='revoked'） |
| Revoke 撤销有前决定 → 回滚恢复前一条 | PASS（restored 返回前一条） |
| Revoke 无决定/不存在门禁 → 拒绝 | PASS（BadRequest / NotFound） |
| History 返回完整记录 | PASS（含 decision/revoked 两种 action） |
| BlockedReason 依赖阻塞 → 中文解释 | PASS（「W1 被 W0 阻塞：W0 尚未完成」） |
| BlockedReason 无阻塞 → 未受阻塞 | PASS |
| OpenAPI 契约登记 3 条新路由 | PASS（strict 0 未登记） |
| route-manifest 更新 | PASS（controller/spec 均 251） |

## Interpretation

- 只做契约闭合，未扩围业务、未改冻结状态机/安全边界/共享契约。
- 撤销/历史沿用 `gate-decisions.json` / `gate-decision-history.json` 落盘，与现有 gate decision 一致。
- 未引入新第三方依赖。真实 PG/浏览器 E2E 依赖外部环境，本环境不可用，未伪造结果。