import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payoutApi } from '../api.js';
import { formatDateTime, formatUnits } from '../format.js';
import { QueryError } from '../ledger/QueryError.js';
import type { Deposit } from '../payoutTypes.js';
import { errorText, useMe } from '../session.js';

const OUTCOME: Record<Deposit['outcome'], { label: string; tone: string }> = {
  credited: { label: 'credited', tone: 'ok' },
  reversed: { label: 'reversed (reorg)', tone: 'warn' },
  outgoing: { label: 'payout seen', tone: 'muted' },
  ignored: { label: 'ignored', tone: 'muted' },
};

const short = (s: string) => `${s.slice(0, 8)}…${s.slice(-6)}`;

function Simulate() {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('250');
  const [sent, setSent] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => payoutApi.simulateDeposit(amount),
    onSuccess: (r) => {
      setSent(r.txHash);
      return qc.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate();
  };
  return (
    <form className="inline-form card" onSubmit={submit}>
      <label className="field">
        <span>Simulate a customer deposit (USDC)</span>
        <input className="input amount-input" value={amount} onChange={(e) => setAmount(e.target.value.trim())} pattern="\d{1,6}(\.\d{1,6})?" required />
      </label>
      <button className="button-primary" disabled={run.isPending}>
        {run.isPending ? 'Sending…' : 'Send on chain'}
      </button>
      {sent && <p className="section-note">Sent {short(sent)}. It appears below once the indexer confirms it, usually within a few seconds.</p>}
      {run.error && <p className="form-error" role="alert">{errorText(run.error)}</p>}
    </form>
  );
}

export function DepositsPage() {
  const me = useMe();
  const deposits = useQuery({ queryKey: ['deposits'], queryFn: payoutApi.deposits, refetchInterval: 2000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Deposits</h1>
          <p className="lede">
            Money coming in. <a href="https://github.com/BrianLiu0531/base-usdc-indexer">base-usdc-indexer</a> watches the custody address,
            survives reorgs, and posts each confirmed transfer here over a signed webhook. Each deposit is credited to the ledger exactly once,
            and reversed if its block is reorganised away. Reconciliation flags any deposit on chain that the indexer never reported.
          </p>
        </div>
      </div>
      {me.data?.demoMode && me.data.user && (
        <section className="section">
          <Simulate />
        </section>
      )}
      <section className="section">
        {deposits.isError ? (
          <QueryError error={deposits.error} onRetry={() => deposits.refetch()} />
        ) : (deposits.data?.deposits ?? []).length === 0 ? (
          <p className="muted">No events from the indexer yet. Start it with <code>npm run dev:indexer</code>.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Received</th>
                  <th scope="col">Event</th>
                  <th scope="col" className="wide-only">
                    Counterparty
                  </th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {deposits.data?.deposits.map((d) => (
                  <tr key={d.eventId}>
                    <td>{formatDateTime(d.receivedAt)}</td>
                    <td>
                      <code title={d.txHash}>{short(d.txHash)}</code> <span className="muted">block {d.blockNumber}</span>
                    </td>
                    <td className="wide-only">
                      <code title={d.outcome === 'outgoing' ? d.to : d.from}>{short(d.outcome === 'outgoing' ? d.to : d.from)}</code>
                    </td>
                    <td className="num amount">{formatUnits(d.value, 6)}</td>
                    <td>
                      <span className={`badge badge-${OUTCOME[d.outcome].tone}`}>{OUTCOME[d.outcome].label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
