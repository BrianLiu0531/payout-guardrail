import type pg from 'pg';
import type { PublicClient } from 'viem';
import type { Ledger } from '@guardrail/ledger';
import { mockUsdcAbi, transferEvent } from '@guardrail/core';
import { audit, latestAudit, verifyAudit } from './audit.js';
import { HOT_ETH, HOT_USDC, type ChainSettings } from './service.js';
import type { SignerPort } from './signerPort.js';

/**
 * Four-way reconciliation: what was approved (intents), what was signed (the signer's log),
 * what happened (the chain) and what was recorded (the ledger) must all agree. A critical
 * finding nobody has acknowledged opens the circuit breaker in the signer.
 */

export interface Finding {
  kind:
    | 'unauthorized_transfer' | 'transfer_mismatch' | 'signed_without_intent' | 'intent_signer_mismatch'
    | 'settled_without_transfer' | 'balance_mismatch' | 'audit_tampered' | 'anchor_rejected' | 'balances_skipped';
  severity: 'critical' | 'warning';
  /** Stable identity of the finding, used to acknowledge it once investigated. */
  fingerprint: string;
  message: string;
  data: Record<string, string | number | boolean | null>;
  acknowledged?: boolean;
}

export interface ReconReport {
  id: number;
  at: string;
  ok: boolean;
  summary: {
    intentsChecked: number;
    signerEntries: number;
    chainTransfers: number;
    auditEntries: number;
    usdc: { chain: string; ledger: string };
    eth: { chain: string; ledger: string };
    inFlight: number;
  };
  findings: Finding[];
  breakerTripped: boolean;
}

