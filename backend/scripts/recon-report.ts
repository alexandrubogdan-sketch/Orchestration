/**
 * T6.3 admin command: `make recon-report`. Prints every OPEN
 * `recon_exceptions` row, grouped by psp_account and type, to stdout —
 * the "zero unexplained exceptions" review-gate SPEC.md's Milestone 6
 * goal describes is read directly off this report's output, not
 * inferred from raw table contents.
 */
import { loadConfig } from '../src/config/index.js';
import { createPostgresPool } from '../src/infra/postgres.js';
import { createDb } from '../src/db/client.js';

async function main() {
  const config = loadConfig();
  const pool = createPostgresPool(config);
  const db = createDb(pool);

  try {
    const rows = await db
      .selectFrom('recon_exceptions')
      .innerJoin('psp_accounts', 'psp_accounts.id', 'recon_exceptions.psp_account_id')
      .select([
        'recon_exceptions.id',
        'recon_exceptions.type',
        'recon_exceptions.payment_id',
        'recon_exceptions.expected_amount_minor_units',
        'recon_exceptions.actual_amount_minor_units',
        'recon_exceptions.currency',
        'recon_exceptions.detected_at',
        'psp_accounts.display_name as psp_account_name',
        'psp_accounts.psp',
      ])
      .where('recon_exceptions.status', '=', 'open')
      .orderBy('recon_exceptions.detected_at', 'desc')
      .execute();

    if (rows.length === 0) {
      // eslint-disable-next-line no-console
      console.log('recon-report: zero open exceptions.');
      return;
    }

    const byPspAndType = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.psp_account_name} (${row.psp}) / ${row.type}`;
      byPspAndType.set(key, (byPspAndType.get(key) ?? 0) + 1);
    }

    // eslint-disable-next-line no-console
    console.log(`recon-report: ${rows.length} open exception(s)\n`);
    // eslint-disable-next-line no-console
    console.log('By psp_account / type:');
    for (const [key, count] of [...byPspAndType.entries()].sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log(`  ${count.toString().padStart(4)}  ${key}`);
    }

    // eslint-disable-next-line no-console
    console.log('\nDetail:');
    for (const row of rows) {
      const expected = row.expected_amount_minor_units ?? '—';
      const actual = row.actual_amount_minor_units ?? '—';
      // eslint-disable-next-line no-console
      console.log(
        `  [${row.detected_at.toString()}] ${row.type} on ${row.psp_account_name} — ` +
          `expected=${expected} actual=${actual} ${row.currency ?? ''} ` +
          `payment_id=${row.payment_id ?? 'n/a'} (recon_exceptions.id=${row.id})`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('recon-report failed', err);
  process.exit(1);
});
