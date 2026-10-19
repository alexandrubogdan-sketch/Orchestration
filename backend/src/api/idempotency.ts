import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.js';

const RESPONSE_CACHE_TTL_SECONDS = 60 * 60 * 24;
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

export function requireIdempotencyKey(headers: Record<string, unknown>, scope: string): string {
  const raw = headers['idempotency-key'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissingIdempotencyKeyError();
  }
  return `${scope}:${value}`;
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
