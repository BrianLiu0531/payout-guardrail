import { describe, expect, it } from 'vitest';
import {
  canApplyGovernance,
  canPropose,
  canSign,
  countApprovals,
  intentChallenge,
  intentHash,
  listScreen,
  parseIntent,
  SAMPLE_SANCTIONED_ADDRESS,
  requiredApprovals,
  SoftAuthenticator,
  verifyApproval,
  type Approval,
  type KnownCredential,
  type PayoutIntent,
} from '../src/index.js';

const USDC = 1_000_000n;
const settings = { rpId: 'localhost', origins: ['http://localhost:5173'] };

const payout: PayoutIntent = {
  kind: 'payout',
  intentId: '7b0c6c1e-3c55-4d2c-9a5f-1f3f1d7f8a10',
  chainId: 31337,
  token: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  amount: (2_500n * USDC).toString(),
  payeeId: 'acme',
  memo: 'INV-1050',
  expenseAccount: 'expense:vendor-services',
  createdBy: 'alice',
  createdAt: '2026-11-05T10:00:00.000Z',
};

describe('intent hash', () => {
  it('does not depend on key order', () => {
    const shuffled = Object.fromEntries(Object.entries(payout).reverse()) as PayoutIntent;
    expect(intentHash(shuffled)).toBe(intentHash(payout));
  });

  it('changes when any field changes', () => {
    const base = intentHash(payout);
    for (const [k, v] of Object.entries({ to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', amount: '2500000001', chainId: 1, memo: 'x' })) {
      expect(intentHash({ ...payout, [k]: v } as PayoutIntent)).not.toBe(base);
    }
  });

  it('parses and normalises addresses; rejects unknown fields and bad amounts', () => {
    const lower = parseIntent({ ...payout, to: payout.to.toLowerCase() });
    expect(lower).toEqual(payout);
    expect(() => parseIntent({ ...payout, extra: 1 })).toThrow(/unexpected field/);
    for (const amount of ['0', '-1', '1.5', '01', '9223372036854775808', 100]) {
      expect(() => parseIntent({ ...payout, amount })).toThrow();
    }
  });
});

describe('policy (Cedar)', () => {
  const facts = { intentId: payout.intentId, amount: 2_500n * USDC, payeeActive: true, payeeAgeSeconds: 3600, recipientSanctioned: false };
  const quiet = { spentToday: 0n, breakerOpen: false };

  it('lets requesters propose and refuses approvers', () => {
    expect(canPropose({ id: 'alice', role: 'requester' }, facts, quiet).allowed).toBe(true);
    expect(canPropose({ id: 'bob', role: 'approver' }, facts, quiet).allowed).toBe(false);
  });

  it('names the policy that forbids', () => {
    const cases: [Partial<typeof facts>, Partial<typeof quiet>, string][] = [
      [{ amount: 50_001n * USDC }, {}, 'per-payout-limit'],
      [{}, { spentToday: 98_000n * USDC }, 'rolling-24h-limit'],
      [{ payeeActive: false, payeeAgeSeconds: 0 }, {}, 'payee-must-be-active'],
      [{ payeeAgeSeconds: 30 }, {}, 'payee-cooldown'],
      [{ recipientSanctioned: true }, {}, 'sanctioned-recipient'],
    ];
    for (const [f, c, id] of cases) {
      const d = canPropose({ id: 'alice', role: 'requester' }, { ...facts, ...f }, { ...quiet, ...c });
      expect(d.allowed, id).toBe(false);
      expect(d.reasons).toContain(id);
    }
  });

  it('requires one approver up to 1,000 USDC and two above', () => {
    expect(requiredApprovals({ ...facts, amount: 1_000n * USDC })).toBe(1);
    expect(requiredApprovals({ ...facts, amount: 1_000n * USDC + 1n })).toBe(2);
    expect(requiredApprovals({ ...facts, amount: 60_000n * USDC })).toBeNull();
    expect(canSign(facts, { ...quiet, approvals: 1 }).allowed).toBe(false);
    expect(canSign(facts, { ...quiet, approvals: 2 }).allowed).toBe(true);
  });

  it('signs nothing while the breaker is open', () => {
    const d = canSign(facts, { spentToday: 0n, approvals: 3, breakerOpen: true });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain('circuit-breaker');
  });

  it('needs two approvers for governance changes', () => {
    expect(canApplyGovernance('g1', 1).allowed).toBe(false);
    expect(canApplyGovernance('g1', 2).allowed).toBe(true);
    expect(canApplyGovernance('g1', 3, true).reasons).toEqual(['sanctioned-payee']);
  });

  it('screens addresses against the OFAC snapshot, case-insensitively', async () => {
    const screen = listScreen();
    expect((await screen.check(SAMPLE_SANCTIONED_ADDRESS.toUpperCase().replace('0X', '0x'))).listed).toBe(true);
    expect((await screen.check(payout.to)).listed).toBe(false);
    expect((await listScreen([payout.to]).check(payout.to)).listed).toBe(true);
  });
});

describe('passkey approvals', () => {
  const bob = SoftAuthenticator.create();
  const carol = SoftAuthenticator.create();
  const creds = new Map<string, KnownCredential>([
    [bob.credentialId, { credentialId: bob.credentialId, userId: 'bob', publicKey: bob.publicKeyCose() }],
    [carol.credentialId, { credentialId: carol.credentialId, userId: 'carol', publicKey: carol.publicKeyCose() }],
  ]);
  const lookup = (id: string) => creds.get(id);
  const hash = intentHash(payout);
  const approve = (a: SoftAuthenticator, userId: string, h = hash, origin = settings.origins[0]!): Approval => ({
    userId,
    credentialId: a.credentialId,
    assertion: a.assert({ challenge: intentChallenge(h), rpId: settings.rpId, origin }),
  });

  it('accepts a signature over this intent', async () => {
    expect(await verifyApproval(approve(bob, 'bob'), hash, lookup, settings)).toEqual({ ok: true, userId: 'bob' });
  });

  it('rejects a signature over a different intent (changed recipient)', async () => {
    const other = intentHash({ ...payout, to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' });
    expect(await verifyApproval(approve(bob, 'bob', other), hash, lookup, settings)).toEqual({ ok: false, reason: 'wrong_intent' });
  });

  it('rejects unknown credentials, borrowed identities, phishing origins and missing user verification', async () => {
    const mallory = SoftAuthenticator.create();
    expect((await verifyApproval(approve(mallory, 'bob'), hash, lookup, settings)).ok).toBe(false);
    expect(await verifyApproval(approve(bob, 'carol'), hash, lookup, settings)).toEqual({ ok: false, reason: 'user_mismatch' });
    expect((await verifyApproval(approve(bob, 'bob', hash, 'https://evil.example'), hash, lookup, settings)).ok).toBe(false);
    const noUv: Approval = {
      userId: 'bob',
      credentialId: bob.credentialId,
      assertion: bob.assert({ challenge: intentChallenge(hash), rpId: settings.rpId, origin: settings.origins[0]!, userVerified: false }),
    };
    expect((await verifyApproval(noUv, hash, lookup, settings)).ok).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const a = approve(bob, 'bob');
    const sig = Buffer.from(a.assertion.response.signature, 'base64url');
    sig[sig.length - 1] = sig[sig.length - 1]! ^ 1;
    a.assertion.response.signature = sig.toString('base64url');
    expect(await verifyApproval(a, hash, lookup, settings)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('counts distinct approvers and never the requester', async () => {
    const r = await countApprovals([approve(bob, 'bob'), approve(bob, 'bob'), approve(carol, 'carol')], hash, 'carol', lookup, settings);
    expect(r.count).toBe(1);
    expect(r.users).toEqual(['bob']);
    expect(r.rejected).toEqual([{ userId: 'carol', reason: 'requester_cannot_approve' }]);
  });

  it('round-trips a soft authenticator through JSON', async () => {
    const copy = SoftAuthenticator.fromJSON(bob.toJSON());
    expect(await verifyApproval(approve(copy, 'bob'), hash, lookup, settings)).toEqual({ ok: true, userId: 'bob' });
  });
});
