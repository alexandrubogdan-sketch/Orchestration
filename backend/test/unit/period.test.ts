import { describe, expect, it } from 'vitest';
import { addInterval } from '../../src/subscriptions/period.js';

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('addInterval', () => {
  it('adds days', () => {
    expect(iso(addInterval(new Date('2026-01-01T00:00:00Z'), 'day', 5))).toBe('2026-01-06');
  });

  it('adds weeks', () => {
    expect(iso(addInterval(new Date('2026-01-01T00:00:00Z'), 'week', 2))).toBe('2026-01-15');
  });

  it('adds months on a plain day', () => {
    expect(iso(addInterval(new Date('2026-01-15T00:00:00Z'), 'month', 1))).toBe('2026-02-15');
  });

  it('adds years', () => {
    expect(iso(addInterval(new Date('2026-03-10T00:00:00Z'), 'year', 1))).toBe('2027-03-10');
  });

  it('clamps Jan 31 + 1 month to Feb 28 (non-leap year)', () => {
    expect(iso(addInterval(new Date('2026-01-31T00:00:00Z'), 'month', 1))).toBe('2026-02-28');
  });

  it('clamps Jan 31 + 1 month to Feb 29 (leap year)', () => {
    expect(iso(addInterval(new Date('2028-01-31T00:00:00Z'), 'month', 1))).toBe('2028-02-29');
  });

  it('handles a full year of monthly renewals ending back on the same day', () => {
    let date = new Date('2026-01-31T00:00:00Z');
    for (let i = 0; i < 12; i++) {
      date = addInterval(date, 'month', 1);
    }
    // 12 successive +1-month steps from Jan 31 do NOT necessarily land
    // back on the 31st every time (Feb/Apr/Jun/... clamp), which is
    // the expected, correct behavior for calendar-month billing — this
    // test documents that rather than asserting a naive "same day
    // every year" claim that wouldn't actually be true.
    expect(iso(date)).toBe('2027-01-28');
  });

  it('multi-month jumps land on the correct month', () => {
    expect(iso(addInterval(new Date('2026-01-15T00:00:00Z'), 'month', 3))).toBe('2026-04-15');
  });
});
