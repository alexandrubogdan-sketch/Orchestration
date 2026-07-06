import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * T8.4: outbound webhook signing. Deliberately mirrors Stripe's own
 * `t=<timestamp>,v1=<hmac>` scheme (a well-understood, defensible
 * design already familiar to any product integrating payment
 * webhooks) rather than inventing a new one: including the timestamp
 * IN the signed payload defeats replay of a captured request, which a
 * bare `HMAC(secret, body)` scheme does not.
 */
const MAX_SIGNATURE_AGE_MS = 5 * 60_000; // 5 minutes — generous enough for delivery/retry jitter, tight enough to matter

export function generateWebhookSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

export function signOutboundWebhook(
  secret: string,
  rawBody: string,
  timestamp: number = Date.now(),
): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  const hmac = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

export class InvalidWebhookSignatureError extends Error {
  constructor(detail: string) {
    super(`Invalid outbound webhook signature: ${detail}`);
    this.name = 'InvalidWebhookSignatureError';
  }
}

/**
 * Reference implementation of the verification a PRODUCT should
 * perform on their end — shipped here mainly so
 * docs/runbooks/outbound-webhooks.md can point at real, tested code
 * rather than prose alone, and so this repo's own delivery tests can
 * assert round-trip correctness.
 */
export function verifyOutboundWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  now: number = Date.now(),
): void {
  const parts = new Map(
    signatureHeader.split(',').map((part) => {
      const [key, value] = part.split('=');
      return [key, value] as [string, string];
    }),
  );
  const timestamp = Number(parts.get('t'));
  const providedSignature = parts.get('v1');
  if (!timestamp || !providedSignature) {
    throw new InvalidWebhookSignatureError('missing t= or v1= component');
  }
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) {
    throw new InvalidWebhookSignatureError(
      'timestamp outside the allowed window (possible replay)',
    );
  }

  const expected = signOutboundWebhook(secret, rawBody, timestamp);
  const expectedSignature = expected.split('v1=')[1]!;

  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidWebhookSignatureError('signature mismatch');
  }
}
