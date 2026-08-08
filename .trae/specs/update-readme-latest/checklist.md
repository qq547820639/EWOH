# 校验清单 — README 更新到最新

- [ ] README「仓库目录导航」与「运行时构成」反映最新模块，条目与仓库实际一一对应
- [ ] README「核心能力」表补充 Command Map 智能调度驾驶舱、统一 Resource State、人工覆盖/约束生命周期、策略版本化与影子评估、调度反馈 KPI
- [ ] README「调度与求解器（当前事实）」如实标注 heuristic=canonical、CP-SAT OPTIONAL/EXPERIMENTAL + parity/fidelity 现状、solverStatus 六态
- [ ] README API 章节 OpenAPI 路径数改为 304（等于 route-manifest controllerKeys.length）
- [ ] README 5.2 NestJS 云侧速查补充调度驾驶舱端点（runs/active-plans/snapshot/conflicts/overrides/policy versions/candidates/metrics+feedback/routes/constraints），与 route-manifest 一致
- [ ] README「版本更新日志」追加 Unreleased 关键条目，与 CHANGELOG.md 一致
- [ ] `node scripts/audit-repo-facts.js` 门禁全绿，无因 README 改动引入的失败
- [ ] 改动仅涉及 README.md，不触碰其他源码
- [ ] 已提交并推送至 `main` 分支