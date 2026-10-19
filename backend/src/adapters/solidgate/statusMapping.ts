import type { CanonicalAttemptStatus } from '../types.js';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import { unmappedDecline, type NormalizedDecline } from '../../domain/declines.js';

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
