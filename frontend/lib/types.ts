/**
 * Domain types mirrored from the backend (payment-orchestrator/src/domain
 * and src/db/types.ts) where a live equivalent exists. This frontend has
 * no live API yet — see lib/mock-data.ts for the fixtures every page
 * renders against. Keep these in sync with the backend's canonical
 * definitions by hand until a shared package/OpenAPI client exists.
 *
 * The Workflow / Plan / Integration models below are modeled directly on
 * PayNext's dashboard (docs.paynext.com/guides/platform/{workflows,plans}
 * and docs.paynext.com/integrations/overview) rather than on this
 * backend's own routing_rules/subscriptions tables — see each section's
 * comment for the specific doc pages used, and the frontend README for
 * the reconciliation gap this creates against the actual backend schema.
 */

export const PAYMENT_STATES = [
  "created",
  "requires_action",
  "authorizing",
  "authorized",
  "capturing",
  "captured",
  "refund_pending",
  "refunded",
  "dispute_opened",
  "dispute_won",
  "dispute_lost",
  "declined",
  "voided",
  "failed",
  "settled",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export type CitMit = "cit" | "mit";

export interface Payment {
  id: string;
  merchantEntity: "US-LLC" | "EU-BV";
  product: string;
  /** FK into Customer — see lib/mock-data.ts's getMockCustomerById. */
  customerId: string;
  customerEmail: string;
  amountMinorUnits: number;
  currency: string;
  state: PaymentState;
  citMit: CitMit;
  pspAccount: string;
  declineCode?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Customers — modeled on the backend's actual schema
 * (payment-orchestrator/db/migrations/*_core-schema.cjs), NOT on
 * PayNext's reference model like Workflows/Plans/Integrations above,
 * since the backend's customers/payment_methods tables are already the
 * real spec here: `customers` (id, merchant_entity_id, external_ref,
 * email) and `payment_methods` (customer_id, psp_account_id, type,
 * card_brand, card_last4, card_exp_month/year, is_active) — token refs
 * and display-safe card metadata only, never a PAN/CVV
 * (Non-negotiable #8). "Location" surfaces the payment's
 * issuer_country (from the card network, i.e. the BIN) rather than a
 * postal address, since that's the only geo signal the real schema
 * captures anywhere near a customer — see docs/adr's workflow
 * conditions (`issuer_country`, `customer_country`) for the same
 * distinction.
 * ------------------------------------------------------------------ */

export const PAYMENT_METHOD_KINDS = ["card", "wallet", "apm", "bank_transfer"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface CustomerPaymentMethod {
  id: string;
  type: PaymentMethodKind;
  pspAccount: string;
  isActive: boolean;
  /** card-type only — display-safe metadata PSPs return alongside the token. */
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
}

/**
 * Billing address captured at checkout — display-only, mirrors what a
 * PSP's customer object typically carries alongside a payment method
 * (street/city/postal/country), not a KYC-verified identity record.
 * Surfaced on the Customers detail page's raw-payload JSON viewer.
 */
export interface CustomerAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
}

/** A customer's link to a Plan (see Plans catalog below) — kept as its
 *  own nested object (rather than flattened fields on Customer) so the
 *  raw-payload JSON viewer groups cleanly into customer / subscription
 *  / paymentMethods sections, mirroring how a real API response would
 *  separate these concerns instead of returning one flat blob. */
export const CUSTOMER_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled"] as const;
export type CustomerSubscriptionStatus = (typeof CUSTOMER_SUBSCRIPTION_STATUSES)[number];

export interface CustomerSubscription {
  id: string;
  planId: string;
  planName: string;
  status: CustomerSubscriptionStatus;
  createdAt: string;
}

export interface Customer {
  id: string;
  merchantEntity: "US-LLC" | "EU-BV";
  /** Full name as captured at checkout — display-only, same rationale as `address` below. */
  firstName: string;
  lastName: string;
  email: string;
  /** customers.external_ref — the product's own id for this customer, if supplied. */
  externalRef?: string;
  /** Derived from the customer's payments' issuer_country/customer_country — see doc comment above. */
  country: string;
  city?: string;
  address: CustomerAddress;
  createdAt: string;
  subscription: CustomerSubscription;
  paymentMethods: CustomerPaymentMethod[];
}

/** Stable timeline event names — docs/design.md §1.2 / SPEC.md T4.3. */
export type TimelineEventType =
  | "started"
  | "authentication_required"
  | "authorized"
  | "pending"
  | "captured"
  | "declined"
  | "refund_pending"
  | "refunded"
  | "settled"
  | "dispute_opened"
  | "dispute_closed"
  | "late_event"
  | "invariant_violation";

export interface PaymentTimelineEvent {
  id: string;
  type: TimelineEventType;
  occurredAt: string;
  declineCode?: string;
  detail?: string;
}

export interface DashboardKpis {
  approvalRate: number;
  approvalRateDelta: number;
  declineRate: number;
  declineRateDelta: number;
  volumeMinorUnits: number;
  volumeCurrency: string;
  volumeDelta: number;
  activeDisputes: number;
}

export interface VolumePoint {
  date: string;
  volumeMinorUnits: number;
  approvalRate: number;
}

export interface DeclineBreakdownRow {
  normalizedCode: string;
  category: string;
  count: number;
  share: number;
}

export interface EntityBreakdownRow {
  entity: "US-LLC" | "EU-BV";
  volumeMinorUnits: number;
  approvalRate: number;
  declineRate: number;
}

/* ------------------------------------------------------------------ *
 * Workflows — modeled on docs.paynext.com/guides/platform/workflows
 * and docs.paynext.com/guides/payments/3d-secure, and (2026-07-09)
 * re-built to match the real client's (AlphaPayments-client, the
 * production Next.js app this demo mirrors) actual canvas 1:1: a real
 * node graph (`nodes[]` + `edges[]`, not an implicit linear chain),
 * a Condition node that can hold multiple side-by-side condition
 * *blocks* (each its own branch, each with its own outgoing handle —
 * see WorkflowConditionBlock), and a Split node for percentage-based
 * fan-out (see WorkflowSplitBranch). Config for a condition block or
 * action lives behind a modal opened from the node's popover menu,
 * exactly like the real client, rather than inline in the card body.
 *
 * Deliberate simplification versus the real client, stated plainly:
 * each condition block here is a single parameter/operator/value
 * check (WorkflowCondition), not the real client's further-nested
 * AND/OR "condition groups" of multiple fields per block — that's a
 * materially bigger domain model change than the canvas UI/UX this
 * pass targets. There's also no separate read-only "view" route for
 * past workflow versions (see workflow-history-list.tsx instead) —
 * this demo's canvas is always editable.
 * ------------------------------------------------------------------ */

export const PAYMENT_METHOD_TYPES = ["cards", "apple_pay", "google_pay"] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodType, string> = {
  cards: "Cards",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
};

/** docs.paynext.com/guides/platform/workflows — "Conditions" table. */
export const WORKFLOW_CONDITION_PARAMETERS = [
  "transaction_type",
  "bin",
  "card_network",
  "issuer_country",
  "currency",
  "issuer_name",
  "customer_country",
  "metadata",
  "cit_processor",
] as const;
export type WorkflowConditionParameter = (typeof WORKFLOW_CONDITION_PARAMETERS)[number];

export const WORKFLOW_CONDITION_LABELS: Record<WorkflowConditionParameter, string> = {
  transaction_type: "Transaction type (CIT / MIT)",
  bin: "BIN (card range)",
  card_network: "Card network",
  issuer_country: "Issuer country code",
  currency: "Currency",
  issuer_name: "Issuer name",
  customer_country: "Customer country",
  metadata: "Metadata",
  cit_processor: "CIT processor",
};

export const WORKFLOW_OPERATORS = ["equals", "not_equals", "one_of", "is_in_list"] as const;
export type WorkflowOperator = (typeof WORKFLOW_OPERATORS)[number];

export interface WorkflowCondition {
  parameter: WorkflowConditionParameter;
  /** Only used when parameter === "metadata" — dot-notation key, e.g. "workflow.experiment_variant". */
  metadataKey?: string;
  operator: WorkflowOperator;
  value: string;
}

/** One branch inside a Condition node's canvas card — matches the real
 *  client's side-by-side condition "blocks" (condition-node-content.
 *  component.tsx): each has its own title, its own WorkflowCondition,
 *  and its own outgoing handle (`id` doubles as the React Flow
 *  sourceHandle id so a Split-style multi-branch condition node can
 *  route each block to a different downstream node). */
export interface WorkflowConditionBlock {
  id: string;
  title: string;
  condition: WorkflowCondition;
}

/** One branch inside a Split node — percentage-based fan-out, matches
 *  the real client's split-node-content.component.tsx (label + % +
 *  progress bar). `value` is a percentage 0-100; all branches on one
 *  Split node must sum to 100 (enforced by the Split modal / rebalance
 *  helpers in lib/workflow-store.ts, not at the type level). */
export interface WorkflowSplitBranch {
  id: string;
  label: string;
  value: number;
}

/** docs.paynext.com/guides/platform/workflows — "Actions" table. */
export const WORKFLOW_ACTION_TYPES = [
  "authorize_payment",
  "settle_payment",
  "block_payment",
  "set_metadata",
  "delay",
] as const;
export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

export const WORKFLOW_ACTION_LABELS: Record<WorkflowActionType, string> = {
  authorize_payment: "Authorize payment",
  settle_payment: "Settle payment",
  block_payment: "Block payment",
  set_metadata: "Set metadata",
  delay: "Delay",
};

/** This product's three built PSP adapters (backend/src/adapters) — the
 *  processor choice for an Authorize Payment action. PayNext itself
 *  supports Stripe/Braintree/PayPal/Unlimit; scoped down to what this
 *  backend actually implements. */
export const PROCESSORS = ["stripe", "solidgate", "paypal"] as const;
export type ProcessorId = (typeof PROCESSORS)[number];
export const PROCESSOR_LABELS: Record<ProcessorId, string> = {
  stripe: "Stripe",
  solidgate: "Solidgate",
  paypal: "PayPal",
};

/** docs.paynext.com/guides/payments/3d-secure — "3DS Modes" table. */
export const THREE_DS_MODES = ["no_3ds", "adaptive", "frictionless"] as const;
export type ThreeDsMode = (typeof THREE_DS_MODES)[number];
export const THREE_DS_LABELS: Record<ThreeDsMode, string> = {
  no_3ds: "No 3DS",
  adaptive: "Adaptive 3DS",
  frictionless: "Frictionless 3DS",
};

/** 2026-07-13: delay capture used to only accept a raw number of
 *  seconds — fine for a quick test delay, unusable for a real capture
 *  window (e.g. "settle 3 days after authorization" meant typing
 *  259200). `delayUnit` lets the builder UI show/accept days, hours, or
 *  minutes instead; `delaySeconds` (below, on WorkflowAction) stays the
 *  single canonical stored value so every existing reader of
 *  `action.delaySeconds` (node-card summaries, height calc, etc.)
 *  keeps working unchanged — delayUnit only affects how the modal
 *  displays/edits that value, never how it's stored. */
export const DELAY_UNITS = ["minutes", "hours", "days"] as const;
export type DelayUnit = (typeof DELAY_UNITS)[number];
export const DELAY_UNIT_LABELS: Record<DelayUnit, string> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};
export const DELAY_UNIT_SECONDS: Record<DelayUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/** Picks the largest unit that divides totalSeconds evenly, so a
 *  saved delay (including older ones with no delayUnit recorded yet)
 *  displays as a clean whole number instead of defaulting to whatever
 *  unit happens to be listed first. Falls back to minutes — this
 *  product's delay actions are always configured in whole minutes at
 *  the very least (see defaultActionFor in lib/workflow-store.ts). */
export function bestDelayUnitFor(totalSeconds: number): DelayUnit {
  if (totalSeconds > 0 && totalSeconds % DELAY_UNIT_SECONDS.days === 0) return "days";
  if (totalSeconds > 0 && totalSeconds % DELAY_UNIT_SECONDS.hours === 0) return "hours";
  return "minutes";
}

/** Compact "1d 2h" / "45m" summary for the workflow-canvas node card
 *  (components/workflow/nodes.tsx's actionSummary) — capped at two
 *  units so it never overflows the card at large delays like "3d 4h
 *  15m 30s" would. */
export function formatDelayDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0m";
  const days = Math.floor(totalSeconds / DELAY_UNIT_SECONDS.days);
  const afterDays = totalSeconds % DELAY_UNIT_SECONDS.days;
  const hours = Math.floor(afterDays / DELAY_UNIT_SECONDS.hours);
  const afterHours = afterDays % DELAY_UNIT_SECONDS.hours;
  const minutes = Math.floor(afterHours / DELAY_UNIT_SECONDS.minutes);
  const seconds = afterHours % DELAY_UNIT_SECONDS.minutes;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && parts.length === 0) parts.push(`${seconds}s`);
  return parts.slice(0, 2).join(" ") || "0m";
}

