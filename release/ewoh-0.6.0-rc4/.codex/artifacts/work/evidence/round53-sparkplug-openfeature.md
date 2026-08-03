# Round 53 Evidence - Sparkplug B Connector + OpenFeature Flag Evaluation

Date: 2026-08-03
Scope: Final 5.0 P1 standard protocol and feature flag capability: Eclipse
Sparkplug B connector support and OpenFeature-style org/ring/role flag
evaluation.

## Implemented

- `src/edge_platform/connectors/sparkplug.py`: Sparkplug B topic parser,
  minimal pure-Python protobuf payload decoder, canonical telemetry envelope,
  birth/death/session/sequence tracking, and a `BaseAdapter`-compatible edge
  adapter.
- `sparkplug-b-1.0.0.json` connector manifest with MQTT Sparkplug protocol,
  required broker/group/client config, output events, and compatibility range.
- Connector TCK now includes Sparkplug topic, payload codec, canonical
  envelope, and session-state checks (17/17 checks passed).
- `POST /api/system/feature-flags/evaluate`: evaluates requested flags against
  `{orgId, factoryId, upgradeRing, roles}` context with ring/role/org/factory
  targeting, safe-closed default, explicit reason, variant, and targeting
  applied marker.
- System page gains a feature-flag evaluator with keys, upgrade ring, factory
  ID, and roles inputs wired to the real API.

## Verification

```text
Python contract tests: 89 passed (was 82)
Python unittest: 667 passed
NestJS Jest: 65 suites / 292 tests passed
Client Jest: 6 suites / 22 tests passed
OpenAPI strict audit: 199 controller operations / 199 documented / 0 drift
HTTP + PostgreSQL E2E: 25/25 (includes flag targeting + safe-closed test)
Connector TCK: 17/17 checks passed
Standalone production build + scripts/standalone-check.sh: PASSED
```

The E2E case verifies a targeted flag is on for the matching org/factory/ring/
role context, off with `ring_mismatch` for a non-target ring, and hidden with
`flag_not_found` for another organization.
