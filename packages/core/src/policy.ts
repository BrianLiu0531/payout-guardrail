import { readFileSync } from 'node:fs';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * Payout policy, written in Cedar (policies/payouts.cedar). The API evaluates it when a payout is
 * proposed and to decide when enough people have approved; the signer evaluates the same file
 * again, with context it computes from its own records, before it signs anything.
 */

export const POLICY_TEXT = readFileSync(new URL('../policies/payouts.cedar', import.meta.url), 'utf8');

// Cedar numbers policies policy0, policy1, ... in file order; map them back to their @id.
const POLICY_IDS = [...POLICY_TEXT.matchAll(/@id\("([^"]+)"\)/g)].map((m) => m[1] as string);
if (POLICY_IDS.length !== (POLICY_TEXT.match(/^\s*(permit|forbid)\s*\(/gm) ?? []).length) {
  throw new Error('every policy in payouts.cedar needs exactly one @id annotation');
}
const policyName = (id: string) => POLICY_IDS[Number(/^policy(\d+)$/.exec(id)?.[1] ?? NaN)] ?? id;

export type Role = 'requester' | 'approver' | 'admin';

export interface PayoutFacts {
  intentId: string;
  /** Smallest unit. Must fit in a signed 64-bit integer. */
  amount: bigint;
  payeeActive: boolean;
  /** Seconds since the payee became active; 0 when inactive. */
  payeeAgeSeconds: number;
}

export interface PayoutContext {
  /** Already committed to payouts in the last 24 hours, smallest unit. */
  spentToday: bigint;
  /** Distinct approvers other than the requester whose approval verified. */
  approvals: number;
  breakerOpen: boolean;
}

export interface Decision {
  allowed: boolean;
  /** Ids of the policies that decided: the permit that allowed, or every forbid that applied. */
  reasons: string[];
  errors: string[];
}

const LONG_MAX = 2n ** 63n - 1n;

function long(v: bigint): number {
  if (v < 0n || v > LONG_MAX) throw new RangeError('amount out of range');
  // cedar-wasm takes JSON numbers; amounts up to 2^53 are exact. Larger values are refused
  // rather than silently rounded.
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('amount too large for policy evaluation');
  return Number(v);
}

function evaluate(
  principal: { type: string; id: string; attrs: Record<string, unknown> },
  action: string,
  resource: { type: string; id: string; attrs: Record<string, unknown> },
  context: Record<string, unknown>,
): Decision {
  const answer = cedar.isAuthorized({
    principal: { type: principal.type, id: principal.id },
    action: { type: 'Action', id: action },
    resource: { type: resource.type, id: resource.id },
    context: context as cedar.Context,
    policies: { staticPolicies: POLICY_TEXT },
    entities: [
      { uid: { type: principal.type, id: principal.id }, attrs: principal.attrs as never, parents: [] },
      { uid: { type: resource.type, id: resource.id }, attrs: resource.attrs as never, parents: [] },
    ],
  });
  if (answer.type === 'failure') {
    return { allowed: false, reasons: [], errors: answer.errors.map((e) => e.message) };
  }
  const { decision, diagnostics } = answer.response;
  return {
    allowed: decision === 'allow',
    reasons: diagnostics.reason.map(policyName),
    errors: diagnostics.errors.map((e) => e.error.message),
  };
}

const payoutResource = (f: PayoutFacts) => ({
  type: 'Payout',
  id: f.intentId,
  attrs: { amount: long(f.amount), payeeActive: f.payeeActive, payeeAgeSeconds: Math.max(0, Math.floor(f.payeeAgeSeconds)) },
});

const payoutContext = (c: PayoutContext) => ({
  spentToday: long(c.spentToday),
  approvals: c.approvals,
  breakerOpen: c.breakerOpen,
});

/** May this user propose this payout? Limits and payee rules apply already at proposal time. */
export function canPropose(user: { id: string; role: Role }, facts: PayoutFacts, context: Omit<PayoutContext, 'approvals'>): Decision {
  return evaluate(
    { type: 'User', id: user.id, attrs: { role: user.role } },
    'propose_payout',
    payoutResource(facts),
    payoutContext({ ...context, approvals: 0 }),
  );
}

/** May the signer sign this payout now? */
export function canSign(facts: PayoutFacts, context: PayoutContext): Decision {
  return evaluate({ type: 'Signer', id: 'hot-wallet', attrs: {} }, 'sign_payout', payoutResource(facts), payoutContext(context));
}

/** May the signer apply this governance change (new payee, new approver, breaker reset)? */
export function canApplyGovernance(intentId: string, approvals: number): Decision {
  return evaluate(
    { type: 'Signer', id: 'hot-wallet', attrs: {} },
    'apply_governance',
    { type: 'Governance', id: intentId, attrs: {} },
    { approvals },
  );
}

/**
 * The fewest approvals the policy accepts for this payout, ignoring the breaker and daily
 * limit, or null if no number of approvals is enough. Derived from the policy itself so the
 * UI never disagrees with the signer.
 */
export function requiredApprovals(facts: PayoutFacts): number | null {
  for (let n = 0; n <= 5; n++) {
    if (canSign(facts, { spentToday: 0n, approvals: n, breakerOpen: false }).allowed) return n;
  }
  return null;
}

export const GOVERNANCE_APPROVALS = 2;
