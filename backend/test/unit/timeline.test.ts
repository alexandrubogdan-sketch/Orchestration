import { describe, expect, it } from 'vitest';
import { serializeTimeline } from '../../src/api/timeline.js';

describe('serializeTimeline', () => {
  it('maps canonical event types to the stable public names', () => {
    const rows = [
      {
        event_type: 'authorization_started',
        decline_code: null,
        occurred_at: '2026-01-01T00:00:00Z',
      },
      { event_type: 'authorized', decline_code: null, occurred_at: '2026-01-01T00:00:01Z' },
      { event_type: 'capture_started', decline_code: null, occurred_at: '2026-01-01T00:00:02Z' },
      { event_type: 'captured', decline_code: null, occurred_at: '2026-01-01T00:00:03Z' },
    ];
    expect(serializeTimeline(rows).map((e) => e.event)).toEqual([
      'started',
      'authorized',
      'pending',
      'captured',
    ]);
  });

  it('includes the decline code on a declined entry', () => {
    const rows = [
      {
        event_type: 'declined',
        decline_code: 'insufficient_funds',
        occurred_at: '2026-01-01T00:00:00Z',
      },
    ];
    const [entry] = serializeTimeline(rows);
    expect(entry).toEqual({
      event: 'declined',
      occurredAt: '2026-01-01T00:00:00.000Z',
      declineCode: 'insufficient_funds',
    });
  });

  it('surfaces dispute_won/dispute_lost as dispute_closed with an outcome', () => {
    const won = serializeTimeline([
      { event_type: 'dispute_won', decline_code: null, occurred_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(won[0]).toMatchObject({ event: 'dispute_closed', outcome: 'won' });

    const lost = serializeTimeline([
      { event_type: 'dispute_lost', decline_code: null, occurred_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(lost[0]).toMatchObject({ event: 'dispute_closed', outcome: 'lost' });
  });

  it('excludes operational-only event types (late_event, invariant_violation) from the timeline', () => {
    const rows = [
      { event_type: 'late_event', decline_code: null, occurred_at: '2026-01-01T00:00:00Z' },
      {
        event_type: 'invariant_violation',
        decline_code: null,
        occurred_at: '2026-01-01T00:00:01Z',
      },
      { event_type: 'captured', decline_code: null, occurred_at: '2026-01-01T00:00:02Z' },
    ];
    expect(serializeTimeline(rows)).toHaveLength(1);
    expect(serializeTimeline(rows)[0]!.event).toBe('captured');
  });

  it('preserves input order', () => {
    const rows = [
      { event_type: 'refund_started', decline_code: null, occurred_at: '2026-01-01T00:00:00Z' },
      { event_type: 'refunded', decline_code: null, occurred_at: '2026-01-01T00:00:01Z' },
    ];
    expect(serializeTimeline(rows).map((e) => e.event)).toEqual(['refund_pending', 'refunded']);
  });
});
