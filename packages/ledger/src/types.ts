export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type Direction = 'debit' | 'credit';

/** Assets and expenses grow with debits; the other types grow with credits. */
export function normalSide(type: AccountType): Direction {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

export interface CreateAccountInput {
  /** Stable machine name, e.g. `wallet:hot:base:usdc`. */
  code: string;
  name: string;
  type: AccountType;
  /** Upper-case unit, e.g. `USDC`. Amounts are integers in the unit's smallest denomination. */
  currency: string;
  /** Allow the balance to go below zero on the account's normal side. Defaults to false. */
  allowNegative?: boolean;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allowNegative: boolean;
  createdAt: Date;
}

export interface EntryInput {
  /** Account code. */
  account: string;
  direction: Direction;
  /** Positive integer in the currency's smallest unit (USDC: 6 decimals). */
  amount: bigint;
}

export interface PostTransactionInput {
  /** Same key + same request = the original result is returned; same key + different request = error. */
  idempotencyKey: string;
  entries: EntryInput[];
  description?: string;
  metadata?: Record<string, unknown>;
  effectiveAt?: Date;
}

export interface ReverseTransactionInput {
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /** When the reversal takes effect, e.g. the time a reorg was detected. Defaults to now. */
  effectiveAt?: Date;
}

export interface Entry {
  id: string;
  account: string;
  currency: string;
  direction: Direction;
  amount: bigint;
}

export interface Transaction {
  id: string;
  seq: string;
  idempotencyKey: string;
  description: string;
  metadata: Record<string, unknown>;
  /** Id of the transaction this one reverses, if any. */
  reverses: string | null;
  /** Id of the transaction that reversed this one, if any. */
  reversedBy: string | null;
  effectiveAt: Date;
  createdAt: Date;
  entries: Entry[];
}

export interface PostResult {
  transaction: Transaction;
  /** True when the idempotency key had already been used with this exact request. */
  replayed: boolean;
}

export interface Balance {
  account: string;
  type: AccountType;
  currency: string;
  debits: bigint;
  credits: bigint;
  /** Balance on the account's normal side (debits − credits for assets/expenses, credits − debits otherwise). */
  balance: bigint;
}

export interface TrialBalanceRow {
  currency: string;
  debits: bigint;
  credits: bigint;
  balanced: boolean;
}

export type IntegrityProblem =
  | { kind: 'unbalanced_transaction'; transactionId: string; currency: string }
  | { kind: 'too_few_entries'; transactionId: string; entries: number }
  | { kind: 'balance_mismatch'; account: string; stored: { debits: bigint; credits: bigint }; fromEntries: { debits: bigint; credits: bigint } }
  | { kind: 'negative_balance'; account: string; balance: bigint };
