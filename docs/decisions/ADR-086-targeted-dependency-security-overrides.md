# ADR-086: Targeted Dependency Security Overrides

## Status

Accepted (2026-09-20)

## Context

The npm production audit reported high-severity advisories in transitive
versions of `js-yaml`, `multer`, `fast-uri`, `@tiptap/core`, and an old
`nanoid` branch. The application is pinned to the Lark/Nest platform (NestJS
10) and has both npm and pnpm lockfiles used by different verification paths.

## Decision

Use the latest same-major patched releases through explicit npm `overrides`
and pnpm `overrides`:

- `js-yaml` 4.3.2
- `multer` 2.4.0
- `fast-uri` 3.1.8
- `@tiptap/core` and `@tiptap/pm` 3.31.3
- `nanoid@3` 3.3.19

Also pin `prosemirror-view` 1.42.4 once so Tiptap core and editor extensions
resolve the same ProseMirror view type.

## Alternatives

- Upgrade the whole Lark/Nest stack to NestJS 12: it addresses some transitive
  packages but is a breaking platform migration and exceeds this security
  repair's blast radius.
- Ignore high advisories because the framework is vendor-pinned: this conflicts
  with the product security gate and does not distinguish vendor constraints
  from fixable transitive dependencies.

## Consequences

The production `npm audit --omit=dev --audit-level=high` gate exits 0. Full
development dependencies have no high advisories; remaining moderate findings
remain visible in `output/npm-audit-production.json` and
`output/npm-audit-full.json`. The npm and pnpm lockfiles must be regenerated
together when overrides change. `pnpm-lock.yaml` is now versioned because CI
runs a frozen pnpm install; ignoring it made that path irreproducible.
