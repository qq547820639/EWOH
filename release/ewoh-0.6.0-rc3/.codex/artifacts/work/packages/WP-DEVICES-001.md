# WP-DEVICES-001 Device 19-Dimension Search and Binding

- package_id: WP-DEVICES-001 v1.0
- owner_agent: AG-13
- validator_agents: AG-42, AG-43
- status: Proposed

## Goal

Extend device search to the authoritative 19 dimensions and 12 config classes
once DDL fields (lifecycle_status, runtime_status, health_status,
device_category, maintenance fields) and `ewoh_device_capability` are in the
live schema.

## Inputs

- `contracts/ui-contract.md` device center
- `db/contracts/schema-manifest.yaml` device tables

## Acceptance

- GET /api/devices accepts all 19 filter dimensions with pagination.
- Config drawer renders 12 accordion classes with credential masking.
- Binding uniqueness and exo exclusivity tests pass.
