import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payoutApi } from '../api.js';
import { QueryError } from '../ledger/QueryError.js';
import type { Intent, Payee } from '../payoutTypes.js';
import { errorText, useConfig, useMe } from '../session.js';
import { IntentCard } from './IntentCard.js';

export function useDemoApprovers(): { id: string; name: string }[] {
  const me = useMe();
  const users = useQuery({ queryKey: ['users'], queryFn: payoutApi.users, enabled: me.data?.demoMode === true });
  return (users.data?.users ?? []).filter((u) => u.demo && u.role === 'approver').map((u) => ({ id: u.id, name: u.name }));
}

export function IntentList({ kind, empty }: { kind?: string; empty: string }) {
  const intents = useQuery({ queryKey: ['intents', kind ?? 'all'], queryFn: () => payoutApi.intents(kind), refetchInterval: 2000 });
  const payees = useQuery({ queryKey: ['payees'], queryFn: payoutApi.payees, refetchInterval: 5000 });
  const demoApprovers = useDemoApprovers();
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  if (intents.isError) return <QueryError error={intents.error} onRetry={() => intents.refetch()} />;
  if (!intents.data) return <p className="muted">Loading…</p>;
  const open = (i: Intent) => ['pending_approval', 'approved', 'signed', 'broadcast'].includes(i.status);
  const shown = intents.data.intents.filter((i) => filter === 'all' || open(i));

  return (
    <>
      <div className="tabs" role="group" aria-label="Filter">
        <button type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>
          In progress <span className="count">{intents.data.intents.filter(open).length}</span>
        </button>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All <span className="count">{intents.data.intents.length}</span>
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted">{filter === 'open' ? empty : 'Nothing yet.'}</p>
      ) : (
        <ul className="intent-list">
          {shown.map((i) => (
            <IntentCard key={i.id} intent={i} payees={payees.data?.payees ?? []} demoApprovers={demoApprovers} />
          ))}
        </ul>
      )}
    </>
  );
}

function NewPayout({ payees }: { payees: Payee[] }) {
  const qc = useQueryClient();
  const config = useConfig();
  const active = payees.filter((p) => p.status === 'active');
  const [payeeId, setPayeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [expenseAccount, setExpenseAccount] = useState('expense:vendor-services');
  const propose = useMutation({
    mutationFn: payoutApi.proposePayout,
    onSuccess: () => {
      setAmount('');
      setMemo('');
      return qc.invalidateQueries({ queryKey: ['intents'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    propose.mutate({ payeeId: payeeId || active[0]?.id || '', amount, memo, expenseAccount });
  };

  return (
    <form className="card form-card" onSubmit={submit} aria-labelledby="new-payout">
      <h2 id="new-payout">New payout</h2>
      <div className="form-grid">
        <label className="field">
          <span>Pay</span>
          <select className="input" value={payeeId || active[0]?.id || ''} onChange={(e) => setPayeeId(e.target.value)} required>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Amount (USDC)</span>
          <input
            className="input amount-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            pattern="\d{1,12}(\.\d{1,6})?"
            placeholder="2500.00"
            required
          />
        </label>
        <label className="field">
          <span>Expense account</span>
          <select className="input" value={expenseAccount} onChange={(e) => setExpenseAccount(e.target.value)}>
            {(config.data?.expenseAccounts ?? ['expense:vendor-services']).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-wide">
          <span>Memo</span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} placeholder="INV-2207" />
        </label>
      </div>
      <p className="section-note">Up to 1,000 USDC needs one approver, above that two; never the requester. Limit 50,000 per payout and 100,000 per 24 hours.</p>
      <div className="form-actions">
        <button className="button-primary" disabled={propose.isPending || active.length === 0}>
          Request payout
        </button>
      </div>
      {propose.error && <p className="form-error" role="alert">{errorText(propose.error)}</p>}
    </form>
  );
}

export function PayoutsPage() {
  const me = useMe();
  const payees = useQuery({ queryKey: ['payees'], queryFn: payoutApi.payees });
  const user = me.data?.user;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payouts</h1>
          <p className="lede">
            Every payout is an intent. Approvers sign its hash with a passkey, and the signer pays only exactly what was approved, then the
            ledger records it.
          </p>
        </div>
      </div>
      {!user && <p className="notice notice-warn">Sign in (top right) to request or approve payouts.</p>}
      {user && (user.role === 'requester' || user.role === 'admin') && (
        <section className="section">
          <NewPayout payees={payees.data?.payees ?? []} />
        </section>
      )}
      <section className="section" aria-labelledby="intents-h">
        <div className="section-head">
          <h2 id="intents-h">Requests</h2>
        </div>
        <p className="section-note">Payouts and changes to payees, approvers and the circuit breaker all go through the same approval.</p>
        <IntentList empty="Nothing waiting. Request a payout above." />
      </section>
    </>
  );
}
