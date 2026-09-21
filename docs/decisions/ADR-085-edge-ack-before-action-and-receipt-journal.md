# ADR-085: Edge Ack-Before-Action and Durable Receipt Journal

## Status

Accepted (2026-09-20)

## Context

The edge control agent used to call the actuator before the platform accepted
the gateway ack. If the platform revoked authorization during the delivery
window, the device could already have acted and the edge could only report that
the command had been rejected. Separately, failed execution receipts lived only
in a bounded in-memory deque, so an edge restart could lose the fact that a
physical action had completed.

## Decision

1. The edge performs authorization, fingerprint, scope and request checks as
   before, then asks the platform to accept the gateway ack. The actuator is
   called only after HTTP 200/201. HTTP 409 remains a fail-closed rejection, and
   an unresolved transport result also leaves the device untouched.
2. After the authorized action, execution success/failure is still reported
   separately. The platform keeps `gateway_ack` and `command_receipt` as
   distinct result records.
3. Failed receipts are appended to an atomic JSON Lines journal. A restart
   reloads the journal and replays the original `commandId`; successful replays
   rewrite the file atomically. The in-memory queue remains bounded, and
   overflow is moved to a durable dead-letter JSON Lines file with an explicit
   counter rather than being discarded.

## Alternatives

- Keep action-before-ack and compensate after rejection: rejected hardware work
  cannot generally be undone, so this failed the execution-boundary requirement.
- Detect unauthorized execution and alarm: the existing platform already does
  this as a defensive audit, but detection is not authorization and must not be
  the primary gate.
- Persist only completed receipts: an action can also complete before its
  receipt is sent, so persistence must cover the receipt after the fact rather
  than reintroduce a lossy in-memory queue.

## Consequences

An unresolved ack can delay an otherwise valid command until the edge retries,
which is intentional for physical actions. Operators configure the journal with
`--receipt-journal` (or `EWOH_CONTROL_RECEIPT_JOURNAL`) for restart-safe
feedback. The journal preserves at-least-once receipt delivery; the platform
already idempotently handles repeated receipts.
