import type { Db } from '../db/client.js';
import type { AppConfig } from '../config/index.js';
import type { NormalizedDecline } from '../domain/declines.js';
import type { PspAccountMode } from '../db/types.js';
import type { OutboundRateLimiter } from '../routing/rateLimiter.js';
import type { PspAdapter } from './types.js';
import { MockAdapter } from './mock/index.js';
import { StripeAdapter } from './stripe/index.js';
import { resolveStripeCredentials } from './stripe/credentials.js';
import { SolidgateAdapter } from './solidgate/index.js';
import { resolveSolidgateCredentials } from './solidgate/credentials.js';
import { RateLimitedPspAdapter } from './rateLimitedAdapter.js';

export interface PspAccountRow {
  id: string;
  psp: string;
  mode: PspAccountMode;
  secret_ref: string;
}

/**
 * Loads every `decline_code_map` row once and groups it by `psp`, so
 * each adapter gets an in-memory lookup instead of hitting Postgres per
 * decline (T1.4/ADR-0002's caching pattern — same idea as Milestone 5's
 * routing-rule cache will use). Call once at boot; there is currently no
 * cache-invalidation path, so a `decline_code_map` change requires a
 * process restart to take effect — acceptable for a table that changes
 * on the order of "a PSP adds a new decline code," not per-request.
 */
export async function loadDeclineMaps(
  db: Db,
): Promise<Map<string, Map<string, NormalizedDecline>>> {
  const rows = await db.selectFrom('decline_code_map').selectAll().execute();
  const byPsp = new Map<string, Map<string, NormalizedDecline>>();
  for (const row of rows) {
    const forPsp = byPsp.get(row.psp) ?? new Map<string, NormalizedDecline>();
    forPsp.set(row.raw_code, {
      psp: row.psp,
      rawCode: row.raw_code,
      normalizedCode: row.normalized_code,
      category: row.category,
      retryClass: row.retry_class,
      description: row.description ?? undefined,
    });
    byPsp.set(row.psp, forPsp);
  }
  return byPsp;
}

/**
 * Resolves a `psp_accounts` row to a ready-to-use `PspAdapter`,
 * caching one adapter instance per account id (a Stripe client is
 * reasonably expensive to construct and safe to reuse across
 * requests). This is the ONLY place outside src/adapters/mock and
 * src/adapters/stripe that is allowed to know both adapter classes
 * exist — every caller (the webhook route, T3.2's normalizer, T3.5's
 * gap-detection cron) goes through `resolve()` and only ever sees the
 * `PspAdapter` interface.
 */
export class PspAdapterRegistry {
  private readonly cache = new Map<string, PspAdapter>();
  private readonly mockAdapter: PspAdapter;

  constructor(
    private readonly config: Pick<AppConfig, 'stripe' | 'solidgate'>,
    private readonly declineMaps: ReadonlyMap<string, Map<string, NormalizedDecline>>,
    // T7.1: optional so every existing call site (admin scripts, the
    // ~6 test files that construct this registry directly) keeps
    // working unchanged without rate limiting; the two real process
    // entrypoints (src/api/server.ts, src/worker.ts) pass a real,
    // Redis-backed one. See src/adapters/rateLimitedAdapter.ts.
    private readonly rateLimiter?: OutboundRateLimiter,
  ) {
    this.mockAdapter = new MockAdapter();
  }

  resolve(pspAccount: PspAccountRow): PspAdapter {
    const raw = this.resolveRaw(pspAccount);
    if (!this.rateLimiter) return raw;
    return new RateLimitedPspAdapter(raw, this.rateLimiter, pspAccount.id);
  }

  private resolveRaw(pspAccount: PspAccountRow): PspAdapter {
    if (pspAccount.psp === 'mock') {
      return this.mockAdapter;
    }

    const cached = this.cache.get(pspAccount.id);
    if (cached) return cached;

    if (pspAccount.psp === 'stripe') {
      const credentials = resolveStripeCredentials(this.config, {
        mode: pspAccount.mode,
        secretRef: pspAccount.secret_ref,
      });
      const adapter = new StripeAdapter({
        credentials,
        apiVersion: this.config.stripe.apiVersion,
        declineMap: this.declineMaps.get('stripe') ?? new Map(),
      });
      this.cache.set(pspAccount.id, adapter);
      return adapter;
    }

    if (pspAccount.psp === 'solidgate') {
      const credentials = resolveSolidgateCredentials(this.config, {
        mode: pspAccount.mode,
        secretRef: pspAccount.secret_ref,
      });
      // Webhook verification credentials are resolved lazily (only
      // needed if verifyWebhook is actually called) rather than at
      // construction time — a process with SOLIDGATE_PUBLIC_KEY/
      // SOLIDGATE_SECRET_KEY set but no webhook keys configured can
      // still make outbound Solidgate calls; it just can't verify
      // inbound Solidgate webhooks yet.
      const webhookCredentials =
        this.config.solidgate.webhookPublicKey && this.config.solidgate.webhookSecretKey
          ? {
              webhookPublicKey: this.config.solidgate.webhookPublicKey,
              webhookSecretKey: this.config.solidgate.webhookSecretKey,
            }
          : undefined;
      const adapter = new SolidgateAdapter({
        credentials,
        webhookCredentials,
        declineMap: this.declineMaps.get('solidgate') ?? new Map(),
      });
      this.cache.set(pspAccount.id, adapter);
      return adapter;
    }

    throw new Error(`No adapter implementation registered for psp "${pspAccount.psp}"`);
  }
}
