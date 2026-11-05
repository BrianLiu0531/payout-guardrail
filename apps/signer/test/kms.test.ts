import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateKeyCommand } from '@aws-sdk/client-kms';
import { createTestClient, http, parseEther, recoverMessageAddress, toHex, type LocalAccount } from 'viem';
import { intentChallenge, intentHash, SoftAuthenticator, type Intent, type PayoutIntent } from '@guardrail/core';
import { kmsAccount, kmsClient, Signer } from '../src/index.js';
import { parseDerSignature } from '../src/kms.js';
import { chain as anvil, freshChain, freshDb, randomAddress, RPC_URL, type TestChain } from './helpers.js';

const KMS_ENDPOINT = process.env.KMS_ENDPOINT ?? 'http://127.0.0.1:8090';
const webauthn = { rpId: 'localhost', origins: ['http://localhost:5173'] };
const client = kmsClient({ region: 'us-east-1', endpoint: KMS_ENDPOINT, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

let db: Awaited<ReturnType<typeof freshDb>>;
let chain: TestChain;
let account: LocalAccount;
const bob = SoftAuthenticator.create();
const acme = randomAddress();

beforeAll(async () => {
  const key = await client.send(new CreateKeyCommand({ KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY' }));
  account = await kmsAccount(client, key.KeyMetadata!.KeyId!);
  db = await freshDb();
  chain = await freshChain();
  await createTestClient({ chain: anvil, mode: 'anvil', transport: http(RPC_URL) }).setBalance({ address: account.address, value: parseEther('1') });
  await chain.mint(account.address, 5_000_000_000n);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe('KMS signer backend', () => {
  it('derives an Ethereum address from the KMS public key and signs messages that recover to it', async () => {
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const signature = await account.signMessage!({ message: 'payout-guardrail' });
    expect(await recoverMessageAddress({ message: 'payout-guardrail', signature })).toBe(account.address);
  });

  it('signs a real payout whose key never leaves KMS, and the chain accepts it', async () => {
    await Signer.migrate(db.pool);
    const signer = new Signer({ pool: db.pool, account, chain: chain.publicClient, webauthn });
    await signer.bootstrap({
      chainId: 31337,
      token: chain.token,
      approvers: [{ userId: 'bob', credentialId: bob.credentialId, publicKey: bob.publicKeyCose() }],
      payees: [{ payeeId: 'acme', name: 'Acme', address: acme, chainId: 31337, activatedAt: new Date('2026-01-01') }],
    });
    const intent: PayoutIntent = {
      kind: 'payout', intentId: randomUUID(), chainId: 31337, token: chain.token, to: acme, amount: '750000000', payeeId: 'acme',
      memo: 'via KMS', expenseAccount: 'expense:vendor-services', createdBy: 'alice', createdAt: new Date().toISOString(),
    };
    const approval = {
      userId: 'bob',
      credentialId: bob.credentialId,
      assertion: bob.assert({ challenge: intentChallenge(intentHash(intent as Intent)), rpId: 'localhost', origin: webauthn.origins[0]! }),
    };
    const signed = await signer.signPayout({ intent, approvals: [approval] });
    const hash = await chain.publicClient.sendRawTransaction({ serializedTransaction: signed.rawTx });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(receipt.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(await chain.balanceOf(acme)).toBe(750_000_000n);
  });

  it('normalises high-s signatures (EIP-2)', () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = 5n;
    const highS = n - 7n;
    const enc = (v: bigint) => {
      let bytes = Buffer.from(toHex(v).slice(2).padStart(64, '0'), 'hex');
      if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
      return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
    };
    const body = Buffer.concat([enc(r), enc(highS)]);
    const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);
    expect(parseDerSignature(der)).toEqual({ r, s: 7n });
  });
});
