-- Optional PayoutVault: when set, payouts are vault.pay(to, amount, intentHash) calls, so the hot
-- key can only spend within the vault's on-chain daily limit, once per intent.
ALTER TABLE signer.state ADD COLUMN vault text CHECK (vault ~ '^0x[0-9a-fA-F]{40}$');
