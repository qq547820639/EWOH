# EWOH Risk Register

Updated: 2026-08-03

| ID | Risk | Level | Current mitigation | Escalation |
|----|------|-------|--------------------|------------|
| R-001 | Dirty worktree contains extensive user and generated changes | High | Preserve all unrelated edits; use scoped patches and validation | Ask only if a direct conflict makes progress impossible |
| R-002 | Some domain services may be in-memory despite API-complete appearance | High | Active persistence audit; do not count module existence as scenario completion | Blocks G6/G8 where confirmed |
| R-003 | Unit-composed scenario tests may overstate real HTTP/database coverage | High | Active workflow audit; add true integration acceptance per selected scenario | Blocks G8 |
| R-004 | Container and Kubernetes artifacts cannot be built/applied locally | Medium | YAML parses; CI definition exists; report Docker/K8s checks as unexecuted | Blocks production G10 until external runner evidence exists |
| R-005 | Production migration/deployment is irreversible or externally visible | High | Keep approval gate; use local PostgreSQL only without explicit approval | User approval required |
| R-006 | Local standalone test service uses temporary JWT configuration | Low | Bind to loopback, use test-only DB, remove temporary acceptance identities | Do not treat as production deployment |
