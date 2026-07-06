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
 * and docs.paynext.com/guides/payments/3d-secure.
 *
 * PayNext's actual model: one trigger ("Payment Pending", tied to a
 * single payment method) per workflow, then any number of Condition /
 * Split / Action nodes connected in any order, with AND/OR condition
 * groups and branching. This first pass deliberately simplifies that to
 * a single linear chain (trigger -> node -> node -> ...) with no
 * branching/grouping and no Split node — see the frontend README's
 * "Known gaps" for what's dropped versus the real PayNext feature set.
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

/** This product's two built PSP adapters (backend/src/adapters) — the
 *  processor choice for an Authorize Payment action. PayNext itself
 *  supports Stripe/Braintree/PayPal/Unlimit; scoped down to what this
 *  backend actually implements. */
export const PROCESSORS = ["stripe", "solidgate"] as const;
export type ProcessorId = (typeof PROCESSORS)[number];
export const PROCESSOR_LABELS: Record<ProcessorId, string> = {
  stripe: "Stripe",
  solidgate: "Solidgate",
};

/** docs.paynext.com/guides/payments/3d-secure — "3DS Modes" table. */
export const THREE_DS_MODES = ["no_3ds", "adaptive", "frictionless"] as const;
export type ThreeDsMode = (typeof THREE_DS_MODES)[number];
export const THREE_DS_LABELS: Record<ThreeDsMode, string> = {
  no_3ds: "No 3DS",
  adaptive: "Adaptive 3DS",
  frictionless: "Frictionless 3DS",
};

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
  /** delay */
  delaySeconds?: number;
}

export type WorkflowNodeKind = "trigger" | "condition" | "action";

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** trigger only */
  paymentMethod?: PaymentMethodType;
  condition?: WorkflowCondition;
  action?: WorkflowAction;
}

export type WorkflowState = "draft" | "published";

export interface Workflow {
  id: string;
  name: string;
  paymentMethod: PaymentMethodType;
  state: WorkflowState;
  /** nodes[0] is always the trigger; the rest is a linear chain in order. */
  nodes: WorkflowNode[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Plans — modeled on docs.paynext.com/guides/platform/plans.
 * ------------------------------------------------------------------ */

export const BILLING_INTERVAL_UNITS = ["days", "months", "years"] as const;
export type BillingIntervalUnit = (typeof BILLING_INTERVAL_UNITS)[number];

export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

/** "All countries" is PayNext's default-price row; every other row is a
 *  country-specific override (docs.paynext.com/guides/platform/plans
 *  §Localized Pricing). Kept as ISO-3166 alpha-2 codes, free-text so any
 *  country can be entered, with "ALL" reserved for the default row. */
export const DEFAULT_PRICE_COUNTRY = "ALL";

export interface PriceRow {
  id: string;
  currency: string;
  amountMinorUnits: number;
  /** ISO-3166 alpha-2, or DEFAULT_PRICE_COUNTRY for "all countries". */
  country: string;
}

export interface TrialConfig {
  enabled: boolean;
  intervalUnit: BillingIntervalUnit;
  intervalCount: number;
  prices: PriceRow[];
}

export interface Plan {
  id: string;
  name: string;
  billingIntervalUnit: BillingIntervalUnit;
  billingIntervalCount: number;
  prices: PriceRow[];
  trial: TrialConfig;
  createdAt: string;
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
   *  per-descriptor filter. */
  descriptors?: string[];
}
