# EWOH 生产化整改最终报告

## 1. Remediation Executive Summary

按生产风险优先级完成 12 项目标中的 11 项（P0 全部、主要 P1 全部、P2 部分）。
核心成果：
- **Python Edge Runtime 真实可运行**：production 模式实测真实装配成功（rule_version=
  risk-rule-v0.2），不再依赖 ImportError 静默 stub。
- **禁止静默 Stub**：`EWOH_RUNTIME_MODE` 三态 + `EWOH_ALLOW_STUB`；production 装配失败
  fail-fast（RealAssemblyError + 退出非零）。
- **EventBus 唯一契约**：handler 回调语义统一，stubs 与真实实现契约一致。
- **Feishu Webhook 安全**：token + timestamp 窗口 + Encrypt-Key 签名 + replay 保护；
  模拟器默认关闭；CORS 显式 allowlist。
- **Scheduler 可信度**：DecisionTrace 使用真实 PriorityEngine 结果；duration 统一
  （policy 单一来源）；route fallback ETA 真实计算；route cost 系数来自 versioned policy。
- **性能**：World Current State 用 DISTINCT ON（数据库内完成）；Ingest batch 每帧
  DB 往返 ~3→~1。
- **事实源收敛**：`/api/scheduler/resources/state` 成为资源状态权威投影；
  CommandMap 正式写链仅 Scheduler V2。

## 2. Audit Base vs Final HEAD

```
Audit Base:  ba7db6b81ede44238905ed2796b9dd7c4b6ba2db
Final HEAD:  1ddee09 (main)
Commits:     8 (edge runtime / feishu / docs / scheduler / world-ingest-cmap / ci / shared / test-fix)
```

## 3. Findings Status Matrix（完整见 01-findings-status.md）

| ID | Sev | Status |
| -- | --- | ------ |
| P0-EDGE-001/002/003/004/005/006 | P0 | VERIFIED |
| P0-SEC-001/002/003 | P0 | VERIFIED |
| P0-SCHED-001/002 | P0 | VERIFIED |
| P1-SCHED-003/004 | P1 | VERIFIED |
| P1-ROUTE-001/002 | P1 | VERIFIED |
| P1-WORLD-001 | P1 | VERIFIED |
| P1-INGEST-001 | P1 | VERIFIED |
| P1-CMAP-001/002/003 | P1 | VERIFIED |
| P2-SHARED-001 | P2 | IN_PROGRESS（barrel 已建，域拆分下迭代） |
| P2-WORK-001 | P2 | DEFERRED（高风险结构性重构，下迭代） |

## 4. All Files Changed（概要）

- **Edge Runtime**：`src/edge_platform/runtime/{__init__,protocols,dependencies,bootstrap}.py`（新）、
  `edge/storage.py`（新，真实 Storage 提升）、`edge/manager.py`（新，真实 AdapterManager）、
  `edge/bus.py`（统一契约 + 异常观测）、`run.py`、`config.py`、`stubs.py`、
  `inference/pipeline.py`、`inference/events.py`、`monitoring/collector.py`
- **Feishu**：`server/security.js`（新）、`server/index.js`、`feishu-config.example.json`、
  `test/security.test.js`（新）
- **Scheduler**：`priority-engine.ts`、`cp-sat-scheduling-solver.ts`、`dispatch-coordinator.service.ts`、
  `routing.service.ts`、`scheduler.controller.ts`、`resource-projection.service.ts`（暴露）、
  `scheduler/__tests__/*`、`shared/api.interface.ts`
- **World/Ingest**：`world.service.ts`、`ingest.service.ts`、`test/unit/ingest/*`
- **Frontend**：`api/scheduler.ts`、`hooks/queryKeys.ts`、`ResourcePoolPanel.tsx`
- **CI**：`.github/workflows/test.yml`、`Makefile`、`openapi/ewoh.yaml`、`openapi/route-manifest.json`、
  `client/src/types/openapi.d.ts`、`shared/index.ts`（新）
- **Docs**：`docs/remediation/00-05,99-*.md`

## 5-13. 领域变更摘要

- **架构**：Edge 装配改为 RuntimeFactory（mode 驱动）；资源状态收敛到 ResourceProjection SSOT。
- **安全**：Feishu 写操作验签闭环；INGEST_API_KEY 未配置时仍 fail-open（遗留，见 Remaining）；
  无静默 stub 路径。
- **Scheduler**：唯一正式求解器 = heuristic（CP-SAT 预留，显式标记）；DecisionTrace 真实。
- **Edge**：真实装配可运行；Bus 契约统一；StreamName 统一登记。
- **DB/性能**：World 查询 DISTINCT ON；Ingest 批量插入。
- **CommandMap**：写链仅 V2；资源读取权威投影。
- **测试新增**：production assembly（5）+ bus contract（6）+ feishu security（13）+
  batch ingest（4）+ route（3）+ decision trace（1）。
- **命令运行**：见各 Phase 文档 + 最终回归（下）。

## 14. Remaining P1/P2/P3

