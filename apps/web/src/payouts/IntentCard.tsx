import { useMutation, useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { payoutApi } from '../api.js';
import { formatDateTime, formatUnits } from '../format.js';
import type { Intent, IntentStatus, Payee } from '../payoutTypes.js';
import { errorText, useMe } from '../session.js';

const STATUS: Record<IntentStatus, { label: string; tone: 'ok' | 'bad' | 'warn' | 'muted' }> = {
  pending_approval: { label: 'Needs approval', tone: 'warn' },
  approved: { label: 'Approved · signing', tone: 'muted' },
  signed: { label: 'Signed · broadcasting', tone: 'muted' },
  broadcast: { label: 'On chain · confirming', tone: 'muted' },
  settled: { label: 'Settled', tone: 'ok' },
  applied: { label: 'Applied', tone: 'ok' },
  refused: { label: 'Refused by signer', tone: 'bad' },
  failed: { label: 'Failed on chain', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

const KIND: Record<Intent['kind'], string> = {
  payout: 'Payout',
  payee_add: 'New payee',
  approver_add: 'New approver',
  breaker_reset: 'Breaker reset',
};

const short = (s: string, n = 6) => (s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);

export function StatusBadge({ intent }: { intent: Intent }) {
  const s = STATUS[intent.status];
  const progress = intent.status === 'pending_approval' && intent.requiredApprovals !== null ? ` ${intent.approvals.length}/${intent.requiredApprovals}` : '';
  return <span className={`badge badge-${s.tone}`}>{s.label + progress}</span>;
}

function Summary({ intent, payees }: { intent: Intent; payees: Payee[] }) {
  const p = intent.payload;
  switch (intent.kind) {
    case 'payout': {
      const payee = payees.find((x) => x.id === p.payeeId);
      return (
        <>
          <span className="amount">{formatUnits(String(p.amount), 6)}</span> <span className="muted">USDC to</span> <strong>{payee?.name ?? String(p.payeeId)}</strong>
          {p.memo ? <span className="muted"> · {String(p.memo)}</span> : null}
        </>
      );
    }
    case 'payee_add':
      return (
        <>
          Add payee <strong>{String(p.name)}</strong> <code title={String(p.address)}>{short(String(p.address))}</code>
        </>
      );
    case 'approver_add':
      return (
        <>
          Enroll a passkey for <strong>{String(p.userId)}</strong>
        </>
      );
    case 'breaker_reset':
      return (
        <>
          Reset the circuit breaker: <em>{String(p.reason)}</em>
        </>
      );
  }
}

export function IntentCard({ intent, payees, demoApprovers }: { intent: Intent; payees: Payee[]; demoApprovers: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const me = useMe();
  const user = me.data?.user ?? null;
  const done = () => qc.invalidateQueries({ queryKey: ['intents'] });

  const approvedBy = new Set(intent.approvals.map((a) => a.userId));
  const pending = intent.status === 'pending_approval';
  const hasPasskey = (me.data?.passkeys ?? []).some((k) => k.enrolled && !k.software);
  const canApprove = pending && user && user.role !== 'requester' && user.id !== intent.createdBy && !approvedBy.has(user.id) && hasPasskey;

  const approve = useMutation({
    mutationFn: async () => {
      const { options } = await payoutApi.approvalOptions(intent.id);
      const response = await startAuthentication({ optionsJSON: options });
      return payoutApi.approve(intent.id, response);
    },
    onSuccess: done,
  });
  const demoApprove = useMutation({ mutationFn: (userId: string) => payoutApi.demoApprove(intent.id, userId), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => payoutApi.cancel(intent.id), onSuccess: done });
  const error = approve.error ?? demoApprove.error ?? cancel.error;

  return (
    <li className={`intent-card intent-${intent.status}`}>
      <div className="intent-head">
        <span className="badge badge-muted">{KIND[intent.kind]}</span>
        <StatusBadge intent={intent} />
        <time dateTime={intent.createdAt}>{formatDateTime(intent.createdAt)}</time>
        <span className="muted">by {intent.createdBy}</span>
      </div>
      <p className="intent-summary">
        <Summary intent={intent} payees={payees} />
      </p>

      <dl className="metadata">
        <div>
          <dt>intent hash</dt>
          <dd title={intent.hash}>{short(intent.hash, 8)}</dd>
        </div>
        {intent.approvals.length > 0 && (
          <div>
            <dt>approved by</dt>
            <dd>{intent.approvals.map((a) => a.userId).join(', ')}</dd>
          </div>
        )}
        {intent.txHash && (
          <div>
            <dt>tx</dt>
            <dd title={intent.txHash}>{short(intent.txHash, 6)}</dd>
          </div>
        )}
        {intent.blockNumber !== null && (
          <div>
            <dt>block</dt>
            <dd>{intent.blockNumber}</dd>
          </div>
        )}
        {intent.feeWei && (
          <div>
            <dt>fee</dt>
            <dd>{formatUnits(intent.feeWei, 18, 6)} ETH</dd>
          </div>
        )}
      </dl>

      {intent.error && intent.status !== 'settled' && (
        <p className={intent.error.reason === 'retrying' ? 'notice notice-warn' : 'notice notice-bad'}>
          <strong>{intent.error.reason}</strong>: {intent.error.message}
          {Array.isArray(intent.error.detail?.policies) && (intent.error.detail.policies as string[]).length > 0 && (
            <> · policy {(intent.error.detail.policies as string[]).join(', ')}</>
          )}
        </p>
      )}

      {pending && (
        <div className="intent-actions">
          {canApprove && (
            <button type="button" className="button-primary" onClick={() => approve.mutate()} disabled={approve.isPending}>
              {approve.isPending ? 'Waiting for passkey…' : 'Approve with passkey'}
            </button>
          )}
          {user &&
            demoApprovers
              .filter((d) => d.id !== intent.createdBy && !approvedBy.has(d.id))
              .map((d) => (
                <button key={d.id} type="button" className="button-secondary" onClick={() => demoApprove.mutate(d.id)} disabled={demoApprove.isPending}>
                  Approve as {d.name.split(' ')[0]} <span className="muted">(demo key)</span>
                </button>
              ))}
          {user && (user.id === intent.createdBy || user.role === 'admin') && (
            <button type="button" className="button-link" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </button>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert">{errorText(error)}</p>}
    </li>
  );
}
