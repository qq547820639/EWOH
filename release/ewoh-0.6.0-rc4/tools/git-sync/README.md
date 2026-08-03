# EWOH Git Sync

Offline-first mapping between `.codex/artifacts` work items and GitHub issue/PR
tracking records. The registry file `.codex/artifacts/work/git-sync.json` is
authoritative for offline mode; repository files remain the source of truth.

```bash
node tools/git-sync/index.js --root . --output output/git-sync.json
```

Live GitHub creation is intentionally disabled by default. It requires
`EWOH_GIT_SYNC_ENABLED=true`, `GITHUB_TOKEN`, `EWOH_GIT_SYNC_APPROVED=true`,
and the explicit `--apply` flag, and should only be used after human approval.
