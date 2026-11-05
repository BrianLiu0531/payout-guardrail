import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { keccak256, type Hex, type LocalAccount, type PublicClient } from 'viem';
import {
  canApplyGovernance,
  canSign,
  countApprovals,
  encodeTransfer,
  intentHash,
  IntentError,
  parseIntent,
  TRANSFER_GAS,
  type Approval,
  type GovernanceIntent,
  type KnownCredential,
  type PayoutIntent,
  type WebAuthnSettings,
} from '@guardrail/core';
import { migrate } from '@guardrail/ledger';

export const SIGNER_MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * The only component that holds the hot wallet key. It trusts nothing the API says about an
 * intent: it recomputes the hash from the fields it will act on, verifies every passkey
 * signature against its own list of approvers, checks the recipient against its own payee
 * list and the 24-hour total against its own log, evaluates the policy, and builds the
 * transaction itself. The API can ask; it cannot tell.
 */

export type RefusalReason =
  | 'invalid_intent'
  | 'hash_mismatch'
  | 'wrong_chain'
  | 'wrong_token'
  | 'unknown_payee'
  | 'payee_mismatch'
  | 'policy_denied'
  | 'intent_id_reused'
  | 'already_applied'
  | 'not_bootstrapped';

export class SignerRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SignerRefusal';
  }
}

export interface SignRequest {
  intent: unknown;
  /** What the caller believes the hash is. Optional; a mismatch is refused and recorded. */
  intentHash?: string;
  approvals: Approval[];
}

export interface SignedPayout {
  intentId: string;
  intentHash: string;
  txHash: Hex;
  rawTx: Hex;
  nonce: number;
  approvers: string[];
  replayed: boolean;
}

export interface SignerStatus {
  address: string;
  chainId: number;
  token: string;
  nextNonce: number;
  breaker: { open: boolean; reason: string | null; at: string | null };
  approvers: number;
  payees: number;
  signed: number;
  refused: number;
}

export interface LogEntry {
  seq: number;
  intentId: string;
  intentHash: string;
  kind: string;
  approvers: string[];
  to: string | null;
  amount: string | null;
  nonce: number | null;
  txHash: string | null;
  createdAt: string;
}

export interface Refusal {
  seq: number;
  intentId: string | null;
  intentHash: string | null;
  reason: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface SignerOptions {
  pool: pg.Pool;
  account: LocalAccount;
  chain: PublicClient;
  webauthn: WebAuthnSettings;
  /** Overridable clock for tests. */
  now?: () => Date;
}

export interface BootstrapInput {
  chainId: number;
  token: Hex;
  approvers: { userId: string; credentialId: string; publicKey: Uint8Array }[];
  payees: { payeeId: string; name: string; address: Hex; chainId: number; activatedAt: Date }[];
}

export class Signer {
  private readonly pool: pg.Pool;
  private readonly account: LocalAccount;
  private readonly chain: PublicClient;
  private readonly webauthn: WebAuthnSettings;
  private readonly now: () => Date;

  constructor(opts: SignerOptions) {
    this.pool = opts.pool;
    this.account = opts.account;
    this.chain = opts.chain;
    this.webauthn = opts.webauthn;
    this.now = opts.now ?? (() => new Date());
  }

  get address(): Hex {
    return this.account.address;
  }

  static migrate(pool: pg.Pool): Promise<string[]> {
    return migrate(pool, SIGNER_MIGRATIONS);
  }

