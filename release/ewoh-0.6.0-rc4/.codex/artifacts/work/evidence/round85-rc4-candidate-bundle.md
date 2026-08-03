# Round 85 - 2026-08-04 EWOH 0.6.0-rc4 Candidate Bundle

Branch: `codex/ewoh-iteration-2026-08-04`

## Real command evidence

```text
EWOH_RELEASE_VERSION=0.6.0-rc4 bash scripts/package-release.sh

Release bundle: /Volumes/Extra/CodeProj/EWOH/release/ewoh-0.6.0-rc4
16M release/ewoh-0.6.0-rc4
1202 files (excluding SHA256SUMS.txt)
release/ewoh-0.6.0-rc4/SHA256SUMS.txt generated
scale-release-review PASSED
```

## Contents

- Standalone NestJS/React source, DB migrations/seeds/verify, deployment and
  Helm artifacts, contracts, OpenAPI, scripts, tools, catalog, Python edge
  platform, delivery docs, `.codex/artifacts`, and `output` evidence.
- Manifest updated to `release: 0.6.0-rc4`, status
  `candidate-for-production (approval-gated)`.

## Remaining next steps

- Authenticated browser flows still need a dedicated harness.
- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
