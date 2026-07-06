/**
 * Milestone 5 — config-driven PSP selection. See docs/design.md §4 for
 * the data-model rationale and docs/adr/0007-routing-rules-engine.md
 * for why this replaces src/api/routing.ts's Milestone 4 stub.
 */

/**
 * Optional allow-lists a rule can match on. An empty/absent field means
 * "matches anything" for that dimension — a rule with `match: {}`
 * matches every attempt routed to its product/entity scope.
 */
export interface RoutingMatchCriteria {
  currency?: string[];
  citMit?: Array<'cit' | 'mit'>;
  paymentMethodType?: string[];
}

export interface RoutingRule {
  id: string;
  merchantEntityId: string;
  productId: string | null;
  priority: number;
  isEnabled: boolean;
  match: RoutingMatchCriteria;
  pspAccountId: string;
  fallbackPspAccountId: string | null;
  description: string | null;
}

export interface RoutingInput {
  productId: string;
  currency: string;
  citMit: 'cit' | 'mit';
  paymentMethodType: string;
}

export interface RoutingDecision {
  strategy: 'rule-match' | 'naive-fallback';
  ruleId: string | null;
  pspAccountId: string;
  psp: string;
  /** Human-readable — surfaced in payments.routing_decision for support/debugging. */
  reason: string;
}

export class NoRoutablePspAccountError extends Error {
  constructor(productId: string) {
    super(`No routable psp_account found for product ${productId}`);
    this.name = 'NoRoutablePspAccountError';
  }
}
