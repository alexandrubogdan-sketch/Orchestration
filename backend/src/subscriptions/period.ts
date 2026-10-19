import type { SubscriptionIntervalUnit } from '../db/types.js';

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
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}
