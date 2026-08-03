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
