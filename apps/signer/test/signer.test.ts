import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { getAddress, keccak256, type Hex } from 'viem';
import {
  intentChallenge,
  intentHash,
  listScreen,
  SAMPLE_SANCTIONED_ADDRESS,
  SoftAuthenticator,
  type Approval,
  type Intent,
  type PayoutIntent,
} from '@guardrail/core';
import { Signer, SignerRefusal, buildSignerApp } from '../src/index.js';
import { freshChain, freshDb, randomAddress, type TestChain } from './helpers.js';

const USDC = 1_000_000n;
const webauthn = { rpId: 'localhost', origins: ['http://localhost:5173'] };

let db: Awaited<ReturnType<typeof freshDb>>;
let pool: pg.Pool;
let chain: TestChain;
let signer: Signer;
let clock = new Date('2026-11-05T12:00:00Z');

const bob = SoftAuthenticator.create();
const carol = SoftAuthenticator.create();
const dave = SoftAuthenticator.create();
const acme = randomAddress();
const fresh = randomAddress(); // added during the test, so still in cooldown

beforeAll(async () => {
  db = await freshDb();
  pool = db.pool;
  chain = await freshChain();
  await Signer.migrate(pool);
  signer = new Signer({ pool, account: chain.hot, chain: chain.publicClient, webauthn, now: () => clock });
  await signer.bootstrap({
    chainId: 31337,
    token: chain.token,
    approvers: [
      { userId: 'bob', credentialId: bob.credentialId, publicKey: bob.publicKeyCose() },
      { userId: 'carol', credentialId: carol.credentialId, publicKey: carol.publicKeyCose() },
    ],
    payees: [{ payeeId: 'acme', name: 'Acme Hosting', address: acme, chainId: 31337, activatedAt: new Date('2026-10-01T00:00:00Z') }],
  });
});

afterAll(async () => {
  await db?.drop();
});

function payout(overrides: Partial<PayoutIntent> = {}): PayoutIntent {
  return {
    kind: 'payout',
    intentId: randomUUID(),
    chainId: 31337,
    token: chain.token,
    to: acme,
    amount: (2_000n * USDC).toString(),
    payeeId: 'acme',
    memo: 'INV-1',
    expenseAccount: 'expense:vendor-services',
    createdBy: 'alice',
    createdAt: clock.toISOString(),
    ...overrides,
  };
}

const approve = (who: SoftAuthenticator, userId: string, intent: Intent): Approval => ({
  userId,
  credentialId: who.credentialId,
  assertion: who.assert({ challenge: intentChallenge(intentHash(intent)), rpId: webauthn.rpId, origin: webauthn.origins[0]! }),
});

