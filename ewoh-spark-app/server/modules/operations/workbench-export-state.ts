/**
 * Async workbench export task state machine.
 *
 * States:
 *   queued → running → succeeded
 *   queued → failed
 *   queued → cancelling → cancelled
 *   queued → cancelling → failed        (cancel could not be honoured)
 *   running → succeeded
 *   running → failed
 *   running → cancelling → cancelled
 *   running → cancelling → failed
 *   queued | running | failed → expired (deadline passed)
 *   failed → running                    (retry/requeue)
 *
 * Pure / side-effect free so it can be unit-tested in isolation and reused by
 * both the in-memory and the PostgreSQL-backed stores.
 */

export type WorkbenchExportStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'expired';

export const TERMINAL_EXPORT_STATUSES: ReadonlySet<WorkbenchExportStatus> =
  new Set(['succeeded', 'failed', 'cancelled', 'expired']);

const ALLOWED_TRANSITIONS: Record<
  WorkbenchExportStatus,
  ReadonlySet<WorkbenchExportStatus>
> = {
  queued: new Set(['running', 'failed', 'cancelling', 'cancelled', 'expired']),
  running: new Set(['succeeded', 'failed', 'cancelling', 'expired']),
  cancelling: new Set(['cancelled', 'failed', 'expired']),
  succeeded: new Set(),
  failed: new Set(['running', 'expired']),
  cancelled: new Set(),
  expired: new Set(['running']),
};

export function canTransition(
  from: WorkbenchExportStatus,
  to: WorkbenchExportStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(
  from: WorkbenchExportStatus,
  to: WorkbenchExportStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid workbench export transition: ${from} → ${to}`,
    );
  }
}

export function isTerminal(status: WorkbenchExportStatus): boolean {
  return TERMINAL_EXPORT_STATUSES.has(status);
}