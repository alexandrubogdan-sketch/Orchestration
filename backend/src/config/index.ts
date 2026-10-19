import { envSchema, type Env } from './schema.js';

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  serviceName: string;
  http: {
    host: string;
    port: number;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  hatchet: {
    token: string;
    tlsStrategy: Env['HATCHET_CLIENT_TLS_STRATEGY'];
  };
  stripe: {
    mode: Env['STRIPE_MODE'];
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    apiVersion: string;
  };

  solidgate: {
    mode: Env['SOLIDGATE_MODE'];
    publicKey: string | undefined;
    secretKey: string | undefined;
    webhookPublicKey: string | undefined;
    webhookSecretKey: string | undefined;
    apiBaseUrl: string;
  };
  otel: {
    exporterOtlpEndpoint: string | undefined;
    serviceName: string;
  };
  metrics: {
    port: number;
  };
}

let cached: AppConfig | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigValidationError(issues);
  }

  const env = result.data;
  cached = {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    serviceName: env.SERVICE_NAME,
    http: {
      host: env.API_HOST,
      port: env.API_PORT,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    hatchet: {
      token: env.HATCHET_CLIENT_TOKEN,
      tlsStrategy: env.HATCHET_CLIENT_TLS_STRATEGY,
    },
    stripe: {
      mode: env.STRIPE_MODE,
      secretKey: env.STRIPE_SECRET_KEY,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      apiVersion: env.STRIPE_API_VERSION,
    },
    solidgate: {
      mode: env.SOLIDGATE_MODE,
      publicKey: env.SOLIDGATE_PUBLIC_KEY,
      secretKey: env.SOLIDGATE_SECRET_KEY,
      webhookPublicKey: env.SOLIDGATE_WEBHOOK_PUBLIC_KEY,
      webhookSecretKey: env.SOLIDGATE_WEBHOOK_SECRET_KEY,
      apiBaseUrl: env.SOLIDGATE_API_BASE_URL,
    },
    otel: {
      exporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
    },
    metrics: {
      port: env.METRICS_PORT,
    },
  };
  return cached;
}

export function __resetConfigForTests(): void {
  cached = undefined;
}
