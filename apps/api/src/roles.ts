import pg from 'pg';

/**
 * Least-privilege database roles. Migrations run as the owner; at runtime the API and the
 * signer each connect as their own role:
 *
 *   guardrail_api     ledger: read, insert, update balances. payouts: what the workflow needs,
 *                     audit and approvals insert-only. signer schema: nothing.
 *   guardrail_signer  signer schema only: read, insert, update its state row.
 *
 * Neither role owns a table, so neither can disable the append-only triggers or alter a
 * table; only the owner (a "DB admin") can, which is what the audit-rewrite attack plays.
 */

export interface RolePasswords {
  api: string;
  signer: string;
}

const GRANTS = `
REVOKE ALL ON SCHEMA ledger, payouts, signer FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ledger, payouts, signer FROM guardrail_api, guardrail_signer;

GRANT USAGE ON SCHEMA ledger, payouts TO guardrail_api;
GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO guardrail_api;
GRANT INSERT ON ledger.transactions, ledger.entries TO guardrail_api;
GRANT UPDATE ON ledger.balances TO guardrail_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ledger TO guardrail_api;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA payouts TO guardrail_api;
GRANT UPDATE ON payouts.intents, payouts.payees, payouts.credentials TO guardrail_api;
GRANT DELETE ON payouts.sessions, payouts.challenges TO guardrail_api;
REVOKE INSERT ON payouts.config FROM guardrail_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA payouts TO guardrail_api;

GRANT USAGE ON SCHEMA signer TO guardrail_signer;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA signer TO guardrail_signer;
GRANT UPDATE ON signer.state TO guardrail_signer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA signer TO guardrail_signer;
`;

async function ensureRole(client: pg.PoolClient, name: string, password: string): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  const pw = client.escapeLiteral(password);
  try {
    if (exists.rowCount === 0) await client.query(`CREATE ROLE ${name} LOGIN PASSWORD ${pw}`);
    else await client.query(`ALTER ROLE ${name} WITH LOGIN PASSWORD ${pw}`);
  } catch (err) {
    // Another process created it first (roles are cluster-wide).
    if ((err as { code?: string }).code !== '42710') throw err;
  }
}

/** Creates the roles if needed and (re)applies their grants. Run as the owner, after migrations. */
export async function applyRoles(owner: pg.Pool, passwords: RolePasswords): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('guardrail:roles'))");
    await ensureRole(client, 'guardrail_api', passwords.api);
    await ensureRole(client, 'guardrail_signer', passwords.signer);
    await client.query(GRANTS);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('guardrail:roles'))").catch(() => undefined);
    client.release();
  }
}

/** The same database URL with a different user and password. */
export function asRole(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
