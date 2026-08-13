# [repo-truth-convergence-cleanup] 仓库事实源收敛与冗余清理 Spec

## Why

基于最新 HEAD（`98bfa2f`，分支 `main`，版本 `0.6.0-rc4`）的全仓走读确认：调度域、边缘、飞书侧的工程质量已很高（`truth-feature-status` 31/31、`tsc -b --force` 0 错误、OpenAPI 零漂移）。但治理事实源与真实代码存在约 10 天漂移，且有纯构建产物被误入库。本规格一次性收敛这些矛盾，使「事实源/制品」与「真实代码」重新对齐，不改动任何冻结契约与运行时行为。

## What Changes

- **治理事实源收敛（消除假阴性/漂移）**
  - 将 `.codex/artifacts/state.json` 的 `trace_id` / `current_status` 推进到当前 rc4 状态（Phase 0 正确性基线、Replan V2、close-head-truth-ux-gaps 已交付）。
  - 更新 `.codex/artifacts/phase-state.md`、`.codex/artifacts/understanding.md` 的 `Updated` 时间，并显式声明 `.codex/artifacts` 已被 `.trae/specs` + `feature-status.yaml` + `CHANGELOG.md` 取代为权威运行时事实源。
- **冗余构建制品清理**
  - 删除 `.trae-html-share-packages/`（20 个 git 跟踪的 HTML-share 构建 zip，全仓源码/CI/脚本零引用，属纯构建产物，由「仓库代码审查」commit 误带入）。
- **中间评估笔记收敛**
  - 为 `.trae/documents/command-map-assessment-6.md`、`command-map-rectification.md` 补一行「已落地」声明，标明其 P0/P1 项已在当前 HEAD 修复（避免后续被当作未完成项重复处理）。

## Impact

- 影响规格：权威事实源（`.codex/artifacts` 治理层）。
- 影响代码：无运行时代码、无 OpenAPI、无状态机、无 DB 迁移；仅治理文档与冗余制品。
- 影响契约：无（不修改任何冻结契约语义）。

## 边界（不可违反）

1. 不改动任何运行时源码、OpenAPI 契约、状态机、DB 迁移 SQL 的语义。
2. 不伪造外部环境依赖项（OIDC/真机/生产上线等仍如实标 `Blocked by External Validation`）。
3. 不扩围业务（不新增财务/ERP 总账等）。
4. 删除 `.trae-html-share-packages/` 前确认全仓无源码/CI/脚本引用（已 Grep 验证为零）。
5. 所有改动需通过 `truth-feature-status.js`、`tsc -b --force`，且不引入新的 OpenAPI 漂移。

## ADDED Requirements

### Requirement: 治理事实源与当前代码对齐
系统 SHALL 将 `.codex/artifacts` 的权威状态指针推进到当前 `0.6.0-rc4` 状态，并显式标注该目录已被 `.trae/specs` + `feature-status.yaml` + `CHANGELOG.md` 取代。

#### Scenario: 消除事实源漂移
- **WHEN** 走读发现 `state.json` trace 停留在 `2026-08-04` 而代码已到 rc4（Phase 0/Replan V2/close-head-truth-ux-gaps 已交付）
- **THEN** `state.json` 的 `trace_id`/`current_status` 反映 rc4 现状，`phase-state.md`/`understanding.md` 更新 `Updated` 并注明新权威来源。

### Requirement: 冗余构建制品清理
系统 SHALL 删除无任何源码/CI/脚本引用的纯构建产物 `.trae-html-share-packages/`。

#### Scenario: 误入库构建产物清理
- **WHEN** `git ls-files` 显示 `.trae-html-share-packages/` 含 20 个 HTML-share zip 且全仓 Grep 引用为零
- **THEN** 该目录从版本库移除，且不破坏构建/测试/门禁。

### Requirement: 中间评估笔记落地收敛
系统 SHALL 为已落地的中间评估笔记补「已落地」声明，避免其声明的 P0/P1 项被当作未完成重复处理。

#### Scenario: 消除假阴性评估项
- **WHEN** `command-map-assessment-6.md` 声称 `gamification.service.ts` 存在 `workstationIds` 重复声明（TS2451）编译阻塞，而当前代码已消除
- **THEN** 在文档标注该 P0 已修复落地。

## MODIFIED Requirements

### Requirement: 上一轮 close-head-truth-ux-gaps 成果（保持）
`feature-status.yaml` 的 `decisionCockpit` 假阴性修正、失效证据清理、`managed_count` 73→57 口径对齐、孤儿页清理等成果保持有效，本规格不重复处理，仅补齐 `.codex/artifacts` 治理层与冗余制品。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。
