import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payoutApi } from '../api.js';
import { QueryError } from '../ledger/QueryError.js';
import type { AttackResult } from '../payoutTypes.js';
import { errorText, useMe } from '../session.js';

const VERDICT: Record<AttackResult['verdict'], { label: string; tone: string }> = {
  blocked: { label: 'Blocked', tone: 'ok' },
  detected: { label: 'Detected & contained', tone: 'warn' },
  not_blocked: { label: 'NOT BLOCKED', tone: 'bad' },
};

const OUTCOME: Record<AttackResult['steps'][number]['outcome'], string> = {
  attacker: 'attacker',
  blocked: 'blocked',
  detected: 'detected',
  ok: 'normal',
  info: 'note',
};

function AttackCard({ id, title, blurb, signedIn }: { id: string; title: string; blurb: string; signedIn: boolean }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<AttackResult | null>(null);
  const run = useMutation({
    mutationFn: () => payoutApi.runAttack(id),
    onSuccess: (r) => {
      setResult(r);
      return qc.invalidateQueries();
    },
  });
  const severe = id === 'leaked-key' || id === 'audit-rewrite';
  return (
    <li className="card attack">
      <div className="card-head">
        <h3>{title}</h3>
        {result && <span className={`badge badge-${VERDICT[result.verdict].tone}`}>{VERDICT[result.verdict].label}</span>}
      </div>
      <p className="muted">{blurb}</p>
      {severe && <p className="notice notice-warn">Leaves the demo in an incident state: the breaker opens until two approvers reset it.</p>}
      <button type="button" className="button-secondary" onClick={() => run.mutate()} disabled={run.isPending || !signedIn}>
        {run.isPending ? 'Running…' : result ? 'Run again' : 'Run attack'}
      </button>
      {run.error && <p className="form-error" role="alert">{errorText(run.error)}</p>}
      {result && (
        <>
          <ol className="steps">
            {result.steps.map((s, i) => (
              <li key={i} className={`step step-${s.outcome}`}>
                <span className="step-tag">{OUTCOME[s.outcome]}</span>
                <div>
                  <strong>{s.label}</strong>
                  <p>{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="attack-summary">{result.summary}</p>
        </>
      )}
    </li>
  );
}

export function AttackLab() {
  const me = useMe();
  const attacks = useQuery({ queryKey: ['attacks'], queryFn: payoutApi.attacks, enabled: me.data?.demoMode === true });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Attack lab</h1>
          <p className="lede">
            Each attack plays a compromised API server (or worse) against the real signer, chain and ledger running on your machine. Nothing is
            mocked: refusals land in the signer&apos;s log and detections trip the real circuit breaker.
          </p>
        </div>
      </div>
      {!me.data?.demoMode && <p className="notice notice-warn">The attack lab is only available in demo mode.</p>}
      {me.data?.demoMode && !me.data.user && <p className="notice notice-warn">Sign in as any demo user to run attacks.</p>}
      {attacks.isError && <QueryError error={attacks.error} onRetry={() => attacks.refetch()} />}
      <ul className="attack-grid">
        {(attacks.data?.attacks ?? []).map((a) => (
          <AttackCard key={a.id} {...a} signedIn={!!me.data?.user} />
        ))}
      </ul>
    </>
  );
}
