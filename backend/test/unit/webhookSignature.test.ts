import { describe, expect, it } from 'vitest';
import {
  generateWebhookSigningSecret,
  InvalidWebhookSignatureError,
  signOutboundWebhook,
  verifyOutboundWebhookSignature,
} from '../../src/outbound/signature.js';

describe('outbound webhook signing — T8.4', () => {
  it('generates distinct secrets with a recognizable prefix', () => {
    const a = generateWebhookSigningSecret();
    const b = generateWebhookSigningSecret();
    expect(a.startsWith('whsec_')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('a signature verifies successfully against the same secret/body/timestamp', () => {
    const secret = generateWebhookSigningSecret();
    const body = JSON.stringify({ event: 'captured', paymentId: 'pay_1' });
    const now = Date.now();
    const signature = signOutboundWebhook(secret, body, now);
    expect(() => verifyOutboundWebhookSignature(secret, body, signature, now)).not.toThrow();
  });

  it('rejects a signature computed with a different secret', () => {
    const body = JSON.stringify({ event: 'captured' });
    const now = Date.now();
    const signature = signOutboundWebhook(generateWebhookSigningSecret(), body, now);
    expect(() =>
      verifyOutboundWebhookSignature(generateWebhookSigningSecret(), body, signature, now),
    ).toThrow(InvalidWebhookSignatureError);
  });

  it('rejects a tampered body', () => {
    const secret = generateWebhookSigningSecret();
    const now = Date.now();
    const signature = signOutboundWebhook(secret, JSON.stringify({ amount: 100 }), now);
    expect(() =>
      verifyOutboundWebhookSignature(secret, JSON.stringify({ amount: 999999 }), signature, now),
    ).toThrow(InvalidWebhookSignatureError);
  });

  it('rejects a signature replayed well outside the allowed window', () => {
    const secret = generateWebhookSigningSecret();
    const body = JSON.stringify({ event: 'captured' });
    const originalTime = Date.now();
    const signature = signOutboundWebhook(secret, body, originalTime);
    const muchLater = originalTime + 60 * 60_000; // 1 hour later
    expect(() => verifyOutboundWebhookSignature(secret, body, signature, muchLater)).toThrow(
      InvalidWebhookSignatureError,
    );
  });

  it('rejects a malformed signature header', () => {
    const secret = generateWebhookSigningSecret();
    expect(() => verifyOutboundWebhookSignature(secret, '{}', 'garbage')).toThrow(
      InvalidWebhookSignatureError,
    );
  });
});