| ID | Sev | Status | 说明 |
| -- | --- | ------ | ---- |
| P1 | P1 | OPEN（已缓解） | IngestGuard 未配置 INGEST_API_KEY 时 fail-open（文档标注，需部署强制） |
| P1 | P1 | OPEN（已缓解） | CP-SAT 生产可用性依赖 ortools 部署（默认 heuristic，显式标记） |
| P2-SHARED-001 | P2 | IN_PROGRESS | shared 域拆分（barrel 已就绪） |
| P2-WORK-001 | P2 | DEFERRED | WorkOrchestration 职责拆分 |
| P3 | P3 | OPEN | ui/command_map 归档、demo.db 清理、output 产物 ignore |

## 15. Rollback Considerations

- 各 commit 独立、逻辑小批次；回滚可按 commit 粒度（edge runtime / feishu / scheduler / world-ingest / ci）。
- Edge Runtime 行为变化：默认 development 模式下真实装配失败会抛错（需 EWOH_ALLOW_STUB=1 才回退）
  ——部署脚本需设置 EWOH_RUNTIME_MODE 或显式 ALLOW_STUB。
- Feishu webhook 现要求 FEISHU_VERIFICATION_TOKEN；未配置时写操作被拒绝（fail-closed）。

## 16. Final Source-of-Truth Matrix（更新）

| Domain | Authoritative Source |
| ------ | -------------------- |
| Production Business State | PostgreSQL (ewoh_*) |
| World State | ewoh_world_state + DISTINCT ON 查询 |
| Scheduler | NestJS Scheduler V2（heuristic 实际求解器） |
| Policy | SchedulingPolicyConfig（versioned） |
| Database Schema | db/migrations(standalone) → schema.ts |
| API Contract | openapi/ewoh.yaml + shared types（301/301 对齐） |
| Resource State | ResourceProjectionService（/api/scheduler/resources/state） |
| Route Cost | RouteCostProvider（policy factors） |
| Edge Runtime | edge_platform.runtime（真实装配，mode 驱动） |

## 17. Module Ownership Matrix（更新）

- Scheduler：Production Canonical = NestJS V2；Edge = Python SchedulerService（真实，数据源 stub）；
  Legacy = V1 模板（仍注册但 deprecated）；Prototype = Python orchestrator。
- Resource：Production Canonical = ResourceProjectionService。
- 其余见审计报告第 28 章（无变化）。

## 18. 最终验证（全量回归）

| Command | Exit | Result |
| ------- | ----: | ------ |
| `python3 -m unittest discover -s src/edge_platform/tests` | 0 | 731 passed |
| `python3 -m pytest tests/` | 0 | 135 passed, 1 skipped |
| `make production-smoke` | 0 | 11 passed |
| `EWOH_RUNTIME_MODE=production python3 run.py` | 0 | real assembly（rule=risk-rule-v0.2） |
| `npx tsc --noEmit --project tsconfig.node.json` | 0 | passed |
| `npx tsc --noEmit --project tsconfig.app.json` | 0 | passed |
| `npx jest --config client/jest.config.cjs` | 0 | 81 suites / 640 tests |
| `npx jest --testPathPattern scheduler/__tests__|test/unit/ingest` | 0 | 26 suites / 214 tests |
| `node scripts/gen-openapi.js --check` | 0 | in sync |
| `node scripts/audit-openapi-routes.js` | 0 | 301/301, undocumented=0 |
| `node --test ewoh-feishu-app/test/security.test.js` | 0 | 13 passed |

## 19. 明确回答

- **Python Edge 是否已能真实运行？** 是。production 模式实测真实装配（rule=risk-rule-v0.2），
  Storage/MessageBus/RuleEngine/InferencePipeline/AdapterManager 均为真实实现。
- **Production 是否还能无意进入 Stub？** 否。无 `ImportError→stub` 路径；production 失败 fail-fast；
  CI 有 no-stub 门禁。
- **EventBus 是否只有一个契约？** 是。handler 回调契约唯一；stubs.Bus 对齐；协议测试覆盖。
- **Feishu webhook 是否安全？** 是（token+timestamp+signature+replay，fail-closed）。
- **Simulator 是否可能误入生产？** 否。默认关闭；production 需双开关才允许。
- **CP-SAT 是否真实可用？** 当前环境未装 ortools → UNAVAILABLE；heuristic 为实际求解器（显式标记）。
- **当前 production 实际 solver 是谁？** HeuristicSchedulingSolver（fallback 状态显式）。
- **DecisionTrace 是否完全真实？** 是。真实 PriorityEngine score/factors/level + 真实候选；
  数据不可得时 null/UNKNOWN，禁止伪造 0/[]。
- **Route fallback ETA 是否修复？** 是。ETA=distance/walkingSpeed，距离>0 时 ETA>0。
- **Duration 是否统一？** 是。Solver/Reservation/Dispatch 共用 policy defaultTaskDurationMs（30min）。
- **World Current State 是否已优化？** 是。DISTINCT ON(entity_id) 数据库内完成。
- **Ingest 是否仍逐条串行 DB？** 单帧路径保留；**batch 路径已批量预检+批量插入**（每帧 ~1 次往返）。
- **CommandMap 是否只走正式 Scheduler V2？** 是（写链）；gamification 仅只读推荐且 deprecated。
- **ResourceProjection 是否成为资源 SSOT？** 是。API 暴露 + ResourcePool 消费权威投影。
- **所有 P0 是否已 VERIFIED？** 是。11 个 P0 Finding 全部 VERIFIED（见 Findings Status Matrix）。
