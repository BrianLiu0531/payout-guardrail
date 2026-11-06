import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, http, parseEther, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { intentChallenge, mockUsdcAbi, SAMPLE_SANCTIONED_ADDRESS, SoftAuthenticator } from '@guardrail/core';
import { Ledger } from '@guardrail/ledger';
import { Signer, SignerRefusal } from '@guardrail/signer';
import { chain as anvil, freshDb, RPC_URL } from '../../signer/test/helpers.js';
import { buildApp } from '../src/app.js';
import { DemoBots, type AttackResult } from '../src/payouts/demo.js';
import { Reconciler } from '../src/payouts/reconcile.js';
import { Payouts, type IntentRecord } from '../src/payouts/service.js';
import { SignerRefused, type SignerPort } from '../src/payouts/signerPort.js';
import { PayoutWorker } from '../src/payouts/worker.js';
import { applyRoles, asRole } from '../src/roles.js';
import { DEMO_VAULT_DAILY_LIMIT, seedAll } from '../src/setup.js';
import pg from 'pg';

const webauthn = { rpId: 'localhost', rpName: 'Payout Guardrail', origins: ['http://localhost:5173'] };
const ORIGIN = webauthn.origins[0]!;

const ROLE_PASSWORDS = { api: 'guardrail_api_dev', signer: 'guardrail_signer_dev' };
let db: Awaited<ReturnType<typeof freshDb>>;
let apiPool: pg.Pool;
let signerPool: pg.Pool;
let app: FastifyInstance;
let ledger: Ledger;
let worker: PayoutWorker;
let reconciler: Reconciler;
let signer: Signer;
let publicClient: PublicClient;
let token: Hex;
let custody: Hex;
const payees = [
  { id: 'acme-hosting', name: 'Acme Hosting', address: privateKeyToAccount(generatePrivateKey()).address },
  { id: 'northwind-contractors', name: 'Northwind Contractors', address: privateKeyToAccount(generatePrivateKey()).address },
];

/** The signer in-process, with its refusals translated the way the HTTP client translates them. */
function inProcess(s: Signer): SignerPort {
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (err) {
      if (err instanceof SignerRefusal) throw new SignerRefused(err.reason, err.message, err.detail);
      throw err;
    }
  };
  return {
    signPayout: wrap((r) => s.signPayout(r)),
    applyGovernance: wrap((r) => s.applyGovernance(r)),
    tripBreaker: (r) => s.tripBreaker(r),
    status: () => s.status(),
    log: (a) => s.log(a),
    refusals: () => s.refusals(),
    approvers: () => s.approvers(),
    anchor: (q, h) => s.anchor(q, h),
    anchors: () => s.anchors(),
  };
}

