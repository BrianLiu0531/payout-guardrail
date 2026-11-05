import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payoutApi } from '../api.js';
import { formatDateTime, formatUnits } from '../format.js';
import { QueryError } from '../ledger/QueryError.js';
import { errorText, useConfig, useMe } from '../session.js';
import { IntentList } from '../payouts/PayoutsPage.js';

function BreakerReset() {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const reset = useMutation({ mutationFn: () => payoutApi.proposeBreakerReset(reason), onSuccess: () => qc.invalidateQueries() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    reset.mutate();
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field field-wide">
        <span>What was found and done</span>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={200} placeholder="Key rotated; 500 USDC written off" />
      </label>
      <button className="button-primary" disabled={reset.isPending}>
        Propose reset
      </button>
      {reset.error && <p className="form-error" role="alert">{errorText(reset.error)}</p>}
    </form>
  );
}

export function SecurityPage() {
  const qc = useQueryClient();
  const me = useMe();
  const config = useConfig();
  const security = useQuery({ queryKey: ['security'], queryFn: payoutApi.security, refetchInterval: 3000 });
  const audit = useQuery({ queryKey: ['audit'], queryFn: payoutApi.audit, refetchInterval: 5000 });
  const reconcile = useMutation({ mutationFn: payoutApi.reconcile, onSuccess: () => qc.invalidateQueries({ queryKey: ['security'] }) });

  if (security.isError) return <QueryError error={security.error} onRetry={() => security.refetch()} />;
  const s = security.data;
  const recon = s?.reconciliation;
  const breaker = s?.signer.breaker;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Security</h1>
          <p className="lede">
            What was approved, what the signer signed, what happened on chain and what the ledger recorded, checked against each other every 15
            seconds.
          </p>
        </div>
      </div>

      {breaker && (
        <section className={`breaker ${breaker.open ? 'breaker-open' : 'breaker-closed'}`} aria-live="polite">
          <div>
            <strong>{breaker.open ? 'Circuit breaker OPEN: the signer is refusing all payouts' : 'Circuit breaker closed: payouts flowing'}</strong>
            {breaker.open && (
              <p>
                {breaker.reason} · since {breaker.at ? formatDateTime(breaker.at) : '?'}. Closing it takes a reset approved by two approvers, which also
                acknowledges the findings below.
              </p>
            )}
          </div>
          {breaker.open && me.data?.user && <BreakerReset />}
        </section>
      )}
      {breaker?.open && (
        <section className="section">
          <IntentList kind="breaker_reset" empty="No reset proposed yet." />
        </section>
      )}

      <section className="section" aria-labelledby="recon-h">
        <div className="section-head">
          <h2 id="recon-h">Four-way reconciliation</h2>
          {recon && <span className={`badge badge-${recon.ok ? 'ok' : 'bad'}`}>{recon.ok ? 'in agreement' : 'discrepancies'}</span>}
          {me.data?.user && (
            <button type="button" className="button-secondary" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
              Run now
            </button>
          )}
        </div>
        <p className="section-note">{recon ? `Last run ${formatDateTime(recon.at)}` : 'Not run yet.'}</p>
        {recon && (
          <div className="cards">
            <div className="card">
              <div className="card-head">
                <h3>Hot wallet USDC</h3>
              </div>
              <dl className="card-figures">
                <div>
                  <dt>On chain</dt>
                  <dd className="amount">{formatUnits(recon.summary.usdc.chain, 6)}</dd>
                </div>
                <div>
                  <dt>Ledger</dt>
                  <dd className="amount">{formatUnits(recon.summary.usdc.ledger, 6)}</dd>
                </div>
              </dl>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Hot wallet ETH (gas)</h3>
              </div>
              <dl className="card-figures">
                <div>
                  <dt>On chain</dt>
                  <dd className="amount">{formatUnits(recon.summary.eth.chain, 18, 6)}</dd>
                </div>
                <div>
                  <dt>Ledger</dt>
                  <dd className="amount">{formatUnits(recon.summary.eth.ledger, 18, 6)}</dd>
                </div>
              </dl>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Checked</h3>
              </div>
              <dl className="card-figures">
                <div>
                  <dt>Intents</dt>
                  <dd>{recon.summary.intentsChecked}</dd>
                </div>
                <div>
                  <dt>Signer log entries</dt>
                  <dd>{recon.summary.signerEntries}</dd>
                </div>
                <div>
                  <dt>Transfers out on chain</dt>
                  <dd>{recon.summary.chainTransfers}</dd>
                </div>
              </dl>
            </div>
          </div>
        )}
        {recon && recon.findings.length > 0 && (
          <ul className="findings">
            {recon.findings.map((f) => (
              <li key={f.fingerprint} className={`finding finding-${f.severity}${f.acknowledged ? ' finding-acked' : ''}`}>
                <span className={`badge badge-${f.severity === 'critical' && !f.acknowledged ? 'bad' : 'muted'}`}>
                  {f.acknowledged ? 'acknowledged' : f.severity}
                </span>{' '}
                <strong>{f.kind}</strong> {f.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="audit-h">
        <div className="section-head">
          <h2 id="audit-h">Audit log</h2>
          {s && <span className={`badge badge-${s.audit.ok ? 'ok' : 'bad'}`}>{s.audit.ok ? 'chain intact' : `${s.audit.problems.length} problem(s)`}</span>}
        </div>
        <p className="section-note">
          {s ? `${s.audit.entries} hash-chained entries; ${s.audit.anchors} checkpoints held by the signer.` : ''}
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col" className="wide-only">
                  Hash
                </th>
              </tr>
            </thead>
            <tbody>
              {(audit.data?.entries ?? []).slice(0, 20).map((e) => (
                <tr key={e.seq} className={s?.audit.problems.some((p) => p.seq === e.seq) ? 'row-bad' : undefined}>
                  <td className="mono">{e.seq}</td>
                  <td>{formatDateTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td className="wide-only mono muted">{e.hash.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="refusals-h">
        <h2 id="refusals-h">Signer refusals</h2>
        <p className="section-note">Every request the signer turned down, from its own append-only log.</p>
        {s && s.refusals.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {(s?.refusals ?? []).map((r) => (
                  <tr key={r.seq}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td>
                      <span className="badge badge-bad">{r.reason}</span>
                    </td>
                    <td className="detail-cell">
                      {String(r.detail.message ?? '')}
                      {Array.isArray(r.detail.policies) && r.detail.policies.length > 0 && <> · {(r.detail.policies as string[]).join(', ')}</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="approvers-h">
        <h2 id="approvers-h">Approvers the signer trusts</h2>
        <ul className="plain-list">
          {(s?.approvers ?? []).map((a) => (
            <li key={a.credentialId}>
              <strong>{a.userId}</strong> <span className="muted">· enrolled {formatDateTime(a.enrolledAt)} by {a.enrolledBy === 'bootstrap' ? 'install' : 'approved change'}</span>
            </li>
          ))}
        </ul>
        <IntentList kind="approver_add" empty="No approver enrollments waiting." />
      </section>

      <section className="section" aria-labelledby="policy-h">
        <h2 id="policy-h">Policy</h2>
        <p className="section-note">Cedar, evaluated by the API when a payout is requested and again by the signer before it signs.</p>
        <pre className="code-block">{config.data?.policy}</pre>
      </section>
    </>
  );
}
