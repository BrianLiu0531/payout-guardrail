import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLedgerError, LedgerError, type LedgerErrorCode } from '../src/errors.js';
import type { Ledger } from '../src/ledger.js';
import { createTestDb, uid, type TestDb } from './helpers.js';

let db: TestDb;
let ledger: Ledger;

beforeAll(async () => {
  db = await createTestDb();
  ledger = db.ledger;
});
afterAll(async () => {
  await db.drop();
});

async function expectLedgerError(promise: Promise<unknown>, code: LedgerErrorCode): Promise<LedgerError> {
  try {
    await promise;
  } catch (err) {
    if (isLedgerError(err, code)) return err;
    throw new Error(`expected LedgerError ${code}, got ${String(err)}`, { cause: err });
  }
  throw new Error(`expected LedgerError ${code}, but the call succeeded`);
}

/** A funding source (equity, may go negative) and two wallets that may not. */
async function setup(currency = 'USDC') {
  const source = await ledger.createAccount({ code: uid('equity'), name: 'Owner funding', type: 'equity', currency, allowNegative: true });
  const a = await ledger.createAccount({ code: uid('wallet'), name: 'Wallet A', type: 'asset', currency });
  const b = await ledger.createAccount({ code: uid('wallet'), name: 'Wallet B', type: 'asset', currency });
  return { source: source.code, a: a.code, b: b.code };
}

/** Moves value into an asset account: debit the asset, credit the equity source. */
function fund(source: string, account: string, amount: bigint, key = uid('fund')) {
  return ledger.postTransaction({
    idempotencyKey: key,
    entries: [
      { account, direction: 'debit', amount },
      { account: source, direction: 'credit', amount },
    ],
  });
}

/** Moves value between two asset accounts. */
function transfer(from: string, to: string, amount: bigint, key = uid('xfer')) {
  return ledger.postTransaction({
    idempotencyKey: key,
    entries: [
      { account: to, direction: 'debit', amount },
      { account: from, direction: 'credit', amount },
    ],
  });
}

describe('accounts', () => {
  it('creates an account and returns the same one on a repeated identical call', async () => {
    const code = uid('acct');
    const first = await ledger.createAccount({ code, name: 'Hot wallet', type: 'asset', currency: 'USDC' });
    const second = await ledger.createAccount({ code, name: 'Hot wallet (renamed)', type: 'asset', currency: 'USDC' });
    expect(second.id).toBe(first.id);
    expect((await ledger.getBalance(code)).balance).toBe(0n);
  });

  it('refuses to redefine an existing account', async () => {
    const code = uid('acct');
    await ledger.createAccount({ code, name: 'x', type: 'asset', currency: 'USDC' });
    await expectLedgerError(ledger.createAccount({ code, name: 'x', type: 'liability', currency: 'USDC' }), 'ACCOUNT_CONFLICT');
    await expectLedgerError(ledger.createAccount({ code, name: 'x', type: 'asset', currency: 'EURC' }), 'ACCOUNT_CONFLICT');
  });

  it('validates codes and currencies', async () => {
    await expectLedgerError(ledger.createAccount({ code: 'Bad Code', name: 'x', type: 'asset', currency: 'USDC' }), 'VALIDATION');
    await expectLedgerError(ledger.createAccount({ code: uid('ok'), name: 'x', type: 'asset', currency: 'usdc' }), 'VALIDATION');
  });
});

