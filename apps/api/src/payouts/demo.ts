import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWalletClient, http, parseUnits, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  intentChallenge,
  intentHash,
  localChain,
  mockUsdcAbi,
  parseIntent,
  SoftAuthenticator,
  type Approval,
  type Intent,
  type PayoutIntent,
} from '@guardrail/core';
import { audit, entryHash, GENESIS, latestAudit, type AuditEntry } from './audit.js';
import type { Reconciler } from './reconcile.js';
import { PayoutError, type Payouts } from './service.js';
import { SignerRefused, type SignerPort } from './signerPort.js';

/**
 * Demo-only pieces: scripted approvers whose passkeys are software keys held in a local file,
 * and an attack lab that plays a compromised API against the real signer, chain and ledger.
 * Never enabled outside DEMO_MODE.
 */

export class DemoBots {
  constructor(private readonly keys: Map<string, SoftAuthenticator>) {}

  static async load(file: string): Promise<DemoBots> {
    const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, { credentialId: string; privateKeyPkcs8: string }>;
    return new DemoBots(new Map(Object.entries(json).map(([user, k]) => [user, SoftAuthenticator.fromJSON(k)])));
  }

  has(userId: string): boolean {
    return this.keys.has(userId);
  }

  approval(userId: string, intent: Intent | string, rpId: string, origin: string): Approval {
    const key = this.keys.get(userId);
    if (!key) throw new PayoutError('NOT_FOUND', `${userId} has no demo key`);
    const hash = typeof intent === 'string' ? intent : intentHash(intent);
    return { userId, credentialId: key.credentialId, assertion: key.assert({ challenge: intentChallenge(hash), rpId, origin }) };
  }
}

export interface AttackStep {
  label: string;
  outcome: 'attacker' | 'blocked' | 'detected' | 'ok' | 'info';
  detail: string;
}

export interface AttackResult {
  id: string;
  title: string;
  verdict: 'blocked' | 'detected' | 'not_blocked';
  summary: string;
  steps: AttackStep[];
}

export interface AttackDeps {
  payouts: Payouts;
  signer: SignerPort;
  bots: DemoBots;
  chain: PublicClient;
  reconciler: Reconciler;
  rpcUrl: string;
  /** The hot wallet key, used only to play a thief who has stolen it. */
  leakedKey: Hex;
}

export const ATTACKS = [
  { id: 'swap-recipient', title: 'Swap the recipient after approval', blurb: 'A compromised API changes where an approved payout goes.' },
  { id: 'inflate-amount', title: 'Inflate the amount after approval', blurb: 'A compromised API turns an approved 2,500 USDC payout into 25,000.' },
  { id: 'replay-approval', title: 'Replay approvals on a new payout', blurb: 'Signatures collected for one payout are attached to another.' },
  { id: 'forged-approver', title: 'Approve with a planted passkey', blurb: "The attacker adds their own passkey to the API's database and approves." },
  { id: 'self-approval', title: 'Approve your own payout', blurb: 'A requester who is also an approver signs off on their own request.' },
  { id: 'unknown-payee', title: 'Pay an address nobody vetted', blurb: 'Approvers are tricked into approving a payout to a new address.' },
  { id: 'over-limit', title: 'Exceed the per-payout limit', blurb: 'Two approvers sign a 60,000 USDC payout; the limit is 50,000.' },
  { id: 'double-spend', title: 'Execute one payout ten times', blurb: 'The same approved payout is sent to the signer ten times at once.' },
  { id: 'leaked-key', title: 'Steal the hot wallet key', blurb: 'The key leaks and the thief transfers USDC directly, bypassing everything.' },
  { id: 'audit-rewrite', title: 'Rewrite the audit log', blurb: 'A database admin edits history to hide who approved what.' },
] as const;

export type AttackId = (typeof ATTACKS)[number]['id'];

const USDC = (n: string) => parseUnits(n, 6);
const short = (h: string, n = 14) => `${h.slice(0, n)}...`;

