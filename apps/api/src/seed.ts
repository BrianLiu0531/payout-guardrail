import pg from 'pg';
import { Ledger, migrate } from '@guardrail/ledger';
import { seedDemo } from './demo.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail',
});
try {
  await migrate(pool);
  const ledger = new Ledger(pool);
  await seedDemo(ledger);
  const problems = await ledger.verify();
  console.log(`demo data loaded; verify: ${problems.length === 0 ? 'ok' : JSON.stringify(problems)}`);
} finally {
  await pool.end();
}
