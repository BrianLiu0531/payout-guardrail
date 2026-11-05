import pg from 'pg';
import { Ledger, migrate } from '@guardrail/ledger';
import { buildApp } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail';
const PORT = Number(process.env.PORT ?? 8787);
// Loopback by default: this API has no authentication yet (phase 2 adds it).
const HOST = process.env.HOST ?? '127.0.0.1';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
await migrate(pool);

const app = buildApp({ ledger: new Ledger(pool), logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: HOST });
