# WP-FRONTEND-SHELL-001 Frontend Shell and API Namespaces

- package_id: WP-FRONTEND-SHELL-001 v1.0
- owner_agent: AG-30
- validator_agents: AG-42, AG-44
- status: Proposed

## Goal

Turn the current 5-route shell into the 11 capability-center shell:

- Routes: /command-center, /digital-world, /scheduling, /ai-decision,
  /devices, /personnel, /alerts, /organization, /model-management,
  /data-assets, /system.
- Layout grouped by situation/management/decision/infrastructure layers with
  role filtering.
- API namespaces and stable query keys for organization, workstation, task,
  resource, control, eventRule, model, knowledge, notification, system.
- Shared loading/empty/error/permission-denied/stale-data states.

## Allowed Paths

- `ewoh-spark-app/client/src/app.tsx`
- `ewoh-spark-app/client/src/components/Layout.tsx`
- `ewoh-spark-app/client/src/api/**`
- `ewoh-spark-app/client/src/hooks/**`
- `ewoh-spark-app/client/src/components/ui/**` (only if needed)

## Forbidden Paths

- `ewoh-spark-app/client/src/pages/CommandMap/**` (owned by AG-31)
- `openapi/**`

## Acceptance

- `npm run type:check:client` passes.
- All 11 routes render placeholder pages with required UI states.
- Query keys invalidate on org switch.
