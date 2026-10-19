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

  reason: string;
}

export class NoRoutablePspAccountError extends Error {
  constructor(productId: string) {
    super(`No routable psp_account found for product ${productId}`);
    this.name = 'NoRoutablePspAccountError';
  }
}
