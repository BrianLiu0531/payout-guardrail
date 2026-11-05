import type { Approval, Intent } from '@guardrail/core';

/** What the API can ask the signer. The signer decides; a refusal is an answer, not an error. */

export interface SignedPayout {
  intentId: string;
  intentHash: string;
  txHash: `0x${string}`;
  rawTx: `0x${string}`;
  nonce: number;
  approvers: string[];
  replayed: boolean;
}

export interface SignerStatus {
  address: string;
  chainId: number;
  token: string;
  nextNonce: number;
  breaker: { open: boolean; reason: string | null; at: string | null };
  approvers: number;
  payees: number;
  signed: number;
  refused: number;
}

export interface SignerLogEntry {
  seq: number;
  intentId: string;
  intentHash: string;
  kind: string;
  approvers: string[];
  to: string | null;
  amount: string | null;
  nonce: number | null;
  txHash: string | null;
  createdAt: string;
}

export interface SignerRefusalRecord {
  seq: number;
  intentId: string | null;
  intentHash: string | null;
  reason: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface SignRequest {
  intent: Intent;
  intentHash?: string;
  approvals: Approval[];
}

export interface SignerPort {
  signPayout(req: SignRequest): Promise<SignedPayout>;
  applyGovernance(req: SignRequest): Promise<{ intentId: string; intentHash: string; approvers: string[]; replayed: boolean }>;
  tripBreaker(reason: string): Promise<void>;
  status(): Promise<SignerStatus>;
  log(afterSeq?: number): Promise<SignerLogEntry[]>;
  refusals(): Promise<SignerRefusalRecord[]>;
  approvers(): Promise<{ userId: string; credentialId: string; enrolledAt: string; enrolledBy: string }[]>;
  anchor(seq: number, hash: string): Promise<{ ok: boolean; existing?: string }>;
  anchors(): Promise<{ seq: number; hash: string; createdAt: string }[]>;
}

export class SignerRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SignerRefused';
  }
}

/** HTTP client for apps/signer. */
export class HttpSigner implements SignerPort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string; reason?: string; message: string; detail?: Record<string, unknown> } };
    if (res.status === 422 && json.error?.code === 'REFUSED') {
      throw new SignerRefused(json.error.reason ?? 'refused', json.error.message, json.error.detail ?? {});
    }
    if (!res.ok) throw new Error(`signer ${method} ${path} failed: ${res.status} ${json.error?.message ?? ''}`);
    return json as T;
  }

  signPayout(req: SignRequest) {
    return this.call<SignedPayout>('POST', '/v1/payouts/sign', req);
  }
  applyGovernance(req: SignRequest) {
    return this.call<{ intentId: string; intentHash: string; approvers: string[]; replayed: boolean }>('POST', '/v1/governance/apply', req);
  }
  async tripBreaker(reason: string) {
    await this.call('POST', '/v1/breaker/trip', { reason });
  }
  status() {
    return this.call<SignerStatus>('GET', '/v1/status');
  }
  async log(afterSeq = 0) {
    return (await this.call<{ entries: SignerLogEntry[] }>('GET', `/v1/log?after=${afterSeq}`)).entries;
  }
  async refusals() {
    return (await this.call<{ refusals: SignerRefusalRecord[] }>('GET', '/v1/refusals')).refusals;
  }
  async approvers() {
    return (await this.call<{ approvers: { userId: string; credentialId: string; enrolledAt: string; enrolledBy: string }[] }>('GET', '/v1/approvers')).approvers;
  }
  anchor(seq: number, hash: string) {
    return this.call<{ ok: boolean; existing?: string }>('POST', '/v1/anchors', { seq, hash });
  }
  async anchors() {
    return (await this.call<{ anchors: { seq: number; hash: string; createdAt: string }[] }>('GET', '/v1/anchors')).anchors;
  }
}
