import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockUsdcAbi } from '@guardrail/core';
import { Ledger } from '@guardrail/ledger';
import { Signer } from '@guardrail/signer';
import { chain as anvil, freshDb, RPC_URL } from '../../signer/test/helpers.js';
import { buildApp } from '../src/app.js';
import { Deposits, verifyIndexerSignature, type IndexerEvent } from '../src/payouts/deposits.js';
import { Reconciler } from '../src/payouts/reconcile.js';
import { Payouts, type ChainSettings } from '../src/payouts/service.js';
import type { SignerPort } from '../src/payouts/signerPort.js';
import { seedAll } from '../src/setup.js';

const SECRET = 'test-indexer-webhook-secret';
const webauthn = { rpId: 'localhost', rpName: 'Payout Guardrail', origins: ['http://localhost:5173'] };
let db: Awaited<ReturnType<typeof freshDb>>;
let app: FastifyInstance;
let ledger: Ledger;
let reconciler: Reconciler;
let chainSettings: ChainSettings;
let publicClient: PublicClient;
let deployerKey: Hex;

beforeAll(async () => {
  db = await freshDb();
  ledger = new Ledger(db.pool);
  publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) }) as PublicClient;
  deployerKey = generatePrivateKey();
  const hotKey = generatePrivateKey();
  await createTestClient({ chain: anvil, mode: 'anvil', transport: http(RPC_URL) }).setBalance({ address: privateKeyToAccount(deployerKey).address, value: parseEther('10') });
  const seeded = await seedAll(db.pool, ledger, {
    rpcUrl: RPC_URL, chainId: 31337, hotKey, deployerKey, webauthn,
    keysFile: join(tmpdir(), `guardrail-keys-${randomBytes(4).toString('hex')}.json`),
    payees: [{ id: 'acme-hosting', name: 'Acme', address: privateKeyToAccount(generatePrivateKey()).address }],
  });
  chainSettings = seeded.chain;
  const signer = new Signer({ pool: db.pool, account: privateKeyToAccount(hotKey), chain: publicClient, webauthn });
  const port: SignerPort = {
    signPayout: (r) => signer.signPayout(r), applyGovernance: (r) => signer.applyGovernance(r), tripBreaker: (r) => signer.tripBreaker(r),
    status: () => signer.status(), log: (a) => signer.log(a), refusals: () => signer.refusals(), approvers: () => signer.approvers(),
    anchor: (q, h) => signer.anchor(q, h), anchors: () => signer.anchors(),
  };
  reconciler = new Reconciler(db.pool, ledger, port, publicClient, chainSettings);
  app = buildApp({
    ledger,
    payouts: {
      payouts: new Payouts(db.pool, chainSettings, webauthn), signer: port, reconciler, demoMode: false,
      deposits: { service: new Deposits(db.pool, ledger, chainSettings), webhookSecret: SECRET },
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

/** A customer sends USDC to custody, the way a real deposit arrives. Returns the indexer's view of it. */
async function deposit(value: bigint): Promise<IndexerEvent> {
  const customer = privateKeyToAccount(generatePrivateKey());
  await createTestClient({ chain: anvil, mode: 'anvil', transport: http(RPC_URL) }).setBalance({ address: customer.address, value: parseEther('1') });
  const minter = createWalletClient({ account: privateKeyToAccount(deployerKey), chain: anvil, transport: http(RPC_URL) });
  await publicClient.waitForTransactionReceipt({ hash: await minter.writeContract({ address: chainSettings.token, abi: mockUsdcAbi, functionName: 'mint', args: [customer.address, value] }) });
  const w = createWalletClient({ account: customer, chain: anvil, transport: http(RPC_URL) });
  const hash = await w.writeContract({ address: chainSettings.token, abi: mockUsdcAbi, functionName: 'transfer', args: [chainSettings.custody, value] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  const log = r.logs[0]!;
  return {
    eventId: `transfer.confirmed:31337:${hash}:${log.logIndex}:${r.blockHash}`, type: 'transfer.confirmed', chainId: 31337, txHash: hash,
    logIndex: log.logIndex, blockNumber: Number(r.blockNumber), from: customer.address, to: chainSettings.custody, value: value.toString(),
  };
}

async function send(events: IndexerEvent[], opts: { secret?: string; ts?: number } = {}) {
  const body = JSON.stringify({ events });
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(`${ts}.${body}`).digest('hex')}`;
  return app.inject({
    method: 'POST', url: '/v1/integrations/indexer', payload: body,
    headers: { 'content-type': 'application/json', 'x-indexer-timestamp': ts, 'x-indexer-signature': sig },
  });
}

const custodyLedger = async () => (await ledger.getBalance('asset:base:hot:usdc')).balance;

describe('deposits from base-usdc-indexer', () => {
  it('signs exactly like the Go publisher', () => {
    const sig = 'sha256=9f923d7189f90ae9359ce99207943ff345d609594d319e5dbeaa97092949a915';
    expect(verifyIndexerSignature('s3cret', '1790000000', sig, '{"events":[]}', 1790000000_000)).toBe(true);
    expect(verifyIndexerSignature('s3cret', '1790000000', sig, '{"events":[]}', 1790000000_000 + 301_000)).toBe(false); // stale
  });

  it('rejects unsigned, forged and stale deliveries', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/integrations/indexer', payload: { events: [] } })).statusCode).toBe(401);
    expect((await send([], { secret: 'wrong-secret-wrong-secret' })).statusCode).toBe(401);
    expect((await send([], { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
  });

  it('waits for the indexer, credits each deposit once, and reconciles', async () => {
    const before = await custodyLedger();
    const e = await deposit(1_234_560_000n);

    // On chain but not yet confirmed by the indexer: a warning, not a discrepancy.
    const pending = await reconciler.run();
    expect(pending.ok).toBe(true);
    expect(pending.findings.map((f) => f.kind)).toEqual(['deposits_pending']);

    const res = await send([e]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ credited: 1 });
    expect((await send([e])).json()).toMatchObject({ duplicate: 1, credited: 0 }); // redelivery changes nothing
    expect(await custodyLedger()).toBe(before + 1_234_560_000n);
    expect((await ledger.getBalance('liability:customer-deposits')).balance).toBe(1_234_560_000n);

    const after = await reconciler.run();
    expect(after.findings).toEqual([]);
  });

  it('reverses a deposit the indexer reports as reorganised away', async () => {
    const e = await deposit(5_000_000n);
    await send([e]);
    const credited = await custodyLedger();
    const reverted: IndexerEvent = { ...e, type: 'transfer.reverted', eventId: e.eventId.replace('transfer.confirmed', 'transfer.reverted') };
    expect((await send([reverted])).json()).toMatchObject({ reversed: 1 });
    expect((await send([reverted])).json()).toMatchObject({ duplicate: 1 });
    expect(await custodyLedger()).toBe(credited - 5_000_000n);
  });

  it('flags a deposit the indexer never reported, once the grace period has passed', async () => {
    const test = createTestClient({ chain: anvil, mode: 'anvil', transport: http(RPC_URL) });
    // The reversed deposit above is still on chain (anvil did not really reorg): it is now uncredited.
    await test.increaseTime({ seconds: 600 });
    await test.mine({ blocks: 1 });
    const report = await reconciler.run();
    expect(report.findings.some((f) => f.kind === 'deposit_not_credited' && f.severity === 'critical')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('records outgoing transfers from custody without booking them twice', async () => {
    const e: IndexerEvent = {
      eventId: `transfer.confirmed:31337:0x${'ab'.repeat(32)}:0:0x${'cd'.repeat(32)}`, type: 'transfer.confirmed', chainId: 31337,
      txHash: `0x${'ab'.repeat(32)}`, logIndex: 0, blockNumber: 1, from: chainSettings.custody, to: privateKeyToAccount(generatePrivateKey()).address, value: '1',
    };
    const before = await custodyLedger();
    expect((await send([e])).json()).toMatchObject({ outgoing: 1 });
    expect(await custodyLedger()).toBe(before);
  });
});
