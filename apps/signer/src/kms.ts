import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import {
  hashTypedData,
  keccak256,
  recoverAddress,
  serializeTransaction,
  toHex,
  type Hex,
  type LocalAccount,
  type SignableMessage,
} from 'viem';
import { hashMessage } from 'viem';
import { publicKeyToAddress, toAccount } from 'viem/accounts';

/**
 * A hot wallet whose private key never leaves AWS KMS (an ECC_SECG_P256K1 signing key). The
 * signer process only ever sees signatures, so stealing the signer's disk or memory no longer
 * yields the key; an attacker would need the signer's KMS permissions, which KMS logs and
 * which can be revoked.
 */

// secp256k1 group order, for normalising s to the lower half (EIP-2).
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Extracts the uncompressed public key (0x04 || X || Y) from a DER SubjectPublicKeyInfo. */
export function spkiToPublicKey(spki: Uint8Array): Hex {
  // The BIT STRING holding the key is the last 65 bytes for an uncompressed EC point.
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('KMS key is not an uncompressed EC point');
  return toHex(point);
}

/** Parses a DER ECDSA signature into r and s (s normalised to the low half). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i++] !== tag) throw new Error('malformed DER signature');
  };
  const len = () => {
    let l = der[i++]!;
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let k = 0; k < n; k++) l = (l << 8) | der[i++]!;
    }
    return l;
  };
  const int = () => {
    expect(0x02);
    const l = len();
    const v = BigInt(toHex(der.slice(i, i + l)));
    i += l;
    return v;
  };
  expect(0x30);
  len();
  const r = int();
  let s = int();
  if (s > N / 2n) s = N - s;
  return { r, s };
}

const pad32 = (v: bigint): Hex => toHex(v, { size: 32 });

export async function kmsAccount(client: KMSClient, keyId: string): Promise<LocalAccount> {
  const pub = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (pub.KeySpec !== 'ECC_SECG_P256K1' || !pub.PublicKey) throw new Error(`KMS key ${keyId} must be ECC_SECG_P256K1`);
  const publicKey = spkiToPublicKey(pub.PublicKey);
  const address = publicKeyToAddress(publicKey);

  async function signDigest(digest: Hex): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }> {
    const res = await client.send(
      new SignCommand({ KeyId: keyId, Message: Buffer.from(digest.slice(2), 'hex'), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }),
    );
    if (!res.Signature) throw new Error('KMS returned no signature');
    const { r, s } = parseDerSignature(res.Signature);
    // KMS doesn't say which of the two candidate keys it used; find the parity that recovers ours.
    for (const yParity of [0, 1] as const) {
      const sig = { r: pad32(r), s: pad32(s), yParity };
      const recovered = await recoverAddress({ hash: digest, signature: sig });
      if (recovered.toLowerCase() === address.toLowerCase()) return sig;
    }
    throw new Error('could not recover the KMS key from its signature');
  }

  const joined = (sig: { r: Hex; s: Hex; yParity: 0 | 1 }): Hex =>
    `${sig.r}${sig.s.slice(2)}${sig.yParity ? '1c' : '1b'}` as Hex;

  return toAccount({
    address,
    async signMessage({ message }: { message: SignableMessage }) {
      return joined(await signDigest(hashMessage(message)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const digest = keccak256(await serializer(transaction));
      const sig = await signDigest(digest);
      return serializer(transaction, { r: sig.r, s: sig.s, yParity: sig.yParity });
    },
    async signTypedData(typedData) {
      return joined(await signDigest(hashTypedData(typedData as never)));
    },
  });
}

export function kmsClient(opts: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}): KMSClient {
  return new KMSClient({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });
}
