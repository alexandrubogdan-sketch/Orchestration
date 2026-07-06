import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import { generateWebhookSigningSecret } from './signature.js';

/**
 * T8.4. No HTTP admin API exists yet for registering an
 * `outbound_webhook_endpoints` row (same flagged gap as
 * `routing_rules`, ADR-0007) — these are the repo-layer functions an
 * admin script or a future admin API would call. The raw signing
 * secret is returned exactly once, at creation, the same UX contract
 * `src/api/auth.ts#generateApiToken` already established for
 * `api_tokens`.
 */
export interface RegisterEndpointInput {
  productId: string;
  url: string;
  eventTypes: string[];
}

export interface RegisteredEndpoint {
  id: string;
  signingSecret: string;
}

export async function registerOutboundWebhookEndpoint(
  db: Db,
  input: RegisterEndpointInput,
): Promise<RegisteredEndpoint> {
  const id = uuidv7();
  const signingSecret = generateWebhookSigningSecret();
  await db
    .insertInto('outbound_webhook_endpoints')
    .values({
      id,
      product_id: input.productId,
      url: input.url,
      signing_secret: signingSecret,
      event_types: JSON.stringify(input.eventTypes),
    })
    .execute();
  return { id, signingSecret };
}

export async function disableOutboundWebhookEndpoint(db: Db, endpointId: string): Promise<void> {
  await db
    .updateTable('outbound_webhook_endpoints')
    .set({ is_enabled: false, updated_at: new Date() })
    .where('id', '=', endpointId)
    .execute();
}
