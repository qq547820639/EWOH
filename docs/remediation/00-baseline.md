# EWOH Remediation Program

## Program Scope

Production-hardening of the EWOH repository based on the full-repo audit
(`docs/audit/2026-08-08-full-repo-audit.md`).

Audit Base Commit: `ba7db6b81ede44238905ed2796b9dd7c4b6ba2db`
Remediation Start HEAD: `ba7db6b81ede44238905ed2796b9dd7c4b6ba2db` (unchanged)
Branch: `main`

## Finding Status Vocabulary

| Status | Meaning |
| ------ | ------- |
| OPEN | Confirmed against current HEAD, not yet addressed |
| IN_PROGRESS | Fix or regression test in flight |
| FIXED | Implementation + regression test committed |
| VERIFIED | Verified via commands/tests listed in the entry |
| DEFERRED | Deliberately not fixed in this round, reasons documented |
| NOT_REPRODUCIBLE | Audit finding could not be reproduced on current HEAD |

## Finding Index

| ID | Severity | Title | Status |
| -- | -------- | ----- | ------ |
| P0-EDGE-001 | P0 | Production runtime assembly broken (top-level imports + missing modules) | OPEN |
| P0-EDGE-002 | P0 | Production silently falls back to Stub on ImportError | OPEN |
| P0-EDGE-003 | P0 | MessageBus subscribe contract divergence (stub queue vs handler) | OPEN |
| P0-EDGE-004 | P0 | Bare-string stream/topic names; `inference` stream undefined | OPEN |
| P0-EDGE-005 | P0 | Bus subscriber exceptions swallowed silently | OPEN |
| P0-EDGE-006 | P0 | No production assembly smoke test (tests pass while runtime is stub) | OPEN |
| P0-SEC-001 | P0 | Feishu webhook missing signature/timestamp/replay protection | OPEN |
| P0-SEC-002 | P0 | Feishu simulator enabled by default | OPEN |
| P0-SEC-003 | P0 | Feishu CORS wide open (`app.use(cors())`) | OPEN |
| P0-SCHED-001 | P0 | CP-SAT availability & solver metadata reporting | OPEN |
| P0-SCHED-002 | P0 | CP-SAT DecisionTrace placeholder data (score=0, factors=[], candidates=[]) | OPEN |
| P1-SCHED-003 | P1 | Scheduling policy magic numbers not centralized/versioned consistently | OPEN |
| P1-SCHED-004 | P1 | Duplicated default duration (solver 30min vs dispatch 1h) | OPEN |
| P1-ROUTE-001 | P1 | Euclidean fallback ETA = 0 | OPEN |
| P1-ROUTE-002 | P1 | Route cost source of truth scattered | OPEN |
| P1-WORLD-001 | P1 | Current world state loads full history into Node | OPEN |
| P1-INGEST-001 | P1 | Batch ingest serial per-frame DB round trips | OPEN |
| P1-CMAP-001 | P1 | CommandMap legacy/gamification scheduler write paths | OPEN |
| P1-CMAP-002 | P1 | ResourcePool does not read ResourceProjection | OPEN |
| P1-CMAP-003 | P1 | World state polling vs scheduler SSE duality | OPEN |
| P2-SHARED-001 | P2 | Shared types monolith (2045 LOC) | OPEN |
| P2-WORK-001 | P2 | WorkOrchestrationService multi-responsibility | OPEN |
