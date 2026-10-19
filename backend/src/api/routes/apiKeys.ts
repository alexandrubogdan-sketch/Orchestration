import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { Selectable } from 'kysely';
import type { Db } from '../../db/client.js';
import type { ApiTokensTable } from '../../db/types.js';
import { generateApiToken } from '../auth.js';
import { API_SCOPES } from '../scopes.js';
import { sendProblem, sendValidationError } from '../problem.js';

const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
});

function serializeApiKey(row: Selectable<ApiTokensTable>) {
  return {
    id: row.id,
    name: row.name ?? row.description ?? 'Untitled key',
    prefix: row.token_prefix,
    scopes: row.scopes,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

export function registerApiKeysRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get(
    '/v1/api-keys',
    { schema: { tags: ['api-keys'], summary: 'List API keys for this product' } },
    async (request, reply) => {
      const auth = request.auth!;
      const rows = await deps.db
        .selectFrom('api_tokens')
        .selectAll()
        .where('product_id', '=', auth.productId)
        .orderBy('created_at', 'desc')
        .execute();
      return reply.send({ data: rows.map(serializeApiKey) });
    },
  );

  app.post(
    '/v1/api-keys',
    { schema: { tags: ['api-keys'], summary: 'Create an API key. The secret is returned once.' } },
    async (request, reply) => {
      const auth = request.auth!;
      const parsed = createApiKeyBodySchema.safeParse(request.body);
      if (!parsed.success) return sendValidationError(reply, parsed.error);

      const { raw, hash } = generateApiToken();
      const row = await deps.db
        .insertInto('api_tokens')
        .values({
          id: uuidv7(),
          product_id: auth.productId,
          merchant_entity_id: auth.merchantEntityId,
          token_hash: hash,
          token_prefix: raw.slice(0, 11),
          name: parsed.data.name,
          scopes: [...new Set(parsed.data.scopes)],
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return reply.status(201).send({ ...serializeApiKey(row), secret: raw });
    },
  );

  app.delete(
    '/v1/api-keys/:id',
    { schema: { tags: ['api-keys'], summary: 'Revoke an API key' } },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return sendProblem(reply, 404, 'API key not found');
      }
      const row = await deps.db
        .updateTable('api_tokens')
        .set({ revoked_at: new Date(), updated_at: new Date() })
        .where('id', '=', id)
        .where('product_id', '=', auth.productId)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'API key not found');
      return reply.send(serializeApiKey(row));
    },
  );
}
