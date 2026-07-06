import type {
  DashboardKpis,
  DeclineBreakdownRow,
  EntityBreakdownRow,
  Integration,
  Payment,
  PaymentState,
  PaymentTimelineEvent,
  Plan,
  VolumePoint,
  Workflow,
} from "./types";

/**
 * Deterministic PRNG (mulberry32). Every generator below creates its
 * OWN local instance (seeded explicitly, or derived from a stable id)
 * rather than sharing one module-level generator — a shared generator's
 * cursor would advance differently depending on call order/count across
 * requests, so the same payment id could produce different-looking data
 * on the list page vs. its own detail page. Each generator being
 * self-seeded means "generate payment X's data" is a pure function of
 * X alone.
 */
function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

type Rng = () => number;
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const randInt = (rng: Rng, min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;

const PRODUCTS = ["Pro Subscription", "One-Time Credits", "EU Pro Subscription"];
const PSP_ACCOUNTS = ["Stripe (US test mode)", "Mock PSP", "Stripe (EU test mode)"];
const DOMAINS = ["acme.io", "gmail.com", "outlook.com", "proton.me", "corp.example"];

const DECLINE_CODES = [
  { normalizedCode: "insufficient_funds", category: "soft" },
  { normalizedCode: "do_not_honor", category: "soft" },
  { normalizedCode: "stolen_card", category: "hard" },
  { normalizedCode: "expired_card", category: "hard" },
  { normalizedCode: "authentication_required", category: "authentication" },
  { normalizedCode: "issuer_not_available", category: "technical" },
  { normalizedCode: "fraudulent", category: "fraud" },
];

const TERMINAL_STATES: PaymentState[] = ["captured", "settled", "declined", "refunded", "voided"];

function randomEmail(rng: Rng): string {
  return `customer${randInt(rng, 1000, 9999)}@${pick(rng, DOMAINS)}`;
}

function daysAgoIso(days: number, rng: Rng, hourJitter = 24): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(randInt(rng, 0, hourJitter - 1), randInt(rng, 0, 59), 0, 0);
  return d.toISOString();
}

