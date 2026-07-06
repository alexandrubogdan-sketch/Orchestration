import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { redactionFormatter } from '../../src/observability/logger.js';

type LogEntry = Record<string, unknown>;

/**
 * Non-negotiable #8: "No PAN/CVV anywhere — not in DB, not in logs, not
 * in error messages. Add a log-scrubbing test that greps for
 * card-number patterns in captured log output." This exercises the real
 * `redactionFormatter` (not a re-implementation of it) against a minimal
 * pino instance so we capture raw JSON synchronously, without pulling in
 * the pino-pretty transport createLogger uses in development. The
 * Milestone 7 (T7.6) test additionally greps rendered log output for
 * card-number regexes as a second, independent check.
 */
function buildCapturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  const logger = pino({ formatters: { log: redactionFormatter } }, stream);
  return { logger, lines };
}

function parseLine(line: string): LogEntry {
  return JSON.parse(line) as LogEntry;
}

describe('log redaction', () => {
  it('redacts top-level sensitive keys', () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info({ card: '4242424242424242', cvv: '123', pan: '4242424242424242' }, 'card event');
    const entry = parseLine(lines[0]!);
    expect(entry['card']).toBe('[REDACTED]');
    expect(entry['cvv']).toBe('[REDACTED]');
    expect(entry['pan']).toBe('[REDACTED]');
  });

  it('redacts arbitrarily nested sensitive keys (e.g. inside a raw Stripe webhook payload)', () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info(
      {
        stripeEvent: {
          data: {
            object: {
              payment_method_details: { card: { number: '4242424242424242' } },
            },
          },
        },
      },
      'webhook received',
    );
    const entry = parseLine(lines[0]!);
    expect(JSON.stringify(entry)).not.toContain('4242424242424242');
  });

  it('redacts client_secret at any depth so Stripe secrets never hit logs', () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info(
      { deeply: { nested: { paymentIntent: { client_secret: 'pi_123_secret_abc' } } } },
      'created intent',
    );
    const entry = parseLine(lines[0]!);
    expect(JSON.stringify(entry)).not.toContain('pi_123_secret_abc');
  });

  it('matches redacted keys case-insensitively', () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info({ CVV: '123', Card: '4242424242424242' }, 'case variant');
    const entry = parseLine(lines[0]!);
    expect(entry['CVV']).toBe('[REDACTED]');
    expect(entry['Card']).toBe('[REDACTED]');
  });

  it('does not redact unrelated fields (redaction should not be so broad it hides useful debug info)', () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info({ paymentId: 'pay_123', status: 'authorized' }, 'state change');
    const entry = parseLine(lines[0]!);
    expect(entry['paymentId']).toBe('pay_123');
    expect(entry['status']).toBe('authorized');
  });

  it('does not redact keys that merely contain a sensitive substring (e.g. phoneNumber)', () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info({ phoneNumber: '+15555550100' }, 'contact update');
    const entry = parseLine(lines[0]!);
    expect(entry['phoneNumber']).toBe('+15555550100');
  });

  describe('T7.6: value-pattern redaction (catches a PAN under an unexpected key)', () => {
    // Checked against the specific field's rendered value, not the whole
    // JSON line — pino's own `time` field is itself a 13-digit
    // epoch-millisecond number and would otherwise false-positive this
    // assertion (exactly the documented false-positive trade-off in
    // src/observability/logger.ts's PAN_PATTERN comment, just showing up
    // in an unexpected place: the test's own assertion, not the redactor).
    it('redacts a card-number-shaped value even under a totally unrelated key name', () => {
      const { logger, lines } = buildCapturingLogger();
      logger.info({ note: 'customer quoted 4242424242424242 over the phone' }, 'support note');
      const entry = parseLine(lines[0]!);
      const note = entry['note'] as string;
      expect(note).not.toContain('4242424242424242');
      expect(note).toContain('[REDACTED]');
    });

    it('redacts a dash- or space-grouped card number under an unexpected key', () => {
      const { logger, lines } = buildCapturingLogger();
      logger.info({ description: 'card 4242-4242-4242-4242 declined' }, 'note');
      const entry = parseLine(lines[0]!);
      const description = entry['description'] as string;
      expect(description).not.toContain('4242-4242-4242-4242');
      expect(description).toContain('[REDACTED]');
    });

    it('does not redact short numeric values (e.g. a 4-digit last4 or a small quantity)', () => {
      const { logger, lines } = buildCapturingLogger();
      logger.info({ cardLast4: '4242', quantity: 3 }, 'order line');
      const entry = parseLine(lines[0]!);
      expect(entry['cardLast4']).toBe('4242');
      expect(entry['quantity']).toBe(3);
    });

    it('is applied recursively, not just at the top level', () => {
      const { logger, lines } = buildCapturingLogger();
      logger.info(
        { support: { ticket: { transcript: 'card ending 4242424242424242 read aloud' } } },
        'ticket',
      );
      const entry = parseLine(lines[0]!) as {
        support: { ticket: { transcript: string } };
      };
      expect(entry.support.ticket.transcript).not.toContain('4242424242424242');
      expect(entry.support.ticket.transcript).toContain('[REDACTED]');
    });
  });
});
