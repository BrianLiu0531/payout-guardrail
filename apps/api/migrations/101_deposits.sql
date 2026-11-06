-- Inbound transfers reported by base-usdc-indexer (webhook, HMAC-signed). One row per event,
-- so a redelivered event is recognised and changes nothing.
CREATE TABLE payouts.deposits (
  event_id      text PRIMARY KEY,
  type          text NOT NULL CHECK (type IN ('transfer.confirmed', 'transfer.reverted')),
  chain_id      integer NOT NULL,
  tx_hash       text NOT NULL,
  log_index     integer NOT NULL,
  block_number  bigint NOT NULL,
  from_address  text NOT NULL,
  to_address    text NOT NULL,
  value         numeric(78, 0) NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('credited', 'reversed', 'outgoing', 'ignored')),
  ledger_tx_id  uuid,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deposits_transfer ON payouts.deposits (chain_id, tx_hash, log_index);
