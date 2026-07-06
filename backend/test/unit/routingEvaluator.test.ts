import { describe, expect, it } from 'vitest';
import { matchesCriteria, sortRules } from '../../src/routing/evaluator.js';
import type { RoutingInput, RoutingRule } from '../../src/routing/types.js';

const baseInput: RoutingInput = {
  productId: 'product-1',
  currency: 'USD',
  citMit: 'cit',
  paymentMethodType: 'card',
};

function rule(overrides: Partial<RoutingRule>): RoutingRule {
  return {
    id: 'rule-default',
    merchantEntityId: 'entity-1',
    productId: null,
    priority: 100,
    isEnabled: true,
    match: {},
    pspAccountId: 'psp-default',
    fallbackPspAccountId: null,
    description: null,
    ...overrides,
  };
}

describe('matchesCriteria', () => {
  it('an empty match object matches anything (wildcard rule)', () => {
    expect(matchesCriteria({}, baseInput)).toBe(true);
  });

  it('matches when the currency allow-list includes the input currency', () => {
    expect(matchesCriteria({ currency: ['USD', 'EUR'] }, baseInput)).toBe(true);
  });

  it('rejects when the currency allow-list excludes the input currency', () => {
    expect(matchesCriteria({ currency: ['EUR'] }, baseInput)).toBe(false);
  });

  it('rejects when citMit does not match', () => {
    expect(matchesCriteria({ citMit: ['mit'] }, baseInput)).toBe(false);
  });

  it('rejects when paymentMethodType does not match', () => {
    expect(matchesCriteria({ paymentMethodType: ['wallet'] }, baseInput)).toBe(false);
  });

  it('requires every specified dimension to match (AND, not OR)', () => {
    const criteria = { currency: ['USD'], citMit: ['mit' as const] };
    expect(matchesCriteria(criteria, baseInput)).toBe(false); // currency matches, citMit doesn't
  });
});

describe('sortRules — T5.5 rule precedence', () => {
  it('orders by priority ascending (lower number evaluated first)', () => {
    const rules = [
      rule({ id: 'low-priority', priority: 50 }),
      rule({ id: 'high-priority', priority: 10 }),
    ];
    expect(sortRules(rules).map((r) => r.id)).toEqual(['high-priority', 'low-priority']);
  });

  it('a product-specific rule wins a priority tie against an entity-wide rule', () => {
    const rules = [
      rule({ id: 'entity-wide', priority: 10, productId: null }),
      rule({ id: 'product-specific', priority: 10, productId: 'product-1' }),
    ];
    expect(sortRules(rules).map((r) => r.id)).toEqual(['product-specific', 'entity-wide']);
  });

  it('is stable with respect to the priority field for already-ordered input', () => {
    const rules = [
      rule({ id: 'first', priority: 1 }),
      rule({ id: 'second', priority: 2 }),
      rule({ id: 'third', priority: 3 }),
    ];
    expect(sortRules(rules).map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('does not mutate the input array', () => {
    const rules = [rule({ id: 'b', priority: 2 }), rule({ id: 'a', priority: 1 })];
    const original = [...rules];
    sortRules(rules);
    expect(rules).toEqual(original);
  });
});