  /**
   * Install-time setup on the signer host: initial approvers and payees. Idempotent. After
   * this, approvers and payees change only through approved governance intents.
   */
  async bootstrap(input: BootstrapInput): Promise<void> {
    const nonce = await this.chain.getTransactionCount({ address: this.address, blockTag: 'pending' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO signer.state (address, chain_id, token, next_nonce) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [this.address, input.chainId, input.token, nonce],
      );
      for (const a of input.approvers) {
        await client.query(
          `INSERT INTO signer.approvers (credential_id, user_id, public_key, enrolled_by) VALUES ($1, $2, $3, 'bootstrap')
           ON CONFLICT DO NOTHING`,
          [a.credentialId, a.userId, Buffer.from(a.publicKey)],
        );
      }
      for (const p of input.payees) {
        await client.query(
          `INSERT INTO signer.payees (address, chain_id, payee_id, name, activated_at, added_by) VALUES ($1, $2, $3, $4, $5, 'bootstrap')
           ON CONFLICT DO NOTHING`,
          [p.address, p.chainId, p.payeeId, p.name, p.activatedAt],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private lookup = async (credentialId: string): Promise<KnownCredential | undefined> => {
    const { rows } = await this.pool.query<{ user_id: string; public_key: Buffer }>(
      'SELECT user_id, public_key FROM signer.approvers WHERE credential_id = $1',
      [credentialId],
    );
    const r = rows[0];
    return r ? { credentialId, userId: r.user_id, publicKey: new Uint8Array(r.public_key) } : undefined;
  };

  private async refuse(err: SignerRefusal, intentId: string | null, hash: string | null): Promise<never> {
    await this.pool.query('INSERT INTO signer.refusals (intent_id, intent_hash, reason, detail) VALUES ($1, $2, $3, $4)', [
      intentId,
      hash,
      err.reason,
      { message: err.message, ...err.detail },
    ]);
    throw err;
  }

  /** Common checks: parse, recompute the hash, compare with the caller's claim. */
  private async parse(req: SignRequest): Promise<{ intent: ReturnType<typeof parseIntent>; hash: string }> {
    let intent;
    try {
      intent = parseIntent(req.intent);
    } catch (err) {
      const id = typeof (req.intent as { intentId?: unknown })?.intentId === 'string' ? (req.intent as { intentId: string }).intentId : null;
      return this.refuse(new SignerRefusal('invalid_intent', (err as IntentError).message), id, req.intentHash ?? null);
    }
    const hash = intentHash(intent);
    if (req.intentHash !== undefined && req.intentHash !== hash) {
      return this.refuse(
        new SignerRefusal('hash_mismatch', 'the intent does not match the hash the caller claims was approved', { claimed: req.intentHash, actual: hash }),
        intent.intentId,
        hash,
      );
    }
    return { intent, hash };
  }

  async signPayout(req: SignRequest): Promise<SignedPayout> {
    const { intent, hash } = await this.parse(req);
    if (intent.kind !== 'payout') {
      return this.refuse(new SignerRefusal('invalid_intent', 'not a payout intent'), intent.intentId, hash);
    }
    const approvals = await countApprovals(req.approvals ?? [], hash, intent.createdBy, this.lookup, this.webauthn);

    const client = await this.pool.connect();
    let refusal: SignerRefusal | null = null;
    try {
      await client.query('BEGIN');
      // One signing at a time: the nonce, the 24-hour total and the idempotency check all
      // read the state this lock protects.
      const { rows: stateRows } = await client.query<{
        address: string; chain_id: number; token: string; next_nonce: string; breaker_open: boolean;
      }>('SELECT address, chain_id, token, next_nonce, breaker_open FROM signer.state FOR UPDATE');
      const state = stateRows[0];
      if (!state) throw new SignerRefusal('not_bootstrapped', 'signer has not been bootstrapped');

      const { rows: prior } = await client.query<{ intent_hash: string; tx_hash: Hex; raw_tx: Hex; nonce: string; approvers: string[] }>(
        'SELECT intent_hash, tx_hash, raw_tx, nonce, approvers FROM signer.log WHERE intent_id = $1',
        [intent.intentId],
      );
      if (prior[0]) {
        await client.query('ROLLBACK');
        if (prior[0].intent_hash !== hash) {
          return this.refuse(new SignerRefusal('intent_id_reused', 'this intent id was already signed with different contents'), intent.intentId, hash);
        }
        // Same intent again (a retry, or a duplicate worker): return the same transaction.
        return {
          intentId: intent.intentId, intentHash: hash, txHash: prior[0].tx_hash, rawTx: prior[0].raw_tx,
          nonce: Number(prior[0].nonce), approvers: prior[0].approvers, replayed: true,
        };
      }

      refusal = this.checkPayoutTarget(intent, state);
      if (!refusal) {
        const { rows: payeeRows } = await client.query<{ payee_id: string; activated_at: Date }>(
          'SELECT payee_id, activated_at FROM signer.payees WHERE address = $1 AND chain_id = $2',
          [intent.to, intent.chainId],
        );
        const payee = payeeRows[0];
        if (!payee) {
          refusal = new SignerRefusal('unknown_payee', 'the recipient is not an approved payee', { to: intent.to });
        } else if (payee.payee_id !== intent.payeeId) {
          refusal = new SignerRefusal('payee_mismatch', 'the recipient address belongs to a different payee', { to: intent.to });
        } else {
          const { rows: spent } = await client.query<{ total: string }>(
            `SELECT coalesce(sum(amount), 0)::text AS total FROM signer.log
              WHERE kind = 'payout' AND created_at > $1::timestamptz - interval '24 hours'`,
            [this.now()],
          );
          const decision = canSign(
            {
              intentId: intent.intentId,
              amount: BigInt(intent.amount),
              payeeActive: true,
              payeeAgeSeconds: (this.now().getTime() - payee.activated_at.getTime()) / 1000,
            },
            { spentToday: BigInt(spent[0]!.total), approvals: approvals.count, breakerOpen: state.breaker_open },
          );
          if (!decision.allowed) {
            refusal = new SignerRefusal('policy_denied', 'the payout policy does not allow signing', {
              policies: decision.reasons,
              approvals: approvals.count,
              approvers: approvals.users,
              rejectedApprovals: approvals.rejected,
              errors: decision.errors,
            });
          }
        }
      }
      if (refusal) {
        await client.query('ROLLBACK');
        return this.refuse(refusal, intent.intentId, hash);
      }

      // Normally next_nonce. If something else spent from this address (a leaked key), the chain
      // is ahead; follow it so legitimate payouts still go through once the breaker is reset.
      const onChain = await this.chain.getTransactionCount({ address: this.address, blockTag: 'pending' });
      const nonce = Math.max(Number(state.next_nonce), onChain);
      const fees = await this.chain.estimateFeesPerGas();
      const rawTx = await this.account.signTransaction({
        type: 'eip1559',
        chainId: intent.chainId,
        nonce,
        to: intent.token,
        data: encodeTransfer(intent.to, BigInt(intent.amount)),
        value: 0n,
        gas: TRANSFER_GAS,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const txHash = keccak256(rawTx);
      await client.query(
        `INSERT INTO signer.log (intent_id, intent_hash, kind, payload, approvers, to_address, amount, nonce, tx_hash, raw_tx, created_at)
         VALUES ($1, $2, 'payout', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [intent.intentId, hash, intent, approvals.users, intent.to, intent.amount, nonce, txHash, rawTx, this.now()],
      );
      await client.query('UPDATE signer.state SET next_nonce = $1', [nonce + 1]);
      await client.query('COMMIT');
      return { intentId: intent.intentId, intentHash: hash, txHash, rawTx, nonce, approvers: approvals.users, replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private checkPayoutTarget(intent: PayoutIntent, state: { chain_id: number; token: string }): SignerRefusal | null {
    if (intent.chainId !== state.chain_id) return new SignerRefusal('wrong_chain', 'the intent is for a different chain');
    if (intent.token.toLowerCase() !== state.token.toLowerCase()) return new SignerRefusal('wrong_token', 'the intent is for a different token');
    return null;
  }

  /** Applies an approved payee_add, approver_add or breaker_reset. Needs two approvers. */
  async applyGovernance(req: SignRequest): Promise<{ intentId: string; intentHash: string; approvers: string[]; replayed: boolean }> {
    const { intent, hash } = await this.parse(req);
    if (intent.kind === 'payout') {
      return this.refuse(new SignerRefusal('invalid_intent', 'payouts are signed, not applied'), intent.intentId, hash);
    }
    const approvals = await countApprovals(req.approvals ?? [], hash, intent.createdBy, this.lookup, this.webauthn);

    const client = await this.pool.connect();
    let refusal: SignerRefusal | null = null;
    try {
      await client.query('BEGIN');
      const { rows: stateRows } = await client.query<{ chain_id: number }>('SELECT chain_id FROM signer.state FOR UPDATE');
      if (!stateRows[0]) throw new SignerRefusal('not_bootstrapped', 'signer has not been bootstrapped');
      const { rows: prior } = await client.query<{ intent_hash: string; approvers: string[] }>(
        'SELECT intent_hash, approvers FROM signer.log WHERE intent_id = $1',
        [intent.intentId],
      );
      if (prior[0]) {
        await client.query('ROLLBACK');
        if (prior[0].intent_hash !== hash) {
          return this.refuse(new SignerRefusal('intent_id_reused', 'this intent id was already applied with different contents'), intent.intentId, hash);
        }
        return { intentId: intent.intentId, intentHash: hash, approvers: prior[0].approvers, replayed: true };
      }

      const decision = canApplyGovernance(intent.intentId, approvals.count);
      if (!decision.allowed) {
        refusal = new SignerRefusal('policy_denied', 'governance changes need two approvers other than the requester', {
          policies: decision.reasons, approvals: approvals.count, approvers: approvals.users, rejectedApprovals: approvals.rejected,
        });
      } else {
        refusal = await this.applyChange(client, intent, stateRows[0].chain_id);
      }
      if (refusal) {
        await client.query('ROLLBACK');
        return this.refuse(refusal, intent.intentId, hash);
      }
      await client.query(
        `INSERT INTO signer.log (intent_id, intent_hash, kind, payload, approvers, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [intent.intentId, hash, intent.kind, intent, approvals.users, this.now()],
      );
      await client.query('COMMIT');
      return { intentId: intent.intentId, intentHash: hash, approvers: approvals.users, replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async applyChange(client: pg.PoolClient, intent: GovernanceIntent, chainId: number): Promise<SignerRefusal | null> {
    switch (intent.kind) {
      case 'payee_add': {
        if (intent.chainId !== chainId) return new SignerRefusal('wrong_chain', 'the payee is for a different chain');
        const r = await client.query(
          `INSERT INTO signer.payees (address, chain_id, payee_id, name, activated_at, added_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [intent.address, intent.chainId, intent.payeeId, intent.name, this.now(), intent.intentId],
        );
        return r.rowCount === 1 ? null : new SignerRefusal('already_applied', 'that address or payee id is already registered');
      }
      case 'approver_add': {
        const r = await client.query(
          `INSERT INTO signer.approvers (credential_id, user_id, public_key, enrolled_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [intent.credentialId, intent.userId, Buffer.from(intent.publicKey, 'base64url'), intent.intentId],
        );
        return r.rowCount === 1 ? null : new SignerRefusal('already_applied', 'that passkey is already enrolled');
      }
      case 'breaker_reset':
        await client.query('UPDATE signer.state SET breaker_open = false, breaker_reason = NULL, breaker_at = NULL');
        return null;
    }
  }

  /** Opening the breaker needs no approval: anything that suspects a problem may stop payouts. */
  async tripBreaker(reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE signer.state SET breaker_open = true, breaker_reason = $1, breaker_at = $2 WHERE NOT breaker_open`,
      [reason.slice(0, 500), this.now()],
    );
  }

  async status(): Promise<SignerStatus> {
    const { rows } = await this.pool.query(
      `SELECT s.address, s.chain_id, s.token, s.next_nonce, s.breaker_open, s.breaker_reason, s.breaker_at,
              (SELECT count(*) FROM signer.approvers)::int AS approvers,
              (SELECT count(*) FROM signer.payees)::int AS payees,
              (SELECT count(*) FROM signer.log WHERE kind = 'payout')::int AS signed,
              (SELECT count(*) FROM signer.refusals)::int AS refused
         FROM signer.state s`,
    );
    const r = rows[0];
    if (!r) throw new SignerRefusal('not_bootstrapped', 'signer has not been bootstrapped');
    return {
      address: r.address,
      chainId: r.chain_id,
      token: r.token,
      nextNonce: Number(r.next_nonce),
      breaker: { open: r.breaker_open, reason: r.breaker_reason, at: r.breaker_at?.toISOString() ?? null },
      approvers: r.approvers,
      payees: r.payees,
      signed: r.signed,
      refused: r.refused,
    };
  }

  async log(afterSeq = 0, limit = 500): Promise<LogEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT seq, intent_id, intent_hash, kind, approvers, to_address, amount::text, nonce, tx_hash, created_at
         FROM signer.log WHERE seq > $1 ORDER BY seq LIMIT $2`,
      [afterSeq, limit],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      intentId: r.intent_id,
      intentHash: r.intent_hash,
      kind: r.kind,
      approvers: r.approvers,
      to: r.to_address,
      amount: r.amount,
      nonce: r.nonce === null ? null : Number(r.nonce),
      txHash: r.tx_hash,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async refusals(limit = 100): Promise<Refusal[]> {
    const { rows } = await this.pool.query(
      'SELECT seq, intent_id, intent_hash, reason, detail, created_at FROM signer.refusals ORDER BY seq DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({
      seq: Number(r.seq), intentId: r.intent_id, intentHash: r.intent_hash, reason: r.reason, detail: r.detail, createdAt: r.created_at.toISOString(),
    }));
  }

  async payees(): Promise<{ payeeId: string; name: string; address: string; chainId: number; activatedAt: string }[]> {
    const { rows } = await this.pool.query('SELECT payee_id, name, address, chain_id, activated_at FROM signer.payees ORDER BY name');
    return rows.map((r) => ({ payeeId: r.payee_id, name: r.name, address: r.address, chainId: r.chain_id, activatedAt: r.activated_at.toISOString() }));
  }

  async approvers(): Promise<{ userId: string; credentialId: string; enrolledAt: string; enrolledBy: string }[]> {
    const { rows } = await this.pool.query('SELECT user_id, credential_id, enrolled_at, enrolled_by FROM signer.approvers ORDER BY enrolled_at');
    return rows.map((r) => ({ userId: r.user_id, credentialId: r.credential_id, enrolledAt: r.enrolled_at.toISOString(), enrolledBy: r.enrolled_by }));
  }

  /** Records a checkpoint of the API's audit log. A different hash for an existing seq is refused. */
  async anchor(seq: number, hash: string): Promise<{ ok: boolean; existing?: string }> {
    const r = await this.pool.query('INSERT INTO signer.anchors (seq, hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [seq, hash]);
    if (r.rowCount === 1) return { ok: true };
    const { rows } = await this.pool.query<{ hash: string }>('SELECT hash FROM signer.anchors WHERE seq = $1', [seq]);
    return rows[0]?.hash === hash ? { ok: true } : { ok: false, existing: rows[0]?.hash };
  }

  async anchors(): Promise<{ seq: number; hash: string; createdAt: string }[]> {
    const { rows } = await this.pool.query('SELECT seq, hash, created_at FROM signer.anchors ORDER BY seq');
    return rows.map((r) => ({ seq: Number(r.seq), hash: r.hash, createdAt: r.created_at.toISOString() }));
  }
}
