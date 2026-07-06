import pino from 'pino';
import type { AppConfig } from '../config/index.js';

/**
 * Redaction list — Non-negotiable #8: no PAN/CVV anywhere, not in DB, not
 * in logs, not in error messages.
 *
 * Deliberately keyed by *field name*, not by static path. Pino's built-in
 * `redact` option only matches fixed paths (`a.b.c`) or single-level
 * wildcards (`a.*.c`) — it cannot express "redact this key no matter how
 * deep it's nested," and raw PSP webhook payloads nest arbitrarily
 * (Stripe's `data.object.payment_method_details.card.number` is 5 levels
 * deep, and other PSPs will differ again). A fixed-depth wildcard list
 * looked correct until a nested-payload test caught it missing exactly
 * that case — see test/unit/logger-redaction.test.ts.
 *
 * So instead we recursively walk every log object ourselves
 * (`redactDeep`, wired in via pino's `formatters.log` hook, which runs on
 * every log object before serialization) and redact any key matching
 * this list at any depth. Matching is case-insensitive and by exact key
 * name (not substring) so we don't accidentally nuke unrelated fields
 * like `phoneNumber` while still catching `Card`, `CVV`, `PAN`, etc.
 */
export const REDACTED_KEYS = ['card', 'number', 'cvv', 'pan', 'client_secret'] as const;

const REDACTED_KEY_SET = new Set<string>(REDACTED_KEYS.map((key) => key.toLowerCase()));
const REDACTED_CENSOR = '[REDACTED]';

/**
 * T7.6 hardening pass: the key-based redaction above only catches a PAN
 * that ends up under one of REDACTED_KEYS. A card number logged under an
 * unexpected/miskeyed field (a bug in some future caller, e.g. `{ note:
 * rawCardNumber }`) would sail through untouched. This is a second,
 * independent, value-pattern layer: any run of 13-19 digits (a card PAN
 * per ISO/IEC 7812), optionally grouped by a single embedded space or
 * dash, gets redacted regardless of which key it's under.
 *
 * This deliberately accepts false positives — e.g. a 13-digit epoch-
 * millisecond timestamp logged as a bare string would also get redacted
 * — in exchange for Non-negotiable #8's absolute framing ("No PAN/CVV
 * anywhere... not in logs"). Over-redacting an innocuous number is the
 * safe failure mode here; under-redacting a real PAN is not.
 */
const PAN_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function redactPanPatterns(value: string): string {
  return value.replace(PAN_PATTERN, (match) => {
    const digitCount = match.replace(/[ -]/g, '').length;
    return digitCount >= 13 && digitCount <= 19 ? REDACTED_CENSOR : match;
  });
}

function redactDeep(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = REDACTED_KEY_SET.has(key.toLowerCase())
        ? REDACTED_CENSOR
        : redactDeep(nested, seen);
    }
    return result;
  }
  if (typeof value === 'string') {
    return redactPanPatterns(value);
  }
  return value;
}

/**
 * Pino `formatters.log` hook: receives the merged log object right
 * before serialization and returns the object that actually gets
 * written. Exported directly (not just used internally) so
 * test/unit/logger-redaction.test.ts can exercise the real redaction
 * logic against a minimal pino instance, instead of re-implementing it.
 */
export function redactionFormatter(object: Record<string, unknown>): Record<string, unknown> {
  return redactDeep(object, new WeakSet()) as Record<string, unknown>;
}

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'serviceName' | 'env'>) {
  return pino({
    name: config.serviceName,
    level: config.logLevel,
    formatters: {
      level(label) {
        return { level: label };
      },
      log: redactionFormatter,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.env === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
