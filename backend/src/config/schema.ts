import { z } from 'zod';

/**
 * Every environment variable the process depends on, validated once at
 * boot. Fail fast: if this doesn't parse, the process must not start.
 * Nothing in this file or its consumers should read from `process.env`
 * directly outside of `loadConfig()` — see src/config/index.ts.
 */
const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('payment-orchestrator'),

  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  HATCHET_CLIENT_TOKEN: z.string().min(1),
  HATCHET_CLIENT_TLS_STRATEGY: z.enum(['none', 'tls', 'mtls']).default('none'),

  // ADR-0005: sandbox vs. production is really a per-psp_account column,
  // but the *process* also needs to know which mode its dev/CI env
  // credentials below belong to, so make/seed and the /dev/* routes can
  // refuse to run against production (T0.6, T2.x). This does not gate
  // what a given psp_account row is allowed to do — that's the DB
  // column — it gates what THIS PROCESS, using THESE env-var
  // credentials, is allowed to do.
  STRIPE_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  // Pinned per non-negotiable stack rule: "Stripe Node SDK (pin version;
  // record API version in config)."
  STRIPE_API_VERSION: z.string().min(1),

  // Milestone 8, T8.5/ADR-0011: Solidgate, the second PSP. ALL optional
  // (unlike Stripe's required fields above) — Solidgate is an
  // incrementally-added second processor, per SPEC.md's own framing
  // ("Solidgate, Adyen, Netevia later via the same adapter interface"),
  // not a hard requirement for every deployment the way Stripe is.
  // `resolveSolidgateCredentials` throws its own clear error at
  // first-use if a psp_account needs these and they're absent, rather
  // than failing every process at boot for a PSP that deployment
  // doesn't use.
  SOLIDGATE_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  // Solidgate's own terminology: "Public key" (api_pk_..., sent as the
  // `merchant` request header) and "Secret key" (api_sk_...) — see
  // docs.solidgate.com/payments/integrate/access-to-api.
  SOLIDGATE_PUBLIC_KEY: z.string().min(1).optional(),
  SOLIDGATE_SECRET_KEY: z.string().min(1).optional(),
  SOLIDGATE_WEBHOOK_PUBLIC_KEY: z.string().min(1).optional(),
  SOLIDGATE_WEBHOOK_SECRET_KEY: z.string().min(1).optional(),
  // FLAGGED (ADR-0011): inferred from Solidgate's documented endpoint
  // paths (`POST /charge`, etc.) following their own naming
  // convention; not independently confirmed against their published
  // base-URL docs in this session. Overridable specifically so this
  // guess doesn't need a code change to correct once verified.
  SOLIDGATE_API_BASE_URL: z.string().url().default('https://pay.solidgate.com/api/v1'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default('payment-orchestrator'),

  METRICS_PORT: z.coerce.number().int().positive().default(9464),
});

/**
 * Cross-field validation: the secret/publishable key prefixes must
 * match the declared mode. Stripe's own key format makes this checkable
 * without ever looking at the key's actual value/permissions — a
 * `sk_live_...` key in a config claiming `STRIPE_MODE=sandbox` (or the
 * reverse) fails config validation at boot (T0.4's fail-fast contract),
 * not on the first live API call.
 */
export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  const secretPrefix = env.STRIPE_MODE === 'sandbox' ? 'sk_test_' : 'sk_live_';
  const publishablePrefix = env.STRIPE_MODE === 'sandbox' ? 'pk_test_' : 'pk_live_';

  if (!env.STRIPE_SECRET_KEY.startsWith(secretPrefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STRIPE_SECRET_KEY'],
      message: `STRIPE_MODE=${env.STRIPE_MODE} requires a key starting with "${secretPrefix}"`,
    });
  }
  if (!env.STRIPE_PUBLISHABLE_KEY.startsWith(publishablePrefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STRIPE_PUBLISHABLE_KEY'],
      message: `STRIPE_MODE=${env.STRIPE_MODE} requires a key starting with "${publishablePrefix}"`,
    });
  }
});

export type Env = z.infer<typeof baseEnvSchema>;
