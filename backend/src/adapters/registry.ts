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

export class PspAdapterRegistry {
  private readonly cache = new Map<string, PspAdapter>();
  private readonly mockAdapter: PspAdapter;

  constructor(
    private readonly config: Pick<AppConfig, 'stripe' | 'solidgate'>,
    private readonly declineMaps: ReadonlyMap<string, Map<string, NormalizedDecline>>,

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
