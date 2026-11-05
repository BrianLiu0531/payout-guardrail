import { createHash } from 'node:crypto';
import { getAddress, isAddress } from 'viem';

/**
 * An intent is what people approve. Its hash is the WebAuthn challenge each approver signs,
 * and the signer recomputes it from the fields it is about to act on, so changing any field
 * after approval (recipient, amount, token, chain) invalidates every approval.
 */

export type Hex = `0x${string}`;

export interface PayoutIntent {
  kind: 'payout';
  intentId: string;
  chainId: number;
  token: Hex;
  to: Hex;
  /** Smallest token unit, decimal string. */
  amount: string;
  payeeId: string;
  memo: string;
  /** Ledger expense account debited when the payout settles. */
  expenseAccount: string;
  createdBy: string;
  createdAt: string;
}

export interface PayeeAddIntent {
  kind: 'payee_add';
  intentId: string;
  chainId: number;
  payeeId: string;
  name: string;
  address: Hex;
  createdBy: string;
  createdAt: string;
}

export interface ApproverAddIntent {
  kind: 'approver_add';
  intentId: string;
  userId: string;
  credentialId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  createdBy: string;
  createdAt: string;
}

export interface BreakerResetIntent {
  kind: 'breaker_reset';
  intentId: string;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export type GovernanceIntent = PayeeAddIntent | ApproverAddIntent | BreakerResetIntent;
export type Intent = PayoutIntent | GovernanceIntent;
export type IntentKind = Intent['kind'];

const DOMAIN = 'payout-guardrail/intent/v1';

/** Deterministic JSON: object keys sorted, no whitespace. Rejects values JSON can't round-trip. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('only safe integers are allowed in intents');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalise ${typeof value}`);
}

/** SHA-256 over a domain tag and the canonical intent, hex without 0x. */
export function intentHash(intent: Intent): string {
  return createHash('sha256').update(DOMAIN).update('\n').update(canonicalJson(intent)).digest('hex');
}

/** The WebAuthn challenge for an intent: its hash bytes, base64url. */
export function intentChallenge(hashHex: string): string {
  return Buffer.from(hashHex, 'hex').toString('base64url');
}

export class IntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentError';
  }
}

const MAX_AMOUNT = 2n ** 63n - 1n; // Cedar Long

/**
 * Validates shape and normalises addresses to checksum form. Used by both the API and the
 * signer, so neither trusts the other's parsing.
 */
export function parseIntent(raw: unknown): Intent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IntentError('intent must be an object');
  const o = raw as Record<string, unknown>;
  const str = (k: string, max = 200): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new IntentError(`${k} must be a non-empty string`);
    return v;
  };
  const addr = (k: string): Hex => {
    const v = str(k, 42);
    if (!isAddress(v, { strict: false })) throw new IntentError(`${k} is not an address`);
    return getAddress(v);
  };
  const int = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new IntentError(`${k} must be a positive integer`);
    return v;
  };
  const time = (k: string): string => {
    const v = str(k, 40);
    if (Number.isNaN(Date.parse(v))) throw new IntentError(`${k} must be an ISO timestamp`);
    return v;
  };
  const common = { intentId: str('intentId', 64), createdBy: str('createdBy', 64), createdAt: time('createdAt') };
  const allowed = (keys: string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) throw new IntentError(`unexpected field ${k}`);
  };

  switch (o.kind) {
    case 'payout': {
      allowed(['kind', 'intentId', 'chainId', 'token', 'to', 'amount', 'payeeId', 'memo', 'expenseAccount', 'createdBy', 'createdAt']);
      const amount = str('amount', 30);
      if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > MAX_AMOUNT) throw new IntentError('amount must be a positive integer string');
      const memo = o.memo;
      if (typeof memo !== 'string' || memo.length > 200) throw new IntentError('memo must be a string of at most 200 characters');
      return {
        kind: 'payout',
        ...common,
        chainId: int('chainId'),
        token: addr('token'),
        to: addr('to'),
        amount,
        payeeId: str('payeeId', 64),
        memo,
        expenseAccount: str('expenseAccount', 100),
      };
    }
    case 'payee_add':
      allowed(['kind', 'intentId', 'chainId', 'payeeId', 'name', 'address', 'createdBy', 'createdAt']);
      return { kind: 'payee_add', ...common, chainId: int('chainId'), payeeId: str('payeeId', 64), name: str('name', 100), address: addr('address') };
    case 'approver_add': {
      allowed(['kind', 'intentId', 'userId', 'credentialId', 'publicKey', 'createdBy', 'createdAt']);
      return { kind: 'approver_add', ...common, userId: str('userId', 64), credentialId: str('credentialId', 1400), publicKey: str('publicKey', 1400) };
    }
    case 'breaker_reset':
      allowed(['kind', 'intentId', 'reason', 'createdBy', 'createdAt']);
      return { kind: 'breaker_reset', ...common, reason: str('reason', 200) };
    default:
      throw new IntentError('unknown intent kind');
  }
}
