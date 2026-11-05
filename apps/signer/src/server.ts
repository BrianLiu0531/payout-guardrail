import pg from 'pg';
import { buildSignerApp } from './app.js';
import { signerConfig } from './config.js';
import { Signer } from './signer.js';

const cfg = signerConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 });
await Signer.migrate(pool);

const signer = new Signer({ pool, account: cfg.account, chain: cfg.chain, webauthn: cfg.webauthn });
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
