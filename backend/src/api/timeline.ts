/**
 * T4.3: "Timeline serializer: stable event names for products/
 * back-office." The stable-name vocabulary itself
 * (`TIMELINE_EVENT_NAMES`/`STABLE_NAME_BY_EVENT_TYPE`) now lives in
 * `src/domain/timelineEvents.ts` (Milestone 8, T8.4 — so
 * `src/domain/stateMachineDb.ts` can reuse it without an inverted
 * domain -> api dependency) and is re-exported here for backward
 * compatibility; this file keeps the actual serialization function.
 */
export {
  TIMELINE_EVENT_NAMES,
  STABLE_NAME_BY_EVENT_TYPE,
  type TimelineEventName,
} from '../domain/timelineEvents.js';
import { STABLE_NAME_BY_EVENT_TYPE, type TimelineEventName } from '../domain/timelineEvents.js';

export interface TimelineEntry {
  event: TimelineEventName;
  occurredAt: string;
  declineCode?: string;
  outcome?: 'won' | 'lost';
}

export interface RawPaymentEventRow {
  event_type: string;
  decline_code: string | null;
  occurred_at: Date | string;
}

export function serializeTimeline(rows: RawPaymentEventRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const row of rows) {
    const event = STABLE_NAME_BY_EVENT_TYPE[row.event_type];
    if (!event) continue;

    const entry: TimelineEntry = {
      event,
      occurredAt: new Date(row.occurred_at).toISOString(),
    };
    if (row.decline_code) entry.declineCode = row.decline_code;
    if (row.event_type === 'dispute_won') entry.outcome = 'won';
    if (row.event_type === 'dispute_lost') entry.outcome = 'lost';
    entries.push(entry);
  }
  return entries;
}