beforeAll(async () => {
  db = await freshDb();
  ledger = new Ledger(db.pool);
  publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) }) as PublicClient;
  const hotKey = generatePrivateKey();
  const deployerKey = generatePrivateKey();
  await createTestClient({ chain: anvil, mode: 'anvil', transport: http(RPC_URL) }).setBalance({
    address: privateKeyToAccount(deployerKey).address, value: parseEther('10'),
  });
  const keysFile = join(tmpdir(), `guardrail-keys-${randomBytes(4).toString('hex')}.json`);
  const seeded = await seedAll(db.pool, ledger, { rpcUrl: RPC_URL, chainId: 31337, hotKey, deployerKey, keysFile, webauthn, payees });
  token = seeded.chain.token;
  custody = seeded.chain.custody;

  // From here on everything runs as the least-privilege roles, as in production.
  await applyRoles(db.pool, ROLE_PASSWORDS);
  apiPool = new pg.Pool({ connectionString: asRole(db.url, 'guardrail_api', ROLE_PASSWORDS.api), max: 10 });
  signerPool = new pg.Pool({ connectionString: asRole(db.url, 'guardrail_signer', ROLE_PASSWORDS.signer), max: 5 });
  ledger = new Ledger(apiPool);

  signer = new Signer({ pool: signerPool, account: privateKeyToAccount(hotKey), chain: publicClient, webauthn });
  const port = inProcess(signer);
  const payouts = new Payouts(apiPool, seeded.chain, webauthn);
  const bots = await DemoBots.load(keysFile);
  worker = new PayoutWorker(payouts, ledger, port, publicClient, { confirmations: 1 });
  reconciler = new Reconciler(db.pool, ledger, port, publicClient, seeded.chain);
  app = buildApp({
    ledger,
    verifyCacheMs: 0,
    payouts: {
      payouts, signer: port, reconciler, demoMode: true, bots,
      attackDeps: { payouts, signer: port, bots, chain: publicClient, reconciler, rpcUrl: RPC_URL, leakedKey: hotKey, adminPool: db.pool },
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await apiPool?.end();
  await signerPool?.end();
  await db?.drop();
});

describe('database roles', () => {
  const denied = (p: Promise<unknown>) => expect(p).rejects.toThrow(/permission denied|must be owner/);

  it("keeps the API out of the signer's schema and away from history", async () => {
    await denied(apiPool.query('SELECT * FROM signer.log'));
    await denied(apiPool.query('SELECT * FROM signer.approvers'));
    await denied(apiPool.query("UPDATE ledger.entries SET amount = 1"));
    await denied(apiPool.query('DELETE FROM ledger.transactions'));
    await denied(apiPool.query("UPDATE payouts.audit SET actor = 'x'"));
    await denied(apiPool.query('DELETE FROM payouts.approvals'));
    await denied(apiPool.query('ALTER TABLE payouts.audit DISABLE TRIGGER audit_append_only'));
    await denied(apiPool.query("INSERT INTO payouts.config (key, value) VALUES ('token', '0x0')"));
  });

  it('keeps the signer out of everything but its own schema', async () => {
    await denied(signerPool.query('SELECT * FROM payouts.intents'));
    await denied(signerPool.query('SELECT * FROM ledger.accounts'));
    await denied(signerPool.query('DELETE FROM signer.log'));
    await denied(signerPool.query('ALTER TABLE signer.log DISABLE TRIGGER log_append_only'));
  });
});

const sessions = new Map<string, string>();
async function login(userId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/demo-login', payload: { userId } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'guardrail_session')!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  sessions.set(userId, cookie.value);
  return cookie.value;
}

async function as(userId: string, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const session = sessions.get(userId) ?? (await login(userId));
  return app.inject({ method, url, payload: payload as never, cookies: { guardrail_session: session } });
}

async function settle(id: string, until: string[] = ['settled', 'applied', 'refused', 'failed']): Promise<IntentRecord> {
  for (let i = 0; i < 60; i++) {
    await worker.tick();
    const r = (await as('alice', 'GET', `/v1/intents/${id}`)).json() as IntentRecord;
    if (until.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`intent ${id} did not finish`);
}

const balanceOf = (who: Hex) => publicClient.readContract({ address: token, abi: mockUsdcAbi, functionName: 'balanceOf', args: [who] });

describe('payout lifecycle', () => {
  it('starts reconciled: chain balances equal the ledger', async () => {
    const report = await reconciler.run();
    expect(report.findings).toEqual([]);
    expect(report.summary.usdc).toEqual({ chain: '16750000000', ledger: '16750000000' });
  });

  it('proposes, collects two passkey approvals, signs, broadcasts, settles and posts to the ledger', async () => {
    const created = await as('alice', 'POST', '/v1/intents/payout', {
      payeeId: 'acme-hosting', amount: '2500.50', memo: 'INV-2207', expenseAccount: 'expense:vendor-services',
    });
    expect(created.statusCode).toBe(201);
    const intent = created.json() as IntentRecord;
    expect(intent).toMatchObject({ status: 'pending_approval', requiredApprovals: 2, amount: '2500500000' });

    const one = (await as('bob', 'POST', '/v1/demo/approve', { intentId: intent.id, userId: 'bob' })).json() as IntentRecord;
    expect(one.status).toBe('pending_approval');
    const two = (await as('bob', 'POST', '/v1/demo/approve', { intentId: intent.id, userId: 'carol' })).json() as IntentRecord;
    expect(two.status).toBe('approved');

    const done = await settle(intent.id);
    expect(done.status).toBe('settled');
    expect(done.ledgerTxId).toBeTruthy();
    expect(await balanceOf(payees[0]!.address)).toBe(2_500_500_000n);

    const accounts = (await as('alice', 'GET', '/v1/ledger/accounts')).json().accounts as { code: string; balance: string }[];
    expect(accounts.find((a) => a.code === 'asset:base:hot:usdc')?.balance).toBe((16_750_000_000n - 2_500_500_000n).toString());

    const report = await reconciler.run();
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary.usdc.chain).toBe(report.summary.usdc.ledger);
    expect(report.summary.eth.chain).toBe(report.summary.eth.ledger);
  });

  it('enforces policy and separation of duties at the API', async () => {
    const over = await as('alice', 'POST', '/v1/intents/payout', { payeeId: 'acme-hosting', amount: '50000.01', expenseAccount: 'expense:vendor-services' });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.details.policies).toContain('per-payout-limit');

    const fromApprover = await as('bob', 'POST', '/v1/intents/payout', { payeeId: 'acme-hosting', amount: '5', expenseAccount: 'expense:vendor-services' });
    expect(fromApprover.statusCode).toBe(422);

    const small = (await as('alice', 'POST', '/v1/intents/payout', { payeeId: 'acme-hosting', amount: '5', expenseAccount: 'expense:vendor-services' })).json() as IntentRecord;
    expect(small.requiredApprovals).toBe(1);
    const self = await as('alice', 'POST', '/v1/demo/approve', { intentId: small.id, userId: 'alice' });
    expect(self.statusCode).toBe(403);
    expect((await as('alice', 'POST', `/v1/intents/${small.id}/cancel`)).json().status).toBe('cancelled');

    expect((await app.inject({ method: 'POST', url: '/v1/intents/payout', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/intents/payout', payload: { payeeId: 'acme-hosting', amount: '1', expenseAccount: 'expense:vendor-services' } })).statusCode).toBe(401);
  });

  it('refuses cross-origin writes even with a valid session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/intents/breaker-reset', payload: { reason: 'x' },
      headers: { origin: 'https://evil.example' }, cookies: { guardrail_session: sessions.get('alice')! },
    });
    expect(res.statusCode).toBe(403);
  });

  it('adds a payee only through a two-approver change applied by the signer', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const add = (await as('alice', 'POST', '/v1/payees', { name: 'Globex Design', address })).json() as IntentRecord;
    expect(add.kind).toBe('payee_add');
    await as('bob', 'POST', '/v1/demo/approve', { intentId: add.id, userId: 'bob' });
    await as('bob', 'POST', '/v1/demo/approve', { intentId: add.id, userId: 'carol' });
    expect((await settle(add.id)).status).toBe('applied');
    const list = (await as('alice', 'GET', '/v1/payees')).json().payees as { name: string; status: string }[];
    expect(list.find((p) => p.name === 'Globex Design')?.status).toBe('active');
    // Active, but still cooling off: proposing a payout to it is refused.
    const globex = (await as('alice', 'GET', '/v1/payees')).json().payees.find((p: { name: string }) => p.name === 'Globex Design');
    const early = await as('alice', 'POST', '/v1/intents/payout', { payeeId: globex.id, amount: '10', expenseAccount: 'expense:vendor-services' });
    expect(early.json().error.details.policies).toContain('payee-cooldown');
  });

  it('enrolls a real passkey: registration, two approvals, then it can approve payouts', async () => {
    const dana = SoftAuthenticator.create(); // stands in for a browser authenticator
    const opts = (await app.inject({ method: 'POST', url: '/v1/auth/register/options', payload: { name: 'Dana Lee', userId: 'dana' } })).json();
    const reg = await app.inject({
      method: 'POST', url: '/v1/auth/register/verify',
      payload: { challengeId: opts.challengeId, response: dana.register({ challenge: opts.options.challenge, rpId: 'localhost', origin: ORIGIN }) },
    });
    expect(reg.statusCode).toBe(200);
    sessions.set('dana', reg.cookies.find((c) => c.name === 'guardrail_session')!.value);
    const enrollment = reg.json().enrollmentIntent as string;

    const payout = (await as('alice', 'POST', '/v1/intents/payout', { payeeId: 'northwind-contractors', amount: '300', expenseAccount: 'expense:contractor-payroll' })).json() as IntentRecord;
    const early = await as('dana', 'POST', `/v1/intents/${payout.id}/approval-options`);
    expect(early.statusCode).toBe(403); // not enrolled yet

    await as('bob', 'POST', '/v1/demo/approve', { intentId: enrollment, userId: 'bob' });
    await as('bob', 'POST', '/v1/demo/approve', { intentId: enrollment, userId: 'carol' });
    expect((await settle(enrollment)).status).toBe('applied');

    const options = (await as('dana', 'POST', `/v1/intents/${payout.id}/approval-options`)).json().options;
    expect(options.challenge).toBe(intentChallenge(payout.hash));
    const assertion = dana.assert({ challenge: options.challenge, rpId: 'localhost', origin: ORIGIN });
    const approved = (await as('dana', 'POST', `/v1/intents/${payout.id}/approve`, { response: assertion })).json() as IntentRecord;
    expect(approved.status).toBe('approved');
    expect((await settle(payout.id)).status).toBe('settled');
    expect(await balanceOf(payees[1]!.address)).toBe(300_000_000n);
  });
});