describe('posting', () => {
  it('posts a balanced transaction and moves balances on each normal side', async () => {
    const { source, a } = await setup();
    const { transaction, replayed } = await fund(source, a, 1_000_000n);
    expect(replayed).toBe(false);
    expect(transaction.entries).toHaveLength(2);

    const wallet = await ledger.getBalance(a);
    expect(wallet).toMatchObject({ debits: 1_000_000n, credits: 0n, balance: 1_000_000n });
    const equity = await ledger.getBalance(source);
    expect(equity).toMatchObject({ debits: 0n, credits: 1_000_000n, balance: 1_000_000n });
  });

  it('rejects malformed transactions before touching the database', async () => {
    const { source, a } = await setup();
    const base = { idempotencyKey: uid('bad') };
    await expectLedgerError(
      ledger.postTransaction({ ...base, entries: [{ account: a, direction: 'debit', amount: 5n }] }),
      'VALIDATION',
    );
    await expectLedgerError(
      ledger.postTransaction({
        ...base,
        entries: [
          { account: a, direction: 'debit', amount: 5n },
          { account: source, direction: 'credit', amount: 4n },
        ],
      }),
      'VALIDATION',
    );
    await expectLedgerError(
      ledger.postTransaction({
        ...base,
        entries: [
          { account: a, direction: 'debit', amount: 0n },
          { account: source, direction: 'credit', amount: 0n },
        ],
      }),
      'VALIDATION',
    );
    await expectLedgerError(
      ledger.postTransaction({
        ...base,
        entries: [
          { account: a, direction: 'debit', amount: 5n },
          { account: 'no-such-account', direction: 'credit', amount: 5n },
        ],
      }),
      'UNKNOWN_ACCOUNT',
    );
  });

  it('balances per currency, not in total', async () => {
    const usdc = await setup('USDC');
    const eurc = await setup('EURC');
    // 5 USDC debit against 5 EURC credit "balances" numerically but not per currency.
    await expectLedgerError(
      ledger.postTransaction({
        idempotencyKey: uid('fx'),
        entries: [
          { account: usdc.a, direction: 'debit', amount: 5n },
          { account: eurc.source, direction: 'credit', amount: 5n },
        ],
      }),
      'VALIDATION',
    );
    // A proper FX trade has two balanced legs.
    await fund(eurc.source, eurc.a, 100n);
    const fx = await ledger.postTransaction({
      idempotencyKey: uid('fx'),
      entries: [
        { account: usdc.a, direction: 'debit', amount: 108n },
        { account: usdc.source, direction: 'credit', amount: 108n },
        { account: eurc.source, direction: 'debit', amount: 100n },
        { account: eurc.a, direction: 'credit', amount: 100n },
      ],
    });
    expect(fx.transaction.entries).toHaveLength(4);
  });

  it('rejects a posting that would overdraw a non-negative account', async () => {
    const { source, a, b } = await setup();
    await fund(source, a, 100n);
    const err = await expectLedgerError(transfer(a, b, 101n), 'INSUFFICIENT_BALANCE');
    expect(err.details).toMatchObject({ account: a, balance: '100', change: '-101' });
    expect((await ledger.getBalance(a)).balance).toBe(100n);
  });
});

describe('idempotency', () => {
  it('returns the original transaction when the same request is repeated', async () => {
    const { source, a } = await setup();
    const key = uid('fund');
    const first = await fund(source, a, 500n, key);
    const second = await fund(source, a, 500n, key);
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect((await ledger.getBalance(a)).balance).toBe(500n);
  });

  it('refuses to reuse a key for a different request', async () => {
    const { source, a } = await setup();
    const key = uid('fund');
    await fund(source, a, 500n, key);
    await expectLedgerError(fund(source, a, 501n, key), 'IDEMPOTENCY_CONFLICT');
  });

  it('replays even when the original could no longer be posted', async () => {
    const { source, a, b } = await setup();
    await fund(source, a, 100n);
    const key = uid('xfer');
    await transfer(a, b, 100n, key);
    // `a` is now empty, but the replay must still return the original result.
    const replay = await transfer(a, b, 100n, key);
    expect(replay.replayed).toBe(true);
  });

  it('applies a request exactly once when 20 copies arrive at the same time', async () => {
    const { source, a } = await setup();
    const key = uid('fund');
    const results = await Promise.all(Array.from({ length: 20 }, () => fund(source, a, 250n, key)));
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await ledger.getBalance(a)).balance).toBe(250n);
  });
});

