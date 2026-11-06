import type { CreateAccountInput, Ledger } from '@guardrail/ledger';

/**
 * Demo chart of accounts and history for a company treasury that pays vendors and
 * contractors in USDC on Base. Every call uses a fixed idempotency key, so running
 * it again changes nothing.
 */

const USDC = 1_000_000n; // 6 decimals
const ETH = 10n ** 18n;

export const DEMO_ACCOUNTS: CreateAccountInput[] = [
  { code: 'equity:owner-capital:usdc', name: 'Owner capital', type: 'equity', currency: 'USDC' },
  { code: 'equity:owner-capital:eth', name: 'Owner capital (gas)', type: 'equity', currency: 'ETH' },
  { code: 'asset:base:safe:usdc', name: 'Treasury Safe (cold)', type: 'asset', currency: 'USDC' },
  { code: 'asset:base:hot:usdc', name: 'Payout float (vault)', type: 'asset', currency: 'USDC' },
  { code: 'asset:base:hot:eth', name: 'Hot wallet gas', type: 'asset', currency: 'ETH' },
  { code: 'liability:payable:vendors', name: 'Payable to vendors', type: 'liability', currency: 'USDC' },
  { code: 'liability:payable:contractors', name: 'Payable to contractors', type: 'liability', currency: 'USDC' },
  { code: 'liability:customer-deposits', name: 'Customer deposits', type: 'liability', currency: 'USDC' },
  { code: 'expense:vendor-services', name: 'Vendor services', type: 'expense', currency: 'USDC' },
  { code: 'expense:contractor-payroll', name: 'Contractor payroll', type: 'expense', currency: 'USDC' },
  { code: 'expense:network-fees', name: 'Network fees', type: 'expense', currency: 'ETH' },
];

const at = (iso: string) => new Date(iso);

export async function seedDemo(ledger: Ledger): Promise<void> {
  for (const account of DEMO_ACCOUNTS) await ledger.createAccount(account);

  const post = (
    idempotencyKey: string,
    effectiveAt: string,
    description: string,
    debit: string,
    credit: string,
    amount: bigint,
    metadata: Record<string, unknown> = {},
  ) =>
    ledger.postTransaction({
      idempotencyKey,
      effectiveAt: at(effectiveAt),
      description,
      metadata,
      entries: [
        { account: debit, direction: 'debit', amount },
        { account: credit, direction: 'credit', amount },
      ],
    });

  await post('demo:capital:usdc', '2026-10-20T01:00:00Z', 'Owner capital deposited to treasury Safe',
    'asset:base:safe:usdc', 'equity:owner-capital:usdc', 250_000n * USDC);
  await post('demo:capital:eth', '2026-10-20T01:05:00Z', 'Gas float funded',
    'asset:base:hot:eth', 'equity:owner-capital:eth', ETH / 2n);
  await post('demo:topup:1', '2026-10-21T02:00:00Z', 'Payout vault top-up from Safe (2-of-3)',
    'asset:base:hot:usdc', 'asset:base:safe:usdc', 20_000n * USDC, { approvals: 2 });

  await post('demo:invoice:acme', '2026-10-22T03:15:00Z', 'Invoice INV-1042 — Acme Hosting',
    'expense:vendor-services', 'liability:payable:vendors', 4_250n * USDC, { invoice: 'INV-1042', vendor: 'Acme Hosting' });
  await post('demo:payout:acme', '2026-10-23T05:40:00Z', 'Payout to Acme Hosting settled',
    'liability:payable:vendors', 'asset:base:hot:usdc', 4_250n * USDC, { payoutIntent: 'pi_demo_001', network: 'base-sepolia' });
  await post('demo:gas:acme', '2026-10-23T05:40:00Z', 'Network fee for payout pi_demo_001',
    'expense:network-fees', 'asset:base:hot:eth', 21_000_000_000_000n, { payoutIntent: 'pi_demo_001' });

  await post('demo:payroll:october', '2026-10-31T09:00:00Z', 'October contractor payroll accrued (3 contractors)',
    'expense:contractor-payroll', 'liability:payable:contractors', 9_000n * USDC, { contractors: 3 });
  const batch = await post('demo:payout:payroll-october', '2026-11-01T02:00:00Z', 'Contractor batch payout settled',
    'liability:payable:contractors', 'asset:base:hot:usdc', 9_000n * USDC, { payoutIntent: 'pi_demo_002', recipients: 3 });
  await ledger.reverseTransaction(batch.transaction.id, {
    idempotencyKey: 'demo:payout:payroll-october:reorg',
    description: 'Reverted: block reorganised before finality',
    metadata: { reason: 'reorg', payoutIntent: 'pi_demo_002' },
    effectiveAt: at('2026-11-01T02:10:00Z'),
  });
  await post('demo:payout:payroll-october:retry', '2026-11-01T02:20:00Z', 'Contractor batch payout re-settled',
    'liability:payable:contractors', 'asset:base:hot:usdc', 9_000n * USDC, { payoutIntent: 'pi_demo_002', recipients: 3, attempt: 2 });

  await post('demo:topup:2', '2026-11-03T02:00:00Z', 'Payout vault top-up from Safe (2-of-3)',
    'asset:base:hot:usdc', 'asset:base:safe:usdc', 10_000n * USDC, { approvals: 2 });
}
