// Runs base-usdc-indexer against the local chain, watching the payout custody address and
// delivering deposits to this API's webhook. Uses ../base-usdc-indexer if it exists, otherwise
// clones the pinned commit into .cache/. Needs Go 1.26+ and `npm run seed` first.
//
//   npm run dev:indexer
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const REPO = 'https://github.com/BrianLiu0531/base-usdc-indexer.git';
// Pinned: the first commit with the webhook publisher and the anvil network.
const COMMIT = process.env.INDEXER_COMMIT ?? '18c97b01bf35809440d9fd33dd0b89578540c1de';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ownerUrl = process.env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail';

let dir = process.env.INDEXER_DIR ?? resolve(root, '..', 'base-usdc-indexer');
if (!existsSync(join(dir, 'go.mod'))) {
  dir = join(root, '.cache', 'base-usdc-indexer');
  if (!existsSync(join(dir, 'go.mod'))) {
    mkdirSync(join(root, '.cache'), { recursive: true });
    console.log(`cloning ${REPO} (${COMMIT}) into ${dir}`);
    const r = spawnSync('git', ['clone', '--quiet', REPO, dir], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
    spawnSync('git', ['-C', dir, 'checkout', '--quiet', COMMIT], { stdio: 'inherit' });
  }
}

const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
const { rows } = await pool.query("SELECT key, value FROM payouts.config WHERE key IN ('token', 'vault', 'hot_wallet', 'deposits_from_block')");
const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
if (!cfg.token) {
  console.error('no chain configuration: run `npm run seed` first');
  process.exit(1);
}
const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = 'indexer'");
if (!exists.rowCount) await pool.query('CREATE DATABASE indexer');
await pool.end();

const dbUrl = new URL(ownerUrl);
dbUrl.pathname = '/indexer';
dbUrl.searchParams.set('sslmode', 'disable');

const env = {
  ...process.env,
  NETWORK: 'anvil',
  USDC_ADDRESS: cfg.token,
  WATCH_ADDRESSES: cfg.vault ?? cfg.hot_wallet,
  START_BLOCK: cfg.deposits_from_block ?? '0',
  // anvil mines only when there are transactions, so "safe" and "finalized" never advance there.
  // On Base use safe or finalized.
  CONFIRM_AT: process.env.INDEXER_CONFIRM_AT ?? 'pending',
  RPC_URLS: process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545',
  RPC_MAX_RPS: '50',
  POLL_INTERVAL: '1s',
  RECONCILE_INTERVAL: '1m',
  DATABASE_URL: dbUrl.toString(),
  HTTP_ADDR: process.env.INDEXER_HTTP_ADDR ?? '127.0.0.1:8089',
  LOG_FORMAT: 'text',
  OUTBOX_WEBHOOK_URL: process.env.INDEXER_WEBHOOK_URL ?? 'http://127.0.0.1:8787/v1/integrations/indexer',
  OUTBOX_WEBHOOK_SECRET: process.env.INDEXER_WEBHOOK_SECRET ?? 'dev-indexer-webhook-secret',
};
console.log(`indexer: watching ${env.WATCH_ADDRESSES} for ${env.USDC_ADDRESS} from block ${env.START_BLOCK}; dashboard http://${env.HTTP_ADDR}`);
const child = spawn('go', ['run', './cmd/indexer'], { cwd: dir, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
