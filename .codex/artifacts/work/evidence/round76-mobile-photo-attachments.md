# Round 76 - 2026-08-04 Mobile Exception Photo Attachments

Branch: `codex/ewoh-iteration-2026-08-04`

## Changes

- Added `client/src/api/files.ts` with an `uploadFile` helper for
  `POST /api/files` multipart uploads.
- Added `FileRecord` to the shared API contract.
- Mobile exception form now accepts JPG/PNG/WebP photos; the selected file is
  uploaded before the pause/exception transition and its id/filename/content
  type are stored in `resultJson.exception.attachments`.
- Photo upload requires online connectivity; text-only exceptions still use
  the offline pending queue.

## Real command evidence

- `npm run type:check`: server + client exit 0.
- `npm run lint`: eslint + stylelint + typecheck exit 0.
- `npm run test:client`: `11 passed, 11 total` suites; `37 passed` tests.
- Server Jest remains `76 suites / 359 tests` (no server changes this round).

## Remaining next steps

- Offline photo blob queue and PWA installability.
- HTTP+PostgreSQL E2E already passes locally (29/29).
- Second/third factory replication drills and partner shadow delivery.
