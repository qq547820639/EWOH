# Round 25 Evidence - Policy Engine

Date: 2026-08-03
Scope: Final 5.0 Y1-06 policy/rule/config center kernel.

## Implemented

- Added `contracts/policy/policy-schema.json` (`ewoh:///policy/v1`) requiring
  `policyId`, `version`, `effect`, and non-empty `rules`; operators include
  `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, and `exists`.
- Added canonical `operator-safety.yaml` example with a deny effect for high
  risk dispatch without approval.
- `POST /api/policies/evaluate` validates the policy against the schema and
  evaluates dot-path rules against a context; `GET /api/policies/examples`
  serves the canonical example.
- Added `scripts/audit-policy-contracts.js` (7 checks), `npm run contract:policy`,
  and unit/contract tests.
- E2E evaluates the canonical policy against risky (deny) and safe (allow)
  contexts over HTTP.

## Verification

```text
Policy contract audit: schema ewoh:///policy/v1 | deny-dispatch-high-risk 1.0.0 | 2 rules | 7 checks passed
OpenAPI strict audit: 163/163
HTTP + PostgreSQL E2E: 21/21 passed including policy evaluation
```
