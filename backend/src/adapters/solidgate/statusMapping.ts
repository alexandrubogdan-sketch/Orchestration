import type { CanonicalAttemptStatus } from '../types.js';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import { unmappedDecline, type NormalizedDecline } from '../../domain/declines.js';

/**
 * Solidgate order/transaction shapes, confirmed against
 * api-docs.solidgate.com/api/card-payments/make-card-charge (fetched
 * and read in this session — not guessed):
 *
 * - `order.status` enum: "processing", "3ds_verify", "refunded",
 *   "auth_ok", "auth_failed", "settle_ok", "partial_settled",
 *   "void_ok".
 * - `transaction.operation` enum: "recurring-auth", "refund",
 *   "resign-auth", "auth", "settle", "void", "apple-pay", "google-pay".
 * - `transaction.status` enum: "processing", "success", "fail",
 *   "verify".
 *
 * FLAGGED (per SPEC.md's working agreement — encode ambiguity, don't
 * guess): the confirmed response schema (read through the "Success"
 * variant) has no explicit decline/error-code field in the portion
 * fetched this session. Rather than invent a plausible-sounding field
 * name with no evidence behind it, `extractSolidgateDeclineCode`
 * always returns `undefined` today — every decline normalizes via
 * `unmappedDecline`, which is honest ("we know it declined, we don't
 * yet know why") rather than silently wrong. Confirm the actual field
 * (likely somewhere in Solidgate's error-response variant, a `oneOf`
 * branch this session's fetch didn't expand) against a live sandbox
 * response before this adapter's decline handling is production-ready.
 */

export interface SolidgateOrder {
  order_id: string;
  status: string;
  subscription_id?: string;
}

export interface SolidgateTransaction {
  id: string;
  operation: string;
  status: string;
  card_token?: { token: string };
}

export interface SolidgateChargeResponse {
  order: SolidgateOrder;
  transaction?: SolidgateTransaction;
}

const ORDER_STATUS_TO_CANONICAL: Record<string, CanonicalAttemptStatus> = {
  processing: 'pending',
  '3ds_verify': 'requires_action',
  auth_ok: 'authorized',
  auth_failed: 'declined',
  settle_ok: 'captured',
  partial_settled: 'captured',
  void_ok: 'voided',
  refunded: 'refunded',
};

export function mapSolidgateOrderStatus(orderStatus: string): CanonicalAttemptStatus {
  return ORDER_STATUS_TO_CANONICAL[orderStatus] ?? 'failed';
}

/** See this file's docblock — always undefined until the real field is confirmed. */
export function extractSolidgateDeclineCode(
  _response: SolidgateChargeResponse,
): string | undefined {
  return undefined;
}

export function normalizeSolidgateDecline(
  declineMap: ReadonlyMap<string, NormalizedDecline>,
  rawCode: string,
): NormalizedDecline {
  return declineMap.get(rawCode) ?? unmappedDecline('solidgate', rawCode);
}

/**
 * Webhook payload shape: `card_gate.order.updated`
 * (docs.solidgate.com/payments/integrate/webhooks/#card-payments).
 * FLAGGED: assumed to carry the same `{order, transaction}` shape as
 * the charge response's own "Success" body — Solidgate's docs
 * describe the webhook body as "event-related information, like order
 * events" without an independently fetched schema for this specific
 * event type in this session.
 */
export function normalizeSolidgateEvent(rawPayload: unknown): CanonicalEvent[] {
  const body = rawPayload as SolidgateChargeResponse | undefined;
  if (!body?.order) return [];

  const status = mapSolidgateOrderStatus(body.order.status);
  switch (status) {
    case 'requires_action':
      return [{ type: 'authentication_required' }];
    case 'authorized':
      return [{ type: 'authorized' }];
    case 'captured':
      return [{ type: 'authorized' }, { type: 'capture_started' }, { type: 'captured' }];
    case 'declined':
      return [{ type: 'declined', declineCode: extractSolidgateDeclineCode(body) }];
    case 'failed':
      return [{ type: 'authorization_failed' }];
    case 'voided':
      return [{ type: 'voided' }];
    case 'refunded':
      return [{ type: 'refund_started' }, { type: 'refunded' }];
    case 'pending':
    default:
      return [];
  }
}
