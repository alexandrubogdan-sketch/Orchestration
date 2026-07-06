import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  equals,
  fromDecimalString,
  InvalidMoneyError,
  isGreaterThan,
  isLessThan,
  isZero,
  isZeroDecimalCurrency,
  makeMoney,
  multiplyByInt,
  subtract,
  toDisplayString,
} from '../../src/domain/money.js';

describe('makeMoney', () => {
  it('accepts a valid integer minor-units amount', () => {
    const money = makeMoney(1999, 'USD');
    expect(money.minorUnits).toBe(1999);
    expect(money.currency).toBe('USD');
  });

  it('normalizes currency to uppercase', () => {
    expect(makeMoney(100, 'usd').currency).toBe('USD');
  });

  // Non-negotiable #1: "Any float in a money path is a bug."
  it.each([19.99, 0.1, 100.5, NaN, Infinity, -Infinity])(
    'rejects non-integer minorUnits: %p',
    (bad) => {
      expect(() => makeMoney(bad, 'USD')).toThrow(InvalidMoneyError);
    },
  );

  it('rejects negative amounts', () => {
    expect(() => makeMoney(-100, 'USD')).toThrow(InvalidMoneyError);
  });

  it('rejects unrecognized currency codes', () => {
    expect(() => makeMoney(100, 'ZZZ')).toThrow(InvalidMoneyError);
    expect(() => makeMoney(100, 'US')).toThrow(InvalidMoneyError);
    expect(() => makeMoney(100, 'DOLLARS')).toThrow(InvalidMoneyError);
  });

  it('rejects values beyond safe integer precision', () => {
    expect(() => makeMoney(Number.MAX_SAFE_INTEGER + 10, 'USD')).toThrow(InvalidMoneyError);
  });
});

describe('fromDecimalString', () => {
  it('converts a plain decimal string to minor units', () => {
    expect(fromDecimalString('19.99', 'USD').minorUnits).toBe(1999);
    expect(fromDecimalString('5', 'USD').minorUnits).toBe(500);
    expect(fromDecimalString('0.01', 'USD').minorUnits).toBe(1);
  });

  it('handles zero-decimal currencies (e.g. JPY) without multiplying by 100', () => {
    expect(fromDecimalString('500', 'JPY').minorUnits).toBe(500);
    expect(isZeroDecimalCurrency('JPY')).toBe(true);
  });

  it('rejects a fractional amount for a zero-decimal currency', () => {
    expect(() => fromDecimalString('500.50', 'JPY')).toThrow(InvalidMoneyError);
  });

  it('rejects malformed decimal strings', () => {
    expect(() => fromDecimalString('nineteen ninety nine', 'USD')).toThrow(InvalidMoneyError);
    expect(() => fromDecimalString('19.99.99', 'USD')).toThrow(InvalidMoneyError);
  });
});

describe('arithmetic', () => {
  it('add() sums same-currency amounts', () => {
    const result = add(makeMoney(500, 'USD'), makeMoney(250, 'USD'));
    expect(result.minorUnits).toBe(750);
  });

  it('add() rejects mismatched currencies', () => {
    expect(() => add(makeMoney(500, 'USD'), makeMoney(250, 'EUR'))).toThrow(InvalidMoneyError);
  });

  it('subtract() computes the difference', () => {
    expect(subtract(makeMoney(500, 'USD'), makeMoney(200, 'USD')).minorUnits).toBe(300);
  });

  it('subtract() throws rather than producing a negative amount', () => {
    expect(() => subtract(makeMoney(100, 'USD'), makeMoney(200, 'USD'))).toThrow(InvalidMoneyError);
  });

  it('multiplyByInt() scales by a whole-number factor', () => {
    expect(multiplyByInt(makeMoney(300, 'USD'), 3).minorUnits).toBe(900);
  });

  it('multiplyByInt() rejects a fractional factor', () => {
    expect(() => multiplyByInt(makeMoney(300, 'USD'), 1.5)).toThrow(InvalidMoneyError);
  });

  it('comparisons and equality work as expected', () => {
    expect(isGreaterThan(makeMoney(500, 'USD'), makeMoney(100, 'USD'))).toBe(true);
    expect(isLessThan(makeMoney(100, 'USD'), makeMoney(500, 'USD'))).toBe(true);
    expect(equals(makeMoney(500, 'USD'), makeMoney(500, 'USD'))).toBe(true);
    expect(isZero(makeMoney(0, 'USD'))).toBe(true);
  });
});

describe('allocate', () => {
  it('splits an amount proportionally without losing or fabricating minor units', () => {
    const shares = allocate(makeMoney(100, 'USD'), [1, 1, 1]);
    const total = shares.reduce((sum, s) => sum + s.minorUnits, 0);
    expect(total).toBe(100);
    // 100/3 -> floor(33.33) = 33, 33, and the remainder (34) goes to the last share.
    expect(shares.map((s) => s.minorUnits)).toEqual([33, 33, 34]);
  });

  it('splits evenly when it divides cleanly', () => {
    const shares = allocate(makeMoney(1000, 'USD'), [50, 50]);
    expect(shares.map((s) => s.minorUnits)).toEqual([500, 500]);
  });

  it('handles a single weight (100% allocation)', () => {
    const shares = allocate(makeMoney(999, 'USD'), [100]);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.minorUnits).toBe(999);
  });

  it('rejects all-zero weights', () => {
    expect(() => allocate(makeMoney(100, 'USD'), [0, 0])).toThrow(InvalidMoneyError);
  });

  // Property-style exhaustive check: for many random weight sets, the
  // shares must always sum back to the original total exactly.
  it('always sums back to the original amount across many weight combinations', () => {
    for (let trial = 0; trial < 200; trial++) {
      const totalMinor = Math.floor(Math.random() * 100_000) + 1;
      const weightCount = Math.floor(Math.random() * 5) + 1;
      const weights = Array.from({ length: weightCount }, () => Math.floor(Math.random() * 10) + 1);
      const shares = allocate(makeMoney(totalMinor, 'USD'), weights);
      const summed = shares.reduce((sum, s) => sum + s.minorUnits, 0);
      expect(summed).toBe(totalMinor);
      expect(shares.every((s) => s.minorUnits >= 0)).toBe(true);
    }
  });
});

describe('toDisplayString', () => {
  it('formats standard currencies with two decimal places', () => {
    expect(toDisplayString(makeMoney(1999, 'USD'))).toBe('19.99 USD');
    expect(toDisplayString(makeMoney(5, 'USD'))).toBe('0.05 USD');
  });

  it('formats zero-decimal currencies without a decimal point', () => {
    expect(toDisplayString(makeMoney(500, 'JPY'))).toBe('500 JPY');
  });
});
