import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Alpha Payments API',
        description:
          'Create, capture, void and refund payments across every connected processor through one API.',
        version: '0.1.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Secret API key created in Developers → API keys. Keys carry scopes such as payments:read.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'payments', description: 'Payment lifecycle: create, capture, void, refund' },
        { name: 'customers', description: 'Customer payment methods' },
        { name: 'api-keys', description: 'Create, list and revoke scoped API keys' },
      ],
    },
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });
}