export async function runAttack(id: AttackId, deps: AttackDeps): Promise<AttackResult> {
  const meta = ATTACKS.find((a) => a.id === id);
  if (!meta) throw new PayoutError('NOT_FOUND', 'unknown attack');
  const steps: AttackStep[] = [];
  const { payouts, signer, bots } = deps;
  const rp = payouts.webauthn.rpId;
  const origin = payouts.webauthn.origins[0]!;
  const payees = await payouts.listPayees();
  const acme = payees.find((p) => p.id === 'acme-hosting');
  const northwind = payees.find((p) => p.id === 'northwind-contractors');
  if (!acme || !northwind) throw new PayoutError('CONFLICT', 'run the demo seed first (npm run seed)');

  const draft = (overrides: Partial<PayoutIntent> = {}): PayoutIntent =>
    parseIntent({
      kind: 'payout', intentId: randomUUID(), chainId: payouts.chain.chainId, token: payouts.chain.token,
      to: acme.address, amount: USDC('2500').toString(), payeeId: acme.id, memo: 'INV-2207 Acme Hosting',
      expenseAccount: 'expense:vendor-services', createdBy: 'alice', createdAt: new Date().toISOString(), ...overrides,
    }) as PayoutIntent;
  const approvedBy = (intent: Intent | string, ...users: string[]) => users.map((u) => bots.approval(u, intent, rp, origin));

  /** Sends a request to the signer as the attacker would, and records what happened. */
  async function tryToSign(label: string, intent: Intent, approvals: Approval[], claimedHash?: string): Promise<boolean> {
    try {
      const r = await signer.signPayout({ intent, approvals, intentHash: claimedHash });
      steps.push({ label, outcome: 'attacker', detail: `The signer signed transaction ${short(r.txHash)}` });
      return true;
    } catch (err) {
      if (!(err instanceof SignerRefused)) throw err;
      const rejected = (err.detail.rejectedApprovals as { userId: string; reason: string }[] | undefined) ?? [];
      const policies = (err.detail.policies as string[] | undefined) ?? [];
      const why = [
        err.message,
        policies.length ? `policy: ${policies.join(', ')}` : '',
        rejected.length ? `approvals rejected: ${rejected.map((r) => `${r.userId} (${r.reason})`).join(', ')}` : '',
      ].filter(Boolean).join('; ');
      steps.push({ label, outcome: 'blocked', detail: `Refused (${err.reason}): ${why}` });
      return false;
    }
  }

  const done = (verdict: AttackResult['verdict'], summary: string): AttackResult => ({ id, title: meta.title, verdict, summary, steps });
  const attacker = privateKeyToAccount(generatePrivateKey()).address;

  switch (id) {
    case 'swap-recipient': {
      const approved = draft();
      const approvals = approvedBy(approved, 'bob', 'carol');
      steps.push({ label: 'Bob and Carol approve 2,500 USDC to Acme Hosting', outcome: 'ok', detail: `Each signs intent hash ${short(intentHash(approved), 16)} with a passkey.` });
      const a = await tryToSign('Attacker swaps the recipient to their own address', { ...approved, to: attacker }, approvals);
      const b = await tryToSign('Attacker swaps it to another approved payee (Northwind)', { ...approved, to: northwind.address as Hex, payeeId: northwind.id }, approvals);
      const c = await tryToSign('Attacker keeps the old hash and hopes the signer trusts it', { ...approved, to: northwind.address as Hex, payeeId: northwind.id }, approvals, intentHash(approved));
      return a || b || c
        ? done('not_blocked', 'The signer accepted a changed recipient.')
        : done('blocked', 'Approvals are signatures over the intent hash. Change any field and they no longer verify, and the signer recomputes the hash itself.');
    }
    case 'inflate-amount': {
      const approved = draft();
      const approvals = approvedBy(approved, 'bob', 'carol');
      steps.push({ label: 'Bob and Carol approve 2,500 USDC', outcome: 'ok', detail: 'Two passkey signatures over the intent hash.' });
      const ok = await tryToSign('Attacker raises the amount to 25,000 USDC', { ...approved, amount: USDC('25000').toString() }, approvals);
      return ok ? done('not_blocked', 'The signer signed an inflated amount.') : done('blocked', 'The amount is part of what was signed.');
    }
    case 'replay-approval': {
      const first = draft();
      const approvals = approvedBy(first, 'bob', 'carol');
      steps.push({ label: 'Bob and Carol approve payout A', outcome: 'ok', detail: `Intent ${short(first.intentId, 8)}` });
      const second = draft({ memo: 'INV-2208 (fake)' });
      const ok = await tryToSign('Attacker attaches the same approvals to a new payout B', second, approvals);
      return ok ? done('not_blocked', 'Approvals were reusable.') : done('blocked', 'Each approval is bound to one intent id and its contents.');
    }
    case 'forged-approver': {
      const mallory = SoftAuthenticator.create();
      steps.push({ label: "Attacker inserts their own passkey into the API's credentials table", outcome: 'attacker', detail: 'The API database now lists "mallory" as an enrolled approver.' });
      const intent = draft();
      const forged: Approval[] = ['mallory', 'mallory2'].map((u) => ({
        userId: u, credentialId: mallory.credentialId,
        assertion: mallory.assert({ challenge: intentChallenge(intentHash(intent)), rpId: rp, origin }),
      }));
      const ok = await tryToSign('Attacker approves twice with the planted passkey', intent, forged);
      return ok ? done('not_blocked', 'A planted passkey counted.') : done('blocked', "The signer only accepts passkeys in its own approver list, which changes only with two existing approvers' consent.");
    }
    case 'self-approval': {
      const intent = draft({ createdBy: 'bob' });
      steps.push({ label: 'Bob requests 2,500 USDC', outcome: 'info', detail: 'Payouts above 1,000 USDC need two approvers other than the requester.' });
      const ok = await tryToSign('Bob approves his own request, Carol approves too', intent, approvedBy(intent, 'bob', 'carol'));
      return ok ? done('not_blocked', 'The requester counted as an approver.') : done('blocked', 'The requester never counts, so one more independent approver is still needed.');
    }
    case 'unknown-payee': {
      const intent = draft({ to: attacker, payeeId: 'new-vendor' });
      steps.push({ label: 'Bob and Carol are tricked into approving 2,500 USDC to a new address', outcome: 'attacker', detail: `Recipient ${attacker}` });
      const ok = await tryToSign('The payout reaches the signer with two valid approvals', intent, approvedBy(intent, 'bob', 'carol'));
      steps.push({ label: 'Adding the address as a payee', outcome: 'info', detail: 'Needs its own two-approver change, and then a cooling-off period before any payout to it is signed.' });
      return ok ? done('not_blocked', 'An unvetted address was paid.') : done('blocked', "Only addresses on the signer's own payee list can be paid, however many people approve.");
    }
    case 'over-limit': {
      const intent = draft({ amount: USDC('60000').toString() });
      const ok = await tryToSign('Bob and Carol approve 60,000 USDC', intent, approvedBy(intent, 'bob', 'carol'));
      return ok ? done('not_blocked', 'The limit did not apply.') : done('blocked', 'Limits are policy the signer evaluates; approvals cannot override a forbid.');
    }
    case 'double-spend': {
      const alice = (await payouts.getUser('alice'))!;
      const intent = await payouts.proposePayout(alice, { payeeId: acme.id, amount: '10', memo: 'Double-spend test', expenseAccount: 'expense:vendor-services' });
      const bob = (await payouts.getUser('bob'))!;
      const ap = bots.approval('bob', intent.hash, rp, origin);
      await payouts.approve(bob, intent.id, ap.credentialId, ap.assertion);
      steps.push({ label: 'Alice requests 10 USDC; Bob approves', outcome: 'ok', detail: `Intent ${short(intent.id, 8)} is approved and real.` });
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => signer.signPayout({ intent: intent.payload, intentHash: intent.hash, approvals: [ap] })),
      );
      const hashes = new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.txHash] : [])));
      const fresh = results.filter((r) => r.status === 'fulfilled' && !r.value.replayed).length;
      steps.push({
        label: 'Ten simultaneous signing requests',
        outcome: hashes.size === 1 ? 'blocked' : 'attacker',
        detail: `${hashes.size} distinct transaction(s); ${fresh} newly signed, ${10 - fresh} returned the existing one. One nonce, one transfer.`,
      });
      return hashes.size === 1
        ? done('blocked', 'Signing is idempotent per intent: retries and duplicates get the same transaction.')
        : done('not_blocked', 'More than one transaction was signed.');
    }
    case 'leaked-key': {
      const thief = privateKeyToAccount(deps.leakedKey);
      const wallet = createWalletClient({ account: thief, chain: localChain(deps.rpcUrl, payouts.chain.chainId), transport: http(deps.rpcUrl) });
      const hash = await wallet.writeContract({ address: payouts.chain.token, abi: mockUsdcAbi, functionName: 'transfer', args: [attacker, USDC('500')] });
      await deps.chain.waitForTransactionReceipt({ hash });
      steps.push({
        label: 'Thief transfers 500 USDC with the stolen key',
        outcome: 'attacker',
        detail: `Transaction ${short(hash)} succeeded: a stolen key spends without asking anyone. Preventing that takes an HSM/KMS or a smart-account allowance; what this system guarantees is detection and containment.`,
      });
      const report = await deps.reconciler.run();
      const found = report.findings.filter((f) => f.severity === 'critical' && !f.acknowledged);
      steps.push({ label: 'Reconciliation runs', outcome: found.length ? 'detected' : 'attacker', detail: found.map((f) => f.message).join(' ') || 'Nothing found.' });
      const status = await signer.status();
      steps.push({ label: 'Circuit breaker', outcome: status.breaker.open ? 'detected' : 'attacker', detail: status.breaker.open ? `Open: ${status.breaker.reason}` : 'Still closed.' });
      const probe = draft({ amount: USDC('100').toString() });
      await tryToSign('A normal, approved payout is attempted', probe, approvedBy(probe, 'bob'));
      return status.breaker.open
        ? done('detected', 'The theft is detected on the next reconciliation and the signer stops all payouts until two approvers reset the breaker. The 500 USDC is gone; the rest of the balance is protected.')
        : done('not_blocked', 'The theft went unnoticed.');
    }
    case 'audit-rewrite': {
      // Make sure the signer holds a checkpoint of the current head.
      await deps.reconciler.run();
      const head = await latestAudit(payouts.pool);
      if (!head || head.seq < 3) throw new PayoutError('CONFLICT', 'not enough audit history yet; approve a payout first');
      const { rows } = await payouts.pool.query("SELECT * FROM payouts.audit WHERE action = 'approval.recorded' ORDER BY seq DESC LIMIT 1");
      const target = rows[0] ?? (await payouts.pool.query('SELECT * FROM payouts.audit WHERE seq = $1', [head.seq - 1])).rows[0];
      const c = await payouts.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('ALTER TABLE payouts.audit DISABLE TRIGGER audit_append_only');
        await c.query("UPDATE payouts.audit SET actor = 'mallory' WHERE seq = $1", [target.seq]);
        steps.push({ label: `DB admin disables the append-only trigger and edits entry ${target.seq}`, outcome: 'attacker', detail: `"${target.action}" by ${target.actor} now says mallory.` });
        // A careful attacker then recomputes every later hash so the chain verifies on its own.
        const { rows: later } = await c.query('SELECT * FROM payouts.audit WHERE seq >= $1 ORDER BY seq', [target.seq]);
        const { rows: before } = await c.query('SELECT hash FROM payouts.audit WHERE seq = $1', [Number(target.seq) - 1]);
        let prev: string = before[0]?.hash ?? GENESIS;
        for (const r of later) {
          const e: Omit<AuditEntry, 'hash'> = {
            seq: Number(r.seq), at: r.at.toISOString(), actor: r.actor, action: r.action, subject: r.subject, data: r.data, prevHash: prev,
          };
          const h = entryHash(e);
          await c.query('UPDATE payouts.audit SET prev_hash = $2, hash = $3 WHERE seq = $1', [e.seq, prev, h]);
          prev = h;
        }
        await c.query('ALTER TABLE payouts.audit ENABLE TRIGGER audit_append_only');
        await c.query('COMMIT');
        steps.push({ label: 'Attacker recomputes every later hash', outcome: 'attacker', detail: `${later.length} entries rewritten; the chain is self-consistent again.` });
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
      const report = await deps.reconciler.run();
      const found = report.findings.filter((f) => f.kind === 'audit_tampered' || f.kind === 'anchor_rejected');
      steps.push({
        label: "Reconciliation compares the log with the signer's checkpoints",
        outcome: found.length ? 'detected' : 'attacker',
        detail: found.length ? `${found.length} checkpoint(s) no longer match. ${found[0]!.message}` : 'Not detected.',
      });
      await audit(payouts.pool, 'attack-lab', 'demo.audit_rewritten', null, { seq: Number(target.seq) });
      return found.length
        ? done('detected', 'The rewritten chain is self-consistent but disagrees with checkpoints held by the signer, a separate system the database admin cannot edit.')
        : done('not_blocked', 'The rewrite went unnoticed.');
    }
  }
}