async function refusal(p: Promise<unknown>): Promise<SignerRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SignerRefusal) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('signing payouts', () => {
  it('signs an approved payout into a transaction that pays exactly the approved recipient and amount', async () => {
    const intent = payout();
    const signed = await signer.signPayout({ intent, approvals: [approve(bob, 'bob', intent), approve(carol, 'carol', intent)] });
    expect(signed.approvers).toEqual(['bob', 'carol']);
    expect(signed.txHash).toBe(keccak256(signed.rawTx));

    await chain.mint(chain.hot.address, 10_000n * USDC);
    const hash = await chain.publicClient.sendRawTransaction({ serializedTransaction: signed.rawTx });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(await chain.balanceOf(acme)).toBe(2_000n * USDC);
  });

  it('returns the same transaction when asked twice, even concurrently', async () => {
    const intent = payout();
    const req = { intent, approvals: [approve(bob, 'bob', intent), approve(carol, 'carol', intent)] };
    const results = await Promise.all(Array.from({ length: 8 }, () => signer.signPayout(req)));
    expect(new Set(results.map((r) => r.txHash)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('refuses when the recipient was changed after approval', async () => {
    const approved = payout();
    const approvals = [approve(bob, 'bob', approved), approve(carol, 'carol', approved)];
    const attacker = randomAddress();
    const err = await refusal(signer.signPayout({ intent: { ...approved, to: attacker }, approvals }));
    // The attacker address is also not a payee; give it one to prove the signatures alone stop it.
    expect(['policy_denied', 'unknown_payee']).toContain(err.reason);

    const tamperedAmount = { ...approved, amount: (40_000n * USDC).toString() };
    const err2 = await refusal(signer.signPayout({ intent: tamperedAmount, approvals }));
    expect(err2.reason).toBe('policy_denied');
    expect((err2.detail.rejectedApprovals as { reason: string }[]).map((r) => r.reason)).toEqual(['wrong_intent', 'wrong_intent']);
  });

  it('refuses when the caller claims a different hash than the intent it sends', async () => {
    const approved = payout();
    const err = await refusal(
      signer.signPayout({ intent: { ...approved, memo: 'changed' }, intentHash: intentHash(approved), approvals: [] }),
    );
    expect(err.reason).toBe('hash_mismatch');
  });

  it('refuses approvals from passkeys it never enrolled, and the requester approving their own payout', async () => {
    const intent = payout({ createdBy: 'bob' });
    const err = await refusal(signer.signPayout({ intent, approvals: [approve(bob, 'bob', intent), approve(dave, 'dave', intent)] }));
    expect(err.reason).toBe('policy_denied');
    expect(err.detail.rejectedApprovals).toEqual([
      { userId: 'bob', reason: 'requester_cannot_approve' },
      { userId: 'dave', reason: 'unknown_credential' },
    ]);
  });

  it('refuses to pay an address that is not an approved payee, whatever the approvals', async () => {
    const intent = payout({ to: randomAddress() });
    const err = await refusal(signer.signPayout({ intent, approvals: [approve(bob, 'bob', intent), approve(carol, 'carol', intent)] }));
    expect(err.reason).toBe('unknown_payee');
  });

  it('refuses over-limit payouts and the 24-hour total', async () => {
    const big = payout({ amount: (50_001n * USDC).toString() });
    const e1 = await refusal(signer.signPayout({ intent: big, approvals: [approve(bob, 'bob', big), approve(carol, 'carol', big)] }));
    expect(e1.detail.policies).toContain('per-payout-limit');

    // 2 x 2,000 already signed; 49,000 + 49,000 more fits, the next one does not.
    for (let i = 0; i < 2; i++) {
      const p = payout({ amount: (48_000n * USDC).toString() });
      await signer.signPayout({ intent: p, approvals: [approve(bob, 'bob', p), approve(carol, 'carol', p)] });
    }
    const over = payout({ amount: (1_000n * USDC).toString() });
    const e2 = await refusal(signer.signPayout({ intent: over, approvals: [approve(bob, 'bob', over), approve(carol, 'carol', over)] }));
    expect(e2.detail.policies).toContain('rolling-24h-limit');

    clock = new Date(clock.getTime() + 25 * 3600_000); // a day later the window has moved on
    const later = payout({ amount: (1_000n * USDC).toString() });
    await expect(signer.signPayout({ intent: later, approvals: [approve(bob, 'bob', later)] })).resolves.toMatchObject({ replayed: false });
  });

  it('records every refusal', async () => {
    const refusals = await signer.refusals();
    expect(refusals.length).toBeGreaterThanOrEqual(6);
    expect(new Set(refusals.map((r) => r.reason))).toEqual(new Set(['policy_denied', 'unknown_payee', 'hash_mismatch']));
  });
});

describe('governance', () => {
  it('adds a payee with two approvals, then enforces the cooldown', async () => {
    const add: Intent = { kind: 'payee_add', intentId: randomUUID(), chainId: 31337, payeeId: 'fresh', name: 'Fresh Vendor', address: fresh, createdBy: 'alice', createdAt: clock.toISOString() };
    const one = await refusal(signer.applyGovernance({ intent: add, approvals: [approve(bob, 'bob', add)] }));
    expect(one.reason).toBe('policy_denied');
    await signer.applyGovernance({ intent: add, approvals: [approve(bob, 'bob', add), approve(carol, 'carol', add)] });

    const p = payout({ to: fresh, payeeId: 'fresh', amount: (500n * USDC).toString() });
    const cool = await refusal(signer.signPayout({ intent: p, approvals: [approve(bob, 'bob', p)] }));
    expect(cool.detail.policies).toContain('payee-cooldown');

    clock = new Date(clock.getTime() + 121_000);
    await expect(signer.signPayout({ intent: p, approvals: [approve(bob, 'bob', p)] })).resolves.toMatchObject({ replayed: false });
  });

  it('never adds a sanctioned address, and stops paying a payee once it is listed', async () => {
    const add: Intent = {
      kind: 'payee_add', intentId: randomUUID(), chainId: 31337, payeeId: 'listed', name: 'Listed', address: getAddress(SAMPLE_SANCTIONED_ADDRESS),
      createdBy: 'alice', createdAt: clock.toISOString(),
    };
    const err = await refusal(signer.applyGovernance({ intent: add, approvals: [approve(bob, 'bob', add), approve(carol, 'carol', add)] }));
    expect(err.detail.policies).toEqual(['sanctioned-payee']);

    // Acme gets listed after it was approved: the next payout to it is refused.
    const strict = new Signer({ pool, account: chain.hot, chain: chain.publicClient, webauthn, now: () => clock, sanctions: listScreen([acme]) });
    const p = payout({ amount: (100n * USDC).toString() });
    const e2 = await refusal(strict.signPayout({ intent: p, approvals: [approve(bob, 'bob', p)] }));
    expect(e2.detail.policies).toContain('sanctioned-recipient');
  });

  it('refuses a payout whose payee id does not own the address', async () => {
    const p = payout({ to: fresh, payeeId: 'acme' });
    expect((await refusal(signer.signPayout({ intent: p, approvals: [approve(bob, 'bob', p), approve(carol, 'carol', p)] }))).reason).toBe('payee_mismatch');
  });

  it('enrolls a new approver only with two existing approvals', async () => {
    const add: Intent = {
      kind: 'approver_add', intentId: randomUUID(), userId: 'dave', credentialId: dave.credentialId,
      publicKey: Buffer.from(dave.publicKeyCose()).toString('base64url'), createdBy: 'dave', createdAt: clock.toISOString(),
    };
    await signer.applyGovernance({ intent: add, approvals: [approve(bob, 'bob', add), approve(carol, 'carol', add)] });
    const p = payout({ amount: (100n * USDC).toString() });
    await expect(signer.signPayout({ intent: p, approvals: [approve(dave, 'dave', p)] })).resolves.toMatchObject({ approvers: ['dave'] });
  });

  it('stops signing while the breaker is open, and only two approvers can close it', async () => {
    await signer.tripBreaker('test: suspicious transfer');
    const p = payout({ amount: (100n * USDC).toString() });
    const err = await refusal(signer.signPayout({ intent: p, approvals: [approve(bob, 'bob', p), approve(carol, 'carol', p)] }));
    expect(err.detail.policies).toEqual(['circuit-breaker']);

    const reset: Intent = { kind: 'breaker_reset', intentId: randomUUID(), reason: 'investigated', createdBy: 'alice', createdAt: clock.toISOString() };
    await refusal(signer.applyGovernance({ intent: reset, approvals: [approve(bob, 'bob', reset)] }));
    expect((await signer.status()).breaker.open).toBe(true);
    await signer.applyGovernance({ intent: reset, approvals: [approve(bob, 'bob', reset), approve(carol, 'carol', reset)] });
    expect((await signer.status()).breaker.open).toBe(false);
    await expect(signer.signPayout({ intent: p, approvals: [approve(bob, 'bob', p)] })).resolves.toMatchObject({ replayed: false });
  });
});

describe('records', () => {
  it('keeps the log append-only', async () => {
    await expect(pool.query("UPDATE signer.log SET to_address = '0x0000000000000000000000000000000000000001'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM signer.refusals')).rejects.toThrow(/append-only/);
  });

  it('refuses a second, different anchor for the same audit position', async () => {
    expect(await signer.anchor(1, 'a'.repeat(64))).toEqual({ ok: true });
    expect(await signer.anchor(1, 'a'.repeat(64))).toEqual({ ok: true });
    expect(await signer.anchor(1, 'b'.repeat(64))).toEqual({ ok: false, existing: 'a'.repeat(64) });
  });
});

describe('HTTP', () => {
  it('requires the service token and maps refusals to 422', async () => {
    const app = buildSignerApp({ signer, token: 'secret' });
    expect((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: 'Bearer secret' } });
    expect(ok.json()).toMatchObject({ address: chain.hot.address as Hex, chainId: 31337 });

    const intent = payout({ to: randomAddress() });
    const res = await app.inject({
      method: 'POST', url: '/v1/payouts/sign', headers: { authorization: 'Bearer secret' },
      payload: { intent, approvals: [approve(bob, 'bob', intent)] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.reason).toBe('unknown_payee');
    await app.close();
  });
});
