import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Db } from '../../db/client.js';
import type { Payment, PaymentAttemptsTable, PaymentMethodsTable } from '../../db/types.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import type { AttemptResult } from '../../adapters/types.js';
import { makeMoney } from '../../domain/money.js';
import { isEligibleForPspFailover } from '../../domain/declines.js';
import { evaluateRouting, type RoutingDecision } from '../../routing/evaluator.js';
import type { CircuitBreaker } from '../../routing/circuitBreaker.js';
import { RateLimitExceededError } from '../../routing/rateLimiter.js';
import {
  requireIdempotencyKey,
  withIdempotencyKey,
  type IdempotentResult,
} from '../idempotency.js';
import { applyCanonicalEvents } from '../../workflow/tasks/applyEvents.js';
import {
  captureAttemptEvents,
  initialAttemptEvents,
  refundAttemptEvents,
  voidAttemptEvents,
} from '../attemptEvents.js';
import { serializeTimeline } from '../timeline.js';
import { sendProblem, sendValidationError } from '../problem.js';
import type { Selectable } from 'kysely';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface PaymentsRouteDeps {
  db: Db;
  redis: Redis;
  registry: PspAdapterRegistry;
  breaker: CircuitBreaker;
}

const moneySchema = z.object({
  minorUnits: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

const createPaymentBodySchema = z
  .object({
    customerId: z.string().uuid().optional(),
    customerEmail: z.string().email().optional(),
    amount: moneySchema,
    paymentMethodRef: z.string().min(1),
    citMit: z.enum(['cit', 'mit']).default('cit'),
    captureMethod: z.enum(['automatic', 'manual']).default('automatic'),
  })
  .refine((data) => data.customerId ?? data.customerEmail, {
    message: 'customerId or customerEmail is required',
  });

const refundBodySchema = z.object({
  amount: moneySchema.optional(),
});

const listPaymentsQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  state: z.string().optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

function serializePayment(payment: Payment) {
  return {
    id: payment.id,
    productId: payment.product_id,
    customerId: payment.customer_id,
    amount: { minorUnits: Number(payment.amount_minor_units), currency: payment.currency },
    state: payment.state,
    citMit: payment.cit_mit,
    createdAt: new Date(payment.created_at).toISOString(),
    updatedAt: new Date(payment.updated_at).toISOString(),
  };
}

function serializeAttempt(attempt: Selectable<PaymentAttemptsTable>) {
  return {
    attemptNumber: attempt.attempt_number,
    status: attempt.status,
    createdAt: new Date(attempt.created_at).toISOString(),
  };
}

function serializePaymentMethod(pm: Selectable<PaymentMethodsTable>) {
  return {
    id: pm.id,
    type: pm.type,
    cardBrand: pm.card_brand,
    cardLast4: pm.card_last4,
    isActive: pm.is_active,
    createdAt: new Date(pm.created_at).toISOString(),
  };
}

async function resolveCustomerId(
  db: Db,
  merchantEntityId: string,
  input: { customerId?: string | undefined; customerEmail?: string | undefined },
): Promise<string> {
  if (input.customerId) return input.customerId;

  const existing = await db
    .selectFrom('customers')
    .select('id')
    .where('merchant_entity_id', '=', merchantEntityId)
    .where('email', '=', input.customerEmail!)
    .executeTakeFirst();
  if (existing) return existing.id;

  const id = uuidv7();
  await db
    .insertInto('customers')
    .values({ id, merchant_entity_id: merchantEntityId, email: input.customerEmail! })
    .execute();
  return id;
}

async function upsertPaymentMethod(
  db: Db,
  customerId: string,
  pspAccountId: string,
  pspPaymentMethodRef: string,
): Promise<Selectable<PaymentMethodsTable>> {
  const existing = await db
    .selectFrom('payment_methods')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('psp_account_id', '=', pspAccountId)
    .where('psp_payment_method_ref', '=', pspPaymentMethodRef)
    .executeTakeFirst();
  if (existing) return existing;

  const id = uuidv7();
  await db
    .insertInto('payment_methods')
    .values({
      id,
      customer_id: customerId,
      psp_account_id: pspAccountId,
      psp_payment_method_ref: pspPaymentMethodRef,
      type: 'card',
      is_active: true,
    })
    .execute();
  return db
    .selectFrom('payment_methods')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export function registerPaymentsRoutes(app: FastifyInstance, deps: PaymentsRouteDeps): void {
  const { db, redis, registry, breaker } = deps;

  app.post(
    '/v1/payments',
    {
      schema: {
        tags: ['payments'],
        summary: 'Create a payment (Idempotency-Key header required)',
        description: 'Requires an `Idempotency-Key` header — see src/api/idempotency.ts.',
        body: zodToJsonSchema(createPaymentBodySchema),
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const idempotencyKey = requireIdempotencyKey(request.headers);
      const parsed = createPaymentBodySchema.safeParse(request.body);
      if (!parsed.success) return sendValidationError(reply, parsed.error);
      const body = parsed.data;

      const outcome = await withIdempotencyKey(
        { db, redis },
        idempotencyKey,
        { method: request.method, path: request.url, body },
        async (): Promise<IdempotentResult> => {
          const customerId = await resolveCustomerId(db, auth.merchantEntityId, body);

          // Second idempotency layer — see
          // db/migrations/..._payments-idempotency-key-unique.cjs's
          // docblock for why this lookup exists on top of
          // src/api/idempotency.ts's own caching.
          let payment = await db
            .selectFrom('payments')
            .selectAll()
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirst();

          let routingDecision: RoutingDecision;
          if (!payment) {
            routingDecision = await evaluateRouting(
              { db, redis, breaker },
              {
                productId: auth.productId,
                currency: body.amount.currency,
                citMit: body.citMit,
                // Only 'card' is supported end-to-end today (see
                // adapters/*'s PspCapabilities); routing_rules can
                // still express a `paymentMethodType` match today for
                // when a second method type lands, per docs/design.md §4.
                paymentMethodType: 'card',
              },
            );
            payment = await db
              .insertInto('payments')
              .values({
                id: uuidv7(),
                merchant_entity_id: auth.merchantEntityId,
                product_id: auth.productId,
                customer_id: customerId,
                amount_minor_units: String(body.amount.minorUnits),
                currency: body.amount.currency,
                cit_mit: body.citMit,
                routing_decision: JSON.stringify(routingDecision),
                idempotency_key: idempotencyKey,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          } else {
            routingDecision = payment.routing_decision as RoutingDecision;
          }

          const pspAccount = await db
            .selectFrom('psp_accounts')
            .selectAll()
            .where('id', '=', routingDecision.pspAccountId)
            .executeTakeFirstOrThrow();
          const adapter = registry.resolve(pspAccount);

          const existingAttempt = await db
            .selectFrom('payment_attempts')
            .selectAll()
            .where('payment_id', '=', payment.id)
            .where('attempt_number', '=', 1)
            .executeTakeFirst();

          let clientSecret: string | undefined;

          if (!existingAttempt) {
            const paymentMethod = await upsertPaymentMethod(
              db,
              customerId,
              pspAccount.id,
              body.paymentMethodRef,
            );
            const pspIdempotencyKey = `${payment.id}-attempt-1`;

            // Milestone 8/ADR-0011: Solidgate's /charge requires a
            // customer email; Stripe/mock ignore this field entirely.
            // Falls back to a DB lookup when the request identified the
            // customer by customerId rather than customerEmail.
            const customerEmail =
              body.customerEmail ??
              (
                await db
                  .selectFrom('customers')
                  .select('email')
                  .where('id', '=', customerId)
                  .executeTakeFirst()
              )?.email ??
              undefined;

            // T5.3: the circuit breaker only ever hears about `technical`
            // failures (adapter throws, or a technical-category decline)
            // — never about business declines, which say nothing about
            // whether the PSP itself is healthy. See
            // src/routing/circuitBreaker.ts and
            // src/domain/declines.ts#isEligibleForPspFailover.
            let result: AttemptResult;
            try {
              result = await adapter.createPayment({
                paymentId: payment.id,
                amount: makeMoney(body.amount.minorUnits, body.amount.currency),
                paymentMethodRef: paymentMethod.psp_payment_method_ref,
                context: { citMit: body.citMit },
                idempotencyKey: pspIdempotencyKey,
                captureMethod: body.captureMethod,
                customerEmail,
              });
            } catch (err) {
              // T7.1: our OWN outbound throttle rejecting a call is not a
              // signal the PSP is unhealthy — never let a self-imposed
              // rate limit trip the circuit breaker.
              if (!(err instanceof RateLimitExceededError)) {
                await breaker.recordFailure(pspAccount.id);
              }
              throw err;
            }

            if (result.decline && isEligibleForPspFailover(result.decline)) {
              await breaker.recordFailure(pspAccount.id);
            } else {
              await breaker.recordSuccess(pspAccount.id);
            }
            clientSecret = result.clientSecret;

            await db
              .insertInto('payment_attempts')
              .values({
                id: uuidv7(),
                payment_id: payment.id,
                psp_account_id: pspAccount.id,
                attempt_number: 1,
                psp_attempt_ref: result.pspAttemptRef,
                idempotency_key: pspIdempotencyKey,
                status: result.status,
              })
              .onConflict((oc) => oc.columns(['payment_id', 'attempt_number']).doNothing())
              .execute();

            await applyCanonicalEvents(
              db,
              payment.id,
              initialAttemptEvents(result),
              pspAccount.psp,
            );
          }

          const finalPayment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', payment.id)
            .executeTakeFirstOrThrow();

          return {
            status: 201,
            body: { ...serializePayment(finalPayment), ...(clientSecret ? { clientSecret } : {}) },
          };
        },
      );

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/v1/payments/:id',
    { schema: { tags: ['payments'], summary: 'Get a payment, its attempts, and its timeline' } },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params as { id: string };

      const payment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', id)
        .where('product_id', '=', auth.productId)
        .executeTakeFirst();
      if (!payment) return sendProblem(reply, 404, 'Payment not found');

      const attempts = await db
        .selectFrom('payment_attempts')
        .selectAll()
        .where('payment_id', '=', id)
        .orderBy('attempt_number', 'asc')
        .execute();
      const events = await db
        .selectFrom('payment_events')
        .select(['event_type', 'decline_code', 'occurred_at'])
        .where('payment_id', '=', id)
        .orderBy('occurred_at', 'asc')
        .execute();

      return reply.send({
        ...serializePayment(payment),
        attempts: attempts.map(serializeAttempt),
        timeline: serializeTimeline(events),
      });
    },
  );

  app.get(
    '/v1/payments',
    { schema: { tags: ['payments'], summary: 'List payments (paginated, filterable)' } },
    async (request, reply) => {
      const auth = request.auth!;
      const parsed = listPaymentsQuerySchema.safeParse(request.query);
      if (!parsed.success) return sendValidationError(reply, parsed.error);
      const query = parsed.data;

      let builder = db.selectFrom('payments').selectAll().where('product_id', '=', auth.productId);
      if (query.customerId) builder = builder.where('customer_id', '=', query.customerId);
      if (query.state) builder = builder.where('state', '=', query.state as never);
      if (query.createdAfter)
        builder = builder.where('created_at', '>=', new Date(query.createdAfter));
      if (query.createdBefore)
        builder = builder.where('created_at', '<=', new Date(query.createdBefore));
      if (query.cursor) builder = builder.where('id', '<', query.cursor);

      // UUIDv7 primary keys are time-sortable, so `id` doubles as a stable
      // keyset-pagination cursor without a separate created_at+id
      // composite key (SPEC.md's UUIDv7 convention, applied).
      const rows = await builder
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);

      return reply.send({
        data: page.map(serializePayment),
        pagination: { hasMore, nextCursor: hasMore ? page[page.length - 1]!.id : null },
      });
    },
  );

  app.post(
    '/v1/payments/:id/capture',
    { schema: { tags: ['payments'], summary: 'Capture a previously authorized payment' } },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params as { id: string };
      const idempotencyKey = requireIdempotencyKey(request.headers);

      const outcome = await withIdempotencyKey(
        { db, redis },
        idempotencyKey,
        { method: request.method, path: request.url, body: request.body },
        async (): Promise<IdempotentResult> => {
          const payment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', id)
            .where('product_id', '=', auth.productId)
            .executeTakeFirst();
          if (!payment) return { status: 404, body: { title: 'Payment not found', status: 404 } };

          const attempt = await db
            .selectFrom('payment_attempts')
            .selectAll()
            .where('payment_id', '=', id)
            .orderBy('attempt_number', 'desc')
            .executeTakeFirst();
          if (!attempt || !attempt.psp_attempt_ref) {
            return {
              status: 409,
              body: { title: 'Payment has no PSP attempt to capture', status: 409 },
            };
          }

          const pspAccount = await db
            .selectFrom('psp_accounts')
            .selectAll()
            .where('id', '=', attempt.psp_account_id)
            .executeTakeFirstOrThrow();
          const adapter = registry.resolve(pspAccount);

          const result = await adapter.capture(
            attempt.psp_attempt_ref,
            undefined,
            `${id}-capture-${idempotencyKey}`,
          );
          await applyCanonicalEvents(db, id, captureAttemptEvents(result), pspAccount.psp);

          const finalPayment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          return { status: 200, body: serializePayment(finalPayment) };
        },
      );

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/v1/payments/:id/void',
    { schema: { tags: ['payments'], summary: 'Void an authorized (not-yet-captured) payment' } },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params as { id: string };
      const idempotencyKey = requireIdempotencyKey(request.headers);

      const outcome = await withIdempotencyKey(
        { db, redis },
        idempotencyKey,
        { method: request.method, path: request.url, body: request.body },
        async (): Promise<IdempotentResult> => {
          const payment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', id)
            .where('product_id', '=', auth.productId)
            .executeTakeFirst();
          if (!payment) return { status: 404, body: { title: 'Payment not found', status: 404 } };

          const attempt = await db
            .selectFrom('payment_attempts')
            .selectAll()
            .where('payment_id', '=', id)
            .orderBy('attempt_number', 'desc')
            .executeTakeFirst();
          if (!attempt || !attempt.psp_attempt_ref) {
            return {
              status: 409,
              body: { title: 'Payment has no PSP attempt to void', status: 409 },
            };
          }

          const pspAccount = await db
            .selectFrom('psp_accounts')
            .selectAll()
            .where('id', '=', attempt.psp_account_id)
            .executeTakeFirstOrThrow();
          const adapter = registry.resolve(pspAccount);

          const result = await adapter.void(
            attempt.psp_attempt_ref,
            `${id}-void-${idempotencyKey}`,
          );
          await applyCanonicalEvents(db, id, voidAttemptEvents(result), pspAccount.psp);

          const finalPayment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          return { status: 200, body: serializePayment(finalPayment) };
        },
      );

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/v1/payments/:id/refunds',
    {
      schema: {
        tags: ['payments'],
        summary: 'Refund a captured payment (full or partial)',
        body: zodToJsonSchema(refundBodySchema),
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params as { id: string };
      const idempotencyKey = requireIdempotencyKey(request.headers);
      const parsed = refundBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendValidationError(reply, parsed.error);

      const outcome = await withIdempotencyKey(
        { db, redis },
        idempotencyKey,
        { method: request.method, path: request.url, body: parsed.data },
        async (): Promise<IdempotentResult> => {
          const payment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', id)
            .where('product_id', '=', auth.productId)
            .executeTakeFirst();
          if (!payment) return { status: 404, body: { title: 'Payment not found', status: 404 } };

          const attempt = await db
            .selectFrom('payment_attempts')
            .selectAll()
            .where('payment_id', '=', id)
            .orderBy('attempt_number', 'desc')
            .executeTakeFirst();
          if (!attempt || !attempt.psp_attempt_ref) {
            return {
              status: 409,
              body: { title: 'Payment has no PSP attempt to refund', status: 409 },
            };
          }

          const pspAccount = await db
            .selectFrom('psp_accounts')
            .selectAll()
            .where('id', '=', attempt.psp_account_id)
            .executeTakeFirstOrThrow();
          const adapter = registry.resolve(pspAccount);

          // Partial refunds supported via the optional body amount;
          // defaults to the full payment amount. Tracking *remaining*
          // refundable balance across multiple partial refunds is
          // Milestone 6 ledger territory — flagged, not guessed at, here.
          const refundAmount = parsed.data.amount
            ? makeMoney(parsed.data.amount.minorUnits, parsed.data.amount.currency)
            : makeMoney(Number(payment.amount_minor_units), payment.currency);

          const result = await adapter.refund(
            attempt.psp_attempt_ref,
            refundAmount,
            `${id}-refund-${idempotencyKey}`,
          );
          await applyCanonicalEvents(db, id, refundAttemptEvents(), pspAccount.psp);
          void result;

          const finalPayment = await db
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          return { status: 200, body: serializePayment(finalPayment) };
        },
      );

      return reply.status(outcome.status).send(outcome.body);
    },
  );
}

export { serializePaymentMethod };
