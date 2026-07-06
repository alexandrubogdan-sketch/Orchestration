import type { SubscriptionIntervalUnit } from '../db/types.js';

/**
 * Milestone 8, T8.1. Pure date arithmetic for subscription period
 * boundaries — no new date-math dependency added (SPEC.md's "ask
 * before adding a dependency" working agreement); native `Date`
 * covers day/week/month/year addition once month-end clamping is
 * handled explicitly (naive `setMonth` on Jan 31 rolls into March,
 * not "the last day of February" — clamped below).
 */
export function addInterval(date: Date, unit: SubscriptionIntervalUnit, count: number): Date {
  const result = new Date(date.getTime());
  switch (unit) {
    case 'day':
      result.setUTCDate(result.getUTCDate() + count);
      return result;
    case 'week':
      result.setUTCDate(result.getUTCDate() + count * 7);
      return result;
    case 'month':
      return addMonthsClamped(result, count);
    case 'year':
      return addMonthsClamped(result, count * 12);
  }
}

function addMonthsClamped(date: Date, months: number): Date {
  const originalDay = date.getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCDate(1); // avoid month-length overflow while adjusting the month itself
  result.setUTCMonth(result.getUTCMonth() + months);

  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}
