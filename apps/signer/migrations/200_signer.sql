-- The signer's own records. In production this schema lives in a separate database that only the
-- signer's role can reach; the API never reads or writes it. Everything the signer decides is
-- based on these tables, not on anything the API stores.

CREATE SCHEMA signer;

-- Passkeys allowed to approve. Bootstrapped at install time; afterwards only an approved
-- approver_add intent can add one.
CREATE TABLE signer.approvers (
  credential_id text PRIMARY KEY,
  user_id       text NOT NULL,
  public_key    bytea NOT NULL,
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  enrolled_by   text NOT NULL            -- 'bootstrap' or the intent id that added it
);

-- Addresses the hot wallet may pay. Same rule: bootstrap or an approved payee_add intent.
CREATE TABLE signer.payees (
  address      text PRIMARY KEY CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id     integer NOT NULL,
  payee_id     text NOT NULL UNIQUE,
  name         text NOT NULL,
  activated_at timestamptz NOT NULL,
  added_by     text NOT NULL
);

-- Everything the signer has signed or applied. Append-only.
CREATE TABLE signer.log (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id   text NOT NULL UNIQUE,
  intent_hash text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('payout', 'payee_add', 'approver_add', 'breaker_reset')),
  payload     jsonb NOT NULL,
  approvers   text[] NOT NULL,
  -- payouts only
  to_address  text,
  amount      numeric(78, 0),
  nonce       bigint UNIQUE,
  tx_hash     text UNIQUE,
  raw_tx      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Requests the signer refused, with the reason. Append-only; this is the attack evidence.
CREATE TABLE signer.refusals (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id   text,
  intent_hash text,
  reason      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Checkpoints of the API's audit log, so rewriting that log is detectable from here.
CREATE TABLE signer.anchors (
  seq         bigint PRIMARY KEY,          -- audit log sequence number
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signer.state (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  address        text NOT NULL,
  chain_id       integer NOT NULL,
  token          text NOT NULL,
  next_nonce     bigint NOT NULL,
  breaker_open   boolean NOT NULL DEFAULT false,
  breaker_reason text,
  breaker_at     timestamptz
);

CREATE FUNCTION signer.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signer.% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER log_append_only BEFORE UPDATE OR DELETE ON signer.log
  FOR EACH ROW EXECUTE FUNCTION signer.reject_mutation();
CREATE TRIGGER refusals_append_only BEFORE UPDATE OR DELETE ON signer.refusals
  FOR EACH ROW EXECUTE FUNCTION signer.reject_mutation();
CREATE TRIGGER anchors_append_only BEFORE UPDATE OR DELETE ON signer.anchors
  FOR EACH ROW EXECUTE FUNCTION signer.reject_mutation();
CREATE TRIGGER log_no_truncate BEFORE TRUNCATE ON signer.log
  FOR EACH STATEMENT EXECUTE FUNCTION signer.reject_mutation();
