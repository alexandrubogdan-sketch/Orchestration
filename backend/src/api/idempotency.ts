import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.js';

/**
 * Client -> API idempotency (Non-negotiable #4). The database is the
 * source of truth (Non-negotiable #2: "idempotency... enforced with DB
 * transactions and unique constraints, not application memory") —
 * `idempotency_keys.key` is a primary key, so whichever concurrent
 * request's INSERT wins the race is the one that actually runs the
 * handler; every other concurrent (or later) request for the same key
 * waits for that row to complete and replays its stored response.
 * Redis is a read-through cache for already-completed keys only, to
 * keep hot replay traffic off Postgres — it is never the thing that
 * decides who "wins," only an optimization once a winner is known.
 */

const RESPONSE_CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h — matches typical PSP idempotency-key windows
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 10_000;

export class IdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency-Key "${key}" was already used with a different request body`);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyStillInProgressError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency-Key "${key}" is still being processed by another request`);
    this.name = 'IdempotencyStillInProgressError';
  }
}

export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super('Idempotency-Key header is required for this request');
    this.name = 'MissingIdempotencyKeyError';
  }
}

/**
 * Routes that mutate state (T1.5, and every mutating Milestone 4
 * endpoint) call this at the top of their handler. Kept as a plain
 * function rather than a Fastify preHandler hook so it composes simply
 * with `withIdempotencyKey` — the handler stays a single, readable
 * `async (request, reply) => { const key = requireIdempotencyKey(...); ... }`.
 */
export function requireIdempotencyKey(headers: Record<string, unknown>): string {
  const raw = headers['idempotency-key'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissingIdempotencyKeyError();
  }
  return value;
}

export interface IdempotentRequestDescriptor {
  method: string;
  path: string;
  body: unknown;
}

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export interface IdempotentOutcome extends IdempotentResult {
  /** True if this response came from a prior completed request, not a fresh execution. */
  replayed: boolean;
}

export function computeRequestHash(request: IdempotentRequestDescriptor): string {
  const canonical = JSON.stringify({
    method: request.method.toUpperCase(),
    path: request.path,
    body: request.body ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  // node-postgres surfaces Postgres error codes on `.code`; 23505 is
  // unique_violation. Duck-typed rather than importing a pg error class
  // so this stays decoupled from the exact driver.
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function cacheKeyFor(key: string): string {
  return `idempotency:response:${key}`;
}

async function pollForCompletion(
  db: Db,
  key: string,
): Promise<{ requestHash: string; result: IdempotentResult }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const row = await db
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'status', 'response_status', 'response_body'])
      .where('key', '=', key)
      .executeTakeFirst();

    if (!row) {
      // The row that was blocking us got cleaned up (e.g. the original
      // attempt failed before completing) — the caller should retry
      // the whole operation, which will now win the insert race itself.
      throw new IdempotencyStillInProgressError(key);
    }

    if (row.status === 'completed') {
      return {
        requestHash: row.request_hash,
        result: { status: row.response_status ?? 500, body: row.response_body },
      };
    }

    if (Date.now() > deadline) {
      throw new IdempotencyStillInProgressError(key);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export interface IdempotencyDeps {
  db: Db;
  redis: Redis;
}

/**
 * Runs `handler` exactly once for a given Idempotency-Key, regardless
 * of how many concurrent/retried requests arrive with that key:
 *
 * - First request to insert the `idempotency_keys` row runs `handler`
 *   for real, stores its result, and returns `{replayed: false}`.
 * - Every other request (concurrent or a later retry) waits for that
 *   row to complete and returns the identical stored result with
 *   `{replayed: true}` — "every retry must produce the same result as
 *   the original request" (Non-negotiable #4).
 * - A request reusing the same key with a *different* body throws
 *   `IdempotencyConflictError` (maps to HTTP 409 at the route layer).
 * - If `handler` throws, the in-progress row is removed so the key
 *   isn't permanently wedged — a subsequent retry with the same key
 *   gets a fresh attempt rather than waiting forever for a row that
 *   will never complete.
 */
export async function withIdempotencyKey(
  deps: IdempotencyDeps,
  key: string,
  request: IdempotentRequestDescriptor,
  handler: () => Promise<IdempotentResult>,
): Promise<IdempotentOutcome> {
  const requestHash = computeRequestHash(request);

  const cached = await deps.redis.get(cacheKeyFor(key));
  if (cached) {
    const parsed = JSON.parse(cached) as { requestHash: string; result: IdempotentResult };
    if (parsed.requestHash !== requestHash) {
      throw new IdempotencyConflictError(key);
    }
    return { ...parsed.result, replayed: true };
  }

  try {
    await deps.db
      .insertInto('idempotency_keys')
      .values({ key, request_hash: requestHash, status: 'in_progress' })
      .execute();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const { requestHash: existingHash, result } = await pollForCompletion(deps.db, key);
    if (existingHash !== requestHash) {
      throw new IdempotencyConflictError(key);
    }
    await deps.redis.set(
      cacheKeyFor(key),
      JSON.stringify({ requestHash: existingHash, result }),
      'EX',
      RESPONSE_CACHE_TTL_SECONDS,
    );
    return { ...result, replayed: true };
  }

  let result: IdempotentResult;
  try {
    result = await handler();
  } catch (err) {
    await deps.db.deleteFrom('idempotency_keys').where('key', '=', key).execute();
    throw err;
  }

  await deps.db
    .updateTable('idempotency_keys')
    .set({
      status: 'completed',
      response_status: result.status,
      response_body: JSON.stringify(result.body),
      updated_at: new Date(),
    })
    .where('key', '=', key)
    .execute();

  await deps.redis.set(
    cacheKeyFor(key),
    JSON.stringify({ requestHash, result }),
    'EX',
    RESPONSE_CACHE_TTL_SECONDS,
  );

  return { ...result, replayed: false };
}
