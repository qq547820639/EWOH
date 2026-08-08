# Week 4 — CI Gates / Policy 收敛 / 全量回归 / 收尾

## Finding: P1-SCHED-003 统一 Scheduling Policy（magic number 集中化）

- **Verification**：`SchedulingPolicyConfig` 已含 minBatteryPct / maxContinuousLoad /
  defaultTaskDurationMs / walkingSpeedMps / congestedFactor / blockedFactor /
  highRiskFactor / mediumRiskFactor / triggerCooldownMs；heuristic solver 已全部
  引用 policy 值。
- **剩余收敛（本次完成）**：`routing.service.ts edgeCost` 此前硬编码 congested=1.5 /
  blocked=2 / risk=2/1.3；现改为从 versioned policy 刷新缓存（refreshEdgeFactors），
  失败时保留上次值（绝不阻断路由）。
- **Tests**：`routing.spec.ts` 10 passed。

## CI Gates（P0-EDGE-006 + P0-EDGE-002）

- `.github/workflows/test.yml` 新增：
  1. `make production-smoke`（Production Runtime Assembly 门禁：真实装配 + no-stub + Bus 契约）；
  2. production 模式真实启动冒烟：断言 `rule_version=risk-rule-v0.2`（真实 RuleEngine），
     否则 fail（防止静默 stub）。

## Final Regression

| Command | Exit Code | Result |
| ------- | --------: | ------ |
| `python3 -m unittest discover -s src/edge_platform/tests` | 0 | 731 passed |
| `python3 -m pytest tests/` | 0 | 135 passed, 1 skipped |
| `make production-smoke` | 0 | 11 passed |
| `npx tsc --noEmit --project tsconfig.node.json` | 0 | passed |
| `npx tsc --noEmit --project tsconfig.app.json` | 0 | passed |
| `npx jest --config client/jest.config.cjs` | 0 | 81 suites / 640 tests |
| `npx jest --testPathPattern scheduler/__tests__` | 0 | 24 suites / 201 tests |
| `node scripts/gen-openapi.js --check` | 0 | in sync |
| `node scripts/audit-openapi-routes.js` | 0 | 301/301, undocumented=0 |
| `node --test ewoh-feishu-app/test/security.test.js` | 0 | 13 passed |

## Remaining Risks
- P2-SHARED-001（shared types 拆分）与 P2-WORK-001（WorkOrchestration 拆职责）：
  属结构性重构，本期未执行（按任务要求 P0/P1 优先）。建议作为下一迭代专项，
  保持兼容 re-export 渐进迁移。
- CP-SAT 生产可用性仍依赖 ortools 部署（默认 heuristic，显式标记）。
