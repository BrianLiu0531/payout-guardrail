import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../packages/ledger/test/helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/demo.js';
import type { AccountDto, ErrorDto, TransactionDto, TransactionPageDto, TrialBalanceDto, VerifyDto } from '../src/dto.js';

let db: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  await seedDemo(db.ledger);
  await seedDemo(db.ledger); // idempotent: a second run must change nothing
  app = buildApp({ ledger: db.ledger, verifyCacheMs: 0 });
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function get<T>(url: string): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

describe('ledger API', () => {
  it('lists accounts with balances as decimal strings', async () => {
    const { status, body } = await get<{ accounts: AccountDto[] }>('/v1/ledger/accounts');
    expect(status).toBe(200);
    const byCode = new Map(body.accounts.map((a) => [a.code, a]));
    // 250,000 − 20,000 − 10,000 moved to the hot wallet
    expect(byCode.get('asset:base:safe:usdc')?.balance).toBe('220000000000');
    // 30,000 topped up − 4,250 − 9,000 + 9,000 (reorg) − 9,000 (retry)
    expect(byCode.get('asset:base:hot:usdc')?.balance).toBe('16750000000');
    expect(byCode.get('liability:payable:contractors')?.balance).toBe('0');
    expect(byCode.get('expense:network-fees')).toMatchObject({ currency: 'ETH', balance: '21000000000000' });
    for (const a of body.accounts) expect(typeof a.balance).toBe('string');
  });

  it('returns a balanced trial balance per currency', async () => {
    const { body } = await get<{ trialBalance: TrialBalanceDto[] }>('/v1/ledger/trial-balance');
    expect(body.trialBalance.map((r) => r.currency)).toEqual(['ETH', 'USDC']);
    for (const row of body.trialBalance) expect(row).toMatchObject({ balanced: true, debits: row.credits });
  });

  it('pages transactions newest first with a cursor', async () => {
    const first = await get<TransactionPageDto>('/v1/ledger/transactions?limit=4');
    expect(first.status).toBe(200);
    expect(first.body.transactions).toHaveLength(4);
    expect(first.body.nextCursor).toBe(first.body.transactions[3]!.seq);

    const seen = [...first.body.transactions];
    let cursor = first.body.nextCursor;
    while (cursor) {
      const page = await get<TransactionPageDto>(`/v1/ledger/transactions?limit=4&before=${cursor}`);
      seen.push(...page.body.transactions);
      cursor = page.body.nextCursor;
    }
    expect(seen).toHaveLength(11);
    const seqs = seen.map((t) => BigInt(t.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => (a > b ? -1 : 1)));
  });

  it('filters by account and links a reversal to its original', async () => {
    const { body } = await get<TransactionPageDto>('/v1/ledger/transactions?account=liability:payable:contractors');
    expect(body.transactions.map((t) => t.description)).toEqual([
      'Contractor batch payout re-settled',
      'Reverted: block reorganised before finality',
      'Contractor batch payout settled',
      'October contractor payroll accrued (3 contractors)',
    ]);
    const [, reversal, original] = body.transactions as [TransactionDto, TransactionDto, TransactionDto];
    expect(reversal.reverses).toBe(original.id);
    expect(original.reversedBy).toBe(reversal.id);

    const one = await get<TransactionDto>(`/v1/ledger/transactions/${original.id.toUpperCase()}`);
    expect(one.status).toBe(200);
    expect(one.body.entries.map((e) => e.direction)).toEqual(['debit', 'credit']);
  });

  it('answers bad input with 400 and unknown resources with 404, without leaking internals', async () => {
    expect((await get<ErrorDto>('/v1/ledger/transactions?limit=0')).status).toBe(400);
    expect((await get<ErrorDto>('/v1/ledger/transactions?before=abc')).status).toBe(400);
    expect((await get<ErrorDto>('/v1/ledger/transactions?sql=1')).status).toBe(400);
    expect((await get<ErrorDto>('/v1/ledger/transactions/not-a-uuid')).status).toBe(400);

    const unknownTx = await get<ErrorDto>('/v1/ledger/transactions/00000000-0000-0000-0000-000000000000');
    expect(unknownTx).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
    const unknownAccount = await get<ErrorDto>('/v1/ledger/transactions?account=nope');
    expect(unknownAccount).toMatchObject({ status: 404, body: { error: { code: 'UNKNOWN_ACCOUNT' } } });
    expect((await get<ErrorDto>('/v1/nope')).status).toBe(404);
  });

  it('sends no-store and nosniff headers', async () => {
    const { headers } = await get('/v1/ledger/accounts');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('has no write endpoints', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/ledger/transactions', payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

  it('reports integrity, and reports tampering', async () => {
    const clean = await get<VerifyDto>('/v1/ledger/verify');
    expect(clean.body).toMatchObject({ ok: true, problems: [] });

    await db.pool.query(
      `UPDATE ledger.balances SET credits = credits + 1 WHERE account_id = (SELECT id FROM ledger.accounts WHERE code = 'asset:base:hot:usdc')`,
    );
    const dirty = await get<VerifyDto>('/v1/ledger/verify');
    expect(dirty.body.ok).toBe(false);
    expect(dirty.body.problems).toEqual([
      expect.objectContaining({ kind: 'balance_mismatch', account: 'asset:base:hot:usdc' }),
    ]);
  });
});

describe('verify cache', () => {
  it('runs one scan for a burst of requests', async () => {
    let scans = 0;
    const counting = new Proxy(db.ledger, {
      get(target, prop, receiver) {
        if (prop === 'verify') {
          return () => {
            scans += 1;
            return target.verify();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const cachedApp = buildApp({ ledger: counting, verifyCacheMs: 60_000 });
    await Promise.all(Array.from({ length: 10 }, () => cachedApp.inject({ method: 'GET', url: '/v1/ledger/verify' })));
    expect(scans).toBe(1);
    await cachedApp.close();
  });
});
