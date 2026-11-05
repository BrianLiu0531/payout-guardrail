import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payoutApi } from '../api.js';
import { formatDateTime } from '../format.js';
import { QueryError } from '../ledger/QueryError.js';
import { errorText, useMe } from '../session.js';
import { IntentList } from './PayoutsPage.js';

const COOLDOWN_MS = 120_000; // payee-cooldown in policies/payouts.cedar (demo value)

function AddPayee() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const add = useMutation({
    mutationFn: () => payoutApi.addPayee(name, address),
    onSuccess: () => {
      setName('');
      setAddress('');
      return qc.invalidateQueries();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form className="card form-card" onSubmit={submit} aria-labelledby="add-payee">
      <h2 id="add-payee">Add a payee</h2>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} />
        </label>
        <label className="field field-wide">
          <span>Address</span>
          <input
            className="input mono"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            required
            pattern="0x[0-9a-fA-F]{40}"
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
      </div>
      <p className="section-note">Needs two approvers. Once applied, payouts to it are refused for a cooling-off period (2 minutes in the demo, 24 hours in production).</p>
      <div className="form-actions">
        <button className="button-primary" disabled={add.isPending}>
          Propose payee
        </button>
      </div>
      {add.error && <p className="form-error" role="alert">{errorText(add.error)}</p>}
    </form>
  );
}

export function PayeesPage() {
  const me = useMe();
  const payees = useQuery({ queryKey: ['payees'], queryFn: payoutApi.payees, refetchInterval: 5000 });
  const now = Date.now();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payees</h1>
          <p className="lede">The only addresses the hot wallet will pay. The signer keeps its own copy of this list; the API cannot add to it.</p>
        </div>
      </div>
      <section className="section">
        {payees.isError ? (
          <QueryError error={payees.error} onRetry={() => payees.refetch()} />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Payee</th>
                  <th scope="col">Address</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="wide-only">
                    Active since
                  </th>
                </tr>
              </thead>
              <tbody>
                {(payees.data?.payees ?? []).map((p) => {
                  const cooling = p.status === 'active' && p.activatedAt && now - Date.parse(p.activatedAt) < COOLDOWN_MS;
                  return (
                    <tr key={p.id}>
                      <th scope="row">{p.name}</th>
                      <td>
                        <code className="address">{p.address}</code>
                      </td>
                      <td>
                        <span className={`badge badge-${p.status === 'active' ? (cooling ? 'warn' : 'ok') : p.status === 'pending' ? 'warn' : 'muted'}`}>
                          {cooling ? 'cooling off' : p.status}
                        </span>
                      </td>
                      <td className="wide-only">{p.activatedAt ? formatDateTime(p.activatedAt) : '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {me.data?.user && (
        <section className="section">
          <AddPayee />
        </section>
      )}
      <section className="section" aria-labelledby="payee-changes">
        <h2 id="payee-changes">Payee changes</h2>
        <p className="section-note">Proposed additions waiting for approval.</p>
        <IntentList kind="payee_add" empty="No payee changes in progress." />
      </section>
    </>
  );
}
