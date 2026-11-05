import type {
  AccountDto,
  CurrencyDto,
  ErrorDto,
  TransactionPageDto,
  TrialBalanceDto,
  VerifyDto,
} from '../../api/src/dto.js';

export type {
  AccountDto,
  CurrencyDto,
  EntryDto,
  IntegrityProblemDto,
  TransactionDto,
  TransactionPageDto,
  TrialBalanceDto,
  VerifyDto,
} from '../../api/src/dto.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ErrorDto;
      code = body.error.code;
      message = body.error.message;
    } catch {
      // not JSON — keep the status line
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const api = {
  currencies: (signal?: AbortSignal) => getJson<{ currencies: CurrencyDto[] }>('/v1/currencies', signal),
  accounts: (signal?: AbortSignal) => getJson<{ accounts: AccountDto[] }>('/v1/ledger/accounts', signal),
  trialBalance: (signal?: AbortSignal) => getJson<{ trialBalance: TrialBalanceDto[] }>('/v1/ledger/trial-balance', signal),
  verify: (signal?: AbortSignal) => getJson<VerifyDto>('/v1/ledger/verify', signal),
  transactions: (params: { account?: string; before?: string; limit?: number }, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.account) q.set('account', params.account);
    if (params.before) q.set('before', params.before);
    q.set('limit', String(params.limit ?? 20));
    return getJson<TransactionPageDto>(`/v1/ledger/transactions?${q.toString()}`, signal);
  },
};
