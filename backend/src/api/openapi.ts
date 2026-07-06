import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/**
 * T4.2: "OpenAPI generated." See ADR-0006 for why these two packages
 * (both Fastify-core-maintained) plus `zod-to-json-schema` (converts
 * the same Zod validators that already enforce requests at runtime,
 * per T4.2's "all Zod-validated" — one source of truth, not two).
 *
 * Served at:
 * - `GET /docs` — interactive Swagger UI
 * - `GET /docs/json` — the raw OpenAPI 3 document
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Payment Orchestrator API',
        description: 'Internal, per-product payments API — see SPEC.md Milestone 4.',
        version: '0.1.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Per-product API token (T4.1) — see scripts/seed.ts for a dev token.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'payments', description: 'Payment lifecycle: create, capture, void, refund' },
        { name: 'customers', description: 'Customer payment methods' },
      ],
    },
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });
}
