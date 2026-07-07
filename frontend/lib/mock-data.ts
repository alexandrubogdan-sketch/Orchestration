import type {
  Customer,
  CustomerPaymentMethod,
  DashboardKpis,
  DeclineBreakdownRow,
  EntityBreakdownRow,
  Integration,
  Payment,
  PaymentMethodKind,
  PaymentState,
  PaymentTimelineEvent,
  Plan,
  RetryAttempt,
  RetryAttemptOutcome,
  TeamInvite,
  TeamMember,
  TeamRole,
  VolumePoint,
  Workflow,
} from "./types";
import { COUNTRIES } from "./countries";

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

const CARD_BRANDS = ["visa", "mastercard", "amex", "discover"];
const WALLET_BRANDS = ["apple_pay", "google_pay"];
/** Weighted toward a handful of common issuer countries, with a long
 *  tail across the full ISO-3166 list — matches how a real customer
 *  base skews geographically without making every country equally
 *  likely (docs/design.md's routing examples lean US/EU-heavy too). */
const COMMON_CUSTOMER_COUNTRIES = ["US", "GB", "DE", "FR", "CA", "AU", "NL", "ES", "BR", "IN"];

function randomCountry(rng: Rng): string {
  if (rng() < 0.72) return pick(rng, COMMON_CUSTOMER_COUNTRIES);
  return pick(rng, COUNTRIES).code;
}

function buildPaymentMethod(rng: Rng, id: string): CustomerPaymentMethod {
  const type: PaymentMethodKind = rng() < 0.8 ? "card" : rng() < 0.85 ? "wallet" : "bank_transfer";
  const pspAccount = pick(rng, PSP_ACCOUNTS);
  if (type === "card") {
    return {
      id,
      type,
      pspAccount,
      isActive: rng() < 0.9,
      cardBrand: pick(rng, CARD_BRANDS),
      cardLast4: String(randInt(rng, 1000, 9999)),
      cardExpMonth: randInt(rng, 1, 12),
      cardExpYear: new Date().getFullYear() + randInt(rng, 0, 4),
    };
  }
  if (type === "wallet") {
    return {
      id,
      type,
      pspAccount,
      isActive: rng() < 0.9,
      cardBrand: pick(rng, WALLET_BRANDS),
      cardLast4: String(randInt(rng, 1000, 9999)),
    };
  }
  return { id, type, pspAccount, isActive: rng() < 0.9 };
}

function buildMockCustomers(count: number): Customer[] {
  const rng = mulberry32(99);
  const customers: Customer[] = [];
  for (let i = 0; i < count; i++) {
    const id = `cus_${(200000 + i).toString(36)}`;
    const methodCount = randInt(rng, 1, 3);
    const paymentMethods: CustomerPaymentMethod[] = [];
    for (let m = 0; m < methodCount; m++) {
      paymentMethods.push(buildPaymentMethod(rng, `${id}_pm${m + 1}`));
    }
    customers.push({
      id,
      merchantEntity: rng() < 0.7 ? "US-LLC" : "EU-BV",
      email: randomEmail(rng),
      externalRef: rng() < 0.6 ? `ext_${randInt(rng, 100000, 999999)}` : undefined,
      country: randomCountry(rng),
      createdAt: daysAgoIso(randInt(rng, 30, 400), rng),
      paymentMethods,
    });
  }
  return customers;
}

let cachedCustomers: Customer[] | undefined;
export function getMockCustomers(count = 60): Customer[] {
  cachedCustomers ??= buildMockCustomers(count);
  return cachedCustomers;
}

export function getMockCustomerById(id: string): Customer | undefined {
  return getMockCustomers().find((c) => c.id === id);
}

export function getMockPaymentsForCustomer(customerId: string): Payment[] {
  return getMockPayments().filter((p) => p.customerId === customerId);
}

