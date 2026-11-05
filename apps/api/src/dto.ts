/**
 * Wire format of the HTTP API. Amounts are decimal strings in the currency's
 * smallest unit (never JSON numbers, which lose precision past 2^53); clients
 * format them with the currency's `decimals`.
 */

export interface CurrencyDto {
  code: string;
  decimals: number;
}

export interface AccountDto {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  currency: string;
  allowNegative: boolean;
  debits: string;
  credits: string;
  /** On the account's normal side: debits − credits for assets/expenses, credits − debits otherwise. */
  balance: string;
}

export interface TrialBalanceDto {
  currency: string;
  debits: string;
  credits: string;
  balanced: boolean;
}

export interface EntryDto {
  id: string;
  account: string;
  currency: string;
  direction: 'debit' | 'credit';
  amount: string;
}

export interface TransactionDto {
  id: string;
  seq: string;
  idempotencyKey: string;
  description: string;
  metadata: Record<string, unknown>;
  reverses: string | null;
  reversedBy: string | null;
  effectiveAt: string;
  createdAt: string;
  entries: EntryDto[];
}

export interface TransactionPageDto {
  transactions: TransactionDto[];
  /** Pass as `before` to get the next (older) page; null when there is none. */
  nextCursor: string | null;
}

export type IntegrityProblemDto =
  | { kind: 'unbalanced_transaction'; transactionId: string; currency: string }
  | { kind: 'too_few_entries'; transactionId: string; entries: number }
  | {
      kind: 'balance_mismatch';
      account: string;
      stored: { debits: string; credits: string };
      fromEntries: { debits: string; credits: string };
    }
  | { kind: 'negative_balance'; account: string; balance: string };

export interface VerifyDto {
  ok: boolean;
  problems: IntegrityProblemDto[];
  checkedAt: string;
}

export interface ErrorDto {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
