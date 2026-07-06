import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { PaymentState } from '../domain/stateMachine.js';

/**
 * Hand-authored Kysely `Database` interface, matching
 * db/migrations/1735776100000_core-schema.cjs column-for-column.
 *
 * ADR-0002 specifies `kysely-codegen` as the intended source of these
 * types, generated from a live Postgres instance. This sandbox has no
 * live Postgres to codegen against, so these are hand-written instead —
 * treat this file as due for regeneration (`npm run db:codegen`, to be
 * wired up once a real database is reachable) the first time someone
 * runs migrations against a real instance. Until then, any schema change
 * must update this file and the migration in the same PR, or Kysely's
 * types will silently drift from reality.
 */

// Not wrapped in Generated<>: Kysely's `Generated<S> = ColumnType<S, S |
// undefined, S>` does not unwrap a nested ColumnType, so
// `Generated<ColumnType<...>>` ends up requiring the raw ColumnType as
// the update/insert value instead of `Date`. For timestamp columns with
// a DB-side default (created_at/updated_at), the "optional on insert"
// behavior is expressed directly in the ColumnType's insert parameter.
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
// For nullable, non-generated timestamp columns (e.g. processed_at).
type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface MerchantEntitiesTable {
  id: string;
  name: string;
  legal_entity_code: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ProductsTable {
  id: string;
  merchant_entity_id: string;
  name: string;
  slug: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PspAccountMode = 'sandbox' | 'production';

export interface PspAccountsTable {
  id: string;
  merchant_entity_id: string;
  psp: string;
  display_name: string;
  secret_ref: string;
  /** ADR-0005: nullable — only PSPs with a client-side public key populate this. */
  publishable_key_ref: string | null;
  /** ADR-0005: nullable — populated once a webhook endpoint is registered for this account. */
  webhook_secret_ref: string | null;
  mode: PspAccountMode;
  capabilities: Generated<unknown>;
  is_enabled: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CustomersTable {
  id: string;
  merchant_entity_id: string;
  external_ref: string | null;
  email: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CustomerPspRefsTable {
  id: string;
  customer_id: string;
  psp_account_id: string;
  psp_customer_ref: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PaymentMethodsTable {
  id: string;
  customer_id: string;
  psp_account_id: string;
  psp_payment_method_ref: string;
  type: 'card' | 'wallet' | 'apm' | 'bank_transfer';
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  network_transaction_id: string | null;
  is_active: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PaymentsTable {
  id: string;
  merchant_entity_id: string;
  product_id: string;
  customer_id: string;
  amount_minor_units: string; // bigint surfaces as string via pg driver
  currency: string;
  state: Generated<PaymentState>;
  cit_mit: 'cit' | 'mit';
  routing_decision: unknown;
  idempotency_key: string | null;
  /**
   * Milestone 8, T8.1 — nullable, and insert-optional (unlike most FKs
   * here) specifically so every pre-existing `insertInto('payments')`
   * call site from Milestones 1-7 keeps compiling unchanged; a renewal
   * payment sets it, everything else omits it (Postgres defaults an
   * omitted nullable column to NULL regardless of what Kysely's
   * Insertable<> requires be spelled out).
   */
  subscription_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PaymentAttemptsTable {
  id: string;
  payment_id: string;
  psp_account_id: string;
  attempt_number: number;
  psp_attempt_ref: string | null;
  idempotency_key: string;
  status: string;
  raw_response_ref: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TransactionType =
  'authorization' | 'capture' | 'refund' | 'chargeback' | 'fee' | 'payout';

export interface TransactionsTable {
  id: string;
  payment_id: string;
  attempt_id: string | null;
  type: TransactionType;
  amount_minor_units: string;
  currency: string;
  psp_account_id: string;
  /** Milestone 6, T6.1 — the fee portion netted out of this transaction by the PSP, if any. */
  fee_minor_units: Generated<string>;
  /** Milestone 6, T6.1 — which payout_batches row this settled into, once known. */
  payout_batch_id: string | null;
  occurred_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
}

export type PayoutBatchStatus = 'pending' | 'paid' | 'failed';

export interface PayoutBatchesTable {
  id: string;
  psp_account_id: string;
  psp_payout_ref: string;
  status: PayoutBatchStatus;
  amount_minor_units: string;
  currency: string;
  arrival_date: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ReconExceptionType =
  'missing_transaction' | 'amount_mismatch' | 'unmatched_settlement' | 'duplicate_settlement';
export type ReconExceptionStatus = 'open' | 'resolved' | 'ignored';

export interface ReconExceptionsTable {
  id: string;
  payment_id: string | null;
  transaction_id: string | null;
  psp_account_id: string;
  type: ReconExceptionType;
  expected_amount_minor_units: string | null;
  actual_amount_minor_units: string | null;
  currency: string | null;
  details: Generated<unknown>;
  status: Generated<ReconExceptionStatus>;
  detected_at: GeneratedTimestamp;
  resolved_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PaymentEventsTable {
  id: string;
  payment_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  decline_code: string | null;
  metadata: Generated<unknown>;
  occurred_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
}

export type WebhookInboxStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'dlq';

export interface WebhookInboxTable {
  id: string;
  psp: string;
  /** Which of possibly several psp_accounts for this psp verified the signature (T3.1). */
  psp_account_id: string | null;
  provider_event_id: string;
  raw_payload: unknown;
  status: Generated<WebhookInboxStatus>;
  attempts: Generated<number>;
  received_at: GeneratedTimestamp;
  processed_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IdempotencyKeysTable {
  key: string;
  product_id: string | null;
  request_hash: string;
  status: Generated<'in_progress' | 'completed'>;
  response_status: number | null;
  response_body: unknown;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OutboxTable {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  status: Generated<'pending' | 'dispatched' | 'failed'>;
  attempts: Generated<number>;
  created_at: GeneratedTimestamp;
  dispatched_at: Timestamp | null;
}

export type DeclineCategory =
  'hard' | 'soft' | 'fraud' | 'authentication' | 'technical' | 'unmapped';
export type DeclineRetryClass =
  'never' | 'same_instrument_later' | 'retry_after_challenge' | 'retry_different_psp' | 'review';

export interface DeclineCodeMapTable {
  id: string;
  psp: string;
  raw_code: string;
  normalized_code: string;
  category: DeclineCategory;
  retry_class: DeclineRetryClass;
  description: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ApiTokensTable {
  id: string;
  product_id: string;
  merchant_entity_id: string;
  token_hash: string;
  description: string | null;
  revoked_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuditLogTable {
  id: string;
  api_token_id: string | null;
  product_id: string | null;
  method: string;
  path: string;
  status_code: number;
  request_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface RoutingRulesTable {
  id: string;
  merchant_entity_id: string;
  product_id: string | null;
  priority: number;
  is_enabled: Generated<boolean>;
  match: Generated<unknown>;
  psp_account_id: string;
  fallback_psp_account_id: string | null;
  description: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RoutingRuleAuditAction = 'created' | 'updated' | 'deleted';

export interface RoutingRulesAuditTable {
  id: string;
  routing_rule_id: string;
  action: RoutingRuleAuditAction;
  snapshot: unknown;
  actor: string | null;
  created_at: GeneratedTimestamp;
}

export type SubscriptionStatus = 'active' | 'paused' | 'past_due' | 'canceled';
export type SubscriptionIntervalUnit = 'day' | 'week' | 'month' | 'year';

export interface SubscriptionsTable {
  id: string;
  merchant_entity_id: string;
  product_id: string;
  customer_id: string;
  payment_method_id: string;
  psp_account_id: string;
  amount_minor_units: string;
  currency: string;
  interval_unit: SubscriptionIntervalUnit;
  interval_count: Generated<number>;
  status: Generated<SubscriptionStatus>;
  current_period_start: GeneratedTimestamp;
  current_period_end: GeneratedTimestamp;
  next_billing_at: GeneratedTimestamp;
  dunning_stage: Generated<number>;
  dunning_next_retry_at: Timestamp | null;
  canceled_at: Timestamp | null;
  cancel_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OutboundWebhookEndpointsTable {
  id: string;
  product_id: string;
  url: string;
  signing_secret: string;
  event_types: Generated<unknown>;
  is_enabled: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type OutboundWebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dlq';

export interface OutboundWebhookDeliveriesTable {
  id: string;
  endpoint_id: string;
  outbox_event_id: string;
  event_type: string;
  payload: unknown;
  status: Generated<OutboundWebhookDeliveryStatus>;
  attempts: Generated<number>;
  response_status: number | null;
  last_error: string | null;
  delivered_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface Database {
  merchant_entities: MerchantEntitiesTable;
  products: ProductsTable;
  psp_accounts: PspAccountsTable;
  customers: CustomersTable;
  customer_psp_refs: CustomerPspRefsTable;
  payment_methods: PaymentMethodsTable;
  payments: PaymentsTable;
  payment_attempts: PaymentAttemptsTable;
  transactions: TransactionsTable;
  payment_events: PaymentEventsTable;
  webhook_inbox: WebhookInboxTable;
  idempotency_keys: IdempotencyKeysTable;
  outbox: OutboxTable;
  decline_code_map: DeclineCodeMapTable;
  api_tokens: ApiTokensTable;
  audit_log: AuditLogTable;
  routing_rules: RoutingRulesTable;
  routing_rules_audit: RoutingRulesAuditTable;
  payout_batches: PayoutBatchesTable;
  recon_exceptions: ReconExceptionsTable;
  subscriptions: SubscriptionsTable;
  outbound_webhook_endpoints: OutboundWebhookEndpointsTable;
  outbound_webhook_deliveries: OutboundWebhookDeliveriesTable;
}

export type Payment = Selectable<PaymentsTable>;
export type NewPayment = Insertable<PaymentsTable>;
export type PaymentUpdate = Updateable<PaymentsTable>;
export type NewPaymentEvent = Insertable<PaymentEventsTable>;
export type NewTransaction = Insertable<TransactionsTable>;
export type NewOutboxEvent = Insertable<OutboxTable>;
