import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { actionForMethod, isAllowed, resourceForRoute } from './scopes.js';

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
  scopes: string[];
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

const LAST_USED_RESOLUTION_MS = 60_000;

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
      .select(['id', 'product_id', 'merchant_entity_id', 'scopes', 'last_used_at'])
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
      scopes: row.scopes,
    };

    const resource = resourceForRoute(request.routeOptions.url);
    const action = actionForMethod(request.method);
    if (resource && !isAllowed(row.scopes, resource, action)) {
      throw new ForbiddenError(`This API key is missing the ${resource}:${action} scope`);
    }

    const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > LAST_USED_RESOLUTION_MS) {
      void deps.db
        .updateTable('api_tokens')
        .set({ last_used_at: new Date() })
        .where('id', '=', row.id)
        .execute()
        .catch((err: unknown) => request.log.error({ err }, 'failed to record api key usage'));
    }
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
        request.log.error({ err }, 'failed to write audit_log row');
      })
      .finally(() => done());
  });
}