describe('attack lab against the real signer, chain and ledger', () => {
  const run = async (id: string) => (await as('alice', 'POST', `/v1/demo/attacks/${id}/run`)).json() as AttackResult;

  it('refuses to propose a sanctioned payee at the API too', async () => {
    const res = await as('alice', 'POST', '/v1/payees', { name: 'Consulting LLC', address: SAMPLE_SANCTIONED_ADDRESS });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.policies).toEqual(['sanctioned-payee']);
  });

  it.each(['swap-recipient', 'inflate-amount', 'replay-approval', 'forged-approver', 'self-approval', 'unknown-payee', 'sanctioned-payee', 'over-limit', 'double-spend'])(
    '%s is blocked',
    async (id) => {
      const r = await run(id);
      expect(r.verdict, JSON.stringify(r.steps, null, 1)).toBe('blocked');
    },
  );

  it('the double-spent payout still settles exactly once', async () => {
    const intents = (await as('alice', 'GET', '/v1/intents?kind=payout')).json().intents as IntentRecord[];
    const ds = intents.find((i) => (i.payload as { memo: string }).memo === 'Double-spend test')!;
    expect((await settle(ds.id)).status).toBe('settled');
    expect((await reconciler.run()).ok).toBe(true);
  });

  it('a stolen key is detected, the breaker opens, and payouts stop until two approvers reset it', async () => {
    const vaultBefore = await balanceOf(custody);
    const r = await run('leaked-key');
    expect(r.verdict).toBe('detected');
    // The vault refused the full drain; the thief got at most the daily limit.
    expect(r.steps.find((s) => s.label.startsWith('Thief tries to drain'))?.outcome).toBe('blocked');
    expect(vaultBefore - (await balanceOf(custody))).toBeLessThanOrEqual(DEMO_VAULT_DAILY_LIMIT);
    expect(await balanceOf(custody)).toBeGreaterThan(0n);
    expect((await signer.status()).breaker.open).toBe(true);

    const p = (await as('alice', 'POST', '/v1/intents/payout', { payeeId: 'acme-hosting', amount: '20', expenseAccount: 'expense:vendor-services' })).json() as IntentRecord;
    await as('bob', 'POST', '/v1/demo/approve', { intentId: p.id, userId: 'bob' });
    const refused = await settle(p.id);
    expect(refused.status).toBe('refused');
    expect(refused.error?.detail?.policies).toEqual(['circuit-breaker']);

    const reset = (await as('alice', 'POST', '/v1/intents/breaker-reset', { reason: 'Key rotated; loss written off' })).json() as IntentRecord;
    await as('bob', 'POST', '/v1/demo/approve', { intentId: reset.id, userId: 'bob' });
    await as('bob', 'POST', '/v1/demo/approve', { intentId: reset.id, userId: 'carol' });
    expect((await settle(reset.id)).status).toBe('applied');
    expect((await signer.status()).breaker.open).toBe(false);

    // The known discrepancy stays visible but no longer trips the breaker.
    const after = await reconciler.run();
    expect(after.ok).toBe(true);
    expect(after.findings.filter((f) => f.severity === 'critical').every((f) => f.acknowledged)).toBe(true);
    expect((await signer.status()).breaker.open).toBe(false);
  });

  it('a rewritten audit log is detected through the signer-held checkpoints', async () => {
    const r = await run('audit-rewrite');
    expect(r.verdict).toBe('detected');
    expect((await signer.status()).breaker.open).toBe(true);
  });
});
