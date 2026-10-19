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
