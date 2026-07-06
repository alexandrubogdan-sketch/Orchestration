import { Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import type { Database } from './types.js';

/**
 * Single Kysely instance, built on the same pg.Pool the rest of the app
 * uses for raw health-check pings (src/infra/postgres.ts) — one pool,
 * one set of connection-lifecycle concerns, per ADR-0002.
 */
export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export type Db = Kysely<Database>;
