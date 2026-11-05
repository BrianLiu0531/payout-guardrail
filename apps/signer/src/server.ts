import pg from 'pg';
import { buildSignerApp } from './app.js';
import { signerConfig } from './config.js';
import { kmsAccount, kmsClient } from './kms.js';
import { Signer } from './signer.js';

const cfg = signerConfig();
const owner = new pg.Pool({ connectionString: cfg.ownerDatabaseUrl, max: 1 });
await Signer.migrate(owner);
await owner.end();
// Runs as guardrail_signer, created by `npm run seed` (or the API on startup).
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 });
await pool.query('SELECT 1 FROM signer.state LIMIT 1').catch((err: Error) => {
  console.error(`cannot use the signer database role (${err.message}). Run \`npm run seed\` first.`);
  process.exit(1);
});

const account = cfg.kms ? await kmsAccount(kmsClient(cfg.kms), cfg.kms.keyId) : cfg.account;
const signer = new Signer({ pool, account, chain: cfg.chain, webauthn: cfg.webauthn });
const app = buildSignerApp({ signer, token: cfg.token, logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ address: signer.address }, 'signer ready');
