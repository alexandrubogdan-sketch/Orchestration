import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { loadConfig } from '../src/config/index.js';
import { createDb } from '../src/db/client.js';
import { STRIPE_DECLINE_SEED } from '../src/domain/declines.js';
import { generateApiToken } from '../src/api/auth.js';

async function main() {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.database.url });
  const db = createDb(pool);

  try {
    const entityA = { id: uuidv7(), name: 'Acme Digital Goods (US)', legal_entity_code: 'US-LLC' };
    const entityB = { id: uuidv7(), name: 'Acme Digital Goods (EU)', legal_entity_code: 'EU-BV' };

    await db
      .insertInto('merchant_entities')
      .values([entityA, entityB])
      .onConflict((oc) => oc.column('legal_entity_code').doNothing())
      .execute();

    const entities = await db
      .selectFrom('merchant_entities')
      .selectAll()
      .where('legal_entity_code', 'in', [entityA.legal_entity_code, entityB.legal_entity_code])
      .execute();
    const usEntity = entities.find((e) => e.legal_entity_code === 'US-LLC')!;
    const euEntity = entities.find((e) => e.legal_entity_code === 'EU-BV')!;

    const products = [
      {
        id: uuidv7(),
        merchant_entity_id: usEntity.id,
        name: 'Pro Subscription',
        slug: 'pro-subscription',
      },
      {
        id: uuidv7(),
        merchant_entity_id: usEntity.id,
        name: 'One-Time Credits',
        slug: 'one-time-credits',
      },
      {
        id: uuidv7(),
        merchant_entity_id: euEntity.id,
        name: 'EU Pro Subscription',
        slug: 'eu-pro-subscription',
      },
    ];
    await db
      .insertInto('products')
      .values(products)
      .onConflict((oc) => oc.column('slug').doNothing())
      .execute();

    const pspAccounts = [
      {
        id: uuidv7(),
        merchant_entity_id: usEntity.id,
        psp: 'mock',
        display_name: 'Mock PSP (tests)',
        mode: 'sandbox' as const,
        secret_ref: 'mock/not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'mock/not-a-real-webhook-secret',
        capabilities: JSON.stringify({
          methods: ['card'],
          currencies: ['USD', 'EUR'],
          threeDs: true,
        }),
        is_enabled: true,
      },
      {
        id: uuidv7(),
        merchant_entity_id: usEntity.id,
        psp: 'stripe',
        display_name: 'Stripe (US sandbox)',
        mode: 'sandbox' as const,
        secret_ref: 'stripe/us/sandbox/secret-key',
        publishable_key_ref: 'stripe/us/sandbox/publishable-key',
        webhook_secret_ref: 'stripe/us/sandbox/webhook-secret',
        capabilities: JSON.stringify({ methods: ['card'], currencies: ['USD'], threeDs: true }),
        is_enabled: true,
      },
    ];

    const existingPspAccounts = await db
      .selectFrom('psp_accounts')
      .select('id')
      .where('merchant_entity_id', '=', usEntity.id)
      .execute();
    if (existingPspAccounts.length === 0) {
      await db.insertInto('psp_accounts').values(pspAccounts).execute();
    }

    const declineRows = STRIPE_DECLINE_SEED.map((entry) => ({
      id: uuidv7(),
      psp: 'stripe',
      raw_code: entry.rawCode,
      normalized_code: entry.normalizedCode,
      category: entry.category,
      retry_class: entry.retryClass,
      description: entry.description ?? null,
    }));
    await db
      .insertInto('decline_code_map')
      .values(declineRows)
      .onConflict((oc) => oc.columns(['psp', 'raw_code']).doNothing())
      .execute();

    const pilotProduct = products[1]!;
    const existingToken = await db
      .selectFrom('api_tokens')
      .select('id')
      .where('product_id', '=', pilotProduct.id)
      .executeTakeFirst();

    let printedToken: string | undefined;
    if (!existingToken) {
      const { raw, hash } = generateApiToken();
      await db
        .insertInto('api_tokens')
        .values({
          id: uuidv7(),
          product_id: pilotProduct.id,
          merchant_entity_id: usEntity.id,
          token_hash: hash,
          token_prefix: raw.slice(0, 11),
          name: 'Seeded pilot key',
          description: 'Seeded pilot-product token (dev only)',
        })
        .execute();
      printedToken = raw;
    }

    // eslint-disable-next-line no-console
    console.log(
      `Seeded ${entities.length} merchant entities, ${products.length} products, ` +
        `${pspAccounts.length} psp_accounts, ${declineRows.length} decline_code_map rows.`,
    );
    if (printedToken) {
      // eslint-disable-next-line no-console
      console.log(
        `\nPilot product API token (save this — shown only once):\n  ${printedToken}\n` +
          `Use it as: Authorization: Bearer ${printedToken}\n`,
      );
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Seed script failed', err);
  process.exit(1);
});
