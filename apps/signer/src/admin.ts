/**
 * Signer host administration. Run on the signer host, with the signer's own key or KMS access.
 *
 *   npm run signer:admin -- address                          print the hot wallet address
 *   npm run signer:admin -- bootstrap                        record chain and token (TOKEN_ADDRESS)
 *   npm run signer:admin -- enroll <userId> <credentialId> <publicKey>
 *                                                            enroll one of the first two approvers
 *   npm run signer:admin -- status
 */
import pg from 'pg';
import { getAddress, type Hex } from 'viem';
import { signerConfig } from './config.js';
import { kmsAccount, kmsClient } from './kms.js';
import { Signer } from './signer.js';

const [command, ...args] = process.argv.slice(2);
const cfg = signerConfig();
const account = cfg.kms ? await kmsAccount(kmsClient(cfg.kms), cfg.kms.keyId) : cfg.account;

if (command === 'address') {
  console.log(account.address);
  process.exit(0);
}

const owner = new pg.Pool({ connectionString: cfg.ownerDatabaseUrl, max: 2 });
try {
  await Signer.migrate(owner);
  const signer = new Signer({ pool: owner, account, chain: cfg.chain, webauthn: cfg.webauthn });
  switch (command) {
    case 'bootstrap': {
      const token = process.env.TOKEN_ADDRESS;
      if (!token) throw new Error('set TOKEN_ADDRESS (Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e)');
      await signer.bootstrap({ chainId: cfg.chainId, token: getAddress(token) as Hex, approvers: [], payees: [] });
      console.log(JSON.stringify(await signer.status(), null, 2));
      break;
    }
    case 'enroll': {
      const [userId, credentialId, publicKey] = args;
      if (!userId || !credentialId || !publicKey) throw new Error('usage: enroll <userId> <credentialId> <publicKey>');
      await signer.enrollBootstrapApprover({ userId, credentialId, publicKey: Buffer.from(publicKey, 'base64url') });
      console.log(`enrolled ${userId}`);
      break;
    }
    case 'status':
      console.log(JSON.stringify(await signer.status(), null, 2));
      break;
    default:
      throw new Error('commands: address | bootstrap | enroll <userId> <credentialId> <publicKey> | status');
  }
} finally {
  await owner.end();
}
