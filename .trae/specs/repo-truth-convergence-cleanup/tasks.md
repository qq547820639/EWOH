# Tasks

- [x] Task 1: 治理事实源收敛到 rc4：更新 `.codex/artifacts/state.json` 的 `trace_id`/`current_status`，将权威状态从 2026-08-04 推进到当前 0.6.0-rc4（Phase 0 / Replan V2 / close-head-truth-ux-gaps 已交付）。
  - [x] 1.1 更新 `state.json` 的 `trace_id` 为当前收敛 trace。
  - [x] 1.2 更新 `state.json` 的 `current_status` 为 rc4 现状一句话。
- [x] Task 2: 更新 `.codex/artifacts/phase-state.md` 与 `understanding.md` 的 `Updated` 时间，并注明 `.codex/artifacts` 已被 `.trae/specs` + `feature-status.yaml` + `CHANGELOG.md` 取代为权威运行时事实源。
- [x] Task 3: 删除冗余构建制品 `.trae-html-share-packages/`（20 个 git 跟踪 zip，零引用）。
- [x] Task 4: 为 `.trae/documents/command-map-assessment-6.md` 与 `command-map-rectification.md` 补「已落地」声明。
- [x] Task 5: 验证：`node scripts/truth-feature-status.js` 31/31、`cd ewoh-spark-app && npx tsc -b --force` 0 错误、确认 `.trae-html-share-packages` 移除后无引用报错。

# Task Dependencies

- Task 5 依赖 Task 1-4 全部完成。
- Task 1-4 相互独立，可并行。
