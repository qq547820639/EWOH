---
workItemIds: T-108
kind: test
result: passed
commitSha: fafd4e5
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: ed991c0a0b9c0561d3add5558435d908cdb800019e637390ceefd3a3ecfbba65
dependencyVersion: 3:2.2.5
testTime: 2026-08-04T11:30:00.000Z
verifier: 独立验证 Agent
expiresAt: 2026-11-01T11:30:00.000Z
---

# Round 107 - G4 Offline Conflict Force-Resolution Closure (Phase 3)

Branch: `main` | HEAD: `fafd4e5`（本轮改动在未提交工作区，提交后以新 SHA 覆盖）

## 目标（闭合 LATEST_HEAD_AUDIT.md G4）

G4：离线冲突无强制解析端点，`offlineConflict.ts`/`useOfflineWorkbench.ts` 的 TODO 标注 409 无 `serverValue`、缺幂等 force-resolution 端点。本 Phase 3 闭合：

**后端**
- 步骤迁移 409 冲突响应新增 `serverValue`（当前服务端步骤状态）。
- `POST /api/mes/work-orders/{id}/steps/{stepId}/force-resolve`：幂等强制解析。`resolution:'server'` 保留服务端状态；`resolution:'local'` 经合法状态机重新应用本地动作，绝不绕过状态机；仍冲突则 `applied=false`+`LOCAL_CONFLICT_PERSISTS`。
- `POST /api/mobile/workbench/orders/{orderId}/steps/{stepId}/force-resolve`：移动端委托。
- 复用 `IdempotencyService`，同 `idempotencyKey` 重复调用返回记录结果。

**前端**
- `offlineConflict.ts` 消费 `serverValue`（`parseConflictPayload`）并渲染本地 vs 服务端差异。
- `useOfflineWorkbench.ts` `resolveConflict` 实际调用 `forceResolveMobileStep`；离线时提示"无法提交冲突解析，请恢复网络后重试"；本地仍无法应用时明确提示"已保留服务端状态"。
- 禁止静默覆盖：所有冲突解决显式选择（本地/服务端/手动），全程审计。

**契约**
- `openapi/ewoh.yaml` 登记 2 条 force-resolve 路由 + `MesForceResolveRequest/MesForceResolveResult` schema。

## Real command evidence

```text
# 1) 服务单元测试（新增 force-resolve 4 用例）
npx jest test/unit/mes/mes.service.spec.ts --runInBand
# PASS 22/22（含 4 个新 force-resolve 用例）

# 2) 服务端类型检查
npm run type:check:server
# PASS（tsc 0 错误）

# 3) 客户端类型检查
npm run type:check:client
# PASS（tsc 0 错误）

# 4) lint（eslint + stylelint + type:check）
npm run lint
# PASS

# 5) OpenAPI 路由审计（严格模式）
node scripts/audit-openapi-routes.js --strict
# Controller operations: 253 | Spec operations: 253 | undocumented: 0 | unimplemented: 0
```

## Check items

| Check | Result |
|---|---|
| 409 冲突响应含 `serverValue` | PASS（`ConflictException({ message:'STATE_CONFLICT', serverValue: step })`） |
| `resolution='server'` 保留服务端状态且幂等 | PASS（同 key 重复调用返回一致结果） |
| `resolution='local'` 经状态机重放成功 → `applied=true` | PASS |
| `resolution='local'` 仍冲突 → `applied=false`+`LOCAL_CONFLICT_PERSISTS` 保留服务端 | PASS |
| 非法 resolution 拒绝 | PASS（BadRequestException） |
| 移动端 force-resolve 委托 | PASS（`mobile.service.ts`/`mobile.controller.ts`） |
| 前端 `resolveConflict` 实际调用 force-resolve | PASS（`useOfflineWorkbench.ts`） |
| 前端 `offlineConflict.ts` 消费 `serverValue` | PASS（`parseConflictPayload`） |
| OpenAPI 契约登记 2 条新路由 | PASS（strict 0 未登记） |
| route-manifest 更新 | PASS（controller/spec 均 253） |

## Interpretation

- 只做契约闭合，未扩围业务、未改冻结状态机/安全边界/共享契约。
- 状态机权威，`force-resolve` 绝不绕过状态机；`local` 仍冲突时保留服务端状态，禁止静默覆盖。
- 未引入新第三方依赖。真实 PG/浏览器 E2E 依赖外部环境，本环境不可用，未伪造结果。
- 本轮同时产出 `docs/product/UX_DEEPENING_BACKLOG.md`，覆盖第四阶段 3.1–3.13 共 13 项。