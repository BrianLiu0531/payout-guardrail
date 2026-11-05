export type LedgerErrorCode =
  | 'VALIDATION'
  | 'UNKNOWN_ACCOUNT'
  | 'ACCOUNT_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSUFFICIENT_BALANCE'
  | 'ALREADY_REVERSED'
  | 'NOT_FOUND';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export function isLedgerError(err: unknown, code?: LedgerErrorCode): err is LedgerError {
  return err instanceof LedgerError && (code === undefined || err.code === code);
}
