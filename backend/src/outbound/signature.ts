import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

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
