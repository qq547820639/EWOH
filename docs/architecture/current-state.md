# EWOH Current State（现状事实）

> 维护规范：本文件是"向 Factory Embodied Intelligence OS 收敛"的现状视图。
> 功能实现布尔事实以根目录 `feature-status.yaml` 为唯一事实源，本文件引用而不复制。
> 基线证据：`docs/reviews/codebase-walkthrough-2026-08-14.md`（完整走读，2026-08-14）。
> 最后更新：2026-08-14 · 版本基线 0.6.0-rc4 · HEAD a149106。

## 1. 一句话现状

EWOH 已是多运行时单仓库的**外骨骼人员作业协同与调度平台**，工程治理（fail-closed 文化、
单一事实源、门禁矩阵）达到产品级水准；**全部能力 productionEnabled=false**，尚无真实
环境（PG/Docker/真机）验收；距"Factory Embodied Intelligence OS"目标状态的差距集中在
统一 World Model 契约、Event Envelope 全链路化、Agent Runtime、维护/质量域闭环与
Continuous Learning。

## 2. 运行时拓扑

| 运行时 | 目录 | 技术栈 | 规模 | 状态 |
|---|---|---|---|---|
| 边缘运行时 | `src/edge_platform/` | Python ≥3.9 纯标准库 | 202 .py ≈46K 行 | 三模式装配（production fail-fast 禁 stub）；离线可用；生产调度只读（advisory） |
| 云侧主产品 | `ewoh-spark-app/` | NestJS 10 + Drizzle + PG17 RLS；React 19 SPA | server ≈76K 行 / client ≈104K 行 | standalone-main.ts 为生产入口；42 业务模块 |
| 飞书侧车 | `ewoh-feishu-app/` | Express + better-sqlite3 + lark-cli | ≈5K 行 | 验签 fail-closed；lark-cli 异步化+熔断 |
| 契约层 | `contracts/ openapi/ db/ catalog/` | YAML/JSON/SQL | 156 文件 | 跨运行时契约；OpenAPI 零漂移门禁 |

## 3. 已建立的真相层（Repository Truth 资产）

- `feature-status.yaml`：10 个 feature 的 6 维布尔矩阵，由 `scripts/truth-feature-status.js`
  行级强制（实测 31/31 PASS）。
- 31 步 standalone 迁移链（`db/migrations/standalone_001..031`，全部成对 rollback），
  `server/database/schema.ts` 由 PG 反向生成（`gen:db-schema`）。
- OpenAPI 契约 `openapi/ewoh.yaml`（323 条控制器路由，spec 481 条目），
  `scripts/audit-openapi-routes.js` 守护零漂移。
- 事件目录 `contracts/events/event-catalog.yaml`（CloudEvents 1.0，30+ 事件类型）。
- 状态机契约 `contracts/state-machines/*.yaml`（alert/approval/control/fleet/plan/task）
  + Python `StateMachineLoader` + 契约测试。
- 部署参数单一事实源 `deploy/.env.example`（audit-env-inventory --strict，102 项 0 违规）。
- 决策日志 `docs/decisions/`（ADR-001..005）+ `OPEN-DECISIONS.md`（1 未决）。

## 4. 关键闭环现状（按总提示词 §6 高价值闭环）

| 闭环 | 现状 | 证据 |
|---|---|---|
| Logistics Task Loop | **Partial**：云侧 触发→快照→求解→审批→预约→派工→Outbox→SSE 真实端到端；执行反馈已消费于决策驾驶舱；边缘 execute 不推进任务状态（R-3） | scheduler 模块、DecisionCockpit.tsx |
| Andon Loop | **Partial**：AndonRaised 事件在目录；云侧 alert 模块 + 飞书推送；端到端 Andon 状态机未贯通 | event-catalog.yaml、alert 模块 |
| Worker + Exoskeleton Loop | **Partial**：人员-设备绑定与使用统计在边缘存储；显式可审计 Session 域模型未建立 | edge/storage.py |
| Maintenance Loop | **Implemented**：MaintenanceCondition 契约（ADR-010）+ standalone_034 + 云侧 maintenance 模块（lifecycle CHECK/事件落库）+ 调度封锁投影（critical→OFFLINE fail-closed）+ WorkOrder 委托建单 | contracts/maintenance、standalone_034、maintenance 模块、workorder 模块 |
| Quality Incident Loop | **Implemented**：QualityFinding 契约（ADR-010/011）+ standalone_034 + 云侧 quality 模块（disposition CHECK）+ 调度资格封锁（critical/high）| contracts/quality、standalone_034、quality 模块 |

## 5. 目标差距总览（详见 docs/capabilities/capability-matrix.yaml）

- Implemented（38 项，Round 38）：事件目录、状态机、调度闭环、跨语言调度一致性、
  Connector SDK+TCK、多租户 RLS、工程治理、工厂复制、世界回放、指挥地图驾驶舱、
  身份/风险/位置/资源/世界/实体/工单/维护/质量契约、事件骨干、Agent Runtime、
  AgentTask 编排、Knowledge System（契约 + 运行时）等。
- Partial（17 项）：L2/L4 工业智能深化、Digital Twin Simulation、Continuous
  Learning、执行反馈闭环（边缘 execute 推进）、可观测性全链路 trace、可靠性混合
  （Dead Letter）、Agent Policy/Approval UI、Canonical Risk Model 云侧接线等。
- Missing（0 项，Round 37 清零）；Prototype 1 项（scoped-assistant）。
  （本表为 Phase-1 基线快照 + 历轮增量刷新；活事实源 = capability-matrix.yaml。）

## 6. 最近一次全仓门禁矩阵（2026-08-14 走读实测）

edge unittest 852 / pytest 163+10skip / server jest 1362 / client jest 879 / type:check /
feishu 63/63 / audit-openapi-routes 323 controllers 0 drift / truth 族全 PASS。
本回合复测：pytest 169 passed+10 skipped；truth-feature-status 31/31。
