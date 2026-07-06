/**
 * Non-negotiable #1: "Money is integers. All amounts are integer minor
 * units + ISO 4217 currency code. Any float in a money path is a bug."
 *
 * `Money` is a branded type so a raw `number`/`{amount, currency}`
 * object can never be accidentally passed where a validated Money value
 * is expected — it must go through `makeMoney`, which is the one place
 * that enforces "integer minor units."
 */

const MONEY_BRAND = Symbol('Money');

export interface Money {
  readonly [MONEY_BRAND]: true;
  readonly minorUnits: number;
  readonly currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

// Not exhaustive of ISO 4217, but covers every currency this codebase's
// PSPs (Stripe first, per SPEC.md) are likely to process at launch.
// Extend as new corridors are added — this list exists to catch typos
// ("USDD", "eur") at the boundary, not to be a complete registry.
const KNOWN_CURRENCIES = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'BRL',
  'MXN',
  'INR',
  'SGD',
  'HKD',
  'NZD',
  'ZAR',
  'AED',
]);

// Zero-decimal currencies per ISO 4217 / Stripe's currency list. Minor
// units ARE the whole unit for these — JPY 100 means ¥100, not ¥1.00.
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF']);

export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
}

/**
 * The only constructor for Money. Validates:
 * - minorUnits is a safe integer (rejects floats, NaN, Infinity, and
 *   anything requiring more precision than a JS number can hold exactly)
 * - minorUnits is non-negative (refunds/adjustments are modeled as
 *   separate signed ledger entries, not negative Money — see
 *   src/ledger/, Milestone 6)
 * - currency is a recognized 3-letter uppercase ISO 4217 code
 */
export function makeMoney(minorUnits: number, currency: string): Money {
  if (!Number.isInteger(minorUnits)) {
    throw new InvalidMoneyError(
      `Money.minorUnits must be an integer, got ${JSON.stringify(minorUnits)}. ` +
        'Money is always integer minor units (Non-negotiable #1) — if this value ' +
        'came from a float (e.g. dollars), convert it via fromDecimal() instead.',
    );
  }
  if (!Number.isSafeInteger(minorUnits)) {
    throw new InvalidMoneyError(
      `Money.minorUnits ${minorUnits} exceeds Number.MAX_SAFE_INTEGER precision`,
    );
  }
  if (minorUnits < 0) {
    throw new InvalidMoneyError(`Money.minorUnits must be non-negative, got ${minorUnits}`);
  }
  const normalizedCurrency = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new InvalidMoneyError(`Currency must be a 3-letter ISO 4217 code, got ${currency}`);
  }
  if (!KNOWN_CURRENCIES.has(normalizedCurrency)) {
    throw new InvalidMoneyError(
      `Currency ${normalizedCurrency} is not in the known-currency list (src/domain/money.ts). ` +
        'Add it deliberately rather than silently accepting unrecognized codes.',
    );
  }
  return { [MONEY_BRAND]: true, minorUnits, currency: normalizedCurrency };
}

/**
 * Explicit, named conversion from a decimal string (e.g. "19.99") to
 * Money — the ONE sanctioned place a decimal/float representation is
 * allowed to enter the system (e.g. parsing a merchant-configured price
 * from a config file). Takes a string, not a number, specifically so
 * callers can't do `fromDecimal(19.99 * 100)` and reintroduce float
 * rounding error before this function ever sees it.
 */
export function fromDecimalString(decimal: string, currency: string): Money {
  if (!/^-?\d+(\.\d+)?$/.test(decimal.trim())) {
    throw new InvalidMoneyError(`fromDecimalString: "${decimal}" is not a plain decimal string`);
  }
  const zeroDecimal = isZeroDecimalCurrency(currency);
  const [wholePart, fractionPart = ''] = decimal.trim().split('.');
  if (zeroDecimal) {
    if (fractionPart.replace(/0+$/, '') !== '') {
      throw new InvalidMoneyError(
        `fromDecimalString: ${currency} is zero-decimal but "${decimal}" has a fractional part`,
      );
    }
    return makeMoney(Number(wholePart), currency);
  }
  const paddedFraction = (fractionPart + '00').slice(0, 2);
  const minorUnits = Number(wholePart) * 100 + Number(paddedFraction);
  return makeMoney(minorUnits, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new InvalidMoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return makeMoney(a.minorUnits + b.minorUnits, a.currency);
}

/**
 * Subtraction is intentionally the only place a "negative" outcome is
 * even possible, and it throws rather than returning a negative Money
 * (Money is always non-negative — see makeMoney). Model refunds/credits
 * as their own ledger entries with their own sign semantics
 * (src/ledger/), not as negative Money.
 */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  if (b.minorUnits > a.minorUnits) {
    throw new InvalidMoneyError(
      `subtract() would produce a negative amount: ${a.minorUnits} - ${b.minorUnits}`,
    );
  }
  return makeMoney(a.minorUnits - b.minorUnits, a.currency);
}

/** Multiply by an integer factor only (e.g. quantity) — never a float. */
export function multiplyByInt(a: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new InvalidMoneyError(
      `multiplyByInt factor must be an integer, got ${JSON.stringify(factor)}. ` +
        'Multiplying money by a fractional factor (e.g. a percentage) is a rounding ' +
        'hazard — use allocate() to split money proportionally instead.',
    );
  }
  return makeMoney(a.minorUnits * factor, a.currency);
}

/**
 * Splits `total` into `parts` non-negative integer shares that sum
 * exactly back to `total.minorUnits` — the standard "distribute a
 * remainder" allocation algorithm, so proportional splits (e.g.
 * routing_split percentages, §4 of the design doc) never lose or
 * fabricate a minor unit to floating-point rounding.
 */
export function allocate(total: Money, weights: number[]): Money[] {
  if (weights.length === 0) {
    throw new InvalidMoneyError('allocate() requires at least one weight');
  }
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new InvalidMoneyError('allocate() weights must be non-negative integers');
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    throw new InvalidMoneyError('allocate() requires at least one non-zero weight');
  }

  let remaining = total.minorUnits;
  const shares: number[] = [];
  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i]!;
    const isLast = i === weights.length - 1;
    const share = isLast ? remaining : Math.floor((total.minorUnits * weight) / totalWeight);
    shares.push(share);
    remaining -= share;
  }
  return shares.map((share) => makeMoney(share, total.currency));
}

export function isZero(a: Money): boolean {
  return a.minorUnits === 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minorUnits === b.minorUnits;
}

export function isGreaterThan(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.minorUnits > b.minorUnits;
}

export function isLessThan(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.minorUnits < b.minorUnits;
}

/** Display-only formatting (e.g. dashboard/logs) — never parsed back. */
export function toDisplayString(money: Money): string {
  if (isZeroDecimalCurrency(money.currency)) {
    return `${money.minorUnits} ${money.currency}`;
  }
  const whole = Math.trunc(money.minorUnits / 100);
  const fraction = Math.abs(money.minorUnits % 100)
    .toString()
    .padStart(2, '0');
  return `${whole}.${fraction} ${money.currency}`;
}
