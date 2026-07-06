import { describe, expect, it } from 'vitest';
import {
  computeRequestHash,
  MissingIdempotencyKeyError,
  requireIdempotencyKey,
} from '../../src/api/idempotency.js';

describe('computeRequestHash', () => {
  it('is deterministic for the same method/path/body', () => {
    const request = { method: 'POST', path: '/v1/payments', body: { amount: 100 } };
    expect(computeRequestHash(request)).toBe(computeRequestHash({ ...request }));
  });

  it('is case-insensitive on method', () => {
    const a = computeRequestHash({ method: 'post', path: '/v1/payments', body: { a: 1 } });
    const b = computeRequestHash({ method: 'POST', path: '/v1/payments', body: { a: 1 } });
    expect(a).toBe(b);
  });

  it('differs when the body differs — this is what drives the 409 conflict path', () => {
    const a = computeRequestHash({ method: 'POST', path: '/v1/payments', body: { amount: 100 } });
    const b = computeRequestHash({ method: 'POST', path: '/v1/payments', body: { amount: 200 } });
    expect(a).not.toBe(b);
  });

  it('differs when the path differs', () => {
    const a = computeRequestHash({ method: 'POST', path: '/v1/payments', body: {} });
    const b = computeRequestHash({ method: 'POST', path: '/v1/refunds', body: {} });
    expect(a).not.toBe(b);
  });

  it('treats undefined and null body the same way', () => {
    const a = computeRequestHash({ method: 'POST', path: '/v1/payments', body: undefined });
    const b = computeRequestHash({ method: 'POST', path: '/v1/payments', body: null });
    expect(a).toBe(b);
  });
});

describe('requireIdempotencyKey', () => {
  it('extracts a valid header', () => {
    expect(requireIdempotencyKey({ 'idempotency-key': 'abc-123' })).toBe('abc-123');
  });

  it('takes the first value if the header was sent multiple times', () => {
    expect(requireIdempotencyKey({ 'idempotency-key': ['first', 'second'] })).toBe('first');
  });

  it('throws MissingIdempotencyKeyError when absent', () => {
    expect(() => requireIdempotencyKey({})).toThrow(MissingIdempotencyKeyError);
  });

  it('throws MissingIdempotencyKeyError for an empty/whitespace-only header', () => {
    expect(() => requireIdempotencyKey({ 'idempotency-key': '   ' })).toThrow(
      MissingIdempotencyKeyError,
    );
  });
});
