import { sql } from 'kysely';
import type { Db } from '../../src/db/client.js';

export async function purgePaymentHistory(
  db: Db,
  paymentIds: string[],
  productIds: string[] = [],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    if (paymentIds.length > 0) {
      await trx.deleteFrom('payment_events').where('payment_id', 'in', paymentIds).execute();
      await trx.deleteFrom('transactions').where('payment_id', 'in', paymentIds).execute();
    }
    if (productIds.length > 0) {
      await trx.deleteFrom('audit_log').where('product_id', 'in', productIds).execute();
    }
  });
}
