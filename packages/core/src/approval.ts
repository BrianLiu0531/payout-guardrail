import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { intentChallenge } from './intent.js';

/** A passkey signature over one intent's hash. */
export interface Approval {
  userId: string;
  credentialId: string;
  assertion: AuthenticationResponseJSON;
}

export interface KnownCredential {
  credentialId: string;
  userId: string;
  /** COSE public key bytes. */
  publicKey: Uint8Array;
}

export interface WebAuthnSettings {
  rpId: string;
  origins: string[];
}

export type ApprovalCheck =
  | { ok: true; userId: string }
  | { ok: false; reason: 'unknown_credential' | 'user_mismatch' | 'credential_mismatch' | 'wrong_intent' | 'bad_signature' | 'no_user_verification' };

/**
 * Checks that an approval is a valid passkey signature, by a credential we enrolled, over
 * exactly this intent hash, with user verification (PIN or biometric). Signature counters are
 * not enforced: synced passkeys report 0.
 */
export async function verifyApproval(
  approval: Approval,
  hashHex: string,
  lookup: (credentialId: string) => KnownCredential | undefined | Promise<KnownCredential | undefined>,
  settings: WebAuthnSettings,
): Promise<ApprovalCheck> {
  if (approval.assertion.id !== approval.credentialId || approval.assertion.rawId !== approval.credentialId) {
    return { ok: false, reason: 'credential_mismatch' };
  }
  const known = await lookup(approval.credentialId);
  if (!known) return { ok: false, reason: 'unknown_credential' };
  if (known.userId !== approval.userId) return { ok: false, reason: 'user_mismatch' };

  const expected = intentChallenge(hashHex);
  let challengeMatched = false;
  try {
    const result = await verifyAuthenticationResponse({
      response: approval.assertion,
      expectedChallenge: (c) => (challengeMatched = c === expected),
      expectedOrigin: settings.origins,
      expectedRPID: settings.rpId,
      requireUserVerification: true,
      credential: { id: known.credentialId, publicKey: known.publicKey as Uint8Array<ArrayBuffer>, counter: 0 },
    });
    if (!result.verified) return { ok: false, reason: 'bad_signature' };
    if (!result.authenticationInfo.userVerified) return { ok: false, reason: 'no_user_verification' };
    return { ok: true, userId: known.userId };
  } catch (err) {
    if (!challengeMatched && /challenge/i.test((err as Error).message)) return { ok: false, reason: 'wrong_intent' };
    if (/user.*verif/i.test((err as Error).message)) return { ok: false, reason: 'no_user_verification' };
    return { ok: false, reason: 'bad_signature' };
  }
}

/**
 * Verifies every approval and counts distinct users other than `excludeUser` (the requester).
 * Returns the count and why each rejected approval failed.
 */
export async function countApprovals(
  approvals: Approval[],
  hashHex: string,
  excludeUser: string,
  lookup: (credentialId: string) => KnownCredential | undefined | Promise<KnownCredential | undefined>,
  settings: WebAuthnSettings,
): Promise<{ count: number; users: string[]; rejected: { userId: string; reason: string }[] }> {
  const users = new Set<string>();
  const rejected: { userId: string; reason: string }[] = [];
  for (const a of approvals) {
    const check = await verifyApproval(a, hashHex, lookup, settings);
    if (!check.ok) rejected.push({ userId: a.userId, reason: check.reason });
    else if (check.userId === excludeUser) rejected.push({ userId: a.userId, reason: 'requester_cannot_approve' });
    else users.add(check.userId);
  }
  return { count: users.size, users: [...users].sort(), rejected };
}
