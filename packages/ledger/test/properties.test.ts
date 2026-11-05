import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLedgerError } from '../src/errors.js';
import type { Transaction } from '../src/types.js';
import { createTestDb, uid, type TestDb } from './helpers.js';

/**
 * Model-based test: random operations run in concurrent batches against the real
 * database. Whatever interleaving Postgres chooses, the stored balances must equal
 * the sum of the transactions the ledger reported as committed, verify() must find
 * nothing, and no non-negative account may go below zero.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const WALLETS = 3;

type Op =
  | { kind: 'fund'; to: number; amount: bigint }
  | { kind: 'transfer'; from: number; to: number; amount: bigint }
  /** Several withdrawals from one wallet fired at the same instant: the overdraft race. */
  | { kind: 'burst'; from: number; to: number; amount: bigint; copies: number }
  | { kind: 'replay'; of: number }
  | { kind: 'reverse'; of: number; keyVariant: number };

const wallet = fc.integer({ min: 0, max: WALLETS - 1 });
const amount = fc.bigInt({ min: 1n, max: 1_000n });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('fund' as const), to: wallet, amount }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('transfer' as const), from: wallet, to: wallet, amount }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('burst' as const),
      from: wallet,
      to: wallet,
      amount,
      copies: fc.integer({ min: 2, max: 8 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('replay' as const), of: fc.nat(40) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('reverse' as const), of: fc.nat(40), keyVariant: fc.nat(1) }) },
);

interface Sent {
  key: string;
  run: () => Promise<{ transaction: Transaction; replayed: boolean }>;
  committed?: Transaction;
}

describe('ledger model', () => {
  it('matches an in-memory model under random concurrent operations', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 8 }), async (ops, batch) => {
        const l = db.ledger;
        const run = uid('run');
        const equity = `${run}-equity`;
        const wallets = Array.from({ length: WALLETS }, (_, i) => `${run}-w${i}`);
        await l.createAccount({ code: equity, name: 'Equity', type: 'equity', currency: 'USDC', allowNegative: true });
        for (const w of wallets) await l.createAccount({ code: w, name: w, type: 'asset', currency: 'USDC' });

        const sent: Sent[] = [];
        const committed = new Map<string, Transaction>();

        const post = (key: string, debit: string, credit: string, amt: bigint): Sent => ({
          key,
          run: () =>
            l.postTransaction({
              idempotencyKey: key,
              entries: [
                { account: debit, direction: 'debit', amount: amt },
                { account: credit, direction: 'credit', amount: amt },
              ],
            }),
        });

        // Builds the calls for op i. Replays and reversals refer to earlier ops, so they
        // only see results from earlier batches — everything in a batch runs concurrently.
        const build = (op: Op, i: number): Sent[] => {
          switch (op.kind) {
            case 'fund':
              return [post(`${run}-op${i}`, wallets[op.to]!, equity, op.amount)];
            case 'transfer':
              return [post(`${run}-op${i}`, wallets[op.to]!, wallets[op.from]!, op.amount)];
            case 'burst':
              return Array.from({ length: op.copies }, (_, c) =>
                post(`${run}-op${i}-c${c}`, wallets[op.to]!, wallets[op.from]!, op.amount),
              );
            case 'replay': {
              const target = sent[op.of];
              return target ? [{ key: target.key, run: target.run }] : [];
            }
            case 'reverse': {
              const original = sent[op.of]?.committed;
              if (!original || original.reverses !== null) return [];
              const key = `${run}-rev-${original.id}-${op.keyVariant}`;
              return [{ key, run: () => l.reverseTransaction(original.id, { idempotencyKey: key }) }];
            }
          }
        };

        for (let start = 0; start < ops.length; start += batch) {
          const groups = ops.slice(start, start + batch).map((op, j) => build(op, start + j));
          const calls = groups.flat();
          const results = await Promise.allSettled(calls.map((c) => c.run()));
          groups.forEach((group, j) => {
            if (group[0]) sent[start + j] = group[0];
          });
          results.forEach((res, j) => {
            const call = calls[j]!;
            if (res.status === 'fulfilled') {
              call.committed = res.value.transaction;
              const previous = committed.get(res.value.transaction.id);
              // A replay must return exactly what was committed the first time.
              if (previous) expect(res.value.transaction.entries).toEqual(previous.entries);
              committed.set(res.value.transaction.id, res.value.transaction);
            } else {
              // The only acceptable failures are business-rule rejections.
              const ok =
                isLedgerError(res.reason, 'INSUFFICIENT_BALANCE') ||
                isLedgerError(res.reason, 'ALREADY_REVERSED');
              if (!ok) throw res.reason;
            }
          });
        }

        // Model: sum of every committed transaction's entries.
        const model = new Map<string, { debits: bigint; credits: bigint }>();
        for (const tx of committed.values()) {
          for (const e of tx.entries) {
            const m = model.get(e.account) ?? { debits: 0n, credits: 0n };
            if (e.direction === 'debit') m.debits += e.amount;
            else m.credits += e.amount;
            model.set(e.account, m);
          }
        }
        for (const code of [equity, ...wallets]) {
          const stored = await l.getBalance(code);
          const expected = model.get(code) ?? { debits: 0n, credits: 0n };
          expect({ account: code, debits: stored.debits, credits: stored.credits }).toEqual({ account: code, ...expected });
          if (code !== equity) expect(stored.balance).toBeGreaterThanOrEqual(0n);
        }
        // Each transaction reversed at most once.
        const reversed = [...committed.values()].map((t) => t.reverses).filter((r): r is string => r !== null);
        expect(new Set(reversed).size).toBe(reversed.length);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 150) },
    );

    expect(await db.ledger.verify()).toEqual([]);
  });
});