describe('concurrency', () => {
  it('lets exactly as many withdrawals through as the balance covers', async () => {
    const { source, a, b } = await setup();
    await fund(source, a, 100n);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => transfer(a, b, 10n)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const r of rejected) expect(isLedgerError(r.reason, 'INSUFFICIENT_BALANCE')).toBe(true);
    expect((await ledger.getBalance(a)).balance).toBe(0n);
    expect((await ledger.getBalance(b)).balance).toBe(100n);
  });

  it('does not deadlock when transfers run in opposite directions', async () => {
    const { source, a, b } = await setup();
    await fund(source, a, 1_000n);
    await fund(source, b, 1_000n);
    const jobs = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? transfer(a, b, 1n) : transfer(b, a, 1n)));
    await Promise.all(jobs);
    expect((await ledger.getBalance(a)).balance).toBe(1_000n);
    expect((await ledger.getBalance(b)).balance).toBe(1_000n);
  });
});

describe('reversal', () => {
  it('reverses a transaction exactly once', async () => {
    const { source, a } = await setup();
    const { transaction } = await fund(source, a, 300n);
    const key = uid('rev');
    const rev = await ledger.reverseTransaction(transaction.id, { idempotencyKey: key });
    expect(rev.transaction.reverses).toBe(transaction.id);
    expect((await ledger.getBalance(a)).balance).toBe(0n);
    expect((await ledger.getTransaction(transaction.id)).reversedBy).toBe(rev.transaction.id);

    const replay = await ledger.reverseTransaction(transaction.id, { idempotencyKey: key });
    expect(replay.replayed).toBe(true);
    // The same key with a different effective date is a different request.
    await expectLedgerError(
      ledger.reverseTransaction(transaction.id, { idempotencyKey: key, effectiveAt: new Date('2026-01-01T00:00:00Z') }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectLedgerError(ledger.reverseTransaction(transaction.id, { idempotencyKey: uid('rev') }), 'ALREADY_REVERSED');
    await expectLedgerError(ledger.reverseTransaction(rev.transaction.id, { idempotencyKey: uid('rev') }), 'VALIDATION');
  });

  it('dates a reversal when asked to', async () => {
    const { source, a } = await setup();
    const { transaction } = await fund(source, a, 10n);
    const when = new Date('2026-11-01T02:10:00Z');
    const rev = await ledger.reverseTransaction(transaction.id, { idempotencyKey: uid('rev'), effectiveAt: when });
    expect(rev.transaction.effectiveAt.toISOString()).toBe(when.toISOString());
  });

  it('refuses a reversal that would overdraw, e.g. a deposit already paid out', async () => {
    const { source, a, b } = await setup();
    const deposit = await fund(source, a, 100n);
    await transfer(a, b, 100n);
    await expectLedgerError(ledger.reverseTransaction(deposit.transaction.id, { idempotencyKey: uid('rev') }), 'INSUFFICIENT_BALANCE');
  });

  it('reports unknown transactions as not found', async () => {
    await expectLedgerError(ledger.getTransaction('not-a-uuid'), 'NOT_FOUND');
    await expectLedgerError(ledger.reverseTransaction('00000000-0000-0000-0000-000000000000', { idempotencyKey: uid('rev') }), 'NOT_FOUND');
  });
});

describe('database-level guarantees (code that bypasses the Ledger class)', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on history', async () => {
    const { source, a } = await setup();
    const { transaction } = await fund(source, a, 10n);
    await expect(db.pool.query('UPDATE ledger.entries SET amount = 1 WHERE transaction_id = $1', [transaction.id])).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM ledger.entries WHERE transaction_id = $1', [transaction.id])).rejects.toThrow(/append-only/);
    await expect(db.pool.query('UPDATE ledger.transactions SET description = $2 WHERE id = $1', [transaction.id, 'x'])).rejects.toThrow(/append-only/);
    await expect(db.pool.query('TRUNCATE ledger.entries CASCADE')).rejects.toThrow(/append-only/);
    await expect(db.pool.query(`UPDATE ledger.accounts SET type = 'expense' WHERE code = $1`, [a])).rejects.toThrow(/append-only/);
  });

  it('rejects an unbalanced transaction at COMMIT', async () => {
    const { a } = await setup();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ledger.transactions (idempotency_key, request_hash) VALUES ($1, 'raw') RETURNING id`,
        [uid('raw')],
      );
      const accountId = (await client.query<{ id: string }>('SELECT id FROM ledger.accounts WHERE code = $1', [a])).rows[0]!.id;
      await client.query(
        `INSERT INTO ledger.entries (transaction_id, account_id, currency, direction, amount)
         VALUES ($1, $2, 'USDC', 'debit', 5), ($1, $2, 'USDC', 'credit', 4)`,
        [rows[0]!.id, accountId],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('rejects a transaction with no entries at COMMIT', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ledger.transactions (idempotency_key, request_hash) VALUES ($1, 'raw')`, [uid('raw')]);
      await expect(client.query('COMMIT')).rejects.toThrow(/at least 2/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it("rejects an entry whose currency differs from its account's", async () => {
    const { a } = await setup('USDC');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ledger.transactions (idempotency_key, request_hash) VALUES ($1, 'raw') RETURNING id`,
        [uid('raw')],
      );
      const accountId = (await client.query<{ id: string }>('SELECT id FROM ledger.accounts WHERE code = $1', [a])).rows[0]!.id;
      await expect(
        client.query(
          `INSERT INTO ledger.entries (transaction_id, account_id, currency, direction, amount) VALUES ($1, $2, 'EURC', 'debit', 5)`,
          [rows[0]!.id, accountId],
        ),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('verification', () => {
  it('finds nothing wrong with a ledger written through the Ledger class', async () => {
    expect(await ledger.verify()).toEqual([]);
    for (const row of await ledger.trialBalance()) expect(row.balanced).toBe(true);
  });

  it('detects a tampered balance projection', async () => {
    const tampered = await createTestDb();
    try {
      const l = tampered.ledger;
      await l.createAccount({ code: 'equity', name: 'Equity', type: 'equity', currency: 'USDC', allowNegative: true });
      await l.createAccount({ code: 'hot', name: 'Hot wallet', type: 'asset', currency: 'USDC' });
      await l.postTransaction({
        idempotencyKey: 'k1',
        entries: [
          { account: 'hot', direction: 'debit', amount: 100n },
          { account: 'equity', direction: 'credit', amount: 100n },
        ],
      });
      await tampered.pool.query(
        `UPDATE ledger.balances SET debits = debits + 1000 WHERE account_id = (SELECT id FROM ledger.accounts WHERE code = 'hot')`,
      );
      const problems = await l.verify();
      expect(problems).toEqual([
        { kind: 'balance_mismatch', account: 'hot', stored: { debits: 1100n, credits: 0n }, fromEntries: { debits: 100n, credits: 0n } },
      ]);
      expect((await l.trialBalance())[0]).toMatchObject({ currency: 'USDC', balanced: false });
    } finally {
      await tampered.drop();
    }
  });
});

describe('listing', () => {
  it('pages transactions newest first and filters by account', async () => {
    const { source, a, b } = await setup();
    await fund(source, a, 10n);
    await fund(source, a, 20n);
    await fund(source, b, 30n);
    const forA = await ledger.listTransactions({ account: a });
    expect(forA.map((t) => t.entries.find((e) => e.account === a)!.amount)).toEqual([20n, 10n]);
    const page1 = await ledger.listTransactions({ account: a, limit: 1 });
    const page2 = await ledger.listTransactions({ account: a, limit: 1, beforeSeq: page1[0]!.seq });
    expect(page2[0]!.id).toBe(forA[1]!.id);
  });
});
