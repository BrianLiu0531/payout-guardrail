import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Ledger } from '../src/ledger.js';
import { migrate } from '../src/migrate.js';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail';

export interface TestDb {
  pool: pg.Pool;
  ledger: Ledger;
  drop(): Promise<void>;
}

/** A fresh, migrated database per test file, dropped afterwards. */
export async function createTestDb(): Promise<TestDb> {
  const name = `guardrail_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 40 });
  await migrate(pool);

  return {
    pool,
    ledger: new Ledger(pool),
    async drop() {
      await pool.end();
      const admin2 = new pg.Client({ connectionString: ADMIN_URL });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin2.end();
    },
  };
}

let counter = 0;
/** Unique suffix so tests sharing a database never collide on codes or keys. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}-${randomBytes(3).toString('hex')}`;
}
