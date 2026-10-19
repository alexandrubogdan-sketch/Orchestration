import { z } from 'zod';

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

  STRIPE_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  STRIPE_API_VERSION: z.string().min(1),

  SOLIDGATE_MODE: z.enum(['sandbox', 'production']).default('sandbox'),

  SOLIDGATE_PUBLIC_KEY: z.string().min(1).optional(),
  SOLIDGATE_SECRET_KEY: z.string().min(1).optional(),
  SOLIDGATE_WEBHOOK_PUBLIC_KEY: z.string().min(1).optional(),
  SOLIDGATE_WEBHOOK_SECRET_KEY: z.string().min(1).optional(),

  SOLIDGATE_API_BASE_URL: z.string().url().default('https://pay.solidgate.com/api/v1'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default('payment-orchestrator'),

  METRICS_PORT: z.coerce.number().int().positive().default(9464),
});

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