export class Reconciler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ledger: Ledger,
    private readonly signer: SignerPort,
    private readonly chain: PublicClient,
    private readonly settings: ChainSettings,
  ) {}

  async run(): Promise<ReconReport> {
    const findings: Finding[] = [];
    const hot = this.settings.hotWallet;

    // A passkey counts as enrolled exactly when the signer says so (bootstrap, approved
    // approver_add, or removal on the signer host).
    const enrolled = (await this.signer.approvers()).map((a) => a.credentialId);
    await this.pool.query(
      'UPDATE payouts.credentials SET enrolled = (id = ANY($1::text[])) WHERE enrolled IS DISTINCT FROM (id = ANY($1::text[]))',
      [enrolled],
    );

    // Anchor the audit head first, so this run's own checks cover it.
    const head = await latestAudit(this.pool);
    if (head) {
      const r = await this.signer.anchor(head.seq, head.hash);
      if (!r.ok) {
        findings.push({
          kind: 'anchor_rejected', severity: 'critical', fingerprint: `anchor_rejected:${head.seq}:${head.hash}`,
          message: `The signer holds a different hash for audit entry ${head.seq}: the audit log was rewritten.`,
          data: { seq: head.seq, anchored: r.existing ?? null, actual: head.hash },
        });
      }
    }

    const [log, anchors, transfers, intentsRes] = await Promise.all([
      this.signer.log(0),
      this.signer.anchors(),
      this.chain.getLogs({ address: this.settings.token, event: transferEvent, args: { from: hot }, fromBlock: 0n, toBlock: 'latest' }),
      this.pool.query(`SELECT id, kind, hash, status, tx_hash, amount::text AS amount, payload FROM payouts.intents`),
    ]);
    const intents = new Map(intentsRes.rows.map((r) => [r.id as string, r]));
    const signedByTx = new Map(log.filter((e) => e.txHash).map((e) => [e.txHash!.toLowerCase(), e]));

    // 1. Everything the signer did corresponds to an intent people approved.
    for (const e of log) {
      const i = intents.get(e.intentId);
      if (!i || i.hash !== e.intentHash) {
        findings.push({
          kind: 'signed_without_intent', severity: 'critical', fingerprint: `signed_without_intent:${e.intentId}`,
          message: i ? 'The signer acted on a different version of this intent than the API stores.' : 'The signer acted on an intent the API has no record of.',
          data: { intentId: e.intentId, kind: e.kind, txHash: e.txHash },
        });
      } else if (e.kind === 'payout' && i.tx_hash && i.tx_hash.toLowerCase() !== e.txHash?.toLowerCase()) {
        findings.push({
          kind: 'intent_signer_mismatch', severity: 'critical', fingerprint: `intent_signer_mismatch:${e.intentId}`,
          message: 'The API and the signer disagree about which transaction pays this intent.',
          data: { intentId: e.intentId, api: i.tx_hash, signer: e.txHash },
        });
      }
    }

    // 2. Every token transfer out of the hot wallet was signed by the signer, as approved.
    for (const t of transfers) {
      const tx = t.transactionHash.toLowerCase();
      const e = signedByTx.get(tx);
      if (!e) {
        findings.push({
          kind: 'unauthorized_transfer', severity: 'critical', fingerprint: `unauthorized_transfer:${tx}`,
          message: 'Tokens left the hot wallet in a transaction the signer never signed. Treat the key as compromised.',
          data: { txHash: tx, to: t.args.to ?? null, amount: (t.args.value ?? 0n).toString(), block: Number(t.blockNumber) },
        });
      } else if (e.to?.toLowerCase() !== t.args.to?.toLowerCase() || e.amount !== (t.args.value ?? 0n).toString()) {
        findings.push({
          kind: 'transfer_mismatch', severity: 'critical', fingerprint: `transfer_mismatch:${tx}`,
          message: 'An on-chain transfer differs from what the signer signed.',
          data: { txHash: tx, intentId: e.intentId },
        });
      }
    }

    // 3. Every settled payout is on chain.
    const transferTx = new Set(transfers.map((t) => t.transactionHash.toLowerCase()));
    for (const i of intents.values()) {
      if (i.kind === 'payout' && i.status === 'settled' && !transferTx.has(String(i.tx_hash).toLowerCase())) {
        findings.push({
          kind: 'settled_without_transfer', severity: 'critical', fingerprint: `settled_without_transfer:${i.id}`,
          message: 'The API marks this payout settled but there is no matching transfer on chain.',
          data: { intentId: i.id, txHash: i.tx_hash },
        });
      }
    }

    // 4. Balances: chain and ledger agree, unless a payout is between signing and settlement.
    const inFlight = [...intents.values()].filter((i) => i.status === 'signed' || i.status === 'broadcast').length;
    const [usdcChain, ethChain, usdcLedger, ethLedger] = await Promise.all([
      this.chain.readContract({ address: this.settings.token, abi: mockUsdcAbi, functionName: 'balanceOf', args: [hot] }),
      this.chain.getBalance({ address: hot }),
      this.ledger.getBalance(HOT_USDC).then((b) => b.balance),
      this.ledger.getBalance(HOT_ETH).then((b) => b.balance),
    ]);
    if (inFlight > 0) {
      findings.push({
        kind: 'balances_skipped', severity: 'warning', fingerprint: 'balances_skipped',
        message: `${inFlight} payout(s) in flight; balances will be compared on the next run.`, data: { inFlight },
      });
    } else {
      for (const [currency, chainBal, ledgerBal] of [['USDC', usdcChain, usdcLedger], ['ETH', ethChain, ethLedger]] as const) {
        if (chainBal !== ledgerBal) {
          const diff = chainBal - ledgerBal;
          findings.push({
            kind: 'balance_mismatch', severity: 'critical', fingerprint: `balance_mismatch:${currency}:${diff}`,
            message: `Hot wallet ${currency} on chain differs from the ledger.`,
            data: { currency, chain: chainBal.toString(), ledger: ledgerBal.toString(), difference: diff.toString() },
          });
        }
      }
    }

    // 5. The audit log is intact and matches the signer's checkpoints.
    const auditCheck = await verifyAudit(this.pool, anchors);
    for (const p of auditCheck.problems) {
      findings.push({
        kind: 'audit_tampered', severity: 'critical', fingerprint: `audit_tampered:${p.kind}:${p.seq}`,
        message: p.kind === 'anchor_mismatch' ? `Audit entry ${p.seq} no longer matches the checkpoint the signer holds.` : `Audit entry ${p.seq} fails its hash chain (${p.kind}).`,
        data: { seq: p.seq, problem: p.kind },
      });
    }

    // Acknowledged findings stay visible but no longer trip the breaker.
    const { rows: acks } = await this.pool.query<{ fingerprint: string }>('SELECT fingerprint FROM payouts.recon_acks');
    const acked = new Set(acks.map((a) => a.fingerprint));
    for (const f of findings) f.acknowledged = acked.has(f.fingerprint);
    const alarming = findings.filter((f) => f.severity === 'critical' && !f.acknowledged);

    let breakerTripped = false;
    if (alarming.length > 0) {
      const status = await this.signer.status();
      if (!status.breaker.open) {
        const reason = `reconciliation: ${[...new Set(alarming.map((f) => f.kind))].join(', ')}`;
        await this.signer.tripBreaker(reason);
        await audit(this.pool, 'reconciler', 'breaker.tripped', null, { reason, findings: alarming.map((f) => f.fingerprint) });
        breakerTripped = true;
      }
    }

    const summary: ReconReport['summary'] = {
      intentsChecked: intents.size,
      signerEntries: log.length,
      chainTransfers: transfers.length,
      auditEntries: auditCheck.entries,
      usdc: { chain: usdcChain.toString(), ledger: usdcLedger.toString() },
      eth: { chain: ethChain.toString(), ledger: ethLedger.toString() },
      inFlight,
    };
    const ok = alarming.length === 0;
    const { rows } = await this.pool.query<{ id: string; at: Date }>(
      'INSERT INTO payouts.recon_runs (ok, summary, findings) VALUES ($1, $2, $3) RETURNING id, at',
      [ok, summary, JSON.stringify(findings)],
    );
    return { id: Number(rows[0]!.id), at: rows[0]!.at.toISOString(), ok, summary, findings, breakerTripped };
  }

  async latest(): Promise<ReconReport | null> {
    const { rows } = await this.pool.query('SELECT id, at, ok, summary, findings FROM payouts.recon_runs ORDER BY id DESC LIMIT 1');
    const r = rows[0];
    return r ? { id: Number(r.id), at: r.at.toISOString(), ok: r.ok, summary: r.summary, findings: r.findings, breakerTripped: false } : null;
  }
}
