import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, payoutApi } from './api.js';
import type { Me } from './payoutTypes.js';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: payoutApi.me, staleTime: 10_000 });
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: payoutApi.config, staleTime: Infinity });
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const details = (err as ApiError & { details?: { policies?: string[] } }).details;
    return details?.policies?.length ? `${err.message} (${details.policies.join(', ')})` : err.message;
  }
  if (err instanceof Error) return err.name === 'NotAllowedError' ? 'The passkey prompt was cancelled or timed out.' : err.message;
  return String(err);
}

/** Who is signed in, and how to switch: demo users, or a real passkey. */
export function SessionBar() {
  const me = useMe();
  const qc = useQueryClient();
  const [panel, setPanel] = useState<'none' | 'register'>('none');
  const users = useQuery({ queryKey: ['users'], queryFn: payoutApi.users, enabled: me.data?.demoMode === true });
  const refresh = () => qc.invalidateQueries();

  const demoLogin = useMutation({ mutationFn: payoutApi.demoLogin, onSuccess: refresh });
  const logout = useMutation({ mutationFn: payoutApi.logout, onSuccess: refresh });
  const passkeyLogin = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await payoutApi.loginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      return payoutApi.loginVerify(challengeId, response);
    },
    onSuccess: refresh,
  });

  if (me.isPending) return <span className="muted">…</span>;
  const current = me.data?.user;
  const error = demoLogin.error ?? passkeyLogin.error ?? logout.error;

  return (
    <div className="session">
      {me.data?.demoMode && (
        <label className="session-switch">
          <span className="visually-hidden">Signed in as</span>
          <select
            value={current?.id ?? ''}
            onChange={(e) => (e.target.value ? demoLogin.mutate(e.target.value) : logout.mutate())}
            aria-label="Signed in as"
          >
            {!current && <option value="">Not signed in</option>}
            {(users.data?.users ?? [])
              .filter((u) => u.demo || u.id === current?.id)
              .map((u) => (
                <option key={u.id} value={u.id} disabled={!u.demo && u.id !== current?.id}>
                  {u.name} · {u.role}
                  {u.demo ? ' (demo)' : ''}
                </option>
              ))}
          </select>
        </label>
      )}
      {current && !current.demo && (
        <span className="session-user">
          {current.name} <span className="badge badge-muted">{current.role}</span>
        </span>
      )}
      <button type="button" className="button-secondary" onClick={() => passkeyLogin.mutate()} disabled={passkeyLogin.isPending}>
        Sign in with passkey
      </button>
      <button type="button" className="button-secondary" onClick={() => setPanel(panel === 'register' ? 'none' : 'register')} aria-expanded={panel === 'register'}>
        New approver
      </button>
      {current && (
        <button type="button" className="button-secondary" onClick={() => logout.mutate()}>
          Sign out
        </button>
      )}
      {error && <p className="form-error" role="alert">{errorText(error)}</p>}
      {panel === 'register' && <RegisterPanel me={me.data} onDone={() => setPanel('none')} />}
    </div>
  );
}

function RegisterPanel({ me, onDone }: { me: Me | undefined; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const register = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await payoutApi.registerOptions(name, userId);
      const response = await startRegistration({ optionsJSON: options });
      return payoutApi.registerVerify(challengeId, response);
    },
    onSuccess: async () => {
      await qc.invalidateQueries();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate();
  };
  return (
    <form className="popover" onSubmit={submit}>
      <h2>Register as an approver</h2>
      <p className="muted">
        Creates a passkey on this device (Windows Hello, Touch ID, a security key). Your passkey can approve payouts only after two existing
        approvers sign an <em>add approver</em> change{me?.demoMode ? ': in the demo, sign in as Bob and Carol to do that.' : '.'}
      </p>
      <label className="field">
        <span>Display name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} autoComplete="name" />
      </label>
      <label className="field">
        <span>User id</span>
        <input
          className="input"
          value={userId}
          onChange={(e) => setUserId(e.target.value.toLowerCase())}
          required
          pattern="[a-z0-9][a-z0-9_\-]{1,31}"
          title="2–32 lowercase letters, digits, _ or -"
          autoComplete="username webauthn"
        />
      </label>
      <div className="form-actions">
        <button className="button-primary" disabled={register.isPending}>
          {register.isPending ? 'Waiting for passkey…' : 'Create passkey'}
        </button>
        <button type="button" className="button-secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {register.error && <p className="form-error" role="alert">{errorText(register.error)}</p>}
    </form>
  );
}
