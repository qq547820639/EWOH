# EWOH Work Indexer

Reads `.codex/artifacts` and emits the canonical `ewoh:///work-graph/v1`
document used by the Work Orchestration Control Plane.

```bash
node tools/work-indexer/index.js --root . --output output/work-graph.json --strict
```

The CLI exits non-zero when required authoritative artifacts are missing.
The same module is loaded by the NestJS work orchestration API at runtime.
