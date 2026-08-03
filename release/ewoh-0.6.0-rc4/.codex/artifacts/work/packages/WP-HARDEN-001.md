# WP-HARDEN-001 W5 Independent-Review Hardening Wave

- package_id: WP-HARDEN-001 v1.0
- owner_agents: AG-06/11/14/16/17/18/19/30/31/44
- validator_agents: AG-40/41/42/43/44
- status: In Progress
- date: 2026-08-03

## Source Findings

- `.codex/artifacts/work/reviews/security-review-2026-08-03.md`
- `.codex/artifacts/work/reviews/persistence-tenancy-2026-08-03.md`
- `.codex/artifacts/work/reviews/frontend-scenario-2026-08-03.md`

## Workstreams

| ID | Worker | Scope | Status |
|----|--------|-------|--------|
| H-01 | Hume (AG-06/11) | RBAC enforcement, refresh rotation/logout, rate-limit scoping, system config unique index, audit roles, k8s config | In Progress |
| H-02 | Boyle (AG-11/16/18/15) | Legacy auth fail-fast, simulator GUC context, conditional state transitions, audit coverage | In Progress |
| H-03 | McClintock (AG-17/19/14) | Control/resource/world-cursor persistence to existing tables; approval gap documented | In Progress |
| H-04 | Chandrasekhar (AG-30/31/44) | Event drill-down, real replay, role-gated nav, 401 refresh/logout, 3D mode/fallback | In Progress |

## Acceptance

- Security review majors resolved with unit tests.
- No background DB write without request-scoped GUC context.
- State transitions are conditional updates with 409 on conflict.
- Control/resource/world-cursor no longer rely solely on in-memory maps.
- Frontend majors resolved; typecheck and standalone client build pass.
- Full Jest, lint, typecheck, server/client build pass after integration.

## Evidence

- Worker final reports and changed-file lists.
- `npm test -- --runInBand`
- `npm run type:check`
- `npm run lint`
- `npm run build:prod:standalone`
