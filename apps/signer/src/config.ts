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
  if (chainId !== 31337 && key === ANVIL_HOT_WALLET_KEY) {
    throw new Error('refusing to use the public anvil key on a non-local chain; set SIGNER_PRIVATE_KEY');
  }
  return {
    databaseUrl: env.SIGNER_DATABASE_URL ?? env.DATABASE_URL ?? 'postgres://guardrail:guardrail@localhost:5434/guardrail',
    port: Number(env.SIGNER_PORT ?? 8788),
    host: env.SIGNER_HOST ?? '127.0.0.1',
    token: env.SIGNER_TOKEN ?? 'dev-signer-token',
    rpcUrl,
    chainId,
    account: privateKeyToAccount(key),
    chain: createPublicClient({ chain: localChain(rpcUrl, chainId), transport: http(rpcUrl) }) as PublicClient,
    webauthn: {
      rpId: env.WEBAUTHN_RP_ID ?? 'localhost',
      origins: (env.WEBAUTHN_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(','),
    },
  };
}
