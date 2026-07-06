import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';

/**
 * T4.1: "Service auth: per-product API tokens (hashed at rest), scoping
 * product_id/entity_id; audit log of admin calls."
 *
 * Tokens are opaque random strings (`po_<48 hex chars>`), shown to the
 * caller exactly once at creation (scripts/seed.ts prints the raw token
 * for the seeded pilot product — see docs/runbooks). Only the SHA-256
 * hash is ever persisted, matching the pgcrypto-for-token-hashing intent
 * flagged back in the T0.3 migration's docblock — done here in Node
 * rather than via pgcrypto's `digest()` so the same hashing function is
 * usable outside a DB round-trip (e.g. to validate a token format before
 * ever querying).
 */

export function generateApiToken(): { raw: string; hash: string } {
  const raw = `po_${randomBytes(24).toString('hex')}`;
  return { raw, hash: hashApiToken(raw) };
}

export function hashApiToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface AuthContext {
  apiTokenId: string;
  productId: string;
  merchantEntityId: string;
}

export class UnauthorizedError extends Error {
  constructor(message = 'Missing or invalid API token') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Guards every `/v1/*` route (the product-facing API surface — health
 * checks, webhooks, and /dev routes are unauthenticated by design) and
 * writes one `audit_log` row per request once a response is sent. Scoping
 * (a product can only ever see/act on its own data) is NOT enforced
 * here — this hook only establishes *who* is calling; every route
 * handler is responsible for filtering its queries by
 * `request.auth.productId` (see src/api/routes/payments.ts), which is
 * what T7.6's authz test ("product A token cannot read product B
 * payments") actually exercises.
 */
export function registerAuth(app: FastifyInstance, deps: { db: Db }): void {
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/v1/')) return;

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      throw new UnauthorizedError();
    }

    const row = await deps.db
      .selectFrom('api_tokens')
      .select(['id', 'product_id', 'merchant_entity_id'])
      .where('token_hash', '=', hashApiToken(token))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!row) {
      throw new UnauthorizedError();
    }

    request.auth = {
      apiTokenId: row.id,
      productId: row.product_id,
      merchantEntityId: row.merchant_entity_id,
    };
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (!request.url.startsWith('/v1/')) {
      done();
      return;
    }
    deps.db
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        api_token_id: request.auth?.apiTokenId ?? null,
        product_id: request.auth?.productId ?? null,
        method: request.method,
        path: request.url,
        status_code: reply.statusCode,
        request_id: request.id,
      })
      .execute()
      .catch((err: unknown) => {
        // Audit logging must never break the request it's logging — it
        // already completed and was sent by the time this hook runs.
        request.log.error({ err }, 'failed to write audit_log row');
      })
      .finally(() => done());
  });
}
