import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type TransactionDto } from '../api.js';
import { formatDateTime } from '../format.js';
import { Amount } from './Amount.js';
import { QueryError } from './QueryError.js';

const PAGE_SIZE = 20;

interface Props {
  account: string | null;
  accountNames: Map<string, string>;
  onClearFilter: () => void;
}

export function Journal({ account, accountNames, onClearFilter }: Props) {
  const query = useInfiniteQuery({
    queryKey: ['transactions', account],
    queryFn: ({ pageParam, signal }) =>
      api.transactions({ account: account ?? undefined, before: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const transactions = query.data?.pages.flatMap((p) => p.transactions) ?? [];
  const seqById = new Map(transactions.map((t) => [t.id, t.seq]));

  return (
    <section aria-labelledby="journal-heading" className="section">
      <div className="section-head">
        <h2 id="journal-heading">Journal</h2>
        {account && (
          <span className="filter-chip">
            <span>
              Showing <strong>{accountNames.get(account) ?? account}</strong>
            </span>
            <button type="button" className="chip-clear" onClick={onClearFilter} aria-label="Show all accounts">
              ×
            </button>
          </span>
        )}
      </div>
      <p className="section-note">Newest first. History is append-only: corrections are posted as reversals.</p>

      {query.error && <QueryError error={query.error} onRetry={() => void query.refetch()} />}
      {query.isPending && <p className="muted">Loading…</p>}
      {!query.isPending && !query.error && transactions.length === 0 && <p className="muted">No transactions.</p>}

      <ol className="journal">
        {transactions.map((t) => (
          <JournalEntry key={t.id} tx={t} accountNames={accountNames} seqById={seqById} />
        ))}
      </ol>

      {query.hasNextPage && (
        <button
          type="button"
          className="button-secondary load-more"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older transactions'}
        </button>
      )}
    </section>
  );
}

function JournalEntry({
  tx,
  accountNames,
  seqById,
}: {
  tx: TransactionDto;
  accountNames: Map<string, string>;
  seqById: Map<string, string>;
}) {
  const ref = (id: string) => (seqById.has(id) ? `#${seqById.get(id)}` : id.slice(0, 8));
  // Accounting convention: debits first, credits after and indented.
  const entries = [...tx.entries].sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'debit' ? -1 : 1));
  const metadata = Object.entries(tx.metadata);

  return (
    <li className={tx.reversedBy ? 'journal-entry reversed' : 'journal-entry'}>
      <header className="journal-head">
        <span className="seq" title={tx.id}>
          #{tx.seq}
        </span>
        <time dateTime={tx.effectiveAt}>{formatDateTime(tx.effectiveAt)}</time>
        <span className="description">{tx.description || <span className="muted">(no description)</span>}</span>
        {tx.reverses && <span className="badge badge-warn">Reversal of {ref(tx.reverses)}</span>}
        {tx.reversedBy && <span className="badge badge-muted">Reversed by {ref(tx.reversedBy)}</span>}
      </header>
      <div className="table-scroll">
        <table className="table entries">
          <caption className="visually-hidden">Entries of transaction {tx.seq}</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="num wide-only">
                Debit
              </th>
              <th scope="col" className="num wide-only">
                Credit
              </th>
              <th scope="col" className="num narrow-only">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <th scope="row" className={e.direction === 'credit' ? 'credit-account' : undefined}>
                  {accountNames.get(e.account) ?? e.account}
                  <code className="account-code">{e.account}</code>
                </th>
                <td className="num wide-only">{e.direction === 'debit' && <Amount raw={e.amount} currency={e.currency} />}</td>
                <td className="num wide-only">{e.direction === 'credit' && <Amount raw={e.amount} currency={e.currency} />}</td>
                <td className="num narrow-only">
                  <span className="dr-cr">{e.direction === 'debit' ? 'Dr' : 'Cr'}</span>{' '}
                  <Amount raw={e.amount} currency={e.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {metadata.length > 0 && (
        <dl className="metadata">
          {metadata.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
