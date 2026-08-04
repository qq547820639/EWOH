---
workItemIds: T-106
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm run test:e2e"
suite: http-e2e
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: d1206693a97f10fabbd2965756a32499ad88db2f646aca1ba82dbb3fcc19db47
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 22 Evidence - Upgrade Rings, Fleet Registry, Support Bundle

Date: 2026-08-03
Scope: Final 5.0 Y3-07/Y4-05/Y4-06.

## Implemented

- Added `contracts/state-machines/fleet.yaml` freezing the ring list
  (`dev/integration/shadow/pilot/small/full`) and profile status transitions
  (`installed/replayed/upgraded/rolled_back`).
- `POST /api/scale/fleet/upgrade` now accepts an optional `ring`; when set,
  only profiles whose `configJson.upgradeRing` matches are upgraded. Without a
  ring the operation remains all-fleet for backward compatibility.
- `POST /api/scale/fleet/rollback` now accepts an optional `ring` and rolls
  back only matching profiles.
- `GET /api/scale/fleet/status` returns the org fleet registry: profiles with
  ring and status, templates, asset package counts, status counts, and ring
  counts.
- `POST /api/scale/fleet/support-bundle` generates an audited, redacted
  diagnostic bundle with `includesSecrets: false`.
- Unit tests cover ring-filtered upgrade/rollback, fleet status, and support
  bundle redaction. E2E installs a shadow-ring profile, upgrades only that
  ring, rolls it back, reads fleet status, and generates a support bundle.

## Verification

```text
OpenAPI strict audit: 160/160
Scale unit tests: ring upgrade/rollback + fleet status/support bundle passed
HTTP + PostgreSQL E2E: 19/19 passed including ring staging and support bundle
```
