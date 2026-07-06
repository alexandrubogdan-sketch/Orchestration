import { describe, expect, it } from 'vitest';
import { generateApiToken, hashApiToken } from '../../src/api/auth.js';

describe('generateApiToken / hashApiToken', () => {
  it('generates a token with a stable, recognizable prefix', () => {
    const { raw } = generateApiToken();
    expect(raw.startsWith('po_')).toBe(true);
    expect(raw.length).toBeGreaterThan(20);
  });

  it('produces a different raw token on every call (not deterministic/reused)', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hashApiToken is deterministic for the same input', () => {
    expect(hashApiToken('po_abc123')).toBe(hashApiToken('po_abc123'));
  });

  it('hashApiToken never returns the raw input (never stored in plaintext)', () => {
    const raw = 'po_super_secret_value';
    const hash = hashApiToken(raw);
    expect(hash).not.toBe(raw);
    expect(hash).not.toContain(raw);
  });

  it('generateApiToken() returns a hash matching hashApiToken(raw)', () => {
    const { raw, hash } = generateApiToken();
    expect(hashApiToken(raw)).toBe(hash);
  });
});
