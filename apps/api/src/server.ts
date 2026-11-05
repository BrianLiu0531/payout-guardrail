import pg from 'pg';
import { createPublicClient, http, type PublicClient } from 'viem';
import { localChain } from '@guardrail/core';
import { Ledger } from '@guardrail/ledger';
import { buildApp } from './app.js';
import { apiConfig } from './config.js';
import { DemoBots } from './payouts/demo.js';
import { Reconciler } from './payouts/reconcile.js';
import { Payouts } from './payouts/service.js';
import { HttpSigner } from './payouts/signerPort.js';
import { PayoutWorker } from './payouts/worker.js';
import { applyRoles } from './roles.js';
import { migrateAll, readChainSettings } from './setup.js';

const cfg = apiConfig();
// Migrations and grants run as the owner; requests are served as guardrail_api.
const owner = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
await migrateAll(owner);
await applyRoles(owner, cfg.rolePasswords);
if (!cfg.demoMode) await owner.end();
const pool = new pg.Pool({ connectionString: cfg.apiDatabaseUrl, max: 10 });

const ledger = new Ledger(pool);
const chainSettings = await readChainSettings(pool);
if (!chainSettings) {
  console.error('No chain configuration found. Start the chain and run `npm run seed` first.');
  process.exit(1);
}

const chain = createPublicClient({ chain: localChain(cfg.rpcUrl, cfg.chainId), transport: http(cfg.rpcUrl) }) as PublicClient;
const signer = new HttpSigner(cfg.signerUrl, cfg.signerToken);
const payouts = new Payouts(pool, chainSettings, cfg.webauthn);
const worker = new PayoutWorker(payouts, ledger, signer, chain, { confirmations: cfg.confirmations });
const reconciler = new Reconciler(pool, ledger, signer, chain, chainSettings);
const bots = cfg.demoMode ? await DemoBots.load(cfg.demoKeysFile) : undefined;

const app = buildApp({
  ledger,
  logger: true,
  payouts: {
    payouts,
    signer,
    reconciler,
    demoMode: cfg.demoMode,
    secureCookies: cfg.secureCookies,
    bots,
    // The owner connection is kept only in demo mode, for the attack that plays a rogue DB admin.
    attackDeps: bots ? { payouts, signer, bots, chain, reconciler, rpcUrl: cfg.rpcUrl, leakedKey: cfg.leakedKey, adminPool: owner } : undefined,
  },
});

/** Runs fn every intervalMs, never overlapping itself, logging failures instead of crashing. */
function every(intervalMs: number, name: string, fn: () => Promise<unknown>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const loop = async () => {
    try {
      await fn();
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, `${name} failed`);
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  timer = setTimeout(loop, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const stopWorker = every(cfg.workerIntervalMs, 'worker', () => worker.tick());
const stopRecon = every(cfg.reconIntervalMs, 'reconciliation', () => reconciler.run());

const shutdown = async () => {
  stopWorker();
  stopRecon();
  await app.close();
  await pool.end();
  if (cfg.demoMode) await owner.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
