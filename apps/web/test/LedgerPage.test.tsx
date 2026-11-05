// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDto, TransactionDto, TransactionPageDto, VerifyDto } from '../src/api.js';
import { LedgerPage } from '../src/ledger/LedgerPage.js';

const accounts: AccountDto[] = [
  { code: 'asset:hot', name: 'Hot wallet', type: 'asset', currency: 'USDC', allowNegative: false, debits: '30000000000', credits: '13250000000', balance: '16750000000' },
  { code: 'liability:payable', name: 'Payable to vendors', type: 'liability', currency: 'USDC', allowNegative: false, debits: '4250000000', credits: '4250000000', balance: '0' },
];

const tx = (seq: string, description: string, extra: Partial<TransactionDto> = {}): TransactionDto => ({
  id: `00000000-0000-0000-0000-${seq.padStart(12, '0')}`,
  seq,
  idempotencyKey: `k${seq}`,
  description,
  metadata: {},
  reverses: null,
  reversedBy: null,
  effectiveAt: '2026-11-01T02:00:00.000Z',
  createdAt: '2026-11-01T02:00:00.000Z',
  entries: [
    { id: `${seq}1`, account: 'asset:hot', currency: 'USDC', direction: 'credit', amount: '4250000000' },
    { id: `${seq}2`, account: 'liability:payable', currency: 'USDC', direction: 'debit', amount: '4250000000' },
  ],
  ...extra,
});

let verify: VerifyDto;
const requests: string[] = [];

function respond(url: string): unknown {
  const u = new URL(url, 'http://test');
  requests.push(u.pathname + u.search);
  switch (u.pathname) {
    case '/v1/currencies':
      return { currencies: [{ code: 'USDC', decimals: 6 }] };
    case '/v1/ledger/accounts':
      return { accounts };
    case '/v1/ledger/trial-balance':
      return { trialBalance: [{ currency: 'USDC', debits: '34250000000', credits: '34250000000', balanced: true }] };
    case '/v1/ledger/verify':
      return verify;
    case '/v1/ledger/transactions': {
      const original = tx('2', 'Payout settled', { reversedBy: '00000000-0000-0000-0000-000000000003' });
      const reversal = tx('3', 'Reverted: reorg', { reverses: original.id });
      const page: TransactionPageDto = u.searchParams.get('account')
        ? { transactions: [reversal], nextCursor: null }
        : { transactions: [reversal, original], nextCursor: null };
      return page;
    }
    default:
      throw new Error(`unexpected request ${url}`);
  }
}

beforeEach(() => {
  verify = { ok: true, problems: [], checkedAt: '2026-11-05T10:00:00.000Z' };
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LedgerPage />
    </QueryClientProvider>,
  );
}

describe('LedgerPage', () => {
  it('shows integrity, trial balance, balances and the journal with exact amounts', async () => {
    renderPage();
    expect(await screen.findByText('Consistent')).toBeTruthy();
    expect(await screen.findByText('Balanced')).toBeTruthy();

    const hot = await screen.findByRole('button', { name: /Hot wallet/ });
    const row = hot.closest('tr')!;
    expect(within(row).getByText('16,750.00')).toBeTruthy();

    expect(await screen.findByText('Reversal of #2')).toBeTruthy();
    expect(screen.getByText('Reversed by #3')).toBeTruthy();
  });

  it('filters the journal by the selected account and clears the filter', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Payable to vendors/ }));
    expect(screen.getByRole('button', { name: /Payable to vendors/ }).getAttribute('aria-pressed')).toBe('true');
    await screen.findByText(/Showing/);
    expect(requests).toContain('/v1/ledger/transactions?account=liability%3Apayable&limit=20');

    fireEvent.click(screen.getByRole('button', { name: 'Show all accounts' }));
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('raises an alert listing integrity problems', async () => {
    verify = {
      ok: false,
      checkedAt: '2026-11-05T10:00:00.000Z',
      problems: [
        { kind: 'balance_mismatch', account: 'asset:hot', stored: { debits: '1', credits: '0' }, fromEntries: { debits: '0', credits: '0' } },
      ],
    };
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('1 integrity problem')).toBeTruthy();
    expect(within(alert).getByText(/asset:hot: stored balance/)).toBeTruthy();
  });
});
