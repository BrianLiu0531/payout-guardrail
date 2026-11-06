import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, type Hex } from 'viem';
import { intentChallenge, intentHash, payoutVaultAbi, SoftAuthenticator, type Intent, type PayoutIntent } from '@guardrail/core';
import { Signer, SignerRefusal } from '../src/index.js';
import { chain as anvil, freshChain, freshDb, randomAddress, RPC_URL, type TestChain } from './helpers.js';

const USDC = 1_000_000n;
const LIMIT = 1_500n * USDC;
const webauthn = { rpId: 'localhost', origins: ['http://localhost:5173'] };

let db: Awaited<ReturnType<typeof freshDb>>;
let chain: TestChain;
let vault: Hex;
let signer: Signer;
const bob = SoftAuthenticator.create();
const acme = randomAddress();

beforeAll(async () => {
  db = await freshDb();
  chain = await freshChain();
  vault = await chain.deployVault(LIMIT);
  await chain.mint(vault, 20_000n * USDC);
  await Signer.migrate(db.pool);
  signer = new Signer({ pool: db.pool, account: chain.hot, chain: chain.publicClient, webauthn });
  await signer.bootstrap({
    chainId: 31337, token: chain.token, vault,
    approvers: [{ userId: 'bob', credentialId: bob.credentialId, publicKey: bob.publicKeyCose() }],
    payees: [{ payeeId: 'acme', name: 'Acme', address: acme, chainId: 31337, activatedAt: new Date('2026-01-01') }],
  });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

const payout = (amount: bigint): PayoutIntent => ({
  kind: 'payout', intentId: randomUUID(), chainId: 31337, token: chain.token, to: acme, amount: amount.toString(), payeeId: 'acme',
  memo: '', expenseAccount: 'expense:vendor-services', createdBy: 'alice', createdAt: new Date().toISOString(),
});
const approvals = (i: Intent) => [{
  userId: 'bob', credentialId: bob.credentialId,
  assertion: bob.assert({ challenge: intentChallenge(intentHash(i)), rpId: 'localhost', origin: webauthn.origins[0]! }),
}];
const thief = () => createWalletClient({ account: chain.hot, chain: anvil, transport: http(RPC_URL) });
const read = <F extends 'remaining' | 'paused' | 'spentInWindow'>(fn: F) =>
  chain.publicClient.readContract({ address: vault, abi: payoutVaultAbi, functionName: fn }) as Promise<F extends 'paused' ? boolean : bigint>;

describe('PayoutVault', () => {
  it('pays an approved intent through the vault; the hot key holds no tokens', async () => {
    const p = payout(1_000n * USDC);
    const signed = await signer.signPayout({ intent: p, approvals: approvals(p) });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash: await chain.publicClient.sendRawTransaction({ serializedTransaction: signed.rawTx }) });
    expect(receipt.status).toBe('success');
    expect(await chain.balanceOf(acme)).toBe(1_000n * USDC);
    expect(await chain.balanceOf(chain.hot.address)).toBe(0n);
    expect(await read('remaining')).toBe(LIMIT - 1_000n * USDC);
  });

  it('refuses before signing when the payout exceeds what is left of the daily limit', async () => {
    const p = payout(900n * USDC); // within policy (one approver), but only 500 is left on chain today
    const err = await signer.signPayout({ intent: p, approvals: approvals(p) }).catch((e) => e);
    expect(err).toBeInstanceOf(SignerRefusal);
    expect(err.reason).toBe('vault_limit');
  });

  it('caps what a stolen hot key can take, and pays each intent hash once', async () => {
    const attacker = randomAddress();
    // The thief tries to drain the whole vault: reverted by the contract.
    await expect(
      thief().writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'pay', args: [attacker, 19_000n * USDC, `0x${'11'.repeat(32)}`] }),
    ).rejects.toThrow(/OverDailyLimit/);
    // What is left of today's limit is all they can get.
    const left = await read('remaining');
    const h = await thief().writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'pay', args: [attacker, left, `0x${'22'.repeat(32)}`] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    expect(await chain.balanceOf(attacker)).toBe(left);
    expect(await chain.balanceOf(vault)).toBe(20_000n * USDC - 1_000n * USDC - left);
    // Replaying an intent hash is refused on chain too.
    await expect(
      thief().writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'pay', args: [attacker, 1n, `0x${'22'.repeat(32)}`] }),
    ).rejects.toThrow(/AlreadyPaid/);
  });

  it('lets the signer pause, refuses while paused, and only the owner can unpause', async () => {
    const h = await thief().writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'pause' });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    expect(await read('paused')).toBe(true);
    const p = payout(10n * USDC);
    const err = await signer.signPayout({ intent: p, approvals: approvals(p) }).catch((e) => e);
    expect(err.reason).toBe('vault_paused');
    await expect(thief().writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'unpause' })).rejects.toThrow(/NotOwner/);
    const u = await chain.owner.writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'unpause', account: chain.owner.account!, chain: anvil });
    await chain.publicClient.waitForTransactionReceipt({ hash: u });
    expect(await read('paused')).toBe(false);
  });

  it('rejects anyone but the signer', async () => {
    await expect(
      chain.owner.writeContract({ address: vault, abi: payoutVaultAbi, functionName: 'pay', args: [acme, 1n, `0x${'33'.repeat(32)}`], account: chain.owner.account!, chain: anvil }),
    ).rejects.toThrow(/NotSigner/);
  });
});
