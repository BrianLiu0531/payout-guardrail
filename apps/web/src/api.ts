import type {
  AccountDto,
  CurrencyDto,
  ErrorDto,
  TransactionPageDto,
  TrialBalanceDto,
  VerifyDto,
} from '../../api/src/dto.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { Attack, AttackResult, AuditEntry, Config, Deposit, Intent, Me, Payee, ReconReport, Security, User, UserSummary } from './payoutTypes.js';

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

async function send<T>(method: 'POST', path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (ErrorDto & { error: { details?: Record<string, unknown> } }) | null;
  if (!res.ok) {
    const err = new ApiError(res.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? `${res.status} ${res.statusText}`);
    (err as ApiError & { details?: unknown }).details = json?.error?.details;
    throw err;
  }
  return json as T;
}

export const payoutApi = {
  me: () => getJson<Me>('/v1/auth/me'),
  users: () => getJson<{ users: UserSummary[] }>('/v1/auth/users'),
  demoLogin: (userId: string) => send<{ user: User }>('POST', '/v1/auth/demo-login', { userId }),
  logout: () => send<{ ok: true }>('POST', '/v1/auth/logout'),
  registerOptions: (name: string, userId: string) =>
    send<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('POST', '/v1/auth/register/options', { name, userId }),
  registerVerify: (challengeId: string, response: RegistrationResponseJSON) =>
    send<{ user: User; enrollmentIntent: string }>('POST', '/v1/auth/register/verify', { challengeId, response }),
  loginOptions: () => send<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('POST', '/v1/auth/login/options'),
  loginVerify: (challengeId: string, response: AuthenticationResponseJSON) =>
    send<{ user: User }>('POST', '/v1/auth/login/verify', { challengeId, response }),

  config: () => getJson<Config>('/v1/config'),
  payees: () => getJson<{ payees: Payee[] }>('/v1/payees'),
  addPayee: (name: string, address: string) => send<Intent>('POST', '/v1/payees', { name, address }),
  intents: (kind?: string) => getJson<{ intents: Intent[] }>(`/v1/intents?limit=100${kind ? `&kind=${kind}` : ''}`),
  proposePayout: (body: { payeeId: string; amount: string; memo: string; expenseAccount: string }) =>
    send<Intent>('POST', '/v1/intents/payout', body),
  proposeBreakerReset: (reason: string) => send<Intent>('POST', '/v1/intents/breaker-reset', { reason }),
  approvalOptions: (id: string) => send<{ options: PublicKeyCredentialRequestOptionsJSON }>('POST', `/v1/intents/${id}/approval-options`),
  approve: (id: string, response: AuthenticationResponseJSON) => send<Intent>('POST', `/v1/intents/${id}/approve`, { response }),
  demoApprove: (intentId: string, userId: string) => send<Intent>('POST', '/v1/demo/approve', { intentId, userId }),
  cancel: (id: string) => send<Intent>('POST', `/v1/intents/${id}/cancel`),

  security: () => getJson<Security>('/v1/security'),
  reconcile: () => send<ReconReport>('POST', '/v1/reconcile'),
  audit: () => getJson<{ entries: AuditEntry[] }>('/v1/audit?limit=50'),
  attacks: () => getJson<{ attacks: Attack[] }>('/v1/demo/attacks'),
  deposits: () => getJson<{ deposits: Deposit[] }>('/v1/deposits'),
  simulateDeposit: (amount: string) => send<{ from: string; txHash: string; amount: string }>('POST', '/v1/demo/deposit', { amount }),
  runAttack: (id: string) => send<AttackResult>('POST', `/v1/demo/attacks/${id}/run`),
};

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