function buildMockPayments(count: number): Payment[] {
  const rng = mulberry32(42);
  const customers = getMockCustomers();
  const payments: Payment[] = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = randInt(rng, 0, 29);
    const isDeclined = rng() < 0.14;
    const state: PaymentState = isDeclined
      ? "declined"
      : pick(rng, TERMINAL_STATES.filter((s) => s !== "declined"));
    const decline = isDeclined ? pick(rng, DECLINE_CODES) : undefined;
    const createdAt = daysAgoIso(daysAgo, rng);
    const customer = pick(rng, customers);

    payments.push({
      id: `pay_${(100000 + i).toString(36)}`,
      merchantEntity: customer.merchantEntity,
      product: pick(rng, PRODUCTS),
      customerId: customer.id,
      customerEmail: customer.email,
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

/** Seed plan catalog — a mix of recurring and one-off plans covering
 *  base pricing, per-country/currency override rules, a mirrored trial
 *  block, and every tax-collection mode, so the Plans page has realistic
 *  data to exercise the richer plan model against. */
export function defaultPlans(): Plan[] {
  return [
    {
      id: "plan-pro-monthly",
      name: "Pro Monthly",
      type: "recurring",
      billingIntervalUnit: "months",
      billingIntervalCount: 1,
      prices: [{ id: "price-pro-default", currency: "USD", amountMinorUnits: 2999, country: "ALL" }],
      rules: [
        { id: "rule-pro-ca", currency: "CAD", countries: ["CA"], amountMinorUnits: 3399 },
        { id: "rule-pro-gb", currency: "GBP", countries: ["GB"], amountMinorUnits: 2499 },
        {
          id: "rule-pro-eu",
          currency: "EUR",
          countries: ["DE", "FR", "ES", "IT", "NL"],
          amountMinorUnits: 2799,
        },
      ],
      trial: {
        enabled: true,
        intervalUnit: "days",
        intervalCount: 7,
        prices: [{ id: "trial-pro-default", currency: "USD", amountMinorUnits: 0, country: "ALL" }],
        rules: [],
      },
      taxCollection: "global",
      createdAt: daysAgoIso(180, mulberry32(1)),
      updatedAt: daysAgoIso(12, mulberry32(1)),
    },
    {
      id: "plan-pro-annual",
      name: "Pro Annual",
      type: "recurring",
      billingIntervalUnit: "years",
      billingIntervalCount: 1,
      prices: [{ id: "price-annual-default", currency: "USD", amountMinorUnits: 29900, country: "ALL" }],
      rules: [{ id: "rule-annual-eu", currency: "EUR", countries: ["DE"], amountMinorUnits: 27900 }],
      trial: {
        enabled: false,
        intervalUnit: "days",
        intervalCount: 0,
        prices: [],
        rules: [],
      },
      taxCollection: "enabled",
      createdAt: daysAgoIso(150, mulberry32(2)),
      updatedAt: daysAgoIso(150, mulberry32(2)),
    },
    {
      id: "plan-starter",
      name: "Starter Monthly",
      type: "recurring",
      billingIntervalUnit: "months",
      billingIntervalCount: 1,
      prices: [{ id: "price-starter-default", currency: "USD", amountMinorUnits: 999, country: "ALL" }],
      rules: [],
      trial: {
        enabled: true,
        intervalUnit: "days",
        intervalCount: 14,
        prices: [{ id: "trial-starter-default", currency: "USD", amountMinorUnits: 0, country: "ALL" }],
        rules: [
          { id: "rule-trial-starter-in", currency: "INR", countries: ["IN"], amountMinorUnits: 0 },
        ],
      },
      taxCollection: "global",
      createdAt: daysAgoIso(90, mulberry32(3)),
      updatedAt: daysAgoIso(30, mulberry32(3)),
    },
    {
      id: "plan-lifetime-setup",
      name: "One-Time Setup Fee",
      type: "one-off",
      billingIntervalUnit: "months",
      billingIntervalCount: 1,
      prices: [{ id: "price-setup-default", currency: "USD", amountMinorUnits: 19900, country: "ALL" }],
      rules: [{ id: "rule-setup-gb", currency: "GBP", countries: ["GB", "IE"], amountMinorUnits: 15900 }],
      trial: {
        enabled: false,
        intervalUnit: "days",
        intervalCount: 0,
        prices: [],
        rules: [],
      },
      taxCollection: "disabled",
      createdAt: daysAgoIso(60, mulberry32(4)),
      updatedAt: daysAgoIso(60, mulberry32(4)),
    },
  ];
}

/** Seed integrations catalog — docs.paynext.com/integrations/overview.
 *  Scoped to this backend's three built adapters (Stripe, Solidgate, PayPal). */
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
    {
      id: "integration-paypal",
      processor: "paypal",
      displayName: "PayPal",
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

/* ------------------------------------------------------------------ *
 * Team — no PayNext/backend model to mirror (see lib/types.ts's Team
 * section comment), so this is an original seed catalog sized like a
 * small payments team: a couple of admins/founders, a handful of
 * members, one support seat, plus a couple of outstanding invites.
 * ------------------------------------------------------------------ */

const TEAM_FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Priya",
  "Marcus",
  "Elena",
  "Sam",
  "Nina",
  "Diego",
  "Yuki",
  "Fatima",
];
const TEAM_LAST_NAMES = [
  "Bogdan",
  "Reyes",
  "Kapoor",
  "Chen",
  "Novak",
  "Osei",
  "Ivanova",
  "Silva",
  "Tanaka",
  "Haddad",
];

function buildMockTeamMembers(count: number): TeamMember[] {
  const rng = mulberry32(17);
  const roles: TeamRole[] = ["admin", "admin", "member", "member", "member", "member", "support"];
  const members: TeamMember[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    let name = `${pick(rng, TEAM_FIRST_NAMES)} ${pick(rng, TEAM_LAST_NAMES)}`;
    while (usedNames.has(name)) {
      name = `${pick(rng, TEAM_FIRST_NAMES)} ${pick(rng, TEAM_LAST_NAMES)}`;
    }
    usedNames.add(name);

    const slug = name.toLowerCase().replace(/\s+/g, ".");
    members.push({
      id: `team-${(300000 + i).toString(36)}`,
      name,
      email: `${slug}@alphapayments.dev`,
      role: i === 0 ? "admin" : pick(rng, roles),
      joinedAt: daysAgoIso(randInt(rng, 20, 500), rng),
    });
  }
  return members;
}

let cachedTeamMembers: TeamMember[] | undefined;
export function getMockTeamMembers(count = 7): TeamMember[] {
  cachedTeamMembers ??= buildMockTeamMembers(count);
  return cachedTeamMembers;
}

function buildMockTeamInvites(count: number): TeamInvite[] {
  const rng = mulberry32(23);
  const roles: TeamRole[] = ["member", "member", "support", "admin"];
  const inviters = getMockTeamMembers().filter((m) => m.role === "admin");
  const invites: TeamInvite[] = [];

  for (let i = 0; i < count; i++) {
    const daysAgo = randInt(rng, 1, 20);
    invites.push({
      id: `invite-${(400000 + i).toString(36)}`,
      email: randomEmail(rng),
      role: pick(rng, roles),
      invitedAt: daysAgoIso(daysAgo, rng),
      invitedBy: inviters.length ? pick(rng, inviters).name : "Alex Bogdan",
      status: daysAgo > 14 ? "expired" : "pending",
    });
  }
  return invites;
}

let cachedTeamInvites: TeamInvite[] | undefined;
export function getMockTeamInvites(count = 3): TeamInvite[] {
  cachedTeamInvites ??= buildMockTeamInvites(count);
  return cachedTeamInvites;
}

/* ------------------------------------------------------------------ *
 * Retries — "Recent retry attempts" table on the Retries tab under
 * Workflows (app/workflows/retries/page.tsx). Each row is a dunning-
 * ladder rung that actually fired against one of the existing mock
 * payments (getMockPayments()), so payment id links on this table lead
 * to a real (mock) payment detail page — same cross-reference pattern
 * getMockPaymentsForCustomer already establishes between customers and
 * payments.
 * ------------------------------------------------------------------ */

const RETRY_ATTEMPT_OUTCOME_WEIGHTS: { outcome: RetryAttemptOutcome; weight: number }[] = [
  { outcome: "declined", weight: 0.55 },
  { outcome: "succeeded", weight: 0.3 },
  { outcome: "failed", weight: 0.15 },
];

function pickWeightedOutcome(rng: Rng): RetryAttemptOutcome {
  const roll = rng();
  let cumulative = 0;
  for (const { outcome, weight } of RETRY_ATTEMPT_OUTCOME_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) return outcome;
  }
  return RETRY_ATTEMPT_OUTCOME_WEIGHTS.at(-1)!.outcome;
}

function buildMockRetryAttempts(count: number): RetryAttempt[] {
  const rng = mulberry32(31);
  // Retries only ever fire against a payment that has already declined
  // once — mirroring the real dunning ladder's own precondition (only a
  // subscription's failed renewal enters dunning at all; see the real
  // backend's internal/subscriptions/dunning.go doc comment). Falls
  // back to the full payment set if fewer than `count` declines exist
  // in the current mock dataset, so this never renders an empty table.
  const declinedPayments = getMockPayments().filter((p) => p.state === "declined");
  const sourcePayments = declinedPayments.length > 0 ? declinedPayments : getMockPayments();

  const attempts: RetryAttempt[] = [];
  for (let i = 0; i < count; i++) {
    const payment = pick(rng, sourcePayments);
    attempts.push({
      id: `retry_${(500000 + i).toString(36)}`,
      paymentId: payment.id,
      attemptNumber: randInt(rng, 1, 4),
      pspAccount: pick(rng, PSP_ACCOUNTS),
      outcome: pickWeightedOutcome(rng),
      occurredAt: daysAgoIso(randInt(rng, 0, 10), rng),
    });
  }
  return attempts.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
}

let cachedRetryAttempts: RetryAttempt[] | undefined;
export function getMockRetryAttempts(count = 24): RetryAttempt[] {
  cachedRetryAttempts ??= buildMockRetryAttempts(count);
  return cachedRetryAttempts;
}