export interface WorkflowAction {
  type: WorkflowActionType;
  /** authorize_payment */
  processor?: ProcessorId;
  fallbackProcessor?: ProcessorId | "none";
  threeDsMode?: ThreeDsMode;
  useCitProcessor?: boolean;
  /** set_metadata */
  metadataKey?: string;
  metadataValue?: string;
  metadataDestination?: "customer" | "payment" | "both";
  /** delay — delaySeconds is the canonical stored value; delayUnit is
   *  only the builder modal's last-used display unit (see this file's
   *  DELAY_UNITS doc comment above). */
  delaySeconds?: number;
  delayUnit?: DelayUnit;
}

export type WorkflowNodeKind = "trigger" | "condition" | "action" | "split";

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** trigger only */
  paymentMethod?: PaymentMethodType;
  /** condition only — one or more side-by-side branches (see
   *  WorkflowConditionBlock's own doc comment). */
  conditions?: WorkflowConditionBlock[];
  /** split only — two or more percentage branches summing to 100. */
  splits?: WorkflowSplitBranch[];
  action?: WorkflowAction;
}

/** A real graph edge — replaces the old "array order implies a linear
 *  chain" model so Condition/Split branches can each route to a
 *  different downstream node, matching the real client's canvas
 *  exactly. `sourceHandle` is set when the edge leaves a specific
 *  condition/split branch rather than a plain trigger/action node's
 *  single output. */