function buildMockPayments(count: number): Payment[] {
  const rng = mulberry32(42);
  const payments: Payment[] = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = randInt(rng, 0, 29);
    const isDeclined = rng() < 0.14;
    const state: PaymentState = isDeclined
      ? "declined"
      : pick(rng, TERMINAL_STATES.filter((s) => s !== "declined"));
    const decline = isDeclined ? pick(rng, DECLINE_CODES) : undefined;
    const createdAt = daysAgoIso(daysAgo, rng);

    payments.push({
      id: `pay_${(100000 + i).toString(36)}`,
      merchantEntity: rng() < 0.7 ? "US-LLC" : "EU-BV",
      product: pick(rng, PRODUCTS),
      customerEmail: randomEmail(rng),
      amountMinorUnits: randInt(rng, 499, 24999),
      currency: rng() < 0.75 ? "USD" : "EUR",
      state,
      citMit: rng() < 0.65 ? "cit" : "mit",
      pspAccount: pick(rng, PSP_ACCOUNTS),
      declineCode: decline?.normalizedCode,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return payments.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Memoized: computed once per server process so a payment id looked up
// from the detail page (a separate request from the list page) resolves
// to the exact same record instead of a freshly-regenerated one.
let cachedPayments: Payment[] | undefined;
export function getMockPayments(count = 180): Payment[] {
  cachedPayments ??= buildMockPayments(count);
  return cachedPayments;
}

export function getMockPaymentById(id: string): Payment | undefined {
  return getMockPayments().find((p) => p.id === id);
}

export function generateTimelineFor(payment: Payment): PaymentTimelineEvent[] {
  const rng = mulberry32(hashString(payment.id));
  const events: PaymentTimelineEvent[] = [
    { id: `${payment.id}-1`, type: "started", occurredAt: payment.createdAt },
  ];
  if (rng() < 0.15) {
    events.push({
      id: `${payment.id}-2`,
      type: "authentication_required",
      occurredAt: payment.createdAt,
    });
  }
  events.push({ id: `${payment.id}-3`, type: "authorized", occurredAt: payment.createdAt });

  if (payment.state === "declined") {
    events.push({
      id: `${payment.id}-4`,
      type: "declined",
      occurredAt: payment.updatedAt,
      declineCode: payment.declineCode,
    });
    return events;
  }

  events.push({ id: `${payment.id}-4`, type: "captured", occurredAt: payment.updatedAt });
  if (payment.state === "settled") {
    events.push({ id: `${payment.id}-5`, type: "settled", occurredAt: payment.updatedAt });
  }
  if (payment.state === "refunded") {
    events.push({ id: `${payment.id}-5`, type: "refund_pending", occurredAt: payment.updatedAt });
    events.push({ id: `${payment.id}-6`, type: "refunded", occurredAt: payment.updatedAt });
  }
  return events;
}

export function computeDashboardKpis(payments: Payment[]): DashboardKpis {
  const declined = payments.filter((p) => p.state === "declined").length;
  const approved = payments.length - declined;
  const volumeMinorUnits = payments
    .filter((p) => p.state !== "declined")
    .reduce((sum, p) => sum + p.amountMinorUnits, 0);

  return {
    approvalRate: (approved / payments.length) * 100,
    approvalRateDelta: 1.4,
    declineRate: (declined / payments.length) * 100,
    declineRateDelta: -0.8,
    volumeMinorUnits,
    volumeCurrency: "USD",
    volumeDelta: 6.2,
    activeDisputes: payments.filter((p) => p.state === "dispute_opened").length + 2,
  };
}

export function computeVolumeSeries(payments: Payment[]): VolumePoint[] {
  const days = 14;
  const rng = mulberry32(7);
  const points: VolumePoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dateStr = daysAgoIso(i, rng).slice(0, 10);
    const dayPayments = payments.filter((p) => p.createdAt.slice(0, 10) === dateStr);
    const declined = dayPayments.filter((p) => p.state === "declined").length;
    const volume = dayPayments
      .filter((p) => p.state !== "declined")
      .reduce((sum, p) => sum + p.amountMinorUnits, 0);
    points.push({
      date: dateStr,
      volumeMinorUnits: volume,
      approvalRate:
        dayPayments.length > 0 ? ((dayPayments.length - declined) / dayPayments.length) * 100 : 100,
    });
  }
  return points;
}

export function computeDeclineBreakdown(payments: Payment[]): DeclineBreakdownRow[] {
  const declined = payments.filter((p) => p.state === "declined" && p.declineCode);
  const counts = new Map<string, number>();
  for (const p of declined) {
    counts.set(p.declineCode!, (counts.get(p.declineCode!) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([normalizedCode, count]) => ({
      normalizedCode,
      category: DECLINE_CODES.find((d) => d.normalizedCode === normalizedCode)?.category ?? "unmapped",
      count,
      share: (count / Math.max(declined.length, 1)) * 100,
    }))
    .sort((a, b) => b.count - a.count);
}

export function computeEntityBreakdown(payments: Payment[]): EntityBreakdownRow[] {
  return (["US-LLC", "EU-BV"] as const).map((entity) => {
    const rows = payments.filter((p) => p.merchantEntity === entity);
    const declined = rows.filter((p) => p.state === "declined").length;
    const volume = rows
      .filter((p) => p.state !== "declined")
      .reduce((sum, p) => sum + p.amountMinorUnits, 0);
    return {
      entity,
      volumeMinorUnits: volume,
      approvalRate: rows.length ? ((rows.length - declined) / rows.length) * 100 : 0,
      declineRate: rows.length ? (declined / rows.length) * 100 : 0,
    };
  });
}

/** Seed plan catalog — docs.paynext.com/guides/platform/plans. */
export function defaultPlans(): Plan[] {
  return [
    {
      id: "plan-pro-monthly",
      name: "Pro Monthly",
      billingIntervalUnit: "months",
      billingIntervalCount: 1,
      prices: [
        { id: "price-pro-default", currency: "USD", amountMinorUnits: 2999, country: "ALL" },
        { id: "price-pro-ca", currency: "CAD", amountMinorUnits: 3399, country: "CA" },
        { id: "price-pro-gb", currency: "GBP", amountMinorUnits: 2499, country: "GB" },
      ],
      trial: {
        enabled: true,
        intervalUnit: "days",
        intervalCount: 7,
        prices: [{ id: "trial-pro-default", currency: "USD", amountMinorUnits: 0, country: "ALL" }],
      },
      createdAt: daysAgoIso(180, mulberry32(1)),
    },
    {
      id: "plan-pro-annual",
      name: "Pro Annual",
      billingIntervalUnit: "years",
      billingIntervalCount: 1,
      prices: [
        { id: "price-annual-default", currency: "USD", amountMinorUnits: 29900, country: "ALL" },
        { id: "price-annual-eu", currency: "EUR", amountMinorUnits: 27900, country: "DE" },
      ],
      trial: { enabled: false, intervalUnit: "days", intervalCount: 0, prices: [] },
      createdAt: daysAgoIso(150, mulberry32(2)),
    },
    {
      id: "plan-starter",
      name: "Starter Monthly",
      billingIntervalUnit: "months",
      billingIntervalCount: 1,
      prices: [{ id: "price-starter-default", currency: "USD", amountMinorUnits: 999, country: "ALL" }],
      trial: {
        enabled: true,
        intervalUnit: "days",
        intervalCount: 14,
        prices: [{ id: "trial-starter-default", currency: "USD", amountMinorUnits: 0, country: "ALL" }],
      },
      createdAt: daysAgoIso(90, mulberry32(3)),
    },
  ];
}

/** Seed integrations catalog — docs.paynext.com/integrations/overview.
 *  Scoped to this backend's two built adapters (Stripe, Solidgate). */
export function defaultIntegrations(): Integration[] {
  return [
    {
      id: "integration-stripe",
      processor: "stripe",
      displayName: "Stripe",
      status: "connected",
      connectedAt: daysAgoIso(120, mulberry32(4)),
      mode: "sandbox",
      credentialPreviews: {
        publishableKey: "pk_test_51NxQ2K...",
        secretKey: "••••4242",
        webhookSecret: "••••9f01",
      },
      descriptors: ["ACME DIGITAL", "ACME* SUBSCRIPTION"],
    },
    {
      id: "integration-solidgate",
      processor: "solidgate",
      displayName: "Solidgate",
      status: "not_connected",
    },
  ];
}

/** Seed workflows — docs.paynext.com/guides/platform/workflows. Each
 *  payment method can have at most one workflow (same constraint
 *  PayNext enforces), matching the trigger's 1:1 tie to a payment
 *  method. */
export function defaultWorkflows(): Workflow[] {
  return [
    {
      id: "workflow-cards",
      name: "Cards — primary routing",
      paymentMethod: "cards",
      state: "published",
      updatedAt: daysAgoIso(2, mulberry32(5)),
      nodes: [
        { id: "node-trigger", kind: "trigger", paymentMethod: "cards" },
        {
          id: "node-condition-eu",
          kind: "condition",
          condition: { parameter: "issuer_country", operator: "one_of", value: "DE,FR,NL,ES" },
        },
        {
          id: "node-action-eu",
          kind: "action",
          action: {
            type: "authorize_payment",
            processor: "stripe",
            fallbackProcessor: "solidgate",
            threeDsMode: "adaptive",
            useCitProcessor: false,
          },
        },
        {
          id: "node-action-default",
          kind: "action",
          action: {
            type: "authorize_payment",
            processor: "stripe",
            fallbackProcessor: "none",
            threeDsMode: "frictionless",
            useCitProcessor: true,
          },
        },
      ],
    },
    {
      id: "workflow-apple-pay",
      name: "Apple Pay — default",
      paymentMethod: "apple_pay",
      state: "draft",
      updatedAt: daysAgoIso(9, mulberry32(6)),
      nodes: [
        { id: "node-trigger", kind: "trigger", paymentMethod: "apple_pay" },
        {
          id: "node-action-1",
          kind: "action",
          action: { type: "authorize_payment", processor: "stripe", threeDsMode: "no_3ds" },
        },
      ],
    },
  ];
}
