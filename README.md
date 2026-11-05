# Payout Guardrail

A self-hostable control plane for **stablecoin payouts**: every outgoing payment is an *intent* that passes a policy, is approved by people signing the intent's hash with passkeys, is executed only if what is signed matches what was approved, and is then reconciled across the intent, the signer's log, the chain and a double-entry ledger.

It is the outbound half of an on-chain money system whose inbound half already exists:
[base-usdc-indexer](https://github.com/BrianLiu0531/base-usdc-indexer) (deposit detection, reorgs, finality) and
[usdc-deposit-ledger](https://github.com/BrianLiu0531/usdc-deposit-ledger) (exactly-once crediting).

> **Testnet only.** This is a reference implementation and portfolio project. It reduces the damage a compromised component can do; it does not make a treasury "hack-proof".

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Postgres double-entry ledger, property-based tests, read-only API, ledger UI | **Done** |
| 2 | Intent API, policy engine (Cedar), passkey approvals, Temporal workflow, KMS signing | planned |
| 3 | Intent ↔ signature binding, four-way reconciliation, circuit breaker, audit log anchoring, attack demo | planned |
| 4 | Sanctions screening adapters, agent budgets | optional |

## Running it

```bash
npm install
npm run db:up        # PostgreSQL 16 on localhost:5434
npm run seed         # demo treasury: vendor and contractor payouts, a reorg reversal, ETH gas
npm run dev:api      # http://127.0.0.1:8787
npm run dev:web      # http://localhost:5173 — open this
```

The seed is idempotent: running it again changes nothing.

## Layout

```
packages/ledger   double-entry ledger library (PostgreSQL)
apps/api          read-only HTTP API (Fastify)
apps/web          ledger UI (React, TanStack Query, Vite)
```

## Ledger UI (`apps/web`)

- **Integrity status:** the server recomputes every balance from the entries; any drift is listed in an alert.
- **Trial balance:** debits and credits per currency, flagged if they ever differ.
- **Accounts:** grouped by type, balances on each account's normal side. Selecting an account filters the journal.
- **Journal:** newest first, keyset-paginated, debits then indented credits. A reversal and the transaction it reverses link to each other, and the reversed one is struck through.
- **Amounts are exact:** formatted from integer strings, never through floating point (tested beyond 2^53).
- Works from 320 px wide (on phones the journal merges debit and credit into one Dr/Cr column), in light and dark mode, and with the keyboard.
- **Content-Security-Policy** in the production build: scripts, styles and requests from `'self'` only, no inline scripts or style attributes. The built app was checked in headless Chrome with no CSP violations. `frame-ancestors` cannot be set in a `<meta>` policy, so whoever hosts the app must send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` as headers.

## API (`apps/api`)

| Endpoint | Returns |
|---|---|
| `GET /v1/ledger/accounts` | Accounts with debits, credits and balance |
| `GET /v1/ledger/trial-balance` | Totals per currency and whether they balance |
| `GET /v1/ledger/transactions?account=&limit=&before=` | Newest first, with `nextCursor` for the next page |
| `GET /v1/ledger/transactions/:id` | One transaction with its entries |
| `GET /v1/ledger/verify` | `{ ok, problems, checkedAt }` |
| `GET /v1/currencies` | Display decimals per currency |

- **Read-only by design.** There is no endpoint that posts to the ledger: in this system, money only moves through approved payout intents (phase 2). A test asserts that `POST`, `PUT`, `PATCH` and `DELETE` all return 404.
- Amounts are decimal strings, never JSON numbers.
- Unknown query parameters are rejected with 400. Fastify's default is to silently drop them; that default is turned off.
- Errors have a stable shape `{ error: { code, message } }` and never include SQL or stack traces.
- `verify` scans every entry, so concurrent calls share one scan and the result is reused for 5 seconds.
- The API binds to `127.0.0.1` and has no authentication yet. Authentication arrives with the approval flow in phase 2.

## Ledger (`packages/ledger`)

### Model

- **Accounts** have a type (`asset`, `liability`, `equity`, `revenue`, `expense`), a currency, and a flag saying whether their balance may go negative. Amounts are integers in the currency's smallest unit (USDC: 6 decimals) and are `bigint` end to end, never floats.
- **Transactions** hold two or more **entries** (debit or credit). Debits must equal credits **per currency**, so an FX trade needs two balanced legs.
- **Reversals** post the mirror image of a transaction. History is never edited.

### Guarantees and where they are enforced

| Guarantee | Enforced by |
|---|---|
| Every transaction balances per currency and has ≥ 2 entries | Validation in TypeScript **and** deferred constraint triggers checked at `COMMIT`, so a raw SQL insert can't break it either |
| An entry's currency is its account's currency | Composite foreign key `(account_id, currency)` |
| History is append-only | Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on transactions and entries; accounts can be renamed but not re-typed or deleted |
| A request is applied at most once | `UNIQUE (idempotency_key)` plus a SHA-256 of the canonical request: the same key with the same request returns the original result (`replayed: true`); with a different request it fails with `IDEMPOTENCY_CONFLICT` |
| A transaction is reversed at most once | `UNIQUE (reverses)` |
| Non-negative accounts never go negative, even under concurrency | Balance rows are locked `FOR UPDATE` before the check, in ascending account id order |
| No deadlocks between postings | That same global lock order |
| The balance projection matches the entries | `verify()` recomputes it from the entries in one `REPEATABLE READ` snapshot |

### Why the balance check locks first

A read-then-write check ("is the balance ≥ 10? then debit 10") lets two concurrent withdrawals both pass. Here, the posting locks the balance rows it will change, checks against the locked values, and writes entries and balances in the same transaction. The test suite fires 20 simultaneous withdrawals of 10 against a balance of 100 and requires exactly 10 to succeed.

Locks are always taken in ascending account id order, so an A→B transfer and a B→A transfer can't each hold the lock the other needs.

**Trade-off:** postings that touch the same account are serialised on that account's balance row. For a single hot wallet at high volume, the remedies are sub-accounts or a dedicated engine such as TigerBeetle. That is a deliberate later step, not a hidden limit.

### API

```ts
import pg from 'pg';
import { Ledger, migrate } from '@guardrail/ledger';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool);
const ledger = new Ledger(pool);

await ledger.createAccount({ code: 'wallet:hot:base:usdc', name: 'Hot wallet', type: 'asset', currency: 'USDC' });
await ledger.createAccount({ code: 'payable:payouts', name: 'Payouts owed', type: 'liability', currency: 'USDC' });

await ledger.postTransaction({
  idempotencyKey: 'payout-123:settled',
  description: 'Payout 123 settled on-chain',
  entries: [
    { account: 'payable:payouts', direction: 'debit', amount: 250_000000n },
    { account: 'wallet:hot:base:usdc', direction: 'credit', amount: 250_000000n },
  ],
});

await ledger.verify();        // [] when consistent
await ledger.trialBalance();  // debits = credits per currency
```

Errors are `LedgerError` with a `code`: `VALIDATION`, `UNKNOWN_ACCOUNT`, `ACCOUNT_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_BALANCE`, `ALREADY_REVERSED`, `NOT_FOUND`.

### Tests

```bash
npm run db:up     # PostgreSQL 16 on localhost:5434
npm test          # ledger, API and UI tests; each database test file gets a fresh database
npm run typecheck
```

- **Behaviour:** balancing per currency, validation, idempotent replay (including a replay after the balance has been spent), `IDEMPOTENCY_CONFLICT`, overdraft rejection, single reversal, reversal of a reversal refused.
- **Concurrency:** 20 copies of one request applied once; 20 withdrawals against a balance covering 10; 30 transfers in opposite directions without deadlock.
- **Database-level guarantees** (raw SQL, bypassing the `Ledger` class): `UPDATE`/`DELETE`/`TRUNCATE` rejected, an unbalanced or entry-less transaction rejected at `COMMIT`, a currency mismatch rejected by the foreign key.
- **Tamper detection:** a hand-edited balance row is reported by `verify()` and unbalances the trial balance.
- **Model-based property test (fast-check):** random funds, transfers, simultaneous withdrawal bursts, replays and reversals run in concurrent batches. After each run, stored balances must equal the sum of every transaction the ledger reported as committed, no non-negative account may be below zero, and no transaction may be reversed twice. Failures shrink to a minimal sequence. Runs default to 150 (`PROPERTY_RUNS=1000 npm test` for a longer soak).

**The tests were checked against deliberately broken code:**

| Mutation | Caught by |
|---|---|
| Remove `FOR UPDATE` from the balance check | The 20-withdrawal test (all 20 succeed), `verify()` (negative balance), and the property test (8 of 8 runs, each shrunk to a short counterexample) |
| Lock rows one at a time in entry order instead of id order | The opposite-direction test (`deadlock detected`) |

### Operating notes

- Run the application as a database role that has only `SELECT` and `INSERT` on `ledger.transactions` and `ledger.entries` and `UPDATE` on `ledger.balances`. The append-only triggers stop mistakes; table ownership must stay with a separate migration role so the triggers themselves can't be dropped by the application.
- `verify()` scans all entries. Schedule it (for example nightly) and alert on any result.

## Supply chain

- `.npmrc` sets `ignore-scripts=true`; CI installs with `npm ci --ignore-scripts`.
- GitHub Actions are pinned to full commit SHAs, and checkout does not persist credentials.
- CI fails on any `npm audit` finding of moderate severity or above.
- Dependencies are pinned to exact releases that have been public for at least two weeks, not the newest (for example vitest 5.0.5 rather than the 3-day-old 5.1.0, and vite 8.3.5 rather than 8.3.6, published the same day).
