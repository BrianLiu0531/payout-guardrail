import type pg from 'pg';
import type { PublicClient } from 'viem';
import { LedgerError, type Ledger } from '@guardrail/ledger';
import type { PayoutIntent } from '@guardrail/core';
import { audit } from './audit.js';
import { FEES, HOT_ETH, HOT_USDC, type Payouts } from './service.js';
import { SignerRefused, type SignerPort } from './signerPort.js';

/**
 * Moves approved intents forward: sign (or apply) → broadcast → confirm → post to the ledger.
 * Every step is idempotent, so a crash or a second worker at any point only repeats work
 * that has no further effect: the signer returns the same transaction for the same intent,
 * re-broadcasting a known transaction is harmless, and ledger postings use fixed keys.
 */
export class PayoutWorker {
  constructor(
    private readonly payouts: Payouts,
    private readonly ledger: Ledger,
    private readonly signer: SignerPort,
    private readonly chain: PublicClient,
    private readonly opts: { confirmations: number } = { confirmations: 1 },
  ) {}

  private get pool(): pg.Pool {
    return this.payouts.pool;
  }

  /** Processes everything that is due. Returns how many intents changed state. */
  async tick(limit = 20): Promise<number> {
    let changed = 0;
    for (let i = 0; i < limit; i++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(
          `SELECT id, kind, payload, hash, status, tx_hash, raw_tx, attempts FROM payouts.intents
            WHERE status IN ('approved', 'signed', 'broadcast') AND next_attempt_at <= now()
            ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const row = rows[0];
        if (!row) {
          await c.query('COMMIT');
          break;
        }
        let moved = false;
        await c.query('SAVEPOINT step');
        try {
          moved = await this.step(c, row);
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT step');
          // Transient (chain or signer unreachable): back off and try again.
          const attempts = row.attempts + 1;
          await c.query(
            `UPDATE payouts.intents SET attempts = $2, error = $3, next_attempt_at = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1`,
            [row.id, attempts, { reason: 'retrying', message: (err as Error).message.slice(0, 300) }, Math.min(60, 2 ** attempts)],
          );
        }
        await c.query('COMMIT');
        if (moved) changed++;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    }
    return changed;
  }

  private async step(c: pg.PoolClient, row: Record<string, any>): Promise<boolean> {
    if (row.status === 'approved') return row.kind === 'payout' ? this.sign(c, row) : this.apply(c, row);
    if (row.status === 'signed') return this.broadcast(c, row);
    return this.confirm(c, row);
  }

  private async sign(c: pg.PoolClient, row: Record<string, any>): Promise<boolean> {
    const approvals = await this.payouts.approvalsFor(row.id);
    try {
      const signed = await this.signer.signPayout({ intent: row.payload, intentHash: row.hash, approvals });
      await c.query(
        `UPDATE payouts.intents SET status = 'signed', tx_hash = $2, raw_tx = $3, nonce = $4, error = NULL, attempts = 0,
                next_attempt_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, signed.txHash, signed.rawTx, signed.nonce],
      );
      await audit(c, 'signer', 'payout.signed', row.id, { txHash: signed.txHash, nonce: signed.nonce, approvers: signed.approvers });
      return true;
    } catch (err) {
      if (!(err instanceof SignerRefused)) throw err;
      await this.refused(c, row, err);
      return true;
    }
  }

  private async apply(c: pg.PoolClient, row: Record<string, any>): Promise<boolean> {
    const approvals = await this.payouts.approvalsFor(row.id);
    try {
      const result = await this.signer.applyGovernance({ intent: row.payload, intentHash: row.hash, approvals });
      await c.query("UPDATE payouts.intents SET status = 'applied', error = NULL, updated_at = now() WHERE id = $1", [row.id]);
      switch (row.kind) {
        case 'payee_add':
          await c.query("UPDATE payouts.payees SET status = 'active', activated_at = now() WHERE intent_id = $1", [row.id]);
          break;
        case 'approver_add':
          await c.query('UPDATE payouts.credentials SET enrolled = true WHERE id = $1', [row.payload.credentialId]);
          break;
        case 'breaker_reset':
          // Everything found so far has now been looked at by two approvers.
          await c.query(
            `INSERT INTO payouts.recon_acks (fingerprint, intent_id)
             SELECT f->>'fingerprint', $1 FROM payouts.recon_runs r, jsonb_array_elements(r.findings) f
              WHERE r.id = (SELECT max(id) FROM payouts.recon_runs) AND f->>'severity' = 'critical'
             ON CONFLICT DO NOTHING`,
            [row.id],
          );
          break;
      }
      await audit(c, 'signer', `${row.kind}.applied`, row.id, { approvers: result.approvers });
      return true;
    } catch (err) {
      if (!(err instanceof SignerRefused)) throw err;
      await this.refused(c, row, err);
      if (row.kind === 'payee_add') await c.query("UPDATE payouts.payees SET status = 'rejected' WHERE intent_id = $1", [row.id]);
      return true;
    }
  }

  private async refused(c: pg.PoolClient, row: Record<string, any>, err: SignerRefused): Promise<void> {
    await c.query("UPDATE payouts.intents SET status = 'refused', error = $2, updated_at = now() WHERE id = $1", [
      row.id,
      { reason: err.reason, message: err.message, detail: err.detail },
    ]);
    await audit(c, 'signer', 'intent.refused_by_signer', row.id, { reason: err.reason, message: err.message });
  }

  private async broadcast(c: pg.PoolClient, row: Record<string, any>): Promise<boolean> {
    try {
      await this.chain.sendRawTransaction({ serializedTransaction: row.raw_tx });
    } catch (err) {
      // Already in the mempool or mined: fine, as long as the chain knows this exact hash.
      const known = await this.chain.getTransaction({ hash: row.tx_hash }).catch(() => null);
      if (!known) throw err;
    }
    await c.query(
      "UPDATE payouts.intents SET status = 'broadcast', attempts = 0, error = NULL, next_attempt_at = now() + interval '1 second', updated_at = now() WHERE id = $1",
      [row.id],
    );
    await audit(c, 'worker', 'payout.broadcast', row.id, { txHash: row.tx_hash });
    return true;
  }

  private async confirm(c: pg.PoolClient, row: Record<string, any>): Promise<boolean> {
    const receipt = await this.chain.getTransactionReceipt({ hash: row.tx_hash }).catch(() => null);
    if (!receipt) {
      // Not mined yet. If the node has forgotten it, broadcast again.
      const known = await this.chain.getTransaction({ hash: row.tx_hash }).catch(() => null);
      await c.query(
        `UPDATE payouts.intents SET status = $2, attempts = attempts + 1, next_attempt_at = now() + interval '2 seconds', updated_at = now() WHERE id = $1`,
        [row.id, known ? 'broadcast' : 'signed'],
      );
      return false;
    }
    const head = await this.chain.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(this.opts.confirmations)) {
      await c.query("UPDATE payouts.intents SET next_attempt_at = now() + interval '2 seconds' WHERE id = $1", [row.id]);
      return false;
    }

    const intent = row.payload as PayoutIntent;
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const at = new Date(Number((await this.chain.getBlock({ blockNumber: receipt.blockNumber })).timestamp) * 1000);
    const meta = { payoutIntent: row.id, txHash: row.tx_hash, block: receipt.blockNumber.toString() };
    try {
      // The fee is spent whether or not the transfer succeeded.
      await this.ledger.postTransaction({
        idempotencyKey: `payout:${row.id}:fee`,
        effectiveAt: at,
        description: `Network fee for payout ${row.id.slice(0, 8)}`,
        metadata: meta,
        entries: [
          { account: FEES, direction: 'debit', amount: fee },
          { account: HOT_ETH, direction: 'credit', amount: fee },
        ],
      });
      let ledgerTxId: string | null = null;
      if (receipt.status === 'success') {
        const posted = await this.ledger.postTransaction({
          idempotencyKey: `payout:${row.id}:settled`,
          effectiveAt: at,
          description: `Payout to ${intent.payeeId}${intent.memo ? ` — ${intent.memo}` : ''}`,
          metadata: { ...meta, payee: intent.payeeId, to: intent.to },
          entries: [
            { account: intent.expenseAccount, direction: 'debit', amount: BigInt(intent.amount) },
            { account: HOT_USDC, direction: 'credit', amount: BigInt(intent.amount) },
          ],
        });
        ledgerTxId = posted.transaction.id;
      }
      const status = receipt.status === 'success' ? 'settled' : 'failed';
      await c.query(
        `UPDATE payouts.intents SET status = $2, block_number = $3, fee_wei = $4, ledger_tx_id = $5, error = $6, updated_at = now() WHERE id = $1`,
        [row.id, status, receipt.blockNumber.toString(), fee.toString(), ledgerTxId,
          status === 'failed' ? { reason: 'reverted', message: 'the transaction reverted on chain' } : null],
      );
      await audit(c, 'worker', `payout.${status}`, row.id, { txHash: row.tx_hash, block: receipt.blockNumber.toString(), feeWei: fee.toString(), ledgerTxId });
      return true;
    } catch (err) {
      if (err instanceof LedgerError) {
        // The chain moved money the ledger says isn't there: leave it for reconciliation to flag.
        throw new Error(`ledger refused settlement: ${err.code} ${err.message}`);
      }
      throw err;
    }
  }
}
