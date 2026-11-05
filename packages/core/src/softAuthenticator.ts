import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/**
 * A software passkey (ES256) that produces real WebAuthn responses. Used by tests and by the
 * demo's scripted approvers. It is exactly as trustworthy as wherever its private key is kept,
 * which in the demo is a local file: never use it for real approvals.
 */
export class SoftAuthenticator {
  readonly credentialId: string;
  private readonly privateKey: KeyObject;
  private counter = 0;

  private constructor(credentialId: string, privateKey: KeyObject) {
    this.credentialId = credentialId;
    this.privateKey = privateKey;
  }

  static create(): SoftAuthenticator {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return new SoftAuthenticator(randomBytes(16).toString('base64url'), privateKey);
  }

  static fromJSON(json: { credentialId: string; privateKeyPkcs8: string }): SoftAuthenticator {
    const key = createPrivateKey({ key: Buffer.from(json.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' });
    return new SoftAuthenticator(json.credentialId, key);
  }

  toJSON(): { credentialId: string; privateKeyPkcs8: string } {
    return {
      credentialId: this.credentialId,
      privateKeyPkcs8: (this.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url'),
    };
  }

  /** COSE_Key (EC2, ES256, P-256) of the public key. */
  publicKeyCose(): Uint8Array {
    const jwk = createPublicKey(this.privateKey).export({ format: 'jwk' });
    const map = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, 'base64url')],
      [-3, Buffer.from(jwk.y as string, 'base64url')],
    ]);
    return isoCBOR.encode(map as never);
  }

  private authData(rpId: string, flags: number, attested?: Uint8Array): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const parts = [createHash('sha256').update(rpId).digest(), Buffer.from([flags]), counter];
    if (attested) parts.push(Buffer.from(attested));
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create() with attestation "none". */
  register(opts: { challenge: string; rpId: string; origin: string }): RegistrationResponseJSON {
    const id = Buffer.from(this.credentialId, 'base64url');
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, id, Buffer.from(this.publicKeyCose())]);
    const authData = this.authData(opts.rpId, 0x45, attested); // UP | UV | AT
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
    );
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  /** navigator.credentials.get(): signs authenticatorData || SHA-256(clientDataJSON). */
  assert(opts: { challenge: string; rpId: string; origin: string; userVerified?: boolean }): AuthenticationResponseJSON {
    const authData = this.authData(opts.rpId, opts.userVerified === false ? 0x01 : 0x05);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }
}
