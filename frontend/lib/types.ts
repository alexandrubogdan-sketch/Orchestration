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

export const PAYMENT_METHOD_KINDS = ["card", "wallet", "apm", "bank_transfer"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface CustomerPaymentMethod {
  id: string;
  type: PaymentMethodKind;
  pspAccount: string;
  isActive: boolean;

  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
}

export interface CustomerAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
}

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

  firstName: string;
  lastName: string;
  email: string;

  externalRef?: string;

  country: string;
  city?: string;
  address: CustomerAddress;
  createdAt: string;
  subscription: CustomerSubscription;
  paymentMethods: CustomerPaymentMethod[];
}

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

export const PAYMENT_METHOD_TYPES = ["cards", "apple_pay", "google_pay"] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodType, string> = {
  cards: "Cards",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
};

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

  metadataKey?: string;
  operator: WorkflowOperator;
  value: string;
}

export interface WorkflowConditionBlock {
  id: string;
  title: string;
  condition: WorkflowCondition;
}

export interface WorkflowSplitBranch {
  id: string;
  label: string;
  value: number;
}

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

export const PROCESSORS = ["stripe", "solidgate", "paypal"] as const;
export type ProcessorId = (typeof PROCESSORS)[number];
export const PROCESSOR_LABELS: Record<ProcessorId, string> = {
  stripe: "Stripe",
  solidgate: "Solidgate",
  paypal: "PayPal",
};

export const THREE_DS_MODES = ["no_3ds", "adaptive", "frictionless"] as const;
export type ThreeDsMode = (typeof THREE_DS_MODES)[number];
export const THREE_DS_LABELS: Record<ThreeDsMode, string> = {
  no_3ds: "No 3DS",
  adaptive: "Adaptive 3DS",
  frictionless: "Frictionless 3DS",
};

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

export interface DelayComponents {
  days: number;
  hours: number;
  minutes: number;
}

export function delaySecondsToComponents(totalSeconds: number): DelayComponents {
  const clamped = Math.max(0, Math.floor(totalSeconds || 0));
  const days = Math.floor(clamped / SECONDS_PER_DAY);
  const afterDays = clamped % SECONDS_PER_DAY;
  const hours = Math.floor(afterDays / SECONDS_PER_HOUR);
  const minutes = Math.floor((afterDays % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return { days, hours, minutes };
}

export function delayComponentsToSeconds(components: DelayComponents): number {
  const days = Math.max(0, Math.floor(components.days) || 0);
  const hours = Math.max(0, Math.floor(components.hours) || 0);
  const minutes = Math.max(0, Math.floor(components.minutes) || 0);
  return days * SECONDS_PER_DAY + hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE;
}

export function formatDelayDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0m";
  const { days, hours, minutes } = delaySecondsToComponents(totalSeconds);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.slice(0, 2).join(" ") || "0m";
}

export interface WorkflowAction {
  type: WorkflowActionType;

  processor?: ProcessorId;
  fallbackProcessor?: ProcessorId | "none";
  threeDsMode?: ThreeDsMode;
  useCitProcessor?: boolean;

  metadataKey?: string;
  metadataValue?: string;
  metadataDestination?: "customer" | "payment" | "both";

  delaySeconds?: number;
}

export type WorkflowNodeKind = "trigger" | "condition" | "action" | "split";

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;

  paymentMethod?: PaymentMethodType;

  conditions?: WorkflowConditionBlock[];

  splits?: WorkflowSplitBranch[];
  action?: WorkflowAction;
}

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

  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt: string;
}

export const WORKFLOW_RUN_STATUSES = ["succeeded", "failed", "in_progress"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;

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

export interface WorkflowHistoryEvent {
  id: string;
  workflowId: string;
  type: WorkflowHistoryEventType;
  versionLabel: string;
  detail: string;
  actorName: string;
  occurredAt: string;
}

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

  entryCount: number;
  authorName: string;
  authorEmail: string;
  createdAt: string;
}

export interface DunningLadderStep {
  id: string;
  waitHours: number;
}

export interface RetryPolicy {
  ladder: DunningLadderStep[];
  maxAttemptsPerPayment: number;
  minSpacingSeconds: number;
}

export const DEFAULT_DUNNING_LADDER_HOURS = [24, 72, 168] as const;
export const DEFAULT_MAX_ATTEMPTS_PER_PAYMENT = 3;
export const DEFAULT_MIN_SPACING_SECONDS = 2;

