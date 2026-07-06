import pg from 'pg';
import type { AppConfig } from '../config/index.js';

const { Pool } = pg;

/**
 * Raw pg Pool, used for /readyz liveness pings in Milestone 0. The typed
 * Kysely instance (built on this pool, per ADR-0002) lands in Milestone 1
 * once `db/migrations/` produces a schema for kysely-codegen to read.
 */
export function createPostgresPool(config: Pick<AppConfig, 'database'>): pg.Pool {
  return new Pool({ connectionString: config.database.url });
}

export async function pingPostgres(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
