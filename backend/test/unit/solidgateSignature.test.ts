import { describe, expect, it } from 'vitest';
import {
  buildSolidgateAuthHeaders,
  computeSolidgateSignature,
} from '../../src/adapters/solidgate/signature.js';

describe('computeSolidgateSignature', () => {
  const publicKey = 'api_pk_test123';
  const secretKey = 'api_sk_test456';

  it('is deterministic for the same inputs', () => {
    const a = computeSolidgateSignature(publicKey, secretKey, '{"amount":100}');
    const b = computeSolidgateSignature(publicKey, secretKey, '{"amount":100}');
    expect(a).toBe(b);
  });

  it('changes when the body changes', () => {
    const a = computeSolidgateSignature(publicKey, secretKey, '{"amount":100}');
    const b = computeSolidgateSignature(publicKey, secretKey, '{"amount":200}');
    expect(a).not.toBe(b);
  });

  it('changes when the secret key changes', () => {
    const a = computeSolidgateSignature(publicKey, 'secret-a', '{"amount":100}');
    const b = computeSolidgateSignature(publicKey, 'secret-b', '{"amount":100}');
    expect(a).not.toBe(b);
  });

  it('changes when the public key changes (it is part of the signed data twice)', () => {
    const a = computeSolidgateSignature('pk-a', secretKey, '{"amount":100}');
    const b = computeSolidgateSignature('pk-b', secretKey, '{"amount":100}');
    expect(a).not.toBe(b);
  });

  it('supports the no-body (GET) form: publicKey + publicKey', () => {
    const withNullBody = computeSolidgateSignature(publicKey, secretKey, null);
    const withEmptyString = computeSolidgateSignature(publicKey, secretKey, '');

    expect(withNullBody).toBe(withEmptyString);
  });

  it('produces a valid base64 string', () => {
    const signature = computeSolidgateSignature(publicKey, secretKey, '{}');
    expect(() => Buffer.from(signature, 'base64')).not.toThrow();
    expect(Buffer.from(signature, 'base64').toString('base64')).toBe(signature);
  });
});

describe('buildSolidgateAuthHeaders', () => {
  it('returns the public key as the merchant header, unmodified', () => {
    const headers = buildSolidgateAuthHeaders('api_pk_abc', 'api_sk_def', '{}');
    expect(headers.merchant).toBe('api_pk_abc');
    expect(headers.signature).toBe(computeSolidgateSignature('api_pk_abc', 'api_sk_def', '{}'));
  });
});
