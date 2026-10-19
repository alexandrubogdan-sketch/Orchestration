import type { Db } from '../db/client.js';
import { webhookDlqDepth, webhookDlqTotal, webhookInboxBacklog } from '../observability/metrics.js';

export const MAX_WEBHOOK_ATTEMPTS = 5;

export type FailureDecision = 'retry' | 'dlq';

export async function recordFailureAndDecide(
  db: Db,
  inboxId: string,
  psp: string,
): Promise<FailureDecision> {
  const updated = await db
    .updateTable('webhook_inbox')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', inboxId)
    .returning(['attempts'])
    .executeTakeFirstOrThrow();

  if (updated.attempts >= MAX_WEBHOOK_ATTEMPTS) {
    await db
      .updateTable('webhook_inbox')
      .set({ status: 'dlq' })
      .where('id', '=', inboxId)
      .execute();
    webhookDlqTotal.inc({ psp });
    return 'dlq';
  }

  return 'retry';
}

export async function refreshWebhookHealthGauges(db: Db): Promise<void> {
  const backlogRows = await db
    .selectFrom('webhook_inbox')
    .select('psp')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', 'in', ['pending', 'processing', 'failed'])
    .groupBy('psp')
    .execute();
  for (const row of backlogRows) {
    webhookInboxBacklog.set({ psp: row.psp }, Number(row.count));
  }

  const dlqRows = await db
    .selectFrom('webhook_inbox')
    .select('psp')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '=', 'dlq')
    .groupBy('psp')
    .execute();
  for (const row of dlqRows) {
    webhookDlqDepth.set({ psp: row.psp }, Number(row.count));
  }
}
