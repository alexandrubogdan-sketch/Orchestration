import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { PaymentState } from '../domain/stateMachine.js';

type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

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

  publishable_key_ref: string | null;

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
  amount_minor_units: string;
  currency: string;
  state: Generated<PaymentState>;
  cit_mit: 'cit' | 'mit';
  routing_decision: unknown;
  idempotency_key: string | null;

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

  fee_minor_units: Generated<string>;

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
  name: string | null;
  scopes: Generated<string[]>;
  token_prefix: string | null;
  last_used_at: Timestamp | null;
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
