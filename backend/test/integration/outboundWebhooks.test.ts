import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { transition } from '../../src/domain/stateMachineDb.js';
import { registerOutboundWebhookEndpoint } from '../../src/outbound/endpoints.js';
import { verifyOutboundWebhookSignature } from '../../src/outbound/signature.js';
import { createOutboundWebhookDeliveryTask } from '../../src/workflow/tasks/outboundWebhookDelivery.js';
import type { OutboxEventEnvelope } from '../../src/workflow/tasks/outboxRelay.js';

describe('T8.4 outbound webhook delivery (real Postgres + real HTTP)', () => {
  let pool: pg.Pool;
  let db: Db;
  let merchantEntityId: string;
  let productId: string;
  let customerId: string;
  let pspAccountId: string;
  let server: http.Server;
  let receivedRequests: { body: string; signature: string }[];

  const fakeCtx = {
    taskName: 'test',
    attempt: 1,
    logger: { info: () => {}, error: () => {} },
  };

  beforeEach(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);

    merchantEntityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({
        id: merchantEntityId,
        name: 'Webhook Test Co',
        legal_entity_code: `WH-${uuidv7()}`,
      })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'Webhook Test Product',
        slug: `wh-test-${uuidv7()}`,
      })
      .execute();

    customerId = uuidv7();
    await db
      .insertInto('customers')
      .values({ id: customerId, merchant_entity_id: merchantEntityId, email: 'wh@example.com' })
      .execute();

    pspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: pspAccountId,
        merchant_entity_id: merchantEntityId,
        psp: 'mock',
        display_name: 'Webhook Test PSP',
        mode: 'sandbox',
        secret_ref: 'not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'not-a-real-secret',
        capabilities: JSON.stringify({}),
        is_enabled: true,
      })
      .execute();

    receivedRequests = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedRequests.push({
          body: Buffer.concat(chunks).toString('utf8'),
          signature: String(req.headers['x-webhook-signature'] ?? ''),
        });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  function endpointUrl(): string {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/webhook`;
  }

  async function seedCapturedPayment(): Promise<string> {
    const paymentId = uuidv7();
    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        merchant_entity_id: merchantEntityId,
        product_id: productId,
        customer_id: customerId,
        amount_minor_units: '1999',
        currency: 'USD',
        state: 'created',
        cit_mit: 'cit',
      })
      .execute();
    await transition(db, paymentId, { type: 'authorization_started' });
    await transition(db, paymentId, { type: 'authorized' });
    await transition(db, paymentId, { type: 'capture_started' });
    await transition(db, paymentId, { type: 'captured' });
    return paymentId;
  }

  it('delivers a correctly signed payload to a subscribed endpoint', async () => {
    const { signingSecret } = await registerOutboundWebhookEndpoint(db, {
      productId,
      url: endpointUrl(),
      eventTypes: ['captured'],
    });

    const paymentId = await seedCapturedPayment();

    const outboxRow = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', paymentId)
      .where('event_type', '=', 'outbound-webhook')
      .execute()
      .then((rows) =>
        rows.find((row) => (row.payload as { event?: string }).event === 'captured')!,
      );
    const payload = outboxRow.payload as { event: string };
    expect(payload.event).toBe('captured');

    const envelope: OutboxEventEnvelope = {
      outboxEventId: outboxRow.id,
      aggregateType: outboxRow.aggregate_type,
      aggregateId: outboxRow.aggregate_id,
      eventType: outboxRow.event_type,
      payload: outboxRow.payload,
    };

    const task = createOutboundWebhookDeliveryTask({ db });
    const result = await task.handler(envelope, fakeCtx);
    expect(result).toEqual({ attempted: 1, delivered: 1, failed: 0 });

    expect(receivedRequests).toHaveLength(1);
    const received = receivedRequests[0]!;
    expect(() =>
      verifyOutboundWebhookSignature(signingSecret, received.body, received.signature),
    ).not.toThrow();
    expect(JSON.parse(received.body)).toMatchObject({ event: 'captured', paymentId });

    const delivery = await db
      .selectFrom('outbound_webhook_deliveries')
      .selectAll()
      .where('outbox_event_id', '=', outboxRow.id)
      .executeTakeFirstOrThrow();
    expect(delivery.status).toBe('delivered');
    expect(delivery.response_status).toBe(200);
  });

  it('does not deliver to an endpoint not subscribed to that event', async () => {
    await registerOutboundWebhookEndpoint(db, {
      productId,
      url: endpointUrl(),
      eventTypes: ['refunded'],
    });

    const paymentId = await seedCapturedPayment();
    const outboxRow = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', paymentId)
      .where('event_type', '=', 'outbound-webhook')
      .execute()
      .then((rows) =>
        rows.find((row) => (row.payload as { event?: string }).event === 'captured')!,
      );

    const task = createOutboundWebhookDeliveryTask({ db });
    const result = await task.handler(
      {
        outboxEventId: outboxRow.id,
        aggregateType: outboxRow.aggregate_type,
        aggregateId: outboxRow.aggregate_id,
        eventType: outboxRow.event_type,
        payload: outboxRow.payload,
      },
      fakeCtx,
    );
    expect(result).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(receivedRequests).toHaveLength(0);
  });

  it('re-running delivery for the same outbox event does not re-deliver to an already-succeeded endpoint', async () => {
    await registerOutboundWebhookEndpoint(db, {
      productId,
      url: endpointUrl(),
      eventTypes: ['captured'],
    });
    const paymentId = await seedCapturedPayment();
    const outboxRow = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', paymentId)
      .where('event_type', '=', 'outbound-webhook')
      .execute()
      .then((rows) =>
        rows.find((row) => (row.payload as { event?: string }).event === 'captured')!,
      );
    const envelope: OutboxEventEnvelope = {
      outboxEventId: outboxRow.id,
      aggregateType: outboxRow.aggregate_type,
      aggregateId: outboxRow.aggregate_id,
      eventType: outboxRow.event_type,
      payload: outboxRow.payload,
    };

    const task = createOutboundWebhookDeliveryTask({ db });
    await task.handler(envelope, fakeCtx);
    const secondRun = await task.handler(envelope, fakeCtx);

    expect(secondRun).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(receivedRequests).toHaveLength(1);
  });
});
