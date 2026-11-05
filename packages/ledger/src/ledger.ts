import type pg from 'pg';
import { canonicalJson, sha256Hex } from './canonical.js';
import { LedgerError } from './errors.js';
import {
  ACCOUNT_TYPES,
  normalSide,
  type Account,
  type AccountType,
  type Balance,
  type CreateAccountInput,
  type Direction,
  type Entry,
  type IntegrityProblem,
  type PostResult,
  type PostTransactionInput,
  type ReverseTransactionInput,
  type Transaction,
  type TrialBalanceRow,
} from './types.js';

const MAX_ENTRIES = 500;
const MAX_AMOUNT = 10n ** 78n; // numeric(78, 0)
const CODE_RE = /^[a-z0-9][a-z0-9_:.-]{0,99}$/;
const CURRENCY_RE = /^[A-Z][A-Z0-9]{1,11}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allow_negative: boolean;
  created_at: Date;
}

interface TransactionRow {
  id: string;
  seq: string;
  idempotency_key: string;
  description: string;
  metadata: Record<string, unknown>;
  reverses: string | null;
  reversed_by: string | null;
  effective_at: Date;
  created_at: Date;
}

interface EntryRow {
  id: string;
  transaction_id: string;
  code: string;
  currency: string;
  direction: Direction;
  amount: string;
}

export interface ListTransactionsOptions {
  /** Only transactions touching this account code. */
  account?: string;
  limit?: number;
  /** Keyset cursor: return transactions with seq lower than this. */
  beforeSeq?: string;
}

/**
 * Double-entry ledger on PostgreSQL.
 *
 * Concurrency model: a posting locks the balance rows of the accounts it touches,
 * in ascending id order (so two postings can never deadlock), checks the
 * no-negative rule against the locked values, then writes entries and balances in
 * the same transaction. The check and the write therefore can't be separated by a
 * concurrent posting — the read-then-write race that lets two withdrawals both
 * pass a balance check.
 */
export class Ledger {
  constructor(private readonly pool: pg.Pool) {}

  /** Creates an account, or returns it if it already exists with the same settings. */
  async createAccount(input: CreateAccountInput): Promise<Account> {
    validateAccountInput(input);
    const allowNegative = input.allowNegative ?? false;
    const inserted = await this.pool.query<AccountRow>(
      `INSERT INTO ledger.accounts (code, name, type, currency, allow_negative)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO NOTHING
       RETURNING *`,
      [input.code, input.name, input.type, input.currency, allowNegative],
    );
    const row =
      inserted.rows[0] ??
      (await this.pool.query<AccountRow>('SELECT * FROM ledger.accounts WHERE code = $1', [input.code])).rows[0];
    if (!row) throw new Error(`account ${input.code} neither inserted nor found`);
    if (row.type !== input.type || row.currency !== input.currency || row.allow_negative !== allowNegative) {
      throw new LedgerError('ACCOUNT_CONFLICT', `account ${input.code} already exists with different settings`, {
        account: input.code,
        existing: { type: row.type, currency: row.currency, allowNegative: row.allow_negative },
      });
    }
    return toAccount(row);
  }

  async getAccount(code: string): Promise<Account> {
    const { rows } = await this.pool.query<AccountRow>('SELECT * FROM ledger.accounts WHERE code = $1', [code]);
    const row = rows[0];
    if (!row) throw new LedgerError('UNKNOWN_ACCOUNT', `unknown account ${code}`, { account: code });
    return toAccount(row);
  }

  async listAccounts(): Promise<Account[]> {
    const { rows } = await this.pool.query<AccountRow>('SELECT * FROM ledger.accounts ORDER BY code');
    return rows.map(toAccount);
  }

  postTransaction(input: PostTransactionInput): Promise<PostResult> {
    return this.post(input, null);
  }

