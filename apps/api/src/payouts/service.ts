import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getAddress, isAddress, parseUnits } from 'viem';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  canPropose,
  GOVERNANCE_APPROVALS,
  intentHash,
  listScreen,
  parseIntent,
  requiredApprovals,
  type SanctionsScreen,
  verifyApproval,
  type Approval,
  type Intent,
  type KnownCredential,
  type PayoutIntent,
  type Role,
} from '@guardrail/core';
import { migrate } from '@guardrail/ledger';
import { audit } from './audit.js';

export const PAYOUTS_MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
export const migratePayouts = (pool: pg.Pool) => migrate(pool, PAYOUTS_MIGRATIONS);

export const EXPENSE_ACCOUNTS = ['expense:vendor-services', 'expense:contractor-payroll'] as const;
export const HOT_USDC = 'asset:base:hot:usdc';
export const HOT_ETH = 'asset:base:hot:eth';
export const FEES = 'expense:network-fees';
export const TOKEN_DECIMALS = 6;

export interface ChainSettings {
  chainId: number;
  token: `0x${string}`;
  hotWallet: `0x${string}`;
}

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

export interface User {
  id: string;
  name: string;
  role: Role;
  demo: boolean;
}

export type IntentStatus =
  | 'pending_approval' | 'approved' | 'signed' | 'broadcast' | 'settled' | 'applied' | 'refused' | 'failed' | 'cancelled';

export interface IntentRecord {
  id: string;
  kind: Intent['kind'];
  payload: Intent;
  hash: string;
  status: IntentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  requiredApprovals: number | null;
  amount: string | null;
  error: { reason: string; message: string; detail?: Record<string, unknown> } | null;
  txHash: string | null;
  nonce: number | null;
  blockNumber: number | null;
  feeWei: string | null;
  ledgerTxId: string | null;
  attempts: number;
  approvals: { userId: string; credentialId: string; at: string }[];
}

export class PayoutError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'POLICY_DENIED' | 'UNAUTHENTICATED',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

function rowToIntent(r: Record<string, unknown>, approvals: IntentRecord['approvals'] = []): IntentRecord {
  return {
    id: r.id as string,
    kind: r.kind as Intent['kind'],
    payload: r.payload as Intent,
    hash: r.hash as string,
    status: r.status as IntentStatus,
    createdBy: r.created_by as string,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
    requiredApprovals: r.required_approvals as number | null,
    amount: (r.amount as string | null) ?? null,
    error: (r.error as IntentRecord['error']) ?? null,
    txHash: (r.tx_hash as string | null) ?? null,
    nonce: r.nonce === null ? null : Number(r.nonce),
    blockNumber: r.block_number === null ? null : Number(r.block_number),
    feeWei: (r.fee_wei as string | null) ?? null,
    ledgerTxId: (r.ledger_tx_id as string | null) ?? null,
    attempts: r.attempts as number,
    approvals,
  };
}

const INTENT_COLUMNS = `id, kind, payload, hash, status, created_by, created_at, updated_at, required_approvals, amount::text AS amount,
  error, tx_hash, nonce, block_number, fee_wei::text AS fee_wei, ledger_tx_id, attempts`;

export class Payouts {
  readonly sanctions: SanctionsScreen;
  private readonly now: () => Date;

  constructor(
    readonly pool: pg.Pool,
    readonly chain: ChainSettings,
    readonly webauthn: WebAuthnConfig,
    opts: { sanctions?: SanctionsScreen; now?: () => Date } = {},
  ) {
    this.sanctions = opts.sanctions ?? listScreen();
    this.now = opts.now ?? (() => new Date());
  }

