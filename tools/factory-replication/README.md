# EWOH Factory Replication Acceptance

Evaluates second/third factory replication reports against the Final 5/6
acceptance rules: no core fork, profile replay, at least 80% config+asset
satisfaction, custom work under 20%, and resolved factory differences.

```bash
node tools/factory-replication/index.js --report tools/factory-replication/fixtures/passing.json --strict
```

Real factory acceptance requires a report produced by VAL-62 from actual
site evidence; the fixture is a contract example, not site evidence.
