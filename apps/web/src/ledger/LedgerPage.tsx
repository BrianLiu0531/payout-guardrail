import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { AccountsTable } from './AccountsTable.js';
import { IntegrityStatus } from './IntegrityStatus.js';
import { Journal } from './Journal.js';
import { QueryError } from './QueryError.js';
import { TrialBalance } from './TrialBalance.js';

export function LedgerPage() {
  const [account, setAccount] = useState<string | null>(null);
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: ({ signal }) => api.accounts(signal) });
  const accountNames = new Map(accounts.data?.accounts.map((a) => [a.code, a.name]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ledger</h1>
          <p className="lede">
            Double-entry books of the payout system. Read-only: money only moves through approved payout intents.
          </p>
        </div>
        <IntegrityStatus />
      </div>

      <TrialBalance />

      <section aria-labelledby="accounts-heading" className="section">
        <h2 id="accounts-heading">Accounts</h2>
        <p className="section-note">Balances on each account's normal side. Select an account to filter the journal.</p>
        {accounts.error && <QueryError error={accounts.error} onRetry={() => void accounts.refetch()} />}
        {accounts.isPending && <p className="muted">Loading…</p>}
        {accounts.data && accounts.data.accounts.length === 0 && (
          <p className="muted">
            No accounts yet. Load the demo data with <code>npm run seed</code>.
          </p>
        )}
        {accounts.data && accounts.data.accounts.length > 0 && (
          <AccountsTable accounts={accounts.data.accounts} selected={account} onSelect={setAccount} />
        )}
      </section>

      <Journal account={account} accountNames={accountNames} onClearFilter={() => setAccount(null)} />
    </>
  );
}
