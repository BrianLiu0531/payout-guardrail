import pg from 'pg';
import { migrate } from './migrate.js';

const DEFAULT_URL = 'postgres://guardrail:guardrail@localhost:5434/guardrail';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'migrate') {
    console.error('usage: cli.ts migrate');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_URL });
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