export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
}

export type WorkflowState = "draft" | "published";

export interface Workflow {
  id: string;
  name: string;
  paymentMethod: PaymentMethodType;
  state: WorkflowState;
  /** nodes[0] is always the trigger. Order beyond that is not
   *  meaningful — the graph structure lives entirely in `edges`. */
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Workflow detail tabs — Canvas / Runs / History on a single
 * workflow's own builder page (app/workflows/[id]/page.tsx), mirroring
 * the real client's module/workflow (singular) WorkflowTabsComponent
 * (element/tab/workflow-tabs.component.tsx: canvas/runs/history) —
 * distinct from the Workflows LIST page's own Workflows/Lists tab pair
 * in WorkflowsTab above.
 * ------------------------------------------------------------------ */

export const WORKFLOW_RUN_STATUSES = ["succeeded", "failed", "in_progress"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** One row on the workflow detail page's "Runs" tab — a single
 *  execution of this workflow's node chain against a real (mock)
 *  payment. `paymentId` links back to getMockPaymentById the same way
 *  RetryAttempt.paymentId already cross-references the payments table
 *  (see lib/mock-data.ts's Retries section doc comment). */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  /** FK into Payment — the payment whose "Payment Pending" trigger fired this run. */
  paymentId: string;
  startedAt: string;
  durationMs: number;
}

export const WORKFLOW_HISTORY_EVENT_TYPES = [
  "published",
  "draft_saved",
  "node_added",
  "node_removed",
  "node_edited",
  "reverted",
] as const;
export type WorkflowHistoryEventType = (typeof WORKFLOW_HISTORY_EVENT_TYPES)[number];

/** One row on the workflow detail page's "History" tab — a
 *  version/change event for this workflow, newest first. Loosely
 *  mirrors the real client's workflow_versions rows (version/status/
 *  author/date_published columns — see workflow-history.service.ts's
 *  workflowHistoryColumns) adapted to this frontend's mock-data-only
 *  model: `versionLabel` stands in for their numeric version, `detail`
 *  carries the human-readable description ("Node added: Authorize"). */
export interface WorkflowHistoryEvent {
  id: string;
  workflowId: string;
  type: WorkflowHistoryEventType;
  versionLabel: string;
  detail: string;
  actorName: string;
  occurredAt: string;
}

/* ------------------------------------------------------------------ *
 * Audience lists — the "Lists" tab that sits alongside Workflows in
 * the real client's own workflows module (its own module keeps a
 * `lists`/`workflows` tab pair backed by two separate table
 * endpoints). A list here is a named, reusable set of match values
 * (e.g. a set of ISO country codes, a set of BINs) meant to be
 * referenced from a workflow condition's "is in list" operator
 * (WORKFLOW_OPERATORS above already has `is_in_list`) instead of
 * hand-typing the same values into every condition that needs them.
 * This first pass is a visual/structural stand-in only — no
 * WorkflowCondition here actually resolves `is_in_list` against one of
 * these lists yet, see the frontend README known gaps for that wiring.
 * ------------------------------------------------------------------ */

/** What kind of values a list holds — mirrors the match parameters a
 *  workflow condition can already target (WORKFLOW_CONDITION_PARAMETERS)
 *  so a list is always usable as a drop-in value set for at least one
 *  real condition parameter. */
export const AUDIENCE_LIST_TYPES = ["country", "bin", "customer"] as const;
export type AudienceListType = (typeof AUDIENCE_LIST_TYPES)[number];

export const AUDIENCE_LIST_TYPE_LABELS: Record<AudienceListType, string> = {
  country: "Country",
  bin: "Card BIN",
  customer: "Customer",
};

export interface AudienceList {
  id: string;
  name: string;
  type: AudienceListType;
  /** Number of entries currently in the list (countries, BINs, customer ids). */
  entryCount: number;
  authorName: string;
  authorEmail: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Retries / dunning policy — mirrors the real Go backend's
 * `retry_settings` table (payment-orchestrator-go/db/migrations/
 * 1735777300000_retry-settings.up.sql) one-for-one: an ordered
 * "wait N hours, then retry" ladder, a max-attempts-per-payment cap,
 * and a minimum spacing (seconds) between attempts on the same payment.
 * Surfaced under Workflows (see app/workflows/retries/page.tsx) since
 * dunning IS a workflow — a linear sequence of wait/retry steps run
 * against a subscription's failed renewal, exactly like a
 * WorkflowNode chain is a linear sequence of condition/action steps
 * run against a payment.
 * ------------------------------------------------------------------ */

/** One rung of the dunning ladder: "wait `waitHours` hours after the
 *  previous attempt, then retry." `id` is a client-only key for the
 *  editable list (add/remove/reorder) — never sent to the backend,
 *  which only ever sees the plain `dunningLadderHours: number[]` array
 *  (see RetryPolicy's own doc comment and retry-settings-store.ts's
 *  toDunningLadderHours). */
export interface DunningLadderStep {
  id: string;
  waitHours: number;
}

/** Mirrors the real backend's retry_settings row shape exactly
 *  (payment-orchestrator-go/internal/api/retry_settings.go's
 *  RetrySettingsDTO): `dunningLadderHours`/`maxAttemptsPerPayment`/
 *  `minSpacingSeconds`, camelCase, same field names. `ladder` here is
 *  the client-side editable representation (DunningLadderStep[], with
 *  stable ids for list operations) rather than a plain number[] —
 *  retry-settings-store.ts's toDunningLadderHours/fromDunningLadderHours
 *  convert between the two at the store boundary, which is exactly
 *  where a real `PUT /v1/retry-settings` call would also need to
 *  serialize/deserialize, so this shape choice costs nothing extra when
 *  that wiring happens later. */
export interface RetryPolicy {
  ladder: DunningLadderStep[];
  maxAttemptsPerPayment: number;
  minSpacingSeconds: number;
}

/** The real backend's hardcoded fallback defaults
 *  (internal/routing/retrypolicy.go's DefaultRetryPolicy +
 *  internal/subscriptions/dunning.go's DunningLadderHours) — used both
 *  as this store's initial state and as the "Reset to defaults" action's
 *  target, so this frontend's default view matches what a merchant who
 *  has never configured retry settings would see from the real API's
 *  GET /v1/retry-settings (which falls back to these exact same three
 *  numbers when no row exists yet). */
export const DEFAULT_DUNNING_LADDER_HOURS = [24, 72, 168] as const;
export const DEFAULT_MAX_ATTEMPTS_PER_PAYMENT = 3;
export const DEFAULT_MIN_SPACING_SECONDS = 2;

export const RETRY_ATTEMPT_OUTCOMES = ["succeeded", "declined", "failed"] as const;
export type RetryAttemptOutcome = (typeof RETRY_ATTEMPT_OUTCOMES)[number];

/** One row in the "Recent retry attempts" mock table — a retry-ladder
 *  rung actually fired against a real (mock) payment. Not persisted
 *  anywhere; regenerated deterministically by
 *  lib/mock-data.ts#getMockRetryAttempts the same seeded way every
 *  other mock table in this app is (see that file's own top doc
 *  comment on why each generator seeds its own PRNG). */
export interface RetryAttempt {
  id: string;
  paymentId: string;
  attemptNumber: number;
  pspAccount: string;
  outcome: RetryAttemptOutcome;
  occurredAt: string;
}

/* ------------------------------------------------------------------ *
 * Plans — modeled on this vendor's own plans catalog UX (a recurring
 * vs. one-off type flag, a base price plus per-country/currency
 * override rules, a mirrored trial price/interval/rules block, and a
 * tax-collection toggle), adapted to this frontend's mock-data-only
 * architecture — see PriceOverrideRule's doc comment for how `rules`
 * relates to the pre-existing `prices`/`PriceRow` shape from the
 * original country-list pricing rows (still used as-is for the base
 * price + trial price editors; kept rather than replaced).
 * ------------------------------------------------------------------ */

export const BILLING_INTERVAL_UNITS = ["days", "months", "years"] as const;
export type BillingIntervalUnit = (typeof BILLING_INTERVAL_UNITS)[number];

export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

/** "All countries" is the default-price row; every other row is a
 *  country-specific override. Kept as ISO-3166 alpha-2 codes, free-text so
 *  any country can be entered, with "ALL" reserved for the default row. */
export const DEFAULT_PRICE_COUNTRY = "ALL";

export interface PriceRow {
  id: string;
  currency: string;
  amountMinorUnits: number;
  /** ISO-3166 alpha-2, or DEFAULT_PRICE_COUNTRY for "all countries". */
  country: string;
}

/** Plan type — a recurring subscription (has a billing interval) vs. a
 *  single one-off charge (no interval, no trial). */
export const PLAN_TYPES = ["recurring", "one-off"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** Tax collection mode for a plan: "global" defers to the account-level
 *  default, "enabled"/"disabled" force tax collection on or off for this
 *  plan specifically. */
export const TAX_COLLECTION_MODES = ["global", "enabled", "disabled"] as const;
export type TaxCollectionMode = (typeof TAX_COLLECTION_MODES)[number];
export const TAX_COLLECTION_LABELS: Record<TaxCollectionMode, string> = {
  global: "Global",
  enabled: "Enabled",
  disabled: "Disabled",
};

/** Per-country/currency price override rule — the richer analogue of a
 *  single PriceRow, but scoped to a *list* of countries per rule instead
 *  of one row per country (so "these 5 countries all pay EUR 9.99" is one
 *  rule, not five rows). This is additive to `prices`/`PriceRow` above:
 *  `prices` remains the simple one-row-per-country editor already used
 *  for the plan's base price and trial price; `rules` is the new,
 *  multi-country-per-rule override list requested for this feature. */
export interface PriceOverrideRule {
  id: string;
  currency: string;
  /** ISO-3166 alpha-2 codes this rule applies to. */
  countries: string[];
  amountMinorUnits: number;
}

export interface TrialConfig {
  enabled: boolean;
  intervalUnit: BillingIntervalUnit;
  intervalCount: number;
  prices: PriceRow[];
  /** Per-country/currency overrides for the trial price, mirroring the
   *  plan-level `rules` below. */
  rules: PriceOverrideRule[];
}

export interface Plan {
  id: string;
  name: string;
  type: PlanType;
  billingIntervalUnit: BillingIntervalUnit;
  billingIntervalCount: number;
  prices: PriceRow[];
  /** Per-country/currency overrides on top of `prices`' default row. */
  rules: PriceOverrideRule[];
  trial: TrialConfig;
  taxCollection: TaxCollectionMode;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Integrations — modeled on docs.paynext.com/integrations/overview.
 * ------------------------------------------------------------------ */

export type IntegrationStatus = "connected" | "not_connected";

export type IntegrationMode = "sandbox" | "production";

/** One processor needs more than one credential — confirmed against the
 *  backend's actual env schema (payment-orchestrator/src/config/schema.ts)
 *  and docs/adr/0011-solidgate-second-psp.md rather than guessed:
 *  Stripe = publishable key + secret key + webhook signing secret;
 *  Solidgate = public key + secret key + a *separate* webhook public/secret
 *  key pair (Solidgate signs webhooks with distinct wh_pk_/wh_sk_
 *  credentials from its api_pk_/api_sk_ API-call pair). `key` matches this
 *  frontend's camelCase convention, not the backend's SCREAMING_SNAKE env
 *  var name — see the trailing comment on each for the backend equivalent. */
export interface CredentialFieldSpec {
  key: string;
  label: string;
  placeholder: string;
  /** Password-masked in the connect form and redacted everywhere else. */
  secret: boolean;
}

export const PROCESSOR_CREDENTIAL_FIELDS: Record<ProcessorId, CredentialFieldSpec[]> = {
  stripe: [
    { key: "publishableKey", label: "Publishable key", placeholder: "pk_test_...", secret: false }, // STRIPE_PUBLISHABLE_KEY
    { key: "secretKey", label: "Secret key", placeholder: "sk_test_...", secret: true }, // STRIPE_SECRET_KEY
    { key: "webhookSecret", label: "Webhook signing secret", placeholder: "whsec_...", secret: true }, // STRIPE_WEBHOOK_SECRET
  ],
  solidgate: [
    { key: "publicKey", label: "Public key", placeholder: "api_pk_...", secret: false }, // SOLIDGATE_PUBLIC_KEY
    { key: "secretKey", label: "Secret key", placeholder: "api_sk_...", secret: true }, // SOLIDGATE_SECRET_KEY
    { key: "webhookPublicKey", label: "Webhook public key", placeholder: "wh_pk_...", secret: false }, // SOLIDGATE_WEBHOOK_PUBLIC_KEY
    { key: "webhookSecretKey", label: "Webhook secret key", placeholder: "wh_sk_...", secret: true }, // SOLIDGATE_WEBHOOK_SECRET_KEY
  ],
  paypal: [
    { key: "accountId", label: "Account ID", placeholder: "merchant@example.com or merchant ID", secret: false },
    { key: "clientId", label: "Client ID", placeholder: "AeA1QIZXiflr9...", secret: false },
    { key: "clientSecret", label: "Client Secret", placeholder: "EGnHDxD_qRPdaLdZz8i...", secret: true },
    { key: "webhookId", label: "Webhook ID", placeholder: "8PT597110X687430LKGECATA", secret: false },
  ],
};

export interface Integration {
  id: string;
  processor: ProcessorId;
  displayName: string;
  status: IntegrationStatus;
  connectedAt?: string;
  mode?: IntegrationMode;
  /** Masked previews only, keyed by CredentialFieldSpec.key — never a real
   *  secret. Non-secret fields (publishable/public keys) are shown in full
   *  since they're not sensitive by design. */
  credentialPreviews?: Record<string, string>;
  /** Statement/billing descriptors configured for this processor account —
   *  surfaced so the VAMP/Mastercard risk-monitoring dashboard can offer a
   *  per-descriptor filter. Settable at connect-time and via the Edit
   *  dialog on the Integrations page (components/integrations/
   *  connect-dialog.tsx); validated client-side against Stripe's
   *  documented 22-char dynamic statement-descriptor-suffix limit, the
   *  same rule the Go backend now enforces at the DB layer (see
   *  payment-orchestrator-go/db/migrations/
   *  1735777500000_psp-account-statement-descriptor.up.sql).
   *
   *  Honesty note: there is currently no backend psp-accounts API for
   *  this frontend to call — Integrations here are 100% local/mock
   *  (unlike Payments/Customers/Retries, which call the real backend in
   *  Live mode). This value is therefore stored client-side only, in
   *  lib/integration-store.ts. A future backend integration would read
   *  this same field to set `statement_descriptor_suffix` on the
   *  connected psp_account. */
  descriptors?: string[];
}

/* ------------------------------------------------------------------ *
 * Checkout — modeled on a real orchestrator client's Checkout
 * configurator module: a per-merchant list of payment methods (some
 * always-on and "locked" — e.g. Card can never be fully disabled —
 * most freely enabled/disabled and reorderable), a routing-conditions
 * panel for the selected method, and a live preview mounted with this
 * repo's own `@alphapayments/checkout-sdk` (payment-orchestrator-sdk),
 * fed the currently-enabled methods/order from local state below —
 * see app/checkout/page.tsx's top doc comment for exactly how the SDK
 * is wired without a real network call, matching this frontend's
 * mock-data-only convention.
 * ------------------------------------------------------------------ */

/** The payment methods this checkout configurator can toggle/reorder.
 *  `card` mirrors the real client's own "always active, can't be
 *  disabled" rule for card payments; every other method starts
 *  disabled. Kept independent of ProcessorId above — a payment
 *  *method* (what the customer sees/picks) is a different axis from a
 *  *processor* (which PSP account settles it), and only `card`'s
 *  conditions panel here offers processor routing. */
export const CHECKOUT_METHOD_TYPES = [
  "card",
  "paypal",
  "apple_pay",
  "google_pay",
  "cash_app",
] as const;
export type CheckoutMethodType = (typeof CHECKOUT_METHOD_TYPES)[number];

export const CHECKOUT_METHOD_LABELS: Record<CheckoutMethodType, string> = {
  card: "Card",
  paypal: "PayPal",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  cash_app: "Cash App",
};

/** Methods whose fixed country/currency requirement can make a
 *  configuration "invalid" if the merchant's own settings don't
 *  satisfy it — surfaced as the methods-list row's red tint, mirroring
 *  the real client's own per-method eligibility rules (e.g. Cash App is
 *  US + USD only). This sandbox flags a method invalid purely from its
 *  own mock condition state (see isMethodConfigInvalid in
 *  lib/mock-data.ts) rather than a real merchant-country lookup.
 *  (Cash App is permanently locked off — see getInitialCheckoutMethods
 *  — so this entry is currently inert, kept for when it's implemented.) */
export const CHECKOUT_METHOD_COUNTRY_LOCKS: Partial<Record<CheckoutMethodType, { country: string; currency: string }>> = {
  cash_app: { country: "US", currency: "USD" },
};

/** Only `card` supports full per-condition processor routing (split
 *  traffic across PSPs) in this simplified model — every other method
 *  routes through whichever single processor its own integration is
 *  connected to, so its conditions panel is the simpler inline
 *  enable/disable + one-line description shown in
 *  components/checkout/checkout-conditions.tsx. */
export const CHECKOUT_METHODS_WITH_PROCESSOR_ROUTING: CheckoutMethodType[] = ["card"];

export const CHECKOUT_CONDITION_MATCH_TYPES = ["equal", "not_equal", "one_of", "not_one_of"] as const;
export type CheckoutConditionMatchType = (typeof CHECKOUT_CONDITION_MATCH_TYPES)[number];

export const CHECKOUT_CONDITION_MATCH_LABELS: Record<CheckoutConditionMatchType, string> = {
  equal: "Equals",
  not_equal: "Does not equal",
  one_of: "One of",
  not_one_of: "Not one of",
};

/** A single routed processor split within a condition block (or the
 *  catch-all "merchant split" below it) — `sharePercent` values across
 *  one block/split should sum to 100, matching the real client's own
 *  percentage-split routing UI. */
export interface CheckoutProcessorSplit {
  id: string;
  processor: ProcessorId;
  sharePercent: number;
}

/** One reorderable routing rule under a card-like method's conditions
 *  panel: "when customer country is {matchType} {countries}, route to
 *  these processors." Mirrors the real client's per-condition-block +
 *  catch-all merchant-split structure, simplified to a single
 *  country-match condition per block (the real client also supports
 *  currency/metadata matchers — out of scope for this first pass, see
 *  frontend README known gaps). */
export interface CheckoutConditionBlock {
  id: string;
  countryMatchType: CheckoutConditionMatchType;
  countries: string[];
  splits: CheckoutProcessorSplit[];
}

/** One payment method row in the configurator's Active/Inactive list.
 *  `order` is the position within its own enabled/disabled bucket —
 *  the methods-list component derives display order directly from
 *  array order in the store rather than sorting by this field, but
 *  it's kept on the type since the real client's backend DTO
 *  (`is_active`/`order` on ICheckoutValue) persists it explicitly. */
export interface CheckoutMethod {
  id: string;
  type: CheckoutMethodType;
  label: string;
  enabled: boolean;
  /** Card can never be fully disabled — mirrors the real client's
   *  own "locked" methods rule (see methods-list-item component). */
  locked: boolean;
  order: number;
  /** Only meaningful for methods in CHECKOUT_METHODS_WITH_PROCESSOR_ROUTING. */
  conditionBlocks: CheckoutConditionBlock[];
  /** The catch-all/default routing split applied when no condition
   *  block above matches — the real client's "merchant split" section. */
  merchantSplit: CheckoutProcessorSplit[];
}

/* ------------------------------------------------------------------ *
 * Team — dashboard-user roles and pending invites. No live equivalent
 * yet on either side (this frontend has no real auth provider wired
 * up — see frontend README known gaps): the real client codebase uses
 * Clerk's built-in organization/members UI for this instead of a
 * bespoke module, so there's no PayNext-style doc page or backend
 * table to mirror here the way Plans/Integrations/Workflows do. Kept
 * deliberately simple — three roles, no granular permission matrix —
 * matching this dashboard's existing scope (mock data only, no fetch
 * calls, no Clerk integration).
 * ------------------------------------------------------------------ */

export const TEAM_ROLES = ["admin", "member", "support"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  admin: "Admin",
  member: "Member",
  support: "Support",
};

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  joinedAt: string;
}

export type TeamInviteStatus = "pending" | "expired";

export interface TeamInvite {
  id: string;
  email: string;
  role: TeamRole;
  invitedAt: string;
  invitedBy: string;
  status: TeamInviteStatus;
}
