import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const REQUEST_ID_HEADER = 'x-request-id';

const storage = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Propagates a request id end-to-end: reuse an inbound `x-request-id` if
 * the caller supplied one (useful when the caller is another internal
 * service), otherwise mint a fresh one. Stashed in AsyncLocalStorage so
 * any code on the request's call stack (including code that doesn't have
 * direct access to the FastifyRequest, e.g. deep in adapters/) can read
 * it for logging/tracing correlation.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, reply, done) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
    request.id = requestId;
    void reply.header(REQUEST_ID_HEADER, requestId);
    storage.run({ requestId }, done);
  });
}
