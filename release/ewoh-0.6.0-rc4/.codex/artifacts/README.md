# EWOH Principal Artifacts

Versioned, file-backed state for the EWOH implementation. Chat history is
ephemeral; these files are the single source of truth for orchestration state.

## Layout

- `intent-anchor.md` - immutable goal, success standards, hard constraints.
- `state.json` - minimal orchestration state object.
- `task-board.md` - task lifecycle and current wave.
- `agent-registry.md` - agent roles, ownership, and local runtime mapping.
- `decision-log.md` - decisions with rationale and reversibility.
- `gates.md` - G0-G13 gate status.
- `contracts/` - C1-C6 shared contracts (filled by contract agents).
- `inventory/` - current-code and document inventory reports.
- `work/` - task packages and integration records.

## Rules

1. Do not edit a file owned by another agent without a change request.
2. Every completed task updates `task-board.md`, `state.json`, and its
   evidence paths.
3. No task is Done without independent verification evidence.
