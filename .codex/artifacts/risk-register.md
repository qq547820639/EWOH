# EWOH Risk Register

Updated: 2026-08-04

| ID | Risk | Level | Current mitigation | Escalation |
|----|------|-------|--------------------|------------|
| R-001 | Dirty worktree contains extensive user and generated changes | High | Preserve all unrelated edits; use scoped patches and validation | Ask only if a direct conflict makes progress impossible |
| R-002 | Some domain services may be in-memory despite API-complete appearance | High | Active persistence audit; do not count module existence as scenario completion | Blocks G6/G8 where confirmed |
| R-003 | Unit-composed scenario tests may overstate real HTTP/database coverage | High | Active workflow audit; add true integration acceptance per selected scenario | Blocks G8 |
| R-004 | Container and Kubernetes artifacts cannot be built/applied locally | Medium | YAML parses; CI definition exists; report Docker/K8s checks as unexecuted | Blocks production G10 until external runner evidence exists |
| R-005 | Production migration/deployment is irreversible or externally visible | High | Keep approval gate; use local PostgreSQL only without explicit approval | User approval required |
| R-006 | Local standalone test service uses temporary JWT configuration | Low | Bind to loopback, use test-only DB, remove temporary acceptance identities | Do not treat as production deployment |
| R-007 | Control plane becomes a second fact source instead of rendering repository artifacts | High | Work Graph schema, indexer consistency CLI, source files remain authoritative; UI writes generate versioned records | Blocks G2 if drift detected |
| R-008 | Artifact drift between task board, gates, OpenAPI, and contracts | High | Path registry, generated `output/work-graph.json`, strict contract audits | Blocks G1/G2 |
| R-009 | Simulated factory replication presented as real replication | High | VAL-62 independent acceptance; only real factory evidence counts | Blocks G11/G13 |
| R-010 | ERP/order backlog expands EWOH into accounting or procurement settlement | Medium | Read-only projections, connectors, scenario packs; no financial ledger in EWOH | Blocks product scope |
| R-011 | Agent over-autonomy in gate approval or shared contract edits | High | Minimum permissions, `EWOH_WORK_WRITABLE` gate, human decisions separated for G10+ | Blocks G9 |
| R-012 | Evidence expires or becomes invalid after code changes | Medium | Evidence binds commit/environment/checksum; audits fail when required artifacts are missing | Blocks G8/G9 |
| R-013 | Manual validation paths still return single-message errors instead of `fieldErrors` | Medium | Global `APP_PIPE` maps class-validator errors to fieldErrors; manual controller checks remain to be converted incrementally | P0-5 follow-up |
| R-014 | Command-map person/device details lack organization, exoskeleton, risk, alerts, recent events, and disposition entry | High | EntityDetail shows only a subset; PersonnelInfo/DeviceInfo do not yet carry the required operational fields | Blocks AG-06 scenario D |
| R-015 | Mobile photo attachment upload and PWA installability still missing | Medium | Offline pending-action queue implemented and flushed on reconnect; photo attachments/PWA cache remain follow-ups | Partial AG-07 scenario C |
