import { createHash } from 'node:crypto';
import type pg from 'pg';
import { canonicalJson } from '@guardrail/core';

/**
 * Tamper-evident audit log. Each entry's hash covers the previous entry's hash, so editing or
 * deleting any row breaks every hash after it; checkpoints held by the signer catch a rewrite
 * of the whole chain.
 */

export const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export function entryHash(e: Omit<AuditEntry, 'hash'>): string {
  const body = canonicalJson({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, subject: e.subject, data: e.data });
  return createHash('sha256').update(e.prevHash).update('\n').update(body).digest('hex');
}

/** Appends an entry. Pass the caller's transaction client so the entry commits with the change it records. */
export async function audit(
  db: Queryable,
  actor: string,
  action: string,
  subject: string | null,
  data: Record<string, unknown> = {},
): Promise<AuditEntry> {
  const own = 'release' in db ? null : await (db as pg.Pool).connect();
  const c = own ?? (db as pg.PoolClient);
  try {
    if (own) await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('payouts.audit'))");
    const { rows } = await c.query<{ seq: string; hash: string }>('SELECT seq, hash FROM payouts.audit ORDER BY seq DESC LIMIT 1');
    const prev = rows[0];
    const entry: Omit<AuditEntry, 'hash'> = {
      seq: prev ? Number(prev.seq) + 1 : 1,
      at: new Date().toISOString(),
      actor,
      action,
      subject,
      data: JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      prevHash: prev?.hash ?? GENESIS,
    };
    const hash = entryHash(entry);
    await c.query(
      'INSERT INTO payouts.audit (seq, at, actor, action, subject, data, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [entry.seq, entry.at, actor, action, subject, entry.data, entry.prevHash, hash],
    );
    if (own) await c.query('COMMIT');
    return { ...entry, hash };
  } catch (err) {
    if (own) await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    own?.release();
  }
}

function rowToEntry(r: Record<string, unknown>): AuditEntry {
  return {
    seq: Number(r.seq),
    at: (r.at as Date).toISOString(),
    actor: r.actor as string,
    action: r.action as string,
    subject: r.subject as string | null,
    data: r.data as Record<string, unknown>,
    prevHash: r.prev_hash as string,
    hash: r.hash as string,
  };
}

export async function listAudit(db: Queryable, limit = 100): Promise<AuditEntry[]> {
  const { rows } = await db.query('SELECT * FROM payouts.audit ORDER BY seq DESC LIMIT $1', [limit]);
  return rows.map(rowToEntry);
}

export async function latestAudit(db: Queryable): Promise<AuditEntry | null> {
  const { rows } = await db.query('SELECT * FROM payouts.audit ORDER BY seq DESC LIMIT 1');
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export type AuditProblem =
  | { kind: 'hash_mismatch'; seq: number }
  | { kind: 'broken_link'; seq: number }
  | { kind: 'gap'; seq: number }
  | { kind: 'anchor_mismatch'; seq: number; anchored: string; actual: string | null };

/** Recomputes the whole chain and compares it with the signer's checkpoints. */
export async function verifyAudit(db: Queryable, anchors: { seq: number; hash: string }[]): Promise<{ ok: boolean; entries: number; problems: AuditProblem[] }> {
  const { rows } = await db.query('SELECT * FROM payouts.audit ORDER BY seq');
  const problems: AuditProblem[] = [];
  const bySeq = new Map<number, string>();
  let prevHash = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    const e = rowToEntry(r);
    if (e.seq !== expectedSeq) problems.push({ kind: 'gap', seq: expectedSeq });
    if (e.prevHash !== prevHash) problems.push({ kind: 'broken_link', seq: e.seq });
    if (entryHash(e) !== e.hash) problems.push({ kind: 'hash_mismatch', seq: e.seq });
    bySeq.set(e.seq, e.hash);
    prevHash = e.hash;
    expectedSeq = e.seq + 1;
  }
  for (const a of anchors) {
    const actual = bySeq.get(a.seq) ?? null;
    if (actual !== a.hash) problems.push({ kind: 'anchor_mismatch', seq: a.seq, anchored: a.hash, actual });
  }
  return { ok: problems.length === 0, entries: rows.length, problems };
}
