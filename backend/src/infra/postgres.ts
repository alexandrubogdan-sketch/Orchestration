import pg from 'pg';
import type { AppConfig } from '../config/index.js';

const { Pool } = pg;

export function createPostgresPool(config: Pick<AppConfig, 'database'>): pg.Pool {
  return new Pool({ connectionString: config.database.url });
}

export async function pingPostgres(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
