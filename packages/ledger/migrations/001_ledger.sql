-- Double-entry ledger.
--
-- Invariants enforced by the database itself, so they hold even for code that
-- bypasses the TypeScript layer:
--   * every transaction has at least two entries and balances per currency
--     (deferred constraint triggers, checked at COMMIT);
--   * an entry's currency is its account's currency (composite foreign key);
--   * transactions and entries are append-only (UPDATE/DELETE/TRUNCATE rejected);
--   * a transaction can be reversed at most once (UNIQUE on reverses).
--
-- ledger.balances is a projection of ledger.entries maintained in the same
-- database transaction as each posting. Ledger.verify() recomputes it from
-- the entries and reports any drift.

CREATE SCHEMA ledger;

CREATE TABLE ledger.accounts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_:.-]{0,99}$'),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type           text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9]{1,11}$'),
  allow_negative boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, currency)
);

CREATE TABLE ledger.balances (
  account_id bigint PRIMARY KEY REFERENCES ledger.accounts (id),
  debits     numeric(78, 0) NOT NULL DEFAULT 0 CHECK (debits >= 0),
  credits    numeric(78, 0) NOT NULL DEFAULT 0 CHECK (credits >= 0),
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger.transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash    text NOT NULL,
  description     text NOT NULL DEFAULT '',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  reverses        uuid UNIQUE REFERENCES ledger.transactions (id),
  effective_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger.entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger.transactions (id),
  account_id     bigint NOT NULL,
  currency       text NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount         numeric(78, 0) NOT NULL CHECK (amount > 0),
  FOREIGN KEY (account_id, currency) REFERENCES ledger.accounts (id, currency)
);

CREATE INDEX entries_account_idx ON ledger.entries (account_id, id DESC);
CREATE INDEX entries_transaction_idx ON ledger.entries (transaction_id);

-- Every account gets its balance row at creation, so postings only ever UPDATE.
CREATE FUNCTION ledger.create_balance_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger.balances (account_id) VALUES (NEW.id);
  RETURN NULL;
END $$;

CREATE TRIGGER accounts_create_balance AFTER INSERT ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.create_balance_row();

-- Balance check, run at COMMIT.
CREATE FUNCTION ledger.assert_balanced(tx uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n   int;
  bad text;
BEGIN
  SELECT count(*) INTO n FROM ledger.entries WHERE transaction_id = tx;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 are required', tx, n
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT currency INTO bad
  FROM ledger.entries
  WHERE transaction_id = tx
  GROUP BY currency
  HAVING sum(CASE WHEN direction = 'debit' THEN amount ELSE 0 END)
      <> sum(CASE WHEN direction = 'credit' THEN amount ELSE 0 END)
  LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ledger transaction % does not balance in %', tx, bad
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION ledger.entries_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger.assert_balanced(NEW.transaction_id);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger.transactions_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger.assert_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.entries_balanced();

-- Catches a transaction inserted with no entries at all.
CREATE CONSTRAINT TRIGGER transactions_balanced AFTER INSERT ON ledger.transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.transactions_balanced();

-- Append-only history.
CREATE FUNCTION ledger.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger.% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON ledger.entries
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON ledger.entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON ledger.transactions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON ledger.transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();

-- Accounts may be renamed, but never deleted or re-typed.
CREATE TRIGGER accounts_immutable BEFORE UPDATE OF code, type, currency, allow_negative ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON ledger.accounts
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
