-- Payout workflow: people, passkeys, payees, intents, approvals, and a tamper-evident audit log.
-- None of this is trusted by the signer, which keeps its own records (schema "signer").

CREATE SCHEMA payouts;

CREATE TABLE payouts.config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE payouts.users (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  name       text NOT NULL,
  role       text NOT NULL CHECK (role IN ('requester', 'approver', 'admin')),
  demo       boolean NOT NULL DEFAULT false,   -- demo users can be signed in to without a passkey
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payouts.credentials (
  id          text PRIMARY KEY,               -- WebAuthn credential id, base64url
  user_id     text NOT NULL REFERENCES payouts.users (id),
  public_key  bytea NOT NULL,                 -- COSE
  counter     bigint NOT NULL DEFAULT 0,
  transports  text[] NOT NULL DEFAULT '{}',
  software    boolean NOT NULL DEFAULT false, -- a demo key held by the server, not a real passkey
  enrolled    boolean NOT NULL DEFAULT false, -- true once the signer has accepted it (approver_add applied)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credentials_user ON payouts.credentials (user_id);

-- Registration and sign-in challenges: single use, short-lived.
CREATE TABLE payouts.challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge  text NOT NULL UNIQUE,
  purpose    text NOT NULL CHECK (purpose IN ('register', 'login')),
  data       jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL
);

CREATE TABLE payouts.sessions (
  token_hash text PRIMARY KEY,                -- SHA-256 of the cookie value; the value itself is never stored
  user_id    text NOT NULL REFERENCES payouts.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE payouts.payees (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name         text NOT NULL,
  address      text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id     integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'active', 'rejected')),
  intent_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE TABLE payouts.intents (
  id                 uuid PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('payout', 'payee_add', 'approver_add', 'breaker_reset')),
  payload            jsonb NOT NULL,
  hash               text NOT NULL,
  status             text NOT NULL CHECK (status IN (
                       'pending_approval', 'approved', 'signed', 'broadcast', 'settled', 'applied',
                       'refused', 'failed', 'cancelled')),
  created_by         text NOT NULL REFERENCES payouts.users (id),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  required_approvals integer,
  amount             numeric(78, 0),          -- payouts only, for listing and limits
  error              jsonb,
  tx_hash            text UNIQUE,
  raw_tx             text,
  nonce              bigint,
  block_number       bigint,
  fee_wei            numeric(78, 0),
  ledger_tx_id       uuid,
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intents_work ON payouts.intents (next_attempt_at) WHERE status IN ('approved', 'signed', 'broadcast');
CREATE INDEX intents_created ON payouts.intents (created_at DESC);

CREATE TABLE payouts.approvals (
  intent_id     uuid NOT NULL REFERENCES payouts.intents (id),
  user_id       text NOT NULL REFERENCES payouts.users (id),
  credential_id text NOT NULL,
  assertion     jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, user_id)
);

-- Hash-chained audit log: each row's hash covers the previous row's hash, and checkpoints are
-- sent to the signer, so a rewritten history no longer matches either.
CREATE TABLE payouts.audit (
  seq       bigint PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL,
  action    text NOT NULL,
  subject   text,
  data      jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash      text NOT NULL UNIQUE
);

CREATE FUNCTION payouts.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payouts.% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON payouts.audit
  FOR EACH ROW EXECUTE FUNCTION payouts.reject_mutation();
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON payouts.approvals
  FOR EACH ROW EXECUTE FUNCTION payouts.reject_mutation();

CREATE TABLE payouts.recon_runs (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  ok       boolean NOT NULL,
  summary  jsonb NOT NULL,
  findings jsonb NOT NULL
);

-- Findings people have investigated. Acknowledged when a breaker reset is approved, so a known
-- incident does not re-open the breaker, while any new discrepancy still does.
CREATE TABLE payouts.recon_acks (
  fingerprint text PRIMARY KEY,
  intent_id   uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
