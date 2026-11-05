import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localChain } from '@guardrail/core';

/**
 * Anvil's well-known development account #1. Public knowledge: anyone can spend from it on any
 * chain, so it is only ever a default for the local demo chain.
 */
export const ANVIL_HOT_WALLET_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export function signerConfig(env: NodeJS.ProcessEnv = process.env) {
  const rpcUrl = env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545';
  const chainId = Number(env.CHAIN_ID ?? 31337);
  const key = (env.SIGNER_PRIVATE_KEY ?? ANVIL_HOT_WALLET_KEY) as Hex;
  // With SIGNER_KMS_KEY_ID set, the key lives in AWS KMS (or a KMS-compatible endpoint) instead.
  const kms = env.SIGNER_KMS_KEY_ID
    ? { keyId: env.SIGNER_KMS_KEY_ID, region: env.AWS_REGION ?? 'us-east-1', endpoint: env.KMS_ENDPOINT }
    : null;
  if (!kms && chainId !== 31337 && key === ANVIL_HOT_WALLET_KEY) {
    throw new Error('refusing to use the public anvil key on a non-local chain; set SIGNER_KMS_KEY_ID or SIGNER_PRIVATE_KEY');
  }
  const ownerUrl = env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail';
  const runtime = new URL(ownerUrl);
  runtime.username = 'guardrail_signer';
  runtime.password = env.SIGNER_DB_PASSWORD ?? 'guardrail_signer_dev';
  return {
    /** Owner, for migrations only. In production the signer has its own database. */
    ownerDatabaseUrl: ownerUrl,
    /** What the signer runs as: its own schema only. */
    databaseUrl: env.SIGNER_DATABASE_URL ?? runtime.toString(),
    port: Number(env.SIGNER_PORT ?? 8788),
    host: env.SIGNER_HOST ?? '127.0.0.1',
    token: env.SIGNER_TOKEN ?? 'dev-signer-token',
    rpcUrl,
    chainId,
    account: privateKeyToAccount(key),
    kms,
    chain: createPublicClient({ chain: localChain(rpcUrl, chainId), transport: http(rpcUrl) }) as PublicClient,
    webauthn: {
      rpId: env.WEBAUTHN_RP_ID ?? 'localhost',
      origins: (env.WEBAUTHN_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(','),
    },
  };
}
