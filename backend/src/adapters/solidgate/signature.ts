import { createHmac } from 'node:crypto';

/**
 * Solidgate's request-signing scheme, as documented at
 * docs.solidgate.com/payments/integrate/access-to-api/#generate-signature
 * (confirmed against their published docs, not guessed):
 *
 * 1. Concatenate `publicKey + jsonString + publicKey` (or just
 *    `publicKey + publicKey` for a GET request with no body).
 * 2. Compute HMAC-SHA512 of that string, keyed with the Secret key.
 * 3. Take the HEX representation of that HMAC digest.
 * 4. Base64-encode the HEX STRING itself (not the raw digest bytes) —
 *    this double-encoding is unusual but is exactly what Solidgate's
 *    docs and reference snippets describe; a Buffer.from(hex, 'hex')
 *    step would produce Stripe/most-PSPs'-style single-encoding
 *    instead, which would NOT match what Solidgate expects.
 *
 * The same function verifies inbound webhooks too, per Solidgate's own
 * docs ("Solidgate uses a similar authentication method for
 * webhooks, with merchant and signature parameters included in the
 * headers") — just with the Webhook key pair (`wh_pk_`/`wh_sk_`)
 * instead of the API key pair (`api_pk_`/`api_sk_`).
 */
export function computeSolidgateSignature(
  publicKey: string,
  secretKey: string,
  jsonString: string | null,
): string {
  const data =
    jsonString === null ? `${publicKey}${publicKey}` : `${publicKey}${jsonString}${publicKey}`;
  const hexDigest = createHmac('sha512', secretKey).update(data).digest('hex');
  return Buffer.from(hexDigest, 'utf8').toString('base64');
}

export interface SolidgateAuthHeaders {
  merchant: string;
  signature: string;
}

export function buildSolidgateAuthHeaders(
  publicKey: string,
  secretKey: string,
  jsonString: string | null,
): SolidgateAuthHeaders {
  return {
    merchant: publicKey,
    signature: computeSolidgateSignature(publicKey, secretKey, jsonString),
  };
}
