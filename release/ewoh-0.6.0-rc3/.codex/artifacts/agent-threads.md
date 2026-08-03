# EWOH Agent Threads

Updated: 2026-08-03

| Agent ID | Nickname | Role | State | Output contract |
|----------|----------|------|-------|-----------------|
| `019fc44e-59bc-7ab2-8f31-17332c6f33aa` | Schrodinger | Persistence/tenancy reviewer | Done | `work/reviews/persistence-tenancy-2026-08-03.md` |
| `019fc44e-5a15-7463-b37a-8a695ff24624` | Feynman | Security reviewer | Done | `work/reviews/security-review-2026-08-03.md` |
| `019fc44e-5a75-7422-9646-7dff32f447a6` | Halley | Frontend/scenario reviewer | Done | `work/reviews/frontend-scenario-2026-08-03.md` |
| `019fc458-4923-75a0-b6b0-78d91078d143` | Hume | Security hardening worker | Done | WP-HARDEN-001 H-01 |
| `019fc458-4a6a-7662-a587-1fc4b6e9b5e1` | Boyle | Runtime/state worker | Done | WP-HARDEN-001 H-02 |
| `019fc458-4b1e-7db3-84cb-9191536d6d35` | McClintock | Domain persistence worker | Done | WP-HARDEN-001 H-03 |
| `019fc458-4c78-7251-9935-6dce94b4309b` | Chandrasekhar | Frontend worker | Done | WP-HARDEN-001 H-04 |
| `019fc469-8065-7932-924d-0ee9e819096f` | Aquinas | E2E integration worker | Done | `test/e2e/**`; 9/9 pass |
| `019fc474-871b-7af0-8d43-0b37b35fa377` | Anscombe | API contract worker | Done | `openapi/ewoh.yaml` 106 ops; C2 v1.0 frozen |
| `019fc47a-d802-74c0-a4cf-86dd5035df5f` | Lovelace | Approval persistence worker | Done | approval event/chain/audit mapping; E2E 10/10 |
| `019fc484-4451-7382-8391-aa5b82aebab5` | Mendel | Contract freeze worker | Done | C3-C6 frozen; requirements trace v1.0; access-matrix synced |
| `019fc43c-5f8a-7c43-97fb-554ff5cc565e` | Banach | Independent security reviewer | Errored | Provider quota; no report produced |
| `019fc43c-601a-7762-938c-1abd9fa94c0b` | Anscombe | Persistence/tenancy explorer | Errored | Provider quota; no report produced |
| `019fc43c-6072-7f73-b11e-abdcbe3da553` | Socrates | Frontend/scenario explorer | Errored | Provider quota; no report produced |

The principal continued these audits locally because the external agent provider
had insufficient quota. This is not a delivery blocker for the current phase.

Completed agents from earlier waves remain recorded in `state.json`. Active
threads must be closed after their reports are integrated.