export const RETRY_ATTEMPT_OUTCOMES = ["succeeded", "declined", "failed"] as const;
export type RetryAttemptOutcome = (typeof RETRY_ATTEMPT_OUTCOMES)[number];

export interface RetryAttempt {
  id: string;
  paymentId: string;
  attemptNumber: number;
  pspAccount: string;
  outcome: RetryAttemptOutcome;
  occurredAt: string;
}

export const BILLING_INTERVAL_UNITS = ["days", "months", "years"] as const;
export type BillingIntervalUnit = (typeof BILLING_INTERVAL_UNITS)[number];

export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

export const DEFAULT_PRICE_COUNTRY = "ALL";

export interface PriceRow {
  id: string;
  currency: string;
  amountMinorUnits: number;

  country: string;
}

export const PLAN_TYPES = ["recurring", "one-off"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const TAX_COLLECTION_MODES = ["global", "enabled", "disabled"] as const;
export type TaxCollectionMode = (typeof TAX_COLLECTION_MODES)[number];
export const TAX_COLLECTION_LABELS: Record<TaxCollectionMode, string> = {
  global: "Global",
  enabled: "Enabled",
  disabled: "Disabled",
};

export interface PriceOverrideRule {
  id: string;
  currency: string;

  countries: string[];
  amountMinorUnits: number;
}

export interface TrialConfig {
  enabled: boolean;
  intervalUnit: BillingIntervalUnit;
  intervalCount: number;
  prices: PriceRow[];

  rules: PriceOverrideRule[];
}

export interface Plan {
  id: string;
  name: string;
  type: PlanType;
  billingIntervalUnit: BillingIntervalUnit;
  billingIntervalCount: number;
  prices: PriceRow[];

  rules: PriceOverrideRule[];
  trial: TrialConfig;
  taxCollection: TaxCollectionMode;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationStatus = "connected" | "not_connected";

export type IntegrationMode = "sandbox" | "production";

export interface CredentialFieldSpec {
  key: string;
  label: string;
  placeholder: string;

  secret: boolean;
}

export const PROCESSOR_CREDENTIAL_FIELDS: Record<ProcessorId, CredentialFieldSpec[]> = {
  stripe: [
    { key: "publishableKey", label: "Publishable key", placeholder: "pk_test_...", secret: false },
    { key: "secretKey", label: "Secret key", placeholder: "sk_test_...", secret: true },
    { key: "webhookSecret", label: "Webhook signing secret", placeholder: "whsec_...", secret: true },
  ],
  solidgate: [
    { key: "publicKey", label: "Public key", placeholder: "api_pk_...", secret: false },
    { key: "secretKey", label: "Secret key", placeholder: "api_sk_...", secret: true },
    { key: "webhookPublicKey", label: "Webhook public key", placeholder: "wh_pk_...", secret: false },
    { key: "webhookSecretKey", label: "Webhook secret key", placeholder: "wh_sk_...", secret: true },
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

  credentialPreviews?: Record<string, string>;

  descriptors?: string[];
}

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

export const CHECKOUT_METHOD_COUNTRY_LOCKS: Partial<Record<CheckoutMethodType, { country: string; currency: string }>> = {
  cash_app: { country: "US", currency: "USD" },
};

export const CHECKOUT_METHODS_WITH_PROCESSOR_ROUTING: CheckoutMethodType[] = ["card"];

export const CHECKOUT_CONDITION_MATCH_TYPES = ["equal", "not_equal", "one_of", "not_one_of"] as const;
export type CheckoutConditionMatchType = (typeof CHECKOUT_CONDITION_MATCH_TYPES)[number];

export const CHECKOUT_CONDITION_MATCH_LABELS: Record<CheckoutConditionMatchType, string> = {
  equal: "Equals",
  not_equal: "Does not equal",
  one_of: "One of",
  not_one_of: "Not one of",
};

export interface CheckoutProcessorSplit {
  id: string;
  processor: ProcessorId;
  sharePercent: number;
}

export interface CheckoutConditionBlock {
  id: string;
  countryMatchType: CheckoutConditionMatchType;
  countries: string[];
  splits: CheckoutProcessorSplit[];
}

export interface CheckoutMethod {
  id: string;
  type: CheckoutMethodType;
  label: string;
  enabled: boolean;

  locked: boolean;
  order: number;

  conditionBlocks: CheckoutConditionBlock[];

  merchantSplit: CheckoutProcessorSplit[];
}

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
