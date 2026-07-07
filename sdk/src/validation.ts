/**
 * Pure, unit-testable card-input validation helpers shared by the
 * mock and solidgate drivers (both of which render their own raw
 * <input> fields, unlike the stripe driver which delegates validation
 * to Stripe's own iframe-hosted Elements).
 *
 * Nothing here talks to the DOM or the network — that's deliberate,
 * so these functions can be exercised directly in vitest without any
 * jsdom setup.
 */

/**
 * Luhn checksum (mod 10) — the standard check-digit algorithm used by
 * all major card networks (Visa, Mastercard, Amex, etc).
 *
 * Accepts a card number that may contain spaces; rejects anything
 * that isn't purely digits once whitespace is stripped, and anything
 * outside the 12-19 digit range real PANs fall in.
 */
export function isValidLuhn(rawCardNumber: string): boolean {
  const digitsOnly = rawCardNumber.replace(/\s+/g, "");
  if (!/^\d{12,19}$/.test(digitsOnly)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = Number(digitsOnly[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

export interface ExpiryParts {
  month: number;
  year: number;
}

/**
 * Parses "MM/YY" or "MM/YYYY" into numeric parts. Returns null if the
 * string doesn't match the expected shape or the month is out of
 * range (1-12). Two-digit years are expanded assuming the 2000s,
 * which is safe for any card expiry a human will type this decade.
 */
export function parseExpiry(raw: string): ExpiryParts | null {
  const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  if (month < 1 || month > 12) {
    return null;
  }
  const rawYear = match[2] as string;
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  return { month, year };
}

/**
 * True if the given MM/YY(YY) expiry is a valid, not-yet-expired card
 * date. Cards are valid through the LAST day of the printed month, so
 * "expired" only becomes true once the current month has fully
 * passed (i.e. we're strictly past that month/year).
 */
export function isValidExpiry(raw: string, now: Date = new Date()): boolean {
  const parsed = parseExpiry(raw);
  if (!parsed) {
    return false;
  }
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (parsed.year < currentYear) {
    return false;
  }
  if (parsed.year === currentYear && parsed.month < currentMonth) {
    return false;
  }
  // Reject unreasonably far-future dates (>20 years) — almost
  // certainly a typo, and matches the spirit of real card networks'
  // max validity windows.
  if (parsed.year > currentYear + 20) {
    return false;
  }
  return true;
}

/**
 * CVC/CVV validation: 3 digits for most networks, 4 for Amex. Since
 * these drivers don't do full network detection off the PAN, we
 * accept the general 3-4 digit range, which is what every real-world
 * "is this a plausible CVC" client check does without card-brand
 * detection.
 */
export function isValidCvc(raw: string): boolean {
  return /^\d{3,4}$/.test(raw.trim());
}
