import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import { generateWebhookSigningSecret } from './signature.js';

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
