import pino from 'pino';
import type { AppConfig } from '../config/index.js';

export const REDACTED_KEYS = ['card', 'number', 'cvv', 'pan', 'client_secret'] as const;

const REDACTED_KEY_SET = new Set<string>(REDACTED_KEYS.map((key) => key.toLowerCase()));
const REDACTED_CENSOR = '[REDACTED]';

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
