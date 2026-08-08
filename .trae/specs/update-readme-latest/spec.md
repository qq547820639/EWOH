# README 更新到最新 Spec

## Why
`README.md`（产品手册）仍停留在 `0.6.0-rc4` 早期现状，与 `main` 分支最新交付脱节：OpenAPI 路由数已从 301 增至 304，调度域新增了 Command Map 智能调度驾驶舱（candidates / runs / active-plans / conflicts / overrides / policy 版本化 / snapshot / metrics+feedback）、CP-SAT 与启发式求解器 parity/fidelity、PriorityEngine ProductionImpact 等能力，但 README 的目录导航、核心能力、调度事实、API 速查、版本日志均未同步。

## What Changes
- 更新 **仓库目录导航** 与 **运行时构成**：反映最新模块（调度驾驶舱、Operations/Workbench、Timeline 等）。
- 更新 **核心能力** 表：补充 Command Map 智能调度驾驶舱、统一 Resource State、人工覆盖/约束生命周期、策略版本化与影子评估、调度反馈 KPI。
- 更新 **调度与求解器（当前事实）**：明确 heuristic 为 canonical、CP-SAT 保持 OPTIONAL/EXPERIMENTAL，但补齐 CP-SAT 数据保真 + 约束透传 + 统一 PriorityEngine 的 parity 现状；`solverStatus` 可见（OPTIMAL/FEASIBLE/HEURISTIC/FALLBACK/TIMEOUT/UNAVAILABLE）。
- 更新 **配置参数**：如有新增环境变量（CPSAT_WORKER_URL 等）核对并修正。
- 更新 **API 接口文档**：OpenAPI 路径数 301→304；NestJS 云侧速查补充调度驾驶舱端点（runs/active-plans/snapshot/conflicts/overrides/policy versions/candidates/metrics+feedback/routes/constraints）。
- 更新 **版本更新日志**：追加 `Unreleased` 关键条目（Command Map 智能调度驾驶舱、调度闭环、CP-SAT parity、RoleWorkbench 生产化、代码深化与 UX 闭环）。
- 保持文档准确、不虚构：只描述已实现能力；未启用（CP-SAT 生产未启用）如实标注。

## Impact
- Affected specs: 产品手册 / 文档事实源（仓库事实源审计 `scripts/audit-repo-facts.js` 会校验 README 导航等）。
- Affected code: 仅 `README.md`（不触碰其他源码）。
- 注意：`scripts/audit-repo-facts.js` 可能校验 README 中的目录/文件/门禁描述，改动后需跑该审计确保不破坏门禁。

## ADDED Requirements

### Requirement: 文档与最新交付一致
README SHALL 反映 `main` 分支当前实现：OpenAPI 路由数 304、调度驾驶舱端点、调度 parity 现状、版本日志 Unreleased 条目。

#### Scenario: 路由数一致
- **WHEN** 读取 README 的 API 章节
- **THEN** 其 OpenAPI 路径数等于 `openapi/route-manifest.json` 的 `controllerKeys.length`（当前 304）。

#### Scenario: 调度事实准确
- **WHEN** 读取「调度与求解器」章节
- **THEN** heuristic 标注为 canonical、CP-SAT 标注为 OPTIONAL/EXPERIMENTAL 且如实说明 parity/fidelity 现状，不虚构生产启用。

## MODIFIED Requirements

### Requirement: 核心能力与目录导航
README 的「仓库目录导航」与「核心能力」表 SHALL 覆盖最新模块（调度驾驶舱、Operations/Workbench、Timeline、统一 Resource State）。

### Requirement: API 速查
README 的 NestJS 云侧 API 速查 SHALL 包含调度驾驶舱的实际端点（runs/active-plans/snapshot/conflicts/overrides/policy versions/candidates/metrics+feedback/routes/constraints），并保持与 route-manifest 一致。

### Requirement: 版本更新日志
README 的版本日志 SHALL 追加 `Unreleased` 关键条目，与 `CHANGELOG.md` 的 Unreleased 主线一致。

## REMOVED Requirements
无（仅更新文档，不删除既有能力）。