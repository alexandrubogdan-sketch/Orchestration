import { describe, expect, it } from 'vitest';
import { actionForMethod, isAllowed, resourceForRoute } from '../../src/api/scopes.js';

describe('api key scopes', () => {
  it('maps routes to resources', () => {
    expect(resourceForRoute('/v1/payments/:id/capture')).toBe('payments');
    expect(resourceForRoute('/v1/customers/:id/payment-methods')).toBe('customers');
    expect(resourceForRoute('/v1/api-keys/:id')).toBe('api_keys');
    expect(resourceForRoute('/healthz')).toBeUndefined();
  });

  it('maps safe methods to read and everything else to write', () => {
    expect(actionForMethod('GET')).toBe('read');
    expect(actionForMethod('HEAD')).toBe('read');
    expect(actionForMethod('POST')).toBe('write');
    expect(actionForMethod('DELETE')).toBe('write');
  });

  it('grants full access with *', () => {
    expect(isAllowed(['*'], 'api_keys', 'write')).toBe(true);
  });

  it('lets write imply read but never the reverse', () => {
    expect(isAllowed(['payments:write'], 'payments', 'read')).toBe(true);
    expect(isAllowed(['payments:read'], 'payments', 'write')).toBe(false);
  });

  it('never leaks a scope across resources', () => {
    expect(isAllowed(['payments:write'], 'customers', 'read')).toBe(false);
    expect(isAllowed(['payments:write'], 'api_keys', 'write')).toBe(false);
  });
});
