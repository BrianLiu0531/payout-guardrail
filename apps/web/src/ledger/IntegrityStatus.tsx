import { useQuery } from '@tanstack/react-query';
import { api, type IntegrityProblemDto } from '../api.js';
import { formatDateTime } from '../format.js';

function describe(p: IntegrityProblemDto): string {
  switch (p.kind) {
    case 'balance_mismatch':
      return `${p.account}: stored balance (Dr ${p.stored.debits} / Cr ${p.stored.credits}) differs from its entries (Dr ${p.fromEntries.debits} / Cr ${p.fromEntries.credits})`;
    case 'negative_balance':
      return `${p.account} is negative (${p.balance}) but is not allowed to be`;
    case 'unbalanced_transaction':
      return `Transaction ${p.transactionId} does not balance in ${p.currency}`;
    case 'too_few_entries':
      return `Transaction ${p.transactionId} has ${p.entries} entr${p.entries === 1 ? 'y' : 'ies'}`;
  }
}

/** Runs the server-side integrity check (balances recomputed from every entry). */
export function IntegrityStatus() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['verify'],
    queryFn: ({ signal }) => api.verify(signal),
    refetchInterval: 60_000,
  });

  const recheck = (
    <button type="button" className="button-secondary" onClick={() => void refetch()} disabled={isFetching}>
      {isFetching ? 'Checking…' : 'Re-check'}
    </button>
  );

  if (error) {
    return (
      <div className="integrity integrity-unknown" role="status">
        <span className="dot" aria-hidden="true" />
        <span>Integrity check unavailable</span>
        {recheck}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="integrity integrity-unknown" role="status">
        <span className="dot" aria-hidden="true" />
        <span>Checking integrity…</span>
      </div>
    );
  }
  if (data.ok) {
    return (
      <div className="integrity integrity-ok" role="status">
        <span className="dot" aria-hidden="true" />
        <span>
          <strong>Consistent</strong>
          <span className="muted"> · balances match every entry · checked {formatDateTime(data.checkedAt)}</span>
        </span>
        {recheck}
      </div>
    );
  }
  return (
    <div className="integrity integrity-bad" role="alert">
      <div className="integrity-head">
        <span className="dot" aria-hidden="true" />
        <strong>
          {data.problems.length} integrity problem{data.problems.length === 1 ? '' : 's'}
        </strong>
        <span className="muted"> · checked {formatDateTime(data.checkedAt)}</span>
        {recheck}
      </div>
      <ul>
        {data.problems.map((p, i) => (
          <li key={i}>{describe(p)}</li>
        ))}
      </ul>
    </div>
  );
}
