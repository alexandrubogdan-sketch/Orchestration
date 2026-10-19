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

  if (parsed.year > currentYear + 20) {
    return false;
  }
  return true;
}

export function isValidCvc(raw: string): boolean {
  return /^\d{3,4}$/.test(raw.trim());
}
