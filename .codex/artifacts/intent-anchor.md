# EWOH Intent Anchor

## Original Goal

Complete the EWOH Embodied Factory OS lifecycle implementation from the
current code baseline to a runnable, testable, deployable, verifiable product:
contracts frozen, DDL/migrations verified, NestJS backend, React frontend,
command map, multi-org security, tests, deployment/rollback, delivery, and
continued multi-phase capability.

## Success Standards

- C1-C6 shared contracts exist, versioned, and enforced.
- 36 new tables + 12 altered tables = 48 managed tables with org_id, RLS,
  audit chain, and concurrency-safe reservations.
- 8 end-to-end scenario packages pass with independent verification.
- Phase gates G0-G13 are evidenced, not asserted.
- No fabricated results: every claim maps to a command, report, or artifact.
- Deliverable is a standalone cloud-deployable HA/concurrency product, not a
  Miaoda-hosted demo; Miaoda remains demo-only fallback.

## Hard Constraints

- No automatic approval, dispatch, or scheduling.
- No real-time joint/safety control from the platform; control stays local.
- All final-user data access through NestJS API; no direct DB DML by users.
- source_type real/controlled_test/simulated isolation is not bypassed.
- Production DDL, deployment, credentials, and irreversible operations require
  explicit user approval.
- Existing user changes in the worktree are preserved.

## Source Refs

- `/Users/panhao/.codex/attachments/8f7c4e91-36c9-4318-a6b6-80ba15ad62d7/goal-objective.md`
- `/Users/panhao/Downloads/EWOH工厂具身智能操作系统_ChatGPT_Work多Agent执行编排方案.docx`
- `/Users/panhao/Downloads/EWOH工厂具身智能操作系统_最终产品实施方案.docx`
- `/Volumes/Extra/CodeProj/EWOH/delivery/02_技术规范/architecture.md`
- `/Volumes/Extra/CodeProj/EWOH/delivery/02_技术规范/database.sql`
- `/Volumes/Extra/CodeProj/EWOH/docs/architecture/embodied_factory.md`