  // ---- users and passkeys ---------------------------------------------------------------

  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT id, name, role, demo FROM payouts.users WHERE id = $1', [id]);
    return (rows[0] as User | undefined) ?? null;
  }

  async listUsers(): Promise<(User & { passkeys: number; enrolled: boolean })[]> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.name, u.role, u.demo,
              count(c.id)::int AS passkeys, coalesce(bool_or(c.enrolled), false) AS enrolled
         FROM payouts.users u LEFT JOIN payouts.credentials c ON c.user_id = u.id
        GROUP BY u.id ORDER BY u.created_at, u.id`,
    );
    return rows;
  }

  /** Credentials this API accepts for approvals: only those the signer has enrolled. */
  lookupCredential = async (credentialId: string): Promise<KnownCredential | undefined> => {
    const { rows } = await this.pool.query<{ user_id: string; public_key: Buffer }>(
      'SELECT user_id, public_key FROM payouts.credentials WHERE id = $1 AND enrolled',
      [credentialId],
    );
    const r = rows[0];
    return r ? { credentialId, userId: r.user_id, publicKey: new Uint8Array(r.public_key) } : undefined;
  };

  async credentialsOf(userId: string): Promise<{ id: string; transports: string[]; enrolled: boolean; software: boolean }[]> {
    const { rows } = await this.pool.query('SELECT id, transports, enrolled, software FROM payouts.credentials WHERE user_id = $1', [userId]);
    return rows;
  }

  // ---- payees ---------------------------------------------------------------------------

  async listPayees() {
    const { rows } = await this.pool.query(
      `SELECT id, name, address, chain_id AS "chainId", status, intent_id AS "intentId", created_at AS "createdAt", activated_at AS "activatedAt"
         FROM payouts.payees ORDER BY name`,
    );
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), activatedAt: r.activatedAt?.toISOString() ?? null }));
  }

  async proposePayee(user: User, input: { name: string; address: string }): Promise<IntentRecord> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 100) throw new PayoutError('VALIDATION', 'name must be 2 to 100 characters');
    if (!isAddress(input.address, { strict: false })) throw new PayoutError('VALIDATION', 'not an EVM address');
    const address = getAddress(input.address);
    const screening = await this.sanctions.check(address);
    if (screening.listed) {
      await audit(this.pool, user.id, 'payee.sanctioned_rejected', null, { address, source: screening.source });
      throw new PayoutError('POLICY_DENIED', 'this address is on a sanctions list', { policies: ['sanctioned-payee'], source: screening.source });
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'payee';
    const payeeId = `${id}-${randomUUID().slice(0, 6)}`;
    const intent: Intent = {
      kind: 'payee_add', intentId: randomUUID(), chainId: this.chain.chainId, payeeId, name, address,
      createdBy: user.id, createdAt: this.now().toISOString(),
    };
    return this.insertIntent(user, intent, GOVERNANCE_APPROVALS, async (c) => {
      const r = await c.query(
        `INSERT INTO payouts.payees (id, name, address, chain_id, status, intent_id) VALUES ($1, $2, $3, $4, 'pending', $5)
         ON CONFLICT (address) DO NOTHING`,
        [payeeId, name, address, this.chain.chainId, intent.intentId],
      );
      if (r.rowCount !== 1) throw new PayoutError('CONFLICT', 'that address is already a payee');
    });
  }

  // ---- intents --------------------------------------------------------------------------

  private async spentToday(): Promise<bigint> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT coalesce(sum(amount), 0)::text AS total FROM payouts.intents
        WHERE kind = 'payout' AND status IN ('approved', 'signed', 'broadcast', 'settled') AND created_at > $1::timestamptz - interval '24 hours'`,
      [this.now()],
    );
    return BigInt(rows[0]!.total);
  }

  async proposePayout(user: User, input: { payeeId: string; amount: string; memo: string; expenseAccount: string }): Promise<IntentRecord> {
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(input.amount)) throw new PayoutError('VALIDATION', 'amount must be a number with at most 6 decimals');
    const units = parseUnits(input.amount, TOKEN_DECIMALS);
    if (units <= 0n) throw new PayoutError('VALIDATION', 'amount must be positive');
    if (!(EXPENSE_ACCOUNTS as readonly string[]).includes(input.expenseAccount)) throw new PayoutError('VALIDATION', 'unknown expense account');
    if (input.memo.length > 200) throw new PayoutError('VALIDATION', 'memo is too long');

    const { rows } = await this.pool.query('SELECT id, address, status, activated_at FROM payouts.payees WHERE id = $1', [input.payeeId]);
    const payee = rows[0];
    if (!payee) throw new PayoutError('NOT_FOUND', 'unknown payee');

    const intent: PayoutIntent = {
      kind: 'payout', intentId: randomUUID(), chainId: this.chain.chainId, token: this.chain.token, to: getAddress(payee.address),
      amount: units.toString(), payeeId: payee.id, memo: input.memo, expenseAccount: input.expenseAccount,
      createdBy: user.id, createdAt: this.now().toISOString(),
    };
    const facts = {
      intentId: intent.intentId,
      amount: units,
      payeeActive: payee.status === 'active',
      payeeAgeSeconds: payee.activated_at ? (this.now().getTime() - payee.activated_at.getTime()) / 1000 : 0,
      recipientSanctioned: (await this.sanctions.check(payee.address)).listed,
    };
    const decision = canPropose(user, facts, { spentToday: await this.spentToday(), breakerOpen: false });
    if (!decision.allowed) {
      throw new PayoutError('POLICY_DENIED', 'the payout policy does not allow this payout', { policies: decision.reasons });
    }
    return this.insertIntent(user, intent, requiredApprovals(facts));
  }

  /** Called inside the registration transaction; returns the new intent's id. */
  async proposeApprover(user: User, credential: { id: string; publicKey: Uint8Array }, client: pg.PoolClient): Promise<string> {
    const intent: Intent = {
      kind: 'approver_add', intentId: randomUUID(), userId: user.id, credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'), createdBy: user.id, createdAt: this.now().toISOString(),
    };
    return this.writeIntent(user, intent, GOVERNANCE_APPROVALS, client);
  }

  async proposeBreakerReset(user: User, reason: string): Promise<IntentRecord> {
    const r = reason.trim();
    if (r.length < 3 || r.length > 200) throw new PayoutError('VALIDATION', 'reason must be 3 to 200 characters');
    const intent: Intent = { kind: 'breaker_reset', intentId: randomUUID(), reason: r, createdBy: user.id, createdAt: this.now().toISOString() };
    return this.insertIntent(user, intent, GOVERNANCE_APPROVALS);
  }

  private async insertIntent(
    user: User,
    raw: Intent,
    required: number | null,
    extra?: (c: pg.PoolClient) => Promise<void>,
  ): Promise<IntentRecord> {
    const c = await this.pool.connect();
    let id: string;
    try {
      await c.query('BEGIN');
      id = await this.writeIntent(user, raw, required, c);
      if (extra) await extra(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    return (await this.getIntent(id))!;
  }

  private async writeIntent(user: User, raw: Intent, required: number | null, c: pg.PoolClient): Promise<string> {
    const intent = parseIntent(raw); // the stored payload is exactly what the signer will parse
    const hash = intentHash(intent);
    await c.query(
      `INSERT INTO payouts.intents (id, kind, payload, hash, status, created_by, created_at, required_approvals, amount)
       VALUES ($1, $2, $3, $4, 'pending_approval', $5, $6, $7, $8)`,
      [intent.intentId, intent.kind, intent, hash, user.id, intent.createdAt, required, intent.kind === 'payout' ? intent.amount : null],
    );
    await audit(c, user.id, `${intent.kind}.proposed`, intent.intentId, { hash, required });
    return intent.intentId;
  }

  async getIntent(id: string): Promise<IntentRecord | null> {
    const { rows } = await this.pool.query(`SELECT ${INTENT_COLUMNS} FROM payouts.intents WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    const { rows: a } = await this.pool.query(
      'SELECT user_id, credential_id, created_at FROM payouts.approvals WHERE intent_id = $1 ORDER BY created_at',
      [id],
    );
    return rowToIntent(rows[0], a.map((x) => ({ userId: x.user_id, credentialId: x.credential_id, at: x.created_at.toISOString() })));
  }

  async listIntents(filter: { kind?: string; status?: string; limit?: number } = {}): Promise<IntentRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT ${INTENT_COLUMNS},
              coalesce((SELECT json_agg(json_build_object('userId', a.user_id, 'credentialId', a.credential_id, 'at', a.created_at) ORDER BY a.created_at)
                          FROM payouts.approvals a WHERE a.intent_id = i.id), '[]') AS approvals_json
         FROM payouts.intents i
        WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT $3`,
      [filter.kind ?? null, filter.status ?? null, filter.limit ?? 50],
    );
    return rows.map((r) => rowToIntent(r, r.approvals_json));
  }

  async approvalsFor(intentId: string): Promise<Approval[]> {
    const { rows } = await this.pool.query('SELECT user_id, credential_id, assertion FROM payouts.approvals WHERE intent_id = $1 ORDER BY created_at', [intentId]);
    return rows.map((r) => ({ userId: r.user_id, credentialId: r.credential_id, assertion: r.assertion }));
  }

  /**
   * Records a passkey approval. The API verifies it too (so a bad approval fails fast and is
   * never counted), but the signer verifies everything again from its own records.
   */
  async approve(user: User, intentId: string, credentialId: string, assertion: AuthenticationResponseJSON): Promise<IntentRecord> {
    if (user.role === 'requester') throw new PayoutError('FORBIDDEN', 'requesters cannot approve');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`SELECT ${INTENT_COLUMNS} FROM payouts.intents WHERE id = $1 FOR UPDATE`, [intentId]);
      if (!rows[0]) throw new PayoutError('NOT_FOUND', 'intent not found');
      const intent = rowToIntent(rows[0]);
      if (intent.status !== 'pending_approval') throw new PayoutError('CONFLICT', `intent is ${intent.status}`);
      if (intent.createdBy === user.id) throw new PayoutError('FORBIDDEN', 'you cannot approve your own request');

      const check = await verifyApproval({ userId: user.id, credentialId, assertion }, intent.hash, this.lookupCredential, this.webauthn);
      if (!check.ok) {
        await audit(c, user.id, 'approval.rejected', intentId, { reason: check.reason });
        await c.query('COMMIT');
        throw new PayoutError('FORBIDDEN', `approval rejected: ${check.reason}`, { reason: check.reason });
      }
      const ins = await c.query(
        'INSERT INTO payouts.approvals (intent_id, user_id, credential_id, assertion) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [intentId, user.id, credentialId, assertion],
      );
      if (ins.rowCount !== 1) throw new PayoutError('CONFLICT', 'you already approved this');
      await audit(c, user.id, 'approval.recorded', intentId, { credentialId });

      const { rows: n } = await c.query<{ n: number }>(
        'SELECT count(DISTINCT user_id)::int AS n FROM payouts.approvals WHERE intent_id = $1 AND user_id <> $2',
        [intentId, intent.createdBy],
      );
      const required = intent.requiredApprovals ?? Infinity;
      if (n[0]!.n >= required) {
        await c.query("UPDATE payouts.intents SET status = 'approved', updated_at = now(), next_attempt_at = now() WHERE id = $1", [intentId]);
        await audit(c, 'system', 'intent.approved', intentId, { approvals: n[0]!.n });
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    return (await this.getIntent(intentId))!;
  }

  async cancel(user: User, intentId: string): Promise<IntentRecord> {
    const r = await this.pool.query(
      `UPDATE payouts.intents SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status = 'pending_approval' AND (created_by = $2 OR $3)`,
      [intentId, user.id, user.role === 'admin'],
    );
    if (r.rowCount !== 1) throw new PayoutError('CONFLICT', 'only a pending intent can be cancelled, by whoever proposed it');
    await this.pool.query("UPDATE payouts.payees SET status = 'rejected' WHERE intent_id = $1", [intentId]);
    await audit(this.pool, user.id, 'intent.cancelled', intentId);
    return (await this.getIntent(intentId))!;
  }
}
