import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ledger } from '@guardrail/ledger';
import { SoftAuthenticator } from '@guardrail/core';
import { Signer, SignerRefusal } from '@guardrail/signer';
import { freshChain, freshDb, type TestChain } from '../../signer/test/helpers.js';
import { setupNetwork } from '../src/network.js';
import { Reconciler } from '../src/payouts/reconcile.js';
import type { SignerPort } from '../src/payouts/signerPort.js';

/**
 * A non-demo install, as on Base Sepolia, rehearsed on anvil: opening balances come from the
 * chain, the first two approvers are enrolled on the signer host, and reconciliation agrees.
 */

const webauthn = { rpId: 'localhost', origins: ['http://localhost:5173'] };
let db: Awaited<ReturnType<typeof freshDb>>;
let chain: TestChain;
let ledger: Ledger;
let signer: Signer;

beforeAll(async () => {
  db = await freshDb();
  chain = await freshChain();
  await chain.mint(chain.hot.address, 12_345_678_900n);
  ledger = new Ledger(db.pool);
  await Signer.migrate(db.pool);
  signer = new Signer({ pool: db.pool, account: chain.hot, chain: chain.publicClient, webauthn });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

const port = (s: Signer): SignerPort => ({
  signPayout: (r) => s.signPayout(r),
  applyGovernance: (r) => s.applyGovernance(r),
  tripBreaker: (r) => s.tripBreaker(r),
  status: () => s.status(),
  log: (a) => s.log(a),
  refusals: () => s.refusals(),
  approvers: () => s.approvers(),
  anchor: (q, h) => s.anchor(q, h),
  anchors: () => s.anchors(),
});

describe('network install', () => {
  it('posts opening balances read from the chain, once', async () => {
    const opts = { rpcUrl: '', chainId: 31337, token: chain.token, hotWallet: chain.hot.address };
    const first = await setupNetwork(db.pool, ledger, opts, chain.publicClient);
    expect(first.token).toEqual({ symbol: 'mUSDC', decimals: 6 });
    expect(first.opening.posted).toBe(true);
    const again = await setupNetwork(db.pool, ledger, opts, chain.publicClient);
    expect(again.opening.posted).toBe(false);
    expect((await ledger.getBalance('asset:base:hot:usdc')).balance).toBe(12_345_678_900n);
    expect((await ledger.getBalance('asset:base:hot:eth')).balance).toBe(await chain.publicClient.getBalance({ address: chain.hot.address }));
  });

  it('enrolls exactly two bootstrap approvers on the signer host', async () => {
    await signer.bootstrap({ chainId: 31337, token: chain.token, approvers: [], payees: [] });
    const keys = [SoftAuthenticator.create(), SoftAuthenticator.create(), SoftAuthenticator.create()];
    await db.pool.query("INSERT INTO payouts.users (id, name, role) VALUES ('erin', 'Erin', 'approver'), ('finn', 'Finn', 'approver')");
    for (const [i, user] of ['erin', 'finn'].entries()) {
      await db.pool.query('INSERT INTO payouts.credentials (id, user_id, public_key) VALUES ($1, $2, $3)', [keys[i]!.credentialId, user, Buffer.from(keys[i]!.publicKeyCose())]);
      await signer.enrollBootstrapApprover({ userId: user, credentialId: keys[i]!.credentialId, publicKey: keys[i]!.publicKeyCose() });
    }
    await expect(signer.enrollBootstrapApprover({ userId: 'mallory', credentialId: keys[2]!.credentialId, publicKey: keys[2]!.publicKeyCose() })).rejects.toBeInstanceOf(SignerRefusal);

    // The API learns who is enrolled from the signer, during reconciliation.
    const settings = { chainId: 31337, token: chain.token, hotWallet: chain.hot.address };
    const report = await new Reconciler(db.pool, ledger, port(signer), chain.publicClient, settings).run();
    const { rows } = await db.pool.query('SELECT id, enrolled FROM payouts.credentials ORDER BY user_id');
    expect(rows.every((r) => r.enrolled)).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