  /**
   * Posts the mirror image of a transaction. A transaction can be reversed once;
   * a reversal itself cannot be reversed (post a new transaction instead).
   */
  async reverseTransaction(id: string, input: ReverseTransactionInput): Promise<PostResult> {
    const original = await this.getTransaction(id);
    if (original.reverses !== null) {
      throw new LedgerError('VALIDATION', 'a reversal cannot itself be reversed', { transactionId: id });
    }
    return this.post(
      {
        idempotencyKey: input.idempotencyKey,
        description: input.description ?? `Reversal of ${id}`,
        metadata: input.metadata,
        effectiveAt: input.effectiveAt,
        entries: original.entries.map((e) => ({
          account: e.account,
          direction: e.direction === 'debit' ? 'credit' : 'debit',
          amount: e.amount,
        })),
      },
      id,
    );
  }

  private async post(input: PostTransactionInput, reverses: string | null): Promise<PostResult> {
    validatePostInput(input);
    const description = input.description ?? '';
    const metadata = input.metadata ?? {};
    const requestHash = sha256Hex(
      canonicalJson({ entries: input.entries, description, metadata, effectiveAt: input.effectiveAt ?? null, reverses }),
    );

    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query('BEGIN');
      open = true;

      const codes = [...new Set(input.entries.map((e) => e.account))];
      const { rows: accountRows } = await client.query<AccountRow>(
        'SELECT * FROM ledger.accounts WHERE code = ANY($1::text[])',
        [codes],
      );
      const byCode = new Map(accountRows.map((a) => [a.code, a]));
      const missing = codes.filter((c) => !byCode.has(c));
      if (missing.length > 0) {
        throw new LedgerError('UNKNOWN_ACCOUNT', `unknown account(s): ${missing.join(', ')}`, { accounts: missing });
      }
      const resolved = input.entries.map((e) => ({ ...e, row: byCode.get(e.account)! }));
      assertBalancedPerCurrency(resolved.map((e) => ({ currency: e.row.currency, direction: e.direction, amount: e.amount })));

      // Claim the idempotency key first. A concurrent insert of the same key waits
      // here until the other transaction commits or rolls back.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ledger.transactions (idempotency_key, request_hash, description, metadata, reverses, effective_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, now()))
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [input.idempotencyKey, requestHash, description, canonicalJson(metadata), reverses, input.effectiveAt ?? null],
      );
      const txId = inserted.rows[0]?.id;
      if (txId === undefined) {
        const { rows } = await client.query<{ id: string; request_hash: string }>(
          'SELECT id, request_hash FROM ledger.transactions WHERE idempotency_key = $1',
          [input.idempotencyKey],
        );
        await client.query('ROLLBACK');
        open = false;
        const existing = rows[0];
        if (!existing) throw new Error(`idempotency key ${input.idempotencyKey} conflicted but no row was found`);
        if (existing.request_hash !== requestHash) {
          throw new LedgerError('IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different request', {
            idempotencyKey: input.idempotencyKey,
            transactionId: existing.id,
          });
        }
        return { transaction: await this.getTransaction(existing.id), replayed: true };
      }

