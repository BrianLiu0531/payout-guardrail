import pg from 'pg';
import { Ledger } from '@guardrail/ledger';
import { ANVIL_DEPLOYER_KEY, apiConfig } from './config.js';
import { applyRoles } from './roles.js';
import { seedAll } from './setup.js';

const cfg = apiConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
try {
  const ledger = new Ledger(pool);
  const { chain } = await seedAll(pool, ledger, {
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    hotKey: cfg.leakedKey,
    deployerKey: ANVIL_DEPLOYER_KEY,
    keysFile: cfg.demoKeysFile,
    webauthn: cfg.webauthn,
  });
  await applyRoles(pool, cfg.rolePasswords);
  const problems = await ledger.verify();
  console.log(`demo data loaded; token ${chain.token}, hot wallet ${chain.hotWallet}; ledger verify: ${problems.length === 0 ? 'ok' : JSON.stringify(problems)}`);
} finally {
  await pool.end();
}
