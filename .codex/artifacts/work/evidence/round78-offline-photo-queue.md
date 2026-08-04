---
workItemIds: [T-771, T-772, T-773, T-774, T-775, T-776, T-777, T-778, T-779, T-780]
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 78 - 2026-08-04 Offline Photo Queue

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- `PendingMobileAction` now carries an optional `attachment` (name, content
  type, data URL) so offline exception photos persist with the queue.
- `client/src/lib/attachmentDataUrl.ts` converts `File` to data URL and back,
  with unit coverage for base64 round-trip and `File` restoration.
- Offline exception flow stores the photo in the pending queue (up to ~2MB)
  instead of rejecting it; on reconnect the flush effect uploads the photo
  through `/api/files` and attaches the returned reference before submitting
  the pause/exception transition.
- Online photo upload path is unchanged.

## Real command evidence

- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- `npm run test:client`: `12 passed, 12 total` suites; `39 passed` tests.
- Server Jest remains `76 suites / 359 tests` (no server changes this round).

## Remaining next steps

- Photo compression UX for files above ~2MB.
- Second/third factory replication drills and partner shadow delivery.
- Production DDL/deploy and live GitHub issue/PR creation remain approval-gated.
