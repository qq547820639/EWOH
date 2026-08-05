# EWOH Work Console

Reads the file-backed Work Graph produced by `tools/work-indexer` and answers
the control-plane questions in one command:

- 当前卡在哪里：状态为 `blocked` 或依赖被阻塞的节点。
- 为什么卡住：阻塞节点的依赖与状态。
- 谁能解除：阻塞节点与直接依赖节点的 Owner。
- 缺少什么证据：Done/Validation/Integrated/Review 节点中无证据或证据
  已过期/失效/未绑定。
- 哪些任务会受影响：从阻塞节点沿依赖边向下游传播的任务集合。

```bash
node tools/work-console/index.js --root /Volumes/Extra/CodeProj/EWOH \
  --output output/work-console.json --strict
```

`--strict` 在出现图不变量冲突或阻塞节点无 Owner 时返回非零。G10-G13 等待
人工批准不会导致门禁失败，人工批准状态由 `tools/gate-engine` 单独记录。

## 证据元数据审计（evidenceMeta）

生成的 `work-console.json` 顶部 `evidenceMeta` 字段统计顶层证据对象的元数据完整性，
覆盖 8 个字段：`commitSha` / `branch` / `buildVersion` / `envFingerprint` /
`dependencyVersion` / `testTime` / `verifier` / `expiresAt`。每个字段统计在所有证据中的
`present` / `missing`（空值）/ `unknown`（字面量 `"unknown"`）数量，`complete` 表示
全部证据的全部字段均非空。

- 2026-08-05 审计：`total=191`，8 个字段全部 `present=191 / missing=0 / unknown=0`，
  `complete=true`，无占位符、无未绑定证据，无需要补录的元数据缺口。
- `sourceRoot` 输出为仓库相对路径（如 `.codex/artifacts`），不再泄漏开发者机器绝对路径。
