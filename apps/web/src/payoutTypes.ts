/** Wire types of the payout API (apps/api/src/payouts). Amounts are integer strings in the token's smallest unit. */

export type Role = 'requester' | 'approver' | 'admin';

export interface User {
  id: string;
  name: string;
  role: Role;
  demo: boolean;
}

export interface UserSummary extends User {
  passkeys: number;
  enrolled: boolean;
}

export interface Passkey {
  id: string;
  transports: string[];
  enrolled: boolean;
  software: boolean;
}

export interface Me {
  user: User | null;
  passkeys: Passkey[];
  demoMode: boolean;
}

export interface Config {
  chainId: number;
  token: string;
  hotWallet: string;
  tokenDecimals: number;
  expenseAccounts: string[];
  demoMode: boolean;
  policy: string;
}

export interface Payee {
  id: string;
  name: string;
  address: string;
  chainId: number;
  status: 'pending' | 'active' | 'rejected';
  intentId: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export type IntentKind = 'payout' | 'payee_add' | 'approver_add' | 'breaker_reset';
export type IntentStatus =
  | 'pending_approval' | 'approved' | 'signed' | 'broadcast' | 'settled' | 'applied' | 'refused' | 'failed' | 'cancelled';

export interface Intent {
  id: string;
  kind: IntentKind;
  payload: Record<string, unknown> & { kind: IntentKind; createdBy: string };
  hash: string;
  status: IntentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  requiredApprovals: number | null;
  amount: string | null;
  error: { reason: string; message: string; detail?: Record<string, unknown> } | null;
  txHash: string | null;
  nonce: number | null;
  blockNumber: number | null;
  feeWei: string | null;
  ledgerTxId: string | null;
  attempts: number;
  approvals: { userId: string; credentialId: string; at: string }[];
}

export interface Finding {
  kind: string;
  severity: 'critical' | 'warning';
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

export interface Security {
  signer: {
    address: string;
    chainId: number;
    token: string;
    nextNonce: number;
    breaker: { open: boolean; reason: string | null; at: string | null };
    approvers: number;
    payees: number;
    signed: number;
    refused: number;
  };
  refusals: { seq: number; intentId: string | null; reason: string; detail: Record<string, unknown>; createdAt: string }[];
  approvers: { userId: string; credentialId: string; enrolledAt: string; enrolledBy: string }[];
  reconciliation: ReconReport | null;
  audit: {
    ok: boolean;
    entries: number;
    problems: { kind: string; seq: number }[];
    anchors: number;
    lastAnchor: { seq: number; hash: string; createdAt: string } | null;
  };
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  data: Record<string, unknown>;
  hash: string;
}

export interface Deposit {
  eventId: string;
  type: 'transfer.confirmed' | 'transfer.reverted';
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  to: string;
  value: string;
  outcome: 'credited' | 'reversed' | 'outgoing' | 'ignored';
  ledgerTxId: string | null;
  receivedAt: string;
}

export interface Attack {
  id: string;
  title: string;
  blurb: string;
}

export interface AttackResult {
  id: string;
  title: string;
  verdict: 'blocked' | 'detected' | 'not_blocked';
  summary: string;
  steps: { label: string; outcome: 'attacker' | 'blocked' | 'detected' | 'ok' | 'info'; detail: string }[];
}
