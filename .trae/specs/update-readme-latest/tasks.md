# Tasks — README 更新到最新

> 目标：把 `README.md`（产品手册）同步到 `main` 分支最新交付，保证文档与实现一致，且不破坏仓库事实源审计门禁。仅改文档，不触碰源码。

- [ ] Task 1: 核对现状与差异清单
  - [ ] 1.1 用 `node scripts/audit-repo-facts.js` 跑一次，确认 README 当前被哪些门禁校验（导航/文件/版本等）。
  - [ ] 1.2 核对 `openapi/route-manifest.json` 的 `controllerKeys.length`（当前 304）与 README 中「301 条路径」的差异。
  - [ ] 1.3 遍历 route-manifest 的 scheduler/operations/timeline 端点，与 README 5.2 速查对比，列出缺失/过时端点。
  - 验证：得到一份明确的差异清单。

- [ ] Task 2: 更新仓库目录导航与运行时构成
  - [ ] 2.1 核对 README「仓库目录导航」表与仓库实际目录/文件（`ewoh-spark-app`、`openapi/`、`db/`、`catalog/`、`delivery/`、`release/` 等）是否仍准确。
  - [ ] 2.2 更新「运行时构成」代码块，反映最新模块（调度驾驶舱、Operations/Workbench、Timeline）。
  - 验证：目录条目与仓库实际一一对应。

- [ ] Task 3: 更新核心能力表
  - [ ] 3.1 在「智能调度（Scheduler V2）」行补充 Command Map 智能调度驾驶舱、统一 Resource State、人工覆盖/约束生命周期、策略版本化与影子评估、调度反馈 KPI。
  - [ ] 3.2 补充「调度与求解器（当前事实）」：heuristic=canonical、CP-SAT OPTIONAL/EXPERIMENTAL + parity/fidelity 现状、`solverStatus` 六态。
  - 验证：描述与 `.trae/specs/cmd-map-scheduling-cockpit`、`cmd-map-scheduling-closed-loop`、`cpsat-parity-fidelity` 一致。

- [ ] Task 4: 更新 API 接口文档
  - [ ] 4.1 将 OpenAPI 路径数由 301 改为 304（与 route-manifest 一致）。
  - [ ] 4.2 在 5.2 NestJS 云侧速查补充调度驾驶舱端点：runs / active-plans / snapshot / conflicts / overrides / policy versions / candidates / metrics+feedback / routes / constraints。
  - 验证：端点与 route-manifest.json 中 scheduler 条目一致，无虚构。

- [ ] Task 5: 更新版本更新日志
  - [ ] 5.1 在「八、版本更新日志」追加 `Unreleased` 关键条目：Command Map 智能调度驾驶舱、调度闭环、CP-SAT parity、RoleWorkbench 生产化、代码深化与 UX 闭环。
  - [ ] 5.2 确认与 `CHANGELOG.md` 的 [Unreleased] 主线一致，不重复罗列全部细节。
  - 验证：与 CHANGELOG 语义一致。

- [ ] Task 6: 校验门禁
  - [ ] 6.1 重跑 `node scripts/audit-repo-facts.js`，确保 README 相关门禁全绿。
  - [ ] 6.2 若该脚本校验 README 中的版本/路径/文件存在性，修正任何不一致。
  - 验证：audit-repo-facts 通过。
  - [ ] 6.3 提交并推送 `main` 分支（项目约定：完成后直接提交推送，不留在旁支）。

# Task Dependencies
- [Task 1] 无依赖（最先）。
- [Task 2] 依赖 [Task 1]。
- [Task 3] 依赖 [Task 1]。
- [Task 4] 依赖 [Task 1]。
- [Task 5] 依赖 [Task 1]。
- [Task 6] 依赖 [Task 2]-[Task 5]。