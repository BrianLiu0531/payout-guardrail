import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { getAddress } from 'viem';
import type { Ledger } from '@guardrail/ledger';
import { audit } from './audit.js';
import { HOT_USDC, type ChainSettings } from './service.js';

/**
 * Inbound side: base-usdc-indexer watches the custody address and posts transfer.confirmed and
 * transfer.reverted events here (HMAC-signed). A confirmed deposit is credited to the ledger
 * once; a reverted one (chain reorganisation) is reversed once. Reconciliation then expects the
 * on-chain balance to equal the ledger plus deposits the indexer hasn't confirmed yet.
 */

export const CUSTOMER_DEPOSITS = 'liability:customer-deposits';
const MAX_SKEW_SECONDS = 300;

export interface IndexerEvent {
  eventId: string;
  type: 'transfer.confirmed' | 'transfer.reverted';
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  to: string;
  value: string;
}

export type Outcome = 'credited' | 'reversed' | 'outgoing' | 'ignored' | 'duplicate';

/** Checks X-Indexer-Signature over "timestamp.body", and that the timestamp is recent. */
export function verifyIndexerSignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const key = (prefix: string, eventId: string) => `${prefix}:${createHash('sha256').update(eventId).digest('hex').slice(0, 40)}`;

export class Deposits {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ledger: Ledger,
    private readonly chain: ChainSettings,
  ) {}

  async ingest(events: IndexerEvent[]): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { credited: 0, reversed: 0, outgoing: 0, ignored: 0, duplicate: 0 };
    for (const e of events) counts[await this.one(e)]++;
    return counts;
  }

  private async one(e: IndexerEvent): Promise<Outcome> {
    const seen = await this.pool.query('SELECT 1 FROM payouts.deposits WHERE event_id = $1', [e.eventId]);
    if (seen.rowCount) return 'duplicate';

    const custody = this.chain.custody.toLowerCase();
    const to = e.to.toLowerCase();
    const from = e.from.toLowerCase();
    const amount = BigInt(e.value);
    let outcome: Exclude<Outcome, 'duplicate'> = 'ignored';
    let ledgerTxId: string | null = null;

    if (e.chainId !== this.chain.chainId || amount === 0n) {
      outcome = 'ignored';
    } else if (to === custody && e.type === 'transfer.confirmed') {
      const posted = await this.ledger.postTransaction({
        idempotencyKey: key('deposit', e.eventId),
        description: `Deposit from ${getAddress(e.from)}`,
        metadata: { source: 'base-usdc-indexer', txHash: e.txHash, logIndex: e.logIndex, block: e.blockNumber },
        entries: [
          { account: HOT_USDC, direction: 'debit', amount },
          { account: CUSTOMER_DEPOSITS, direction: 'credit', amount },
        ],
      });
      outcome = 'credited';
      ledgerTxId = posted.transaction.id;
    } else if (to === custody && e.type === 'transfer.reverted') {
      // The block holding the deposit was reorganised away: undo the credit, if there was one.
      const { rows } = await this.pool.query<{ ledger_tx_id: string }>(
        `SELECT ledger_tx_id FROM payouts.deposits
          WHERE chain_id = $1 AND lower(tx_hash) = lower($2) AND log_index = $3 AND outcome = 'credited'
          ORDER BY received_at DESC LIMIT 1`,
        [e.chainId, e.txHash, e.logIndex],
      );
      const credited = rows[0];
      if (credited) {
        const reversed = await this.ledger
          .reverseTransaction(credited.ledger_tx_id, {
            idempotencyKey: key('deposit-reorg', e.eventId),
            description: 'Deposit reverted: block reorganised before finality',
            metadata: { source: 'base-usdc-indexer', txHash: e.txHash, logIndex: e.logIndex },
          })
          .catch((err: { code?: string }) => {
            if (err.code === 'ALREADY_REVERSED') return null;
            throw err;
          });
        outcome = 'reversed';
        ledgerTxId = reversed?.transaction.id ?? null;
      }
    } else if (from === custody) {
      outcome = 'outgoing'; // a payout; the worker already booked it, reconciliation cross-checks it
    }

    const ins = await this.pool.query(
      `INSERT INTO payouts.deposits (event_id, type, chain_id, tx_hash, log_index, block_number, from_address, to_address, value, outcome, ledger_tx_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
      [e.eventId, e.type, e.chainId, e.txHash, e.logIndex, e.blockNumber, e.from, e.to, e.value, outcome, ledgerTxId],
    );
    if (!ins.rowCount) return 'duplicate';
    if (outcome === 'credited' || outcome === 'reversed') {
      await audit(this.pool, 'indexer', `deposit.${outcome}`, ledgerTxId, { txHash: e.txHash, logIndex: e.logIndex, value: e.value });
    }
    return outcome;
  }

  async list(limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT event_id AS "eventId", type, tx_hash AS "txHash", log_index AS "logIndex", block_number AS "blockNumber",
              from_address AS "from", to_address AS "to", value::text AS value, outcome, ledger_tx_id AS "ledgerTxId", received_at AS "receivedAt"
         FROM payouts.deposits ORDER BY received_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ ...r, blockNumber: Number(r.blockNumber), receivedAt: r.receivedAt.toISOString() }));
  }
}
