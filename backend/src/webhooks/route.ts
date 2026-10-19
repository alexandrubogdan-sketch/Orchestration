import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { PspAdapterRegistry, PspAccountRow } from '../adapters/registry.js';
import { InvalidSignatureError } from '../adapters/types.js';
import type { WorkflowEngine } from '../workflow/engine.js';
import { webhookSignatureInvalidTotal } from '../observability/metrics.js';

export interface WebhookRouteDeps {
  db: Db;
  registry: PspAdapterRegistry;
  engine: WorkflowEngine;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  void app.register((instance, _opts, done) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    instance.post<{ Params: { psp: string } }>('/webhooks/:psp', async (request, reply) => {
      const { psp } = request.params;
      const rawBody = request.body as Buffer;

      const candidates: PspAccountRow[] = await deps.db
        .selectFrom('psp_accounts')
        .select(['id', 'psp', 'mode', 'secret_ref'])
        .where('psp', '=', psp)
        .where('is_enabled', '=', true)
        .execute();

      let verified: { providerEventId: string; rawPayload: unknown } | undefined;
      let matchedAccount: PspAccountRow | undefined;

      for (const account of candidates) {
        try {
          const adapter = deps.registry.resolve(account);
          verified = adapter.verifyWebhook(rawBody, request.headers);
          matchedAccount = account;
          break;
        } catch (err) {
          if (err instanceof InvalidSignatureError) continue;
          throw err;
        }
      }

      if (!verified || !matchedAccount) {
        webhookSignatureInvalidTotal.inc({ psp });
        request.log.warn(
          { psp },
          'webhook signature verification failed against every candidate account',
        );
        return reply
          .status(400)
          .type('application/problem+json')
          .send({ type: 'about:blank', title: 'Invalid webhook signature', status: 400 });
      }

      const inserted = await deps.db
        .insertInto('webhook_inbox')
        .values({
          id: uuidv7(),
          psp,
          psp_account_id: matchedAccount.id,
          provider_event_id: verified.providerEventId,
          raw_payload: JSON.stringify(verified.rawPayload),
          status: 'pending',
        })
        .onConflict((oc) => oc.columns(['psp', 'provider_event_id']).doNothing())
        .returning('id')
        .executeTakeFirst();

      if (inserted) {
        deps.engine
          .dispatch('webhook.normalize', { inboxId: inserted.id }, { key: inserted.id })
          .catch((err: unknown) => {
            request.log.error(
              { err, inboxId: inserted.id },
              'failed to dispatch webhook.normalize — will be picked up by gap-detection or a manual replay',
            );
          });
      }

      return reply.status(200).send({ status: 'ok' });
    });

    done();
  });
}
