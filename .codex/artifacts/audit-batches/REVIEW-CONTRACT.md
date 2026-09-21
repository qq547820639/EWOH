# Full-file review contract

For every input row, read the complete current file at the repository root. Do not mark a file reviewed from filename, tests, search output, or a partial read. Preserve all input fields. Change only review metadata and finding/understanding fields. Do not modify product source, tests, docs, or the authoritative ledger. Each output row must include `reviewed: true`, `reviewed_sha256` equal to the input/content hash, `reviewed_ranges: [[1,line_count]]`, `reviewed_at`, and `reviewed_by`.

Write only `.codex/artifacts/audit-batches/outputs/reviewed-<batch>.jsonl`, one JSON object per line. Include actual entry points, imports/exports, read/write effects, database tables, consumed/emitted events, contracts, security/tenant boundaries, failure paths, associated tests, and findings. Use `[]` when absent. A finding must name path/lines, severity P0-P3, evidence, and concrete impact/fix. Generated files, vendored UI primitives, fixtures, and lock-free generated contracts may have concise semantic descriptions, but still require complete reads.

Process files in manageable groups, append completed output incrementally, and report only file/line counts, P0/P1 findings, and blockers.
