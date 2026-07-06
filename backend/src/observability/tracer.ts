import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, type Tracer } from '@opentelemetry/api';
import type { AppConfig } from '../config/index.js';

let sdk: NodeSDK | undefined;

/**
 * Starts the OTel Node SDK. Call once at process boot, before any other
 * module that should be auto-instrumented (pg, redis, http, fastify) is
 * imported for its side effects — in practice we call this at the very
 * top of api/server.ts and worker.ts.
 */
export function startTracing(config: Pick<AppConfig, 'otel'>): NodeSDK {
  if (sdk) return sdk;

  sdk = new NodeSDK({
    serviceName: config.otel.serviceName,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reduce noise from fs instrumentation in dev.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = () => {
    sdk?.shutdown().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Error shutting down OTel SDK', err);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return sdk;
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}
