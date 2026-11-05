import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { Amount } from './Amount.js';
import { QueryError } from './QueryError.js';

export function TrialBalance() {
  const { data, error, refetch } = useQuery({
    queryKey: ['trial-balance'],
    queryFn: ({ signal }) => api.trialBalance(signal),
  });

  return (
    <section aria-labelledby="trial-heading" className="section">
      <h2 id="trial-heading">Trial balance</h2>
      <p className="section-note">Total debits must equal total credits in every currency.</p>
      {error && <QueryError error={error} onRetry={() => void refetch()} />}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.trialBalance.length === 0 && <p className="muted">No accounts yet.</p>}
      {data && data.trialBalance.length > 0 && (
        <div className="cards">
          {data.trialBalance.map((row) => (
            <article key={row.currency} className={row.balanced ? 'card' : 'card card-bad'}>
              <header className="card-head">
                <h3>{row.currency}</h3>
                <span className={row.balanced ? 'badge badge-ok' : 'badge badge-bad'}>
                  {row.balanced ? 'Balanced' : 'Out of balance'}
                </span>
              </header>
              <dl className="card-figures">
                <div>
                  <dt>Debits</dt>
                  <dd>
                    <Amount raw={row.debits} currency={row.currency} showCurrency={false} />
                  </dd>
                </div>
                <div>
                  <dt>Credits</dt>
                  <dd>
                    <Amount raw={row.credits} currency={row.currency} showCurrency={false} />
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
