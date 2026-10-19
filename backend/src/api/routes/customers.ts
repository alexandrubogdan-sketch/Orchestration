import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.js';
import { sendProblem } from '../problem.js';
import { serializePaymentMethod } from './payments.js';

export interface CustomersRouteDeps {
  db: Db;
}

export function registerCustomersRoutes(app: FastifyInstance, deps: CustomersRouteDeps): void {
  app.get(
    '/v1/customers/:id/payment-methods',
    { schema: { tags: ['customers'], summary: "List a customer's active payment methods" } },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params as { id: string };

      const customer = await deps.db
        .selectFrom('customers')
        .select('id')
        .where('id', '=', id)
        .where('merchant_entity_id', '=', auth.merchantEntityId)
        .executeTakeFirst();
      if (!customer) return sendProblem(reply, 404, 'Customer not found');

      const methods = await deps.db
        .selectFrom('payment_methods')
        .selectAll()
        .where('customer_id', '=', id)
        .where('is_active', '=', true)
        .execute();

      return reply.send({ data: methods.map(serializePaymentMethod) });
    },
  );
}
