/**
 * T4.3: "Timeline serializer: stable event names for products/
 * back-office." These names are a public contract — SPEC.md lists
 * `started, authentication_required, authorized, pending, captured,
 * declined(code), refund_pending, refunded, settled, dispute_opened,
 * dispute_closed(outcome)` explicitly. `voided` is one genuine addition
 * beyond that list: a payment that was authorized and deliberately
 * canceled before capture is a materially different outcome for a
 * product to show a customer than "declined," and collapsing the two
 * would hide real information — flagged here rather than silently
 * folded into `declined`.
 *
 * `late_event` and `invariant_violation` (src/domain/stateMachineDb.ts)
 * are deliberately EXCLUDED: they're operational signals (duplicate/
 * out-of-order webhooks, a rejected transition), not a state a
 * product's own timeline (or an outbound webhook, Milestone 8's T8.4)
 * should surface. They remain in `payment_events` for ops/debugging.
 *
 * Lives in `src/domain/`, not `src/api/`, specifically so
 * `src/domain/stateMachineDb.ts` (T8.4: deciding which state
 * transitions to enqueue as outbound webhooks) can depend on it
 * without an inverted domain -> api import — `src/api/timeline.ts`
 * (T4.3's own serializer) re-exports these for backward compatibility
 * with existing call sites/imports.
 */

export const TIMELINE_EVENT_NAMES = [
  'started',
  'authentication_required',
  'authorized',
  'pending',
  'captured',
  'declined',
  'voided',
  'refund_pending',
  'refunded',
  'settled',
  'dispute_opened',
  'dispute_closed',
] as const;
export type TimelineEventName = (typeof TIMELINE_EVENT_NAMES)[number];

export const STABLE_NAME_BY_EVENT_TYPE: Partial<Record<string, TimelineEventName>> = {
  authorization_started: 'started',
  authentication_required: 'authentication_required',
  authentication_completed: 'pending',
  authorized: 'authorized',
  capture_started: 'pending',
  captured: 'captured',
  declined: 'declined',
  authorization_failed: 'declined',
  voided: 'voided',
  refund_started: 'refund_pending',
  refunded: 'refunded',
  settled: 'settled',
  dispute_opened: 'dispute_opened',
  dispute_won: 'dispute_closed',
  dispute_lost: 'dispute_closed',
};