      // Net change per account.
      const deltas = new Map<string, { debits: bigint; credits: bigint }>();
      for (const e of resolved) {
        const d = deltas.get(e.row.id) ?? { debits: 0n, credits: 0n };
        if (e.direction === 'debit') d.debits += e.amount;
        else d.credits += e.amount;
        deltas.set(e.row.id, d);
      }
      const accountIds = [...deltas.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const byId = new Map(accountRows.map((a) => [a.id, a]));

      // Lock balance rows in id order, then check against the locked values.
      const { rows: locked } = await client.query<{ account_id: string; debits: string; credits: string }>(
        `SELECT account_id, debits, credits FROM ledger.balances
         WHERE account_id = ANY($1::bigint[])
         ORDER BY account_id
         FOR UPDATE`,
        [accountIds],
      );
      for (const row of locked) {
        const account = byId.get(row.account_id)!;
        const delta = deltas.get(row.account_id)!;
        if (account.allow_negative) continue;
        const before = sideBalance(account.type, BigInt(row.debits), BigInt(row.credits));
        const after = sideBalance(account.type, BigInt(row.debits) + delta.debits, BigInt(row.credits) + delta.credits);
        if (after < 0n) {
          throw new LedgerError('INSUFFICIENT_BALANCE', `account ${account.code} would go negative`, {
            account: account.code,
            balance: before.toString(),
            change: (after - before).toString(),
          });
        }
      }

      await client.query(
        `INSERT INTO ledger.entries (transaction_id, account_id, currency, direction, amount)
         SELECT $1, t.account_id, t.currency, t.direction, t.amount
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::numeric[])
              WITH ORDINALITY AS t(account_id, currency, direction, amount, ord)
         ORDER BY t.ord`,
        [
          txId,
          resolved.map((e) => e.row.id),
          resolved.map((e) => e.row.currency),
          resolved.map((e) => e.direction),
          resolved.map((e) => e.amount.toString()),
        ],
      );

      await client.query(
        `UPDATE ledger.balances AS b
         SET debits = b.debits + t.debits,
             credits = b.credits + t.credits,
             version = b.version + 1,
             updated_at = now()
         FROM unnest($1::bigint[], $2::numeric[], $3::numeric[]) AS t(account_id, debits, credits)
         WHERE b.account_id = t.account_id`,
        [
          accountIds,
          accountIds.map((id) => deltas.get(id)!.debits.toString()),
          accountIds.map((id) => deltas.get(id)!.credits.toString()),
        ],
      );

      await client.query('COMMIT');
      open = false;
      return { transaction: await this.getTransaction(txId), replayed: false };
    } catch (err) {
      if (open) await client.query('ROLLBACK').catch(() => undefined);
      throw mapPgError(err, reverses);
    } finally {
      client.release();
    }
  }

  async getTransaction(id: string): Promise<Transaction> {
    if (!UUID_RE.test(id)) throw new LedgerError('NOT_FOUND', `transaction ${id} not found`, { transactionId: id });
    const { rows } = await this.pool.query<TransactionRow>(
      `SELECT t.*, r.id AS reversed_by
       FROM ledger.transactions t
       LEFT JOIN ledger.transactions r ON r.reverses = t.id
       WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new LedgerError('NOT_FOUND', `transaction ${id} not found`, { transactionId: id });
    const entries = await this.entriesFor([id]);
    return toTransaction(row, entries.get(id) ?? []);
  }

  /** Newest first, keyset-paginated by `seq`. */
  async listTransactions(options: ListTransactionsOptions = {}): Promise<Transaction[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const params: unknown[] = [limit];
    const where: string[] = [];
    if (options.beforeSeq !== undefined) {
      if (!/^\d+$/.test(options.beforeSeq)) throw new LedgerError('VALIDATION', 'beforeSeq must be a positive integer');
      params.push(options.beforeSeq);
      where.push(`t.seq < $${params.length}::bigint`);
    }
    if (options.account !== undefined) {
      params.push(options.account);
      where.push(`EXISTS (SELECT 1 FROM ledger.entries e JOIN ledger.accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.code = $${params.length})`);
    }
    const { rows } = await this.pool.query<TransactionRow>(
      `SELECT t.*, r.id AS reversed_by
       FROM ledger.transactions t
       LEFT JOIN ledger.transactions r ON r.reverses = t.id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.seq DESC
       LIMIT $1`,
      params,
    );
    const entries = await this.entriesFor(rows.map((r) => r.id));
    return rows.map((r) => toTransaction(r, entries.get(r.id) ?? []));
  }

  async getBalance(code: string): Promise<Balance> {
    const balances = await this.queryBalances('WHERE a.code = $1', [code]);
    const balance = balances[0];
    if (!balance) throw new LedgerError('UNKNOWN_ACCOUNT', `unknown account ${code}`, { account: code });
    return balance;
  }

  listBalances(): Promise<Balance[]> {
    return this.queryBalances('', []);
  }

  /** Total debits and credits per currency. Every row must balance. */
  async trialBalance(): Promise<TrialBalanceRow[]> {
    const { rows } = await this.pool.query<{ currency: string; debits: string; credits: string }>(
      `SELECT a.currency, sum(b.debits) AS debits, sum(b.credits) AS credits
       FROM ledger.balances b
       JOIN ledger.accounts a ON a.id = b.account_id
       GROUP BY a.currency
       ORDER BY a.currency`,
    );
    return rows.map((r) => {
      const debits = BigInt(r.debits);
      const credits = BigInt(r.credits);
      return { currency: r.currency, debits, credits, balanced: debits === credits };
    });
  }

  /**
   * Recomputes everything from the entries, in one consistent snapshot, and lists
   * any problem. An empty array means the ledger is internally consistent.
   */
  async verify(): Promise<IntegrityProblem[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const problems: IntegrityProblem[] = [];

      const unbalanced = await client.query<{ transaction_id: string; currency: string }>(
        `SELECT transaction_id, currency FROM ledger.entries
         GROUP BY transaction_id, currency
         HAVING sum(CASE WHEN direction = 'debit' THEN amount ELSE 0 END)
             <> sum(CASE WHEN direction = 'credit' THEN amount ELSE 0 END)`,
      );
      for (const r of unbalanced.rows) {
        problems.push({ kind: 'unbalanced_transaction', transactionId: r.transaction_id, currency: r.currency });
      }

      const tooFew = await client.query<{ id: string; n: string }>(
        `SELECT t.id, count(e.id) AS n
         FROM ledger.transactions t
         LEFT JOIN ledger.entries e ON e.transaction_id = t.id
         GROUP BY t.id
         HAVING count(e.id) < 2`,
      );
      for (const r of tooFew.rows) problems.push({ kind: 'too_few_entries', transactionId: r.id, entries: Number(r.n) });

      const drift = await client.query<{ code: string; debits: string; credits: string; d: string; c: string }>(
        `SELECT a.code, b.debits, b.credits, coalesce(x.d, 0) AS d, coalesce(x.c, 0) AS c
         FROM ledger.accounts a
         JOIN ledger.balances b ON b.account_id = a.id
         LEFT JOIN (
           SELECT account_id,
                  sum(CASE WHEN direction = 'debit' THEN amount ELSE 0 END) AS d,
                  sum(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS c
           FROM ledger.entries
           GROUP BY account_id
         ) x ON x.account_id = a.id
         WHERE b.debits <> coalesce(x.d, 0) OR b.credits <> coalesce(x.c, 0)
         ORDER BY a.code`,
      );
      for (const r of drift.rows) {
        problems.push({
          kind: 'balance_mismatch',
          account: r.code,
          stored: { debits: BigInt(r.debits), credits: BigInt(r.credits) },
          fromEntries: { debits: BigInt(r.d), credits: BigInt(r.c) },
        });
      }

      const negative = await client.query<{ code: string; balance: string }>(
        `SELECT code, balance FROM (
           SELECT a.code, a.allow_negative,
                  CASE WHEN a.type IN ('asset', 'expense') THEN b.debits - b.credits ELSE b.credits - b.debits END AS balance
           FROM ledger.accounts a JOIN ledger.balances b ON b.account_id = a.id
         ) s
         WHERE NOT allow_negative AND balance < 0
         ORDER BY code`,
      );
      for (const r of negative.rows) problems.push({ kind: 'negative_balance', account: r.code, balance: BigInt(r.balance) });

      await client.query('COMMIT');
      return problems;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async queryBalances(where: string, params: unknown[]): Promise<Balance[]> {
    const { rows } = await this.pool.query<{ code: string; type: AccountType; currency: string; debits: string; credits: string }>(
      `SELECT a.code, a.type, a.currency, b.debits, b.credits
       FROM ledger.accounts a
       JOIN ledger.balances b ON b.account_id = a.id
       ${where}
       ORDER BY a.code`,
      params,
    );
    return rows.map((r) => {
      const debits = BigInt(r.debits);
      const credits = BigInt(r.credits);
      return { account: r.code, type: r.type, currency: r.currency, debits, credits, balance: sideBalance(r.type, debits, credits) };
    });
  }

  private async entriesFor(transactionIds: string[]): Promise<Map<string, Entry[]>> {
    const out = new Map<string, Entry[]>();
    if (transactionIds.length === 0) return out;
    const { rows } = await this.pool.query<EntryRow>(
      `SELECT e.id, e.transaction_id, a.code, e.currency, e.direction, e.amount
       FROM ledger.entries e
       JOIN ledger.accounts a ON a.id = e.account_id
       WHERE e.transaction_id = ANY($1::uuid[])
       ORDER BY e.id`,
      [transactionIds],
    );
    for (const r of rows) {
      const list = out.get(r.transaction_id) ?? [];
      list.push({ id: r.id, account: r.code, currency: r.currency, direction: r.direction, amount: BigInt(r.amount) });
      out.set(r.transaction_id, list);
    }
    return out;
  }
}

function sideBalance(type: AccountType, debits: bigint, credits: bigint): bigint {
  return normalSide(type) === 'debit' ? debits - credits : credits - debits;
}

function assertBalancedPerCurrency(entries: { currency: string; direction: Direction; amount: bigint }[]): void {
  const net = new Map<string, bigint>();
  for (const e of entries) {
    net.set(e.currency, (net.get(e.currency) ?? 0n) + (e.direction === 'debit' ? e.amount : -e.amount));
  }
  const unbalanced = [...net].filter(([, n]) => n !== 0n).map(([c]) => c);
  if (unbalanced.length > 0) {
    throw new LedgerError('VALIDATION', `debits and credits differ in ${unbalanced.join(', ')}`, { currencies: unbalanced });
  }
}

function validateAccountInput(input: CreateAccountInput): void {
  if (typeof input.code !== 'string' || !CODE_RE.test(input.code)) {
    throw new LedgerError('VALIDATION', 'code must match ^[a-z0-9][a-z0-9_:.-]{0,99}$');
  }
  if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 200) {
    throw new LedgerError('VALIDATION', 'name must be 1–200 characters');
  }
  if (!ACCOUNT_TYPES.includes(input.type)) throw new LedgerError('VALIDATION', `type must be one of ${ACCOUNT_TYPES.join(', ')}`);
  if (typeof input.currency !== 'string' || !CURRENCY_RE.test(input.currency)) {
    throw new LedgerError('VALIDATION', 'currency must be 2–12 upper-case letters or digits');
  }
}

function validatePostInput(input: PostTransactionInput): void {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
    throw new LedgerError('VALIDATION', 'idempotencyKey must be 1–200 characters');
  }
  if (!Array.isArray(input.entries) || input.entries.length < 2 || input.entries.length > MAX_ENTRIES) {
    throw new LedgerError('VALIDATION', `a transaction needs 2–${MAX_ENTRIES} entries`);
  }
  input.entries.forEach((e, i) => {
    if (typeof e.account !== 'string' || e.account.length === 0) {
      throw new LedgerError('VALIDATION', `entries[${i}].account is required`);
    }
    if (e.direction !== 'debit' && e.direction !== 'credit') {
      throw new LedgerError('VALIDATION', `entries[${i}].direction must be debit or credit`);
    }
    if (typeof e.amount !== 'bigint' || e.amount <= 0n || e.amount >= MAX_AMOUNT) {
      throw new LedgerError('VALIDATION', `entries[${i}].amount must be a positive bigint below 10^78`);
    }
  });
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 1000)) {
    throw new LedgerError('VALIDATION', 'description must be at most 1000 characters');
  }
  if (input.metadata !== undefined && (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
    throw new LedgerError('VALIDATION', 'metadata must be an object');
  }
  if (input.effectiveAt !== undefined && (!(input.effectiveAt instanceof Date) || Number.isNaN(input.effectiveAt.getTime()))) {
    throw new LedgerError('VALIDATION', 'effectiveAt must be a valid Date');
  }
}

function mapPgError(err: unknown, reverses: string | null): unknown {
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr?.code === '23505' && pgErr.constraint === 'transactions_reverses_key') {
    return new LedgerError('ALREADY_REVERSED', `transaction ${reverses} has already been reversed`, { transactionId: reverses });
  }
  return err;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    currency: row.currency,
    allowNegative: row.allow_negative,
    createdAt: row.created_at,
  };
}

function toTransaction(row: TransactionRow, entries: Entry[]): Transaction {
  return {
    id: row.id,
    seq: row.seq,
    idempotencyKey: row.idempotency_key,
    description: row.description,
    metadata: row.metadata,
    reverses: row.reverses,
    reversedBy: row.reversed_by,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
    entries,
  };
}
